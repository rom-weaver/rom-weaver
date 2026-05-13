use std::path::{Path, PathBuf};

use crate::{
    OperationContext, OperationFamily, OperationStatus, Result, ThreadCapability, ThreadExecution,
};

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
    pub percent: Option<f32>,
    pub thread_execution: Option<ThreadExecution>,
    pub status: OperationStatus,
}

impl OperationReport {
    pub fn unsupported(
        family: OperationFamily,
        format: Option<String>,
        stage: impl Into<String>,
        label: impl Into<String>,
        thread_execution: Option<ThreadExecution>,
    ) -> Self {
        Self {
            family,
            format,
            stage: stage.into(),
            label: label.into(),
            percent: None,
            thread_execution,
            status: OperationStatus::Unsupported,
        }
    }

    pub fn failed(
        family: OperationFamily,
        format: Option<String>,
        stage: impl Into<String>,
        label: impl Into<String>,
        thread_execution: Option<ThreadExecution>,
    ) -> Self {
        Self {
            family,
            format,
            stage: stage.into(),
            label: label.into(),
            percent: None,
            thread_execution,
            status: OperationStatus::Failed,
        }
    }

    pub fn succeeded(
        family: OperationFamily,
        format: Option<String>,
        stage: impl Into<String>,
        label: impl Into<String>,
        percent: Option<f32>,
        thread_execution: Option<ThreadExecution>,
    ) -> Self {
        Self {
            family,
            format,
            stage: stage.into(),
            label: label.into(),
            percent,
            thread_execution,
            status: OperationStatus::Succeeded,
        }
    }

    pub fn into_event(self, command: impl Into<String>) -> crate::ProgressEvent {
        let thread_execution = self.thread_execution.as_ref();
        crate::ProgressEvent {
            command: command.into(),
            family: self.family,
            format: self.format,
            stage: self.stage,
            label: self.label,
            percent: self.percent,
            requested_threads: thread_execution.map(|value| value.requested_threads),
            effective_threads: thread_execution.map(|value| value.effective_threads),
            thread_mode: thread_execution.map(|value| value.thread_mode),
            used_parallelism: thread_execution.map(|value| value.used_parallelism),
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
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContainerCreateRequest {
    pub inputs: Vec<PathBuf>,
    pub output: PathBuf,
    pub format: String,
    pub codec: Option<String>,
    pub level: Option<i32>,
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
    pub threads: ThreadCapability,
}

pub type CodecDescriptor = FormatDescriptor;

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
