use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};

use crate::{Result, RomWeaverError};

#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    inner: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.inner.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(RomWeaverError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// The process-wide cancellation token. The native CLI's Ctrl-C handler trips
/// this, and every operation context it builds clones it, so one signal reaches
/// work already in flight. The browser has its own per-run token and never
/// touches this one.
pub fn process_cancellation_token() -> CancellationToken {
    static TOKEN: OnceLock<CancellationToken> = OnceLock::new();
    TOKEN.get_or_init(CancellationToken::new).clone()
}

fn in_progress_outputs() -> &'static Mutex<Vec<std::path::PathBuf>> {
    static PATHS: OnceLock<Mutex<Vec<std::path::PathBuf>>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Register a new output for cleanup if the native run is cancelled.
/// Callers MUST register only paths that did not exist before the run; this is
/// a no-op on WASM, where the browser manages output cleanup.
pub fn register_in_progress_output(path: &std::path::Path) {
    if cfg!(target_arch = "wasm32") {
        return;
    }
    if let Ok(mut paths) = in_progress_outputs().lock() {
        paths.push(path.to_path_buf());
    }
}

/// Drop one path from the registry once its output is fully written, so a
/// later Ctrl-C in the same run cannot delete a finished file.
pub fn complete_in_progress_output(path: &std::path::Path) {
    if let Ok(mut paths) = in_progress_outputs().lock() {
        paths.retain(|registered| registered != path);
    }
}

/// Delete every registered output that made it to disk. Called when a run ends
/// cancelled, so Ctrl-C does not leave a half-written file behind.
pub fn remove_in_progress_outputs() {
    let Ok(mut paths) = in_progress_outputs().lock() else {
        return;
    };
    for path in paths.drain(..) {
        let _ = std::fs::remove_file(&path);
    }
}

/// Forget the registered outputs; the run finished and they are real files now.
pub fn clear_in_progress_outputs() {
    if let Ok(mut paths) = in_progress_outputs().lock() {
        paths.clear();
    }
}

#[cfg(test)]
#[path = "../tests/unit/cancel.rs"]
mod tests;
