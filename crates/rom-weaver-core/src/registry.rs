use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::Value;

use crate::{
    OperationContext, OperationFamily, OperationStatus, Result, RomWeaverError, ThreadCapability,
    ThreadExecution,
};
use tracing::trace;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FormatDescriptor {
    pub family: OperationFamily,
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub extensions: &'static [&'static str],
}

impl FormatDescriptor {
    pub fn matches_name(&self, candidate: &str) -> bool {
        let candidate = candidate.trim();
        self.name.eq_ignore_ascii_case(candidate)
            || self
                .aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(candidate))
    }

    pub fn matches_path(&self, path: &Path) -> bool {
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        let Some(file_name) = file_name else {
            return false;
        };
        self.extensions
            .iter()
            .any(|extension| file_name.ends_with(&extension.to_ascii_lowercase()))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeConfidence {
    Extension,
    Signature,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OperationReport {
    pub family: OperationFamily,
    pub format: Option<String>,
    pub stage: String,
    pub label: String,
    pub details: Option<Value>,
    pub percent: Option<f32>,
    pub thread_execution: Option<ThreadExecution>,
    pub status: OperationStatus,
}

impl OperationReport {
    fn with_status(
        family: OperationFamily,
        format: Option<String>,
        stage: impl Into<String>,
        label: impl Into<String>,
        percent: Option<f32>,
        thread_execution: Option<ThreadExecution>,
        status: OperationStatus,
    ) -> Self {
        Self {
            family,
            format,
            stage: stage.into(),
            label: label.into(),
            details: None,
            percent,
            thread_execution,
            status,
        }
    }

    pub fn unsupported(
        family: OperationFamily,
        format: Option<String>,
        stage: impl Into<String>,
        label: impl Into<String>,
        thread_execution: Option<ThreadExecution>,
    ) -> Self {
        Self::with_status(
            family,
            format,
            stage,
            label,
            None,
            thread_execution,
            OperationStatus::Unsupported,
        )
    }

    pub fn failed(
        family: OperationFamily,
        format: Option<String>,
        stage: impl Into<String>,
        label: impl Into<String>,
        thread_execution: Option<ThreadExecution>,
    ) -> Self {
        let mut report = Self::unsupported(family, format, stage, label, thread_execution);
        report.status = OperationStatus::Failed;
        report
    }

    pub fn succeeded(
        family: OperationFamily,
        format: Option<String>,
        stage: impl Into<String>,
        label: impl Into<String>,
        percent: Option<f32>,
        thread_execution: Option<ThreadExecution>,
    ) -> Self {
        Self::with_status(
            family,
            format,
            stage,
            label,
            percent,
            thread_execution,
            OperationStatus::Succeeded,
        )
    }

    pub fn into_event(self, command: impl Into<String>) -> crate::ProgressEvent {
        let thread_execution = self.thread_execution.as_ref();
        crate::ProgressEvent {
            command: command.into(),
            family: self.family,
            format: self.format,
            stage: self.stage,
            label: self.label,
            details: self.details,
            percent: self.percent,
            requested_threads: thread_execution.map(|value| value.requested_threads),
            effective_threads: thread_execution.map(|value| value.effective_threads),
            thread_mode: thread_execution.map(|value| value.thread_mode),
            used_parallelism: thread_execution.map(|value| value.used_parallelism),
            thread_fallback: thread_execution.map(|value| value.thread_fallback),
            thread_fallback_reason: thread_execution
                .and_then(|value| value.thread_fallback_reason.clone()),
            status: self.status,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerInspectRequest {
    pub source: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerExtractRequest {
    pub source: PathBuf,
    pub selections: Vec<String>,
    pub out_dir: PathBuf,
    pub split_bin: bool,
    pub parent: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerCreateRequest {
    pub inputs: Vec<PathBuf>,
    pub output: PathBuf,
    pub format: String,
    pub codec: Option<String>,
    pub level: Option<i32>,
    pub parent: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchApplyRequest {
    pub input: PathBuf,
    pub patches: Vec<PathBuf>,
    pub output: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchCreateRequest {
    pub original: PathBuf,
    pub modified: PathBuf,
    pub output: PathBuf,
    pub format: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChecksumRequest {
    pub source: PathBuf,
    pub algorithms: Vec<String>,
    pub start: Option<u64>,
    pub length: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodecOperationRequest {
    pub input: PathBuf,
    pub output: PathBuf,
    pub level: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerCapabilities {
    pub inspect: bool,
    pub extract: bool,
    pub create: bool,
    pub extract_threads: ThreadCapability,
    pub create_threads: ThreadCapability,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchCapabilities {
    pub parse: bool,
    pub apply: bool,
    pub create: bool,
    pub threaded_scan: bool,
    pub threaded_diff: bool,
    pub threaded_output: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChecksumCapabilities {
    pub checksum_file: bool,
    pub checksum_range: bool,
    pub threaded_fanout: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodecCapabilities {
    pub encode: bool,
    pub decode: bool,
    pub encode_threads: ThreadCapability,
    pub decode_threads: ThreadCapability,
}

pub type CodecDescriptor = FormatDescriptor;

pub fn traced_container_handler(handler: Arc<dyn ContainerHandler>) -> Arc<dyn ContainerHandler> {
    Arc::new(TracingContainerHandler { inner: handler })
}

pub fn traced_patch_handler(handler: Arc<dyn PatchHandler>) -> Arc<dyn PatchHandler> {
    Arc::new(TracingPatchHandler { inner: handler })
}

pub fn traced_codec_backend(backend: Arc<dyn CodecBackend>) -> Arc<dyn CodecBackend> {
    Arc::new(TracingCodecBackend { inner: backend })
}

pub trait ContainerHandler: Send + Sync {
    fn descriptor(&self) -> &'static FormatDescriptor;
    fn probe(&self, source: &Path) -> ProbeConfidence {
        let _ = source;
        ProbeConfidence::Extension
    }
    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<Vec<String>> {
        let _ = (request, context);
        Err(RomWeaverError::Unsupported(format!(
            "{} does not support listing entries",
            self.descriptor().name
        )))
    }
    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn capabilities(&self) -> ContainerCapabilities;
}

pub trait PatchHandler: Send + Sync {
    fn descriptor(&self) -> &'static FormatDescriptor;
    fn probe(&self, patch_path: &Path) -> ProbeConfidence {
        let _ = patch_path;
        ProbeConfidence::Extension
    }
    fn parse(&self, patch_path: &Path, context: &OperationContext) -> Result<OperationReport>;
    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn capabilities(&self) -> PatchCapabilities;
}

pub trait ChecksumEngine: Send + Sync {
    fn name(&self) -> &'static str;
    fn supported_algorithms(&self) -> &'static [&'static str];
    fn checksum_file(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn checksum_range(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn capabilities(&self) -> ChecksumCapabilities;
}

pub trait CodecBackend: Send + Sync {
    fn descriptor(&self) -> &'static CodecDescriptor;
    fn encode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn decode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport>;
    fn capabilities(&self) -> CodecCapabilities;
}

struct TracingContainerHandler {
    inner: Arc<dyn ContainerHandler>,
}

impl ContainerHandler for TracingContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.inner.descriptor()
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            source = %source.display(),
            "container probe start"
        );
        let confidence = self.inner.probe(source);
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            source = %source.display(),
            confidence = ?confidence,
            "container probe complete"
        );
        confidence
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            source = %request.source.display(),
            "container inspect start"
        );
        let result = self.inner.inspect(request, context);
        trace_operation_result("inspect", descriptor, &result);
        result
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<Vec<String>> {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            source = %request.source.display(),
            "container list start"
        );
        let result = self.inner.list_entries(request, context);
        match &result {
            Ok(entries) => {
                trace!(
                    family = ?descriptor.family,
                    format = descriptor.name,
                    entry_count = entries.len(),
                    "container list complete"
                );
            }
            Err(error) => {
                trace!(
                    family = ?descriptor.family,
                    format = descriptor.name,
                    error = %error,
                    "container list failed"
                );
            }
        }
        result
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            source = %request.source.display(),
            out_dir = %request.out_dir.display(),
            selections = request.selections.len(),
            parent = ?request.parent.as_ref().map(|path| path.display().to_string()),
            "container extract start"
        );
        let result = self.inner.extract(request, context);
        trace_operation_result("extract", descriptor, &result);
        result
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            output = %request.output.display(),
            input_count = request.inputs.len(),
            requested_format = %request.format,
            codec = ?request.codec,
            level = ?request.level,
            parent = ?request.parent.as_ref().map(|path| path.display().to_string()),
            "container create start"
        );
        let result = self.inner.create(request, context);
        trace_operation_result("create", descriptor, &result);
        result
    }

    fn capabilities(&self) -> ContainerCapabilities {
        self.inner.capabilities()
    }
}

struct TracingPatchHandler {
    inner: Arc<dyn PatchHandler>,
}

impl PatchHandler for TracingPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.inner.descriptor()
    }

    fn probe(&self, patch_path: &Path) -> ProbeConfidence {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            patch = %patch_path.display(),
            "patch probe start"
        );
        let confidence = self.inner.probe(patch_path);
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            patch = %patch_path.display(),
            confidence = ?confidence,
            "patch probe complete"
        );
        confidence
    }

    fn parse(&self, patch_path: &Path, context: &OperationContext) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            patch = %patch_path.display(),
            "patch parse start"
        );
        let result = self.inner.parse(patch_path, context);
        trace_operation_result("parse", descriptor, &result);
        result
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            input = %request.input.display(),
            output = %request.output.display(),
            patch_count = request.patches.len(),
            "patch apply start"
        );
        let result = self.inner.apply(request, context);
        trace_operation_result("apply", descriptor, &result);
        result
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace!(
            family = ?descriptor.family,
            format = descriptor.name,
            original = %request.original.display(),
            modified = %request.modified.display(),
            output = %request.output.display(),
            requested_format = %request.format,
            "patch create start"
        );
        let result = self.inner.create(request, context);
        trace_operation_result("create", descriptor, &result);
        result
    }

    fn capabilities(&self) -> PatchCapabilities {
        self.inner.capabilities()
    }
}

struct TracingCodecBackend {
    inner: Arc<dyn CodecBackend>,
}

impl CodecBackend for TracingCodecBackend {
    fn descriptor(&self) -> &'static CodecDescriptor {
        self.inner.descriptor()
    }

    fn encode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace_codec_operation("encode", descriptor, request, || {
            self.inner.encode(request, context)
        })
    }

    fn decode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let descriptor = self.inner.descriptor();
        trace_codec_operation("decode", descriptor, request, || {
            self.inner.decode(request, context)
        })
    }

    fn capabilities(&self) -> CodecCapabilities {
        self.inner.capabilities()
    }
}

fn trace_codec_operation(
    stage: &'static str,
    descriptor: &CodecDescriptor,
    request: &CodecOperationRequest,
    operation: impl FnOnce() -> Result<OperationReport>,
) -> Result<OperationReport> {
    trace!(
        family = ?descriptor.family,
        format = descriptor.name,
        input = %request.input.display(),
        output = %request.output.display(),
        level = ?request.level,
        "codec operation start"
    );
    let result = operation();
    trace_operation_result(stage, descriptor, &result);
    result
}

fn trace_operation_result(
    stage: &str,
    descriptor: &FormatDescriptor,
    result: &Result<OperationReport>,
) {
    match result {
        Ok(report) => {
            trace!(
                family = ?descriptor.family,
                format = descriptor.name,
                stage,
                status = ?report.status,
                percent = ?report.percent,
                label = %report.label,
                "operation complete"
            );
        }
        Err(error) => {
            trace!(
                family = ?descriptor.family,
                format = descriptor.name,
                stage,
                error = %error,
                "operation failed"
            );
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/registry.rs"]
mod tests;
