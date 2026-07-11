use std::sync::{
    Mutex,
    atomic::{AtomicU8, Ordering},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::trace;
#[cfg(feature = "typescript-types")]
use ts_rs::TS;

use crate::{
    context::OperationContext,
    threads::{ThreadExecution, ThreadMode},
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum OperationFamily {
    Command,
    Container,
    Patch,
    Checksum,
    Codec,
    Threading,
    Test,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Pending,
    Running,
    Succeeded,
    Unsupported,
    Failed,
    Cancelled,
}

impl OperationStatus {
    pub fn exit_code(self) -> u8 {
        match self {
            Self::Succeeded | Self::Pending | Self::Running => 0,
            Self::Failed => 1,
            Self::Unsupported => 2,
            Self::Cancelled => 130,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ProgressEvent {
    pub command: String,
    pub family: OperationFamily,
    pub format: Option<String>,
    pub stage: String,
    pub label: String,
    pub details: Option<Value>,
    pub percent: Option<f32>,
    pub requested_threads: Option<usize>,
    pub effective_threads: Option<usize>,
    pub thread_mode: Option<ThreadMode>,
    pub used_parallelism: Option<bool>,
    pub thread_fallback: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_fallback_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u32>,
    /// Typed error classification for a `Failed` event, derived from the failure
    /// message via [`crate::RomWeaverErrorKind::classify_message`]. Lets the
    /// webapp read the generated `RomWeaverErrorKind` directly instead of
    /// re-inferring it from `label`; `None` (and omitted) for non-failure events
    /// and for failures whose message is not a bare `RomWeaverError` rendering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<crate::RomWeaverErrorKind>,
    pub status: OperationStatus,
}

impl ProgressEvent {
    /// Base event carrying only the six flattened thread-execution fields,
    /// derived from `execution` (all `None` when it is `None`). Intended for
    /// struct-update syntax so each emit site maps a `ThreadExecution` in
    /// exactly one place - add or rename a thread field here, not at 8 call
    /// sites:
    ///
    /// ```ignore
    /// ProgressEvent {
    ///     command, family, format, stage, label, details, percent, status,
    ///     ..ProgressEvent::from_thread_execution(thread_execution)
    /// }
    /// ```
    ///
    /// The non-thread fields below are placeholders the caller overrides.
    pub fn from_thread_execution(execution: Option<&ThreadExecution>) -> Self {
        Self {
            command: String::new(),
            family: OperationFamily::Command,
            format: None,
            stage: String::new(),
            label: String::new(),
            details: None,
            percent: None,
            requested_threads: execution.map(|value| value.requested_threads),
            effective_threads: execution.map(|value| value.effective_threads),
            thread_mode: execution.map(|value| value.thread_mode),
            used_parallelism: execution.map(|value| value.used_parallelism),
            thread_fallback: execution.map(|value| value.thread_fallback),
            thread_fallback_reason: execution
                .and_then(|value| value.thread_fallback_reason.clone()),
            elapsed_ms: None,
            error_kind: None,
            status: OperationStatus::Pending,
        }
    }
}

pub fn emit_container_running_progress(
    context: &OperationContext,
    command: &str,
    format: &str,
    stage: &str,
    label: impl Into<String>,
    percent: f32,
    thread_execution: Option<&ThreadExecution>,
) {
    let clamped_percent = percent.clamp(0.0, 100.0);
    // Every emitted container progress event, across all formats and commands.
    trace!(
        command,
        family = ?OperationFamily::Container,
        format,
        stage,
        percent = clamped_percent,
        effective_threads = ?thread_execution.map(|value| value.effective_threads),
        "container progress event"
    );
    context.emit(ProgressEvent {
        command: command.to_string(),
        family: OperationFamily::Container,
        format: Some(format.to_string()),
        stage: stage.to_string(),
        label: label.into(),
        details: None,
        percent: Some(clamped_percent),
        elapsed_ms: None,
        status: OperationStatus::Running,
        ..ProgressEvent::from_thread_execution(thread_execution)
    });
}

#[derive(Clone, Copy, Debug)]
pub struct ContainerByteProgress<'a> {
    pub command: &'a str,
    pub format: &'a str,
    pub stage: &'a str,
    pub label: &'a str,
    pub thread_execution: Option<&'a ThreadExecution>,
    pub emitted_progress_bucket: &'a AtomicU8,
}

pub fn maybe_emit_container_byte_progress(
    context: &OperationContext,
    completed_bytes: u64,
    total_bytes: u64,
    progress: ContainerByteProgress<'_>,
) {
    if total_bytes == 0 || completed_bytes == 0 {
        return;
    }
    let completed = completed_bytes.min(total_bytes);
    let percent_bucket = completed
        .saturating_mul(100)
        .checked_div(total_bytes)
        .unwrap_or(100)
        .min(100) as u8;
    if percent_bucket == 0 {
        return;
    }

    let (start_bucket, end_bucket) = loop {
        let previous_bucket = progress.emitted_progress_bucket.load(Ordering::Relaxed);
        if percent_bucket <= previous_bucket {
            return;
        }
        match progress.emitted_progress_bucket.compare_exchange(
            previous_bucket,
            percent_bucket,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => break (previous_bucket.saturating_add(1), percent_bucket),
            Err(_) => continue,
        }
    };

    for bucket in start_bucket..=end_bucket {
        emit_container_running_progress(
            context,
            progress.command,
            progress.format,
            progress.stage,
            progress.label.to_string(),
            bucket as f32,
            progress.thread_execution,
        );
    }
}

pub trait ProgressSink: Send + Sync {
    fn emit(&self, event: ProgressEvent);
}

#[derive(Debug, Default)]
pub struct NoopProgressSink;

impl ProgressSink for NoopProgressSink {
    fn emit(&self, _event: ProgressEvent) {}
}

#[derive(Debug, Default)]
pub struct RecordingProgressSink {
    events: Mutex<Vec<ProgressEvent>>,
}

impl RecordingProgressSink {
    fn events_guard(&self) -> std::sync::MutexGuard<'_, Vec<ProgressEvent>> {
        match self.events.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub fn snapshot(&self) -> Vec<ProgressEvent> {
        self.events_guard().clone()
    }
}

impl ProgressSink for RecordingProgressSink {
    fn emit(&self, event: ProgressEvent) {
        self.events_guard().push(event);
    }
}
