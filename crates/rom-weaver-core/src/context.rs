use std::{
    fmt,
    path::Path,
    path::PathBuf,
    str::FromStr,
    sync::{Arc, Mutex},
};

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
    ppf_undo_aware: bool,
    xdelta_secondary_mode: XdeltaSecondaryMode,
    /// One operation-scoped worker pool, sized to the full thread budget and reused by every
    /// extract (the primary container and each nested archive). Building a fresh pool per extract
    /// stacked worker threads across sequential/nested extracts and exhausted the browser's fixed
    /// wasi worker pool, stalling with 30s spawn timeouts; reusing one pool keeps the live thread
    /// count bounded while still giving each (serially processed) extract the whole pool.
    operation_pool: Arc<Mutex<Option<(SharedThreadPool, ThreadExecution)>>>,
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
            ppf_undo_aware: false,
            xdelta_secondary_mode: XdeltaSecondaryMode::default(),
            operation_pool: Arc::new(Mutex::new(None)),
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

    /// When enabled, PPF apply uses the patch's stored undo data to reconstruct the
    /// original bytes of any validation region that has already been overwritten by a
    /// prior application of the same patch. This lets a PPF3 patch (with a blockcheck
    /// validation block) be safely re-applied to an already-patched ROM. For a clean,
    /// unpatched ROM it is a strict no-op.
    pub fn ppf_undo_aware(&self) -> bool {
        self.ppf_undo_aware
    }

    pub fn with_ppf_undo_aware(self, enabled: bool) -> Self {
        Self {
            ppf_undo_aware: enabled,
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
        // The returned `execution` still reflects this caller's negotiated capability (it drives
        // whether/how the handler parallelizes and progress reporting), but the pool itself is the
        // shared operation pool so nested/sequential extracts reuse one fixed set of worker threads.
        let (pool, pool_execution) = self.operation_pool()?;
        // If the shared pool itself degraded to single-thread (e.g. the OS refused to build a
        // multi-thread pool), every operation drawing on it genuinely runs serially — so propagate
        // that fallback into this caller's reported execution instead of advertising parallelism it
        // never got.
        let mut execution = execution;
        if pool_execution.thread_fallback && execution.used_parallelism {
            let reason = pool_execution
                .thread_fallback_reason
                .clone()
                .unwrap_or_else(|| "shared operation pool fell back to single-thread".to_string());
            execution.apply_pool_fallback(reason);
        }
        Ok((execution, pool))
    }

    /// Lazily build (once) and return the operation-scoped worker pool, sized to the full thread
    /// budget so every extract that reuses it can draw on all available threads. The cached
    /// `ThreadExecution` records the pool's actual size after any build fallback so callers can
    /// reconcile their reported execution against what the shared pool can really deliver.
    fn operation_pool(&self) -> Result<(SharedThreadPool, ThreadExecution)> {
        let mut guard = self
            .operation_pool
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((pool, execution)) = guard.as_ref() {
            return Ok((pool.clone(), execution.clone()));
        }
        let full = self.plan_threads(ThreadCapability::parallel(None));
        trace!(
            effective_threads = full.effective_threads,
            used_parallelism = full.used_parallelism,
            "building shared operation pool"
        );
        let (execution, pool) = SharedThreadPool::with_execution_fallback(full)?;
        *guard = Some((pool.clone(), execution.clone()));
        Ok((pool, execution))
    }
}
