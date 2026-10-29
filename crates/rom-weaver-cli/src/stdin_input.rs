//! Accept `-` as the `--input` value for `checksum`, `probe`, or `identify`, reading the ROM
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
pub(crate) use native::{copy_stdin, spool_stdin_if_dash};

#[cfg(target_arch = "wasm32")]
pub(crate) use wasm::spool_stdin_if_dash;

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::STDIN_INPUT_SENTINEL;
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Read, Write};
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
            // Unregister only after removal so a forced exit mid-remove still finds the path.
            if let Err(error) = fs::remove_file(&self.path) {
                trace!(path = %self.path.display(), %error, "failed to remove stdin spool temp file");
            }
            rom_weaver_core::unregister_live_temp_dir(&self.path);
        }
    }

    /// When `input` is the `-` sentinel, drain stdin into a fresh temp file,
    /// rewrite `input` to point at it, and return the cleanup guard. Otherwise
    /// leave `input` untouched and return `None`.
    pub(crate) fn spool_stdin_if_dash(input: &mut PathBuf) -> crate::Result<Option<StdinSpool>> {
        if input.as_os_str() != STDIN_INPUT_SENTINEL {
            return Ok(None);
        }
        let (path, file) = create_temp_file()?;
        trace!(path = %path.display(), "spooling stdin to temp file");
        spool_reader_to_file(input, &mut stdin_reader(), path, file)
    }

    pub(super) fn spool_reader_to_file<R: Read>(
        input: &mut PathBuf,
        reader: &mut R,
        path: PathBuf,
        mut file: File,
    ) -> crate::Result<Option<StdinSpool>> {
        let spool = StdinSpool { path: path.clone() };
        let copied = (|| -> crate::Result<u64> {
            let bytes = rom_weaver_core::copy_cancelable(
                reader,
                &mut file,
                &rom_weaver_core::process_cancellation_token(),
            )?;
            file.flush()?;
            Ok(bytes)
        })();
        drop(file);
        let bytes = copied?;
        trace!(path = %path.display(), bytes, "spooled stdin to temp file");
        *input = path;
        Ok(Some(spool))
    }

    pub(crate) fn copy_stdin(output: &mut impl Write) -> crate::Result<u64> {
        rom_weaver_core::copy_cancelable(
            &mut stdin_reader(),
            output,
            &rom_weaver_core::process_cancellation_token(),
        )
    }

    #[cfg(not(unix))]
    fn stdin_reader() -> impl Read {
        io::stdin().lock()
    }

    #[cfg(unix)]
    fn stdin_reader() -> impl Read {
        PollStdin
    }

    #[cfg(unix)]
    struct PollStdin;

    #[cfg(unix)]
    impl Read for PollStdin {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if buffer.is_empty() {
                return Ok(0);
            }
            let mut descriptor = libc::pollfd {
                fd: libc::STDIN_FILENO,
                events: libc::POLLIN,
                revents: 0,
            };
            // A bounded wait MUST let the copier recheck cancellation, even with SA_RESTART.
            // SAFETY: descriptor points to one initialized pollfd for the duration of poll.
            let ready = unsafe { libc::poll(&mut descriptor, 1, 100) };
            if ready < 0 {
                return Err(io::Error::last_os_error());
            }
            if ready == 0 {
                return Err(io::ErrorKind::Interrupted.into());
            }
            // Stdin has one reader during spooling; readiness cannot be consumed elsewhere.
            // SAFETY: buffer is writable for its length and stdin is a borrowed descriptor.
            let count =
                unsafe { libc::read(libc::STDIN_FILENO, buffer.as_mut_ptr().cast(), buffer.len()) };
            if count < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(count as usize)
        }
    }

    /// Reserve a unique, freshly-created temp path (no `tempfile` dependency).
    /// Uniqueness comes from the pid plus a process-monotonic counter;
    /// `create_new` guards against colliding with a stale file from a prior run.
    pub(super) fn create_temp_file() -> crate::Result<(PathBuf, File)> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir();
        let pid = std::process::id();
        loop {
            let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
            let candidate = dir.join(format!("rom-weaver-stdin-{pid}-{seq}.tmp"));
            let created = rom_weaver_core::with_output_creation(
                &rom_weaver_core::process_cancellation_token(),
                || {
                    let created = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&candidate);
                    if created.is_ok() {
                        // Drop is skipped by the forced second-interrupt exit; register for removal there.
                        rom_weaver_core::register_live_temp_dir(&candidate);
                    }
                    Ok(created)
                },
            )?;
            match created {
                Ok(file) => return Ok((candidate, file)),
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

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "../tests/unit/stdin_input.rs"]
mod tests;
