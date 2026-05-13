use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::ThreadMode;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
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
pub struct ProgressEvent {
    pub command: String,
    pub family: OperationFamily,
    pub format: Option<String>,
    pub stage: String,
    pub label: String,
    pub percent: Option<f32>,
    pub requested_threads: Option<usize>,
    pub effective_threads: Option<usize>,
    pub thread_mode: Option<ThreadMode>,
    pub used_parallelism: Option<bool>,
    pub status: OperationStatus,
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
    pub fn snapshot(&self) -> Vec<ProgressEvent> {
        self.events.lock().expect("progress events mutex").clone()
    }
}

impl ProgressSink for RecordingProgressSink {
    fn emit(&self, event: ProgressEvent) {
        self.events
            .lock()
            .expect("progress events mutex")
            .push(event);
    }
}
