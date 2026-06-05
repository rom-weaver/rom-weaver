use std::{fmt, path::Path, path::PathBuf, str::FromStr, sync::Arc};

use crate::{
    CancellationToken, ProgressEvent, ProgressSink, Result, RomWeaverError, SharedThreadPool,
    TempPathAllocator, ThreadBudget, ThreadCapability, ThreadExecution,
};
use tracing::trace;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatchChecksumValidation {
    Strict,
    Ignore,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum XdeltaSecondaryMode {
    Auto,
    Djw,
    Fgk,
    #[default]
    Lzma,
    None,
}

impl fmt::Display for XdeltaSecondaryMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Auto => formatter.write_str("auto"),
            Self::Djw => formatter.write_str("djw"),
            Self::Fgk => formatter.write_str("fgk"),
            Self::Lzma => formatter.write_str("lzma"),
            Self::None => formatter.write_str("none"),
        }
    }
}

impl FromStr for XdeltaSecondaryMode {
    type Err = RomWeaverError;

    fn from_str(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(Self::Auto),
            "djw" => Ok(Self::Djw),
            "fgk" => Ok(Self::Fgk),
            "lzma" => Ok(Self::Lzma),
            "none" => Ok(Self::None),
            _ => Err(RomWeaverError::Validation(format!(
                "invalid xdelta secondary mode `{value}`; expected one of: auto, lzma, djw, fgk, none"
            ))),
        }
    }
}

#[derive(Clone)]
pub struct OperationContext {
    thread_budget: ThreadBudget,
    temp_paths: Arc<TempPathAllocator>,
    progress: Arc<dyn ProgressSink>,
    cancel: CancellationToken,
    extract_checksum_algorithms: Vec<String>,
    patch_checksum_validation: PatchChecksumValidation,
    xdelta_secondary_mode: XdeltaSecondaryMode,
}

impl OperationContext {
    pub fn new(
        thread_budget: ThreadBudget,
        temp_root: PathBuf,
        progress: Arc<dyn ProgressSink>,
        cancel: CancellationToken,
    ) -> Self {
        trace!(
            thread_budget = %thread_budget,
            temp_root = %temp_root.display(),
            "creating operation context"
        );
        Self {
            thread_budget,
            temp_paths: Arc::new(TempPathAllocator::new(temp_root)),
            progress,
            cancel,
            extract_checksum_algorithms: Vec::new(),
            patch_checksum_validation: PatchChecksumValidation::Strict,
            xdelta_secondary_mode: XdeltaSecondaryMode::default(),
        }
    }

    pub fn thread_budget(&self) -> ThreadBudget {
        self.thread_budget
    }

    pub fn temp_root(&self) -> &Path {
        self.temp_paths.root()
    }

    pub fn temp_paths(&self) -> &TempPathAllocator {
        self.temp_paths.as_ref()
    }

    pub fn cancel(&self) -> &CancellationToken {
        &self.cancel
    }

    pub fn extract_checksum_algorithms(&self) -> &[String] {
        &self.extract_checksum_algorithms
    }

    pub fn with_extract_checksum_algorithms(self, algorithms: Vec<String>) -> Self {
        Self {
            extract_checksum_algorithms: algorithms,
            ..self
        }
    }

    pub fn patch_checksum_validation(&self) -> PatchChecksumValidation {
        self.patch_checksum_validation
    }

    pub fn with_patch_checksum_validation(self, validation: PatchChecksumValidation) -> Self {
        Self {
            patch_checksum_validation: validation,
            ..self
        }
    }

    pub fn xdelta_secondary_mode(&self) -> XdeltaSecondaryMode {
        self.xdelta_secondary_mode
    }

    pub fn with_xdelta_secondary_mode(self, mode: XdeltaSecondaryMode) -> Self {
        Self {
            xdelta_secondary_mode: mode,
            ..self
        }
    }

    pub fn emit(&self, event: ProgressEvent) {
        trace!(
            command = %event.command,
            family = ?event.family,
            format = ?event.format,
            stage = %event.stage,
            status = ?event.status,
            "emitting progress event"
        );
        self.progress.emit(event);
    }

    pub fn progress_sink(&self) -> Arc<dyn ProgressSink> {
        self.progress.clone()
    }

    pub fn with_progress_sink(self, progress: Arc<dyn ProgressSink>) -> Self {
        Self { progress, ..self }
    }

    pub fn plan_threads(&self, capability: ThreadCapability) -> ThreadExecution {
        trace!(capability = ?capability, budget = %self.thread_budget, "planning thread usage");
        capability.negotiate(self.thread_budget)
    }

    pub fn build_pool(
        &self,
        capability: ThreadCapability,
    ) -> Result<(ThreadExecution, SharedThreadPool)> {
        let execution = self.plan_threads(capability);
        trace!(
            requested_threads = execution.requested_threads,
            effective_threads = execution.effective_threads,
            thread_mode = ?execution.thread_mode,
            used_parallelism = execution.used_parallelism,
            "building execution pool for operation context"
        );
        SharedThreadPool::with_execution_fallback(execution)
    }
}
