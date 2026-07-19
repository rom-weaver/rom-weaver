//! Accept `-` as the `--input` value for `checksum`/`probe`, reading the ROM
//! bytes from stdin. Stdin is spooled to a temp file so the existing
//! path-based, seek-driven command code (range resolution, container probing,
//! ROM identity) runs unchanged. Native-only: the wasm entry point receives a
//! typed JSON request over stdin and supplies real OPFS paths, so `-` never
//! reaches it.

/// Sentinel `--input` value meaning "read from stdin".
///
/// Gated like its only consumer below: on wasm the entry point never sees `-`,
/// so an ungated constant is dead code there.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) const STDIN_INPUT_SENTINEL: &str = "-";

#[cfg(not(target_arch = "wasm32"))]
pub(crate) use native::spool_stdin_if_dash;

#[cfg(target_arch = "wasm32")]
pub(crate) use wasm::spool_stdin_if_dash;

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::STDIN_INPUT_SENTINEL;
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use tracing::trace;

    /// Owns the temp file that stdin was spooled into and removes it on drop.
    /// Callers hold the guard for the lifetime of the command so the file
    /// outlives every read of it.
    pub(crate) struct StdinSpool {
        path: PathBuf,
    }

    impl Drop for StdinSpool {
        fn drop(&mut self) {
            if let Err(error) = fs::remove_file(&self.path) {
                trace!(path = %self.path.display(), %error, "failed to remove stdin spool temp file");
            }
        }
    }

    /// When `input` is the `-` sentinel, drain stdin into a fresh temp file,
    /// rewrite `input` to point at it, and return the cleanup guard. Otherwise
    /// leave `input` untouched and return `None`.
    pub(crate) fn spool_stdin_if_dash(input: &mut PathBuf) -> crate::Result<Option<StdinSpool>> {
        if input.as_os_str() != STDIN_INPUT_SENTINEL {
            return Ok(None);
        }
        let path = create_temp_file()?;
        trace!(path = %path.display(), "spooling stdin to temp file");
        let mut file = File::create(&path)?;
        let bytes = io::copy(&mut io::stdin().lock(), &mut file)?;
        file.flush()?;
        drop(file);
        trace!(path = %path.display(), bytes, "spooled stdin to temp file");
        *input = path.clone();
        Ok(Some(StdinSpool { path }))
    }

    /// Reserve a unique, freshly-created temp path (no `tempfile` dependency).
    /// Uniqueness comes from the pid plus a process-monotonic counter;
    /// `create_new` guards against colliding with a stale file from a prior run.
    fn create_temp_file() -> crate::Result<PathBuf> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir();
        let pid = std::process::id();
        loop {
            let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
            let candidate = dir.join(format!("rom-weaver-stdin-{pid}-{seq}.tmp"));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(_) => return Ok(candidate),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::path::PathBuf;

    /// Stdin spooling is native-only; the wasm entry supplies real OPFS paths.
    pub(crate) fn spool_stdin_if_dash(_input: &mut PathBuf) -> crate::Result<Option<()>> {
        Ok(None)
    }
}
