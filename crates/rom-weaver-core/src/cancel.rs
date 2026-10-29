use std::{
    sync::{
        Arc, Mutex, OnceLock, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
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

    /// `result`, or `Cancelled` when it failed after this token tripped. A check inside a
    /// callback whose error the caller rewraps (as text or a library error) comes back as
    /// some other error; this reports it as the cancellation it was.
    pub fn or_cancelled<T>(&self, result: Result<T>) -> Result<T> {
        match result {
            Err(_) if self.is_cancelled() => Err(RomWeaverError::Cancelled),
            result => result,
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

/// Register a new output file or directory for cleanup if the native run is cancelled.
/// Callers MUST register only paths that did not exist before the run, and a directory
/// before the outputs inside it; this is a no-op on WASM, where the browser manages
/// output cleanup.
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

/// Delete every registered output that made it to disk, newest first. Called when a
/// run ends cancelled, so Ctrl-C does not leave a half-written file behind. A directory
/// goes only once it is empty, so anything else in it stays.
pub fn remove_in_progress_outputs() {
    let Ok(mut paths) = in_progress_outputs().lock() else {
        return;
    };
    for path in paths.drain(..).rev() {
        let is_dir = std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir());
        let _ = if is_dir {
            std::fs::remove_dir(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
}

/// Longest a forced exit waits for in-flight output creation before cleaning up anyway.
const FORCED_CLEANUP_LOCK_WAIT: Duration = Duration::from_secs(1);

#[derive(Default)]
struct LiveTempDirs {
    creation: RwLock<()>,
    closed: AtomicBool,
    paths: Mutex<Vec<std::path::PathBuf>>,
}

impl LiveTempDirs {
    fn with_creation<T>(
        &self,
        cancel: &CancellationToken,
        create: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let _creation = self
            .creation
            .read()
            .unwrap_or_else(|error| error.into_inner());
        cancel.check()?;
        if self.closed.load(Ordering::SeqCst) {
            return Err(RomWeaverError::Cancelled);
        }
        create()
    }

    fn register(&self, path: &std::path::Path) {
        let mut paths = self.paths.lock().unwrap_or_else(|error| error.into_inner());
        if self.closed.load(Ordering::SeqCst) {
            remove_temp_path(path);
        } else {
            paths.push(path.to_path_buf());
        }
    }

    fn unregister(&self, path: &std::path::Path) {
        self.paths
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|registered| registered != path);
    }

    fn write_bounded(&self, wait: Duration) -> Option<std::sync::RwLockWriteGuard<'_, ()>> {
        let deadline = Instant::now() + wait;
        loop {
            match self.creation.try_write() {
                Ok(guard) => return Some(guard),
                Err(std::sync::TryLockError::Poisoned(error)) => return Some(error.into_inner()),
                Err(std::sync::TryLockError::WouldBlock) => {}
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn remove(&self) {
        // Bounded wait: a creator blocked in the kernel (e.g. opening a FIFO with no reader) holds the read lock
        // indefinitely, and a forced exit must still make progress. On timeout, close and clean up best effort.
        let _creation = self.write_bounded(FORCED_CLEANUP_LOCK_WAIT);
        self.closed.store(true, Ordering::SeqCst);
        let mut paths = self.paths.lock().unwrap_or_else(|error| error.into_inner());
        tracing::debug!(
            paths = paths.len(),
            "removing live temporary outputs after closing creation"
        );
        for path in paths.drain(..).rev() {
            remove_temp_path(&path);
        }
    }
}

fn remove_temp_path(path: &std::path::Path) {
    let is_dir = std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir());
    let result = if is_dir {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    tracing::debug!(path = %path.display(), ?result, "live temporary output cleanup result");
}

fn live_temp_dirs() -> &'static LiveTempDirs {
    static PATHS: OnceLock<LiveTempDirs> = OnceLock::new();
    PATHS.get_or_init(LiveTempDirs::default)
}

/// Protect native output entry creation from forced cleanup. The callback MUST cover
/// directory/file creation and any registration; long decoding work belongs outside it.
pub fn with_output_creation<T>(
    cancel: &CancellationToken,
    create: impl FnOnce() -> Result<T>,
) -> Result<T> {
    if cfg!(target_arch = "wasm32") {
        cancel.check()?;
        return create();
    }
    live_temp_dirs().with_creation(cancel, create)
}

/// Track a temp directory or file owned by a live guard (`TempPathAllocator`, staging dir, stdin spool), so a process that must leave
/// without running destructors (a forced second Ctrl-C) can still remove it. Native only.
pub fn register_live_temp_dir(path: &std::path::Path) {
    if cfg!(target_arch = "wasm32") {
        return;
    }
    live_temp_dirs().register(path);
}

/// Stop tracking a temp directory or file once its owner has removed it itself. Call this after the removal, not before, so a
/// forced exit during a slow removal still finds the path in `remove_live_temp_dirs`.
pub fn unregister_live_temp_dir(path: &std::path::Path) {
    live_temp_dirs().unregister(path);
}

/// Remove every tracked temp path. Called right before the process exits without
/// unwinding, since `Drop` will not run then. This permanently closes native
/// output creation, so callers MUST sweep partial outputs after this call.
pub fn remove_live_temp_dirs() {
    live_temp_dirs().remove();
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
