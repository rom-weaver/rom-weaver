//! Human-facing explanations for filesystem access denials.
//!
//! A bare `Permission denied (os error 13)` never says whose permissions were
//! wrong. These helpers turn one into the three facts that actually resolve it:
//! the mode and owner of the path (or of the nearest existing ancestor, when the
//! path itself could not be created), the identity the process is running under,
//! and - inside a container - the flag that fixes the mismatch.

use std::path::Path;

/// A one-line explanation of why `path` may be inaccessible, or `None` when the
/// platform exposes nothing useful. Rendered inside parentheses after the io
/// error, so it must stay short and factual.
pub fn access_advice(path: &Path) -> Option<String> {
    platform::access_advice(path)
}

/// The effective user and group id this process runs under, where the platform
/// has such a concept. `None` on wasm and Windows.
pub fn effective_ids() -> Option<(u32, u32)> {
    platform::effective_ids()
}

/// Whether this process appears to be running inside a container. Docker,
/// Podman, and the OCI runtimes all leave one of these markers behind; the
/// answer only ever adds a hint, so a false negative is harmless.
pub fn in_container() -> bool {
    platform::in_container()
}

#[cfg(all(unix, not(target_family = "wasm")))]
mod platform {
    use std::{
        fs,
        os::unix::fs::MetadataExt,
        path::{Path, PathBuf},
    };

    use tracing::trace;

    pub(super) fn effective_ids() -> Option<(u32, u32)> {
        // SAFETY: `geteuid`/`getegid` take no arguments, cannot fail, and only
        // read the calling process's own credentials.
        Some(unsafe { (libc::geteuid(), libc::getegid()) })
    }

    pub(super) fn access_advice(path: &Path) -> Option<String> {
        let (uid, gid) = effective_ids()?;
        let mut parts = Vec::new();
        if let Some((owned, metadata)) = nearest_existing(path)
            .and_then(|owned| fs::metadata(&owned).ok().map(|metadata| (owned, metadata)))
        {
            let mode = metadata.mode() & 0o7777;
            let owner = format!(
                "`{}` is mode {mode:04o} owned by {}:{}",
                owned.display(),
                metadata.uid(),
                metadata.gid()
            );
            parts.push(owner);
        }
        parts.push(format!("this process runs as {uid}:{gid}"));
        if super::in_container() {
            parts.push(
                "in a container: re-run with `--user \"$(id -u):$(id -g)\"` so the mounted files match"
                    .to_string(),
            );
        }
        let advice = parts.join("; ");
        trace!(path = %path.display(), advice, "built access advice");
        Some(advice)
    }

    /// The path itself when it exists, otherwise the closest ancestor that does.
    /// A denial on a path that does not exist is a denial on its parent
    /// directory, and naming that directory is what tells the user where to look.
    fn nearest_existing(path: &Path) -> Option<PathBuf> {
        let mut candidate = Some(path);
        while let Some(current) = candidate {
            if current.exists() {
                return Some(current.to_path_buf());
            }
            candidate = current.parent();
        }
        None
    }

    pub(super) fn in_container() -> bool {
        Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists()
    }
}

#[cfg(not(all(unix, not(target_family = "wasm"))))]
mod platform {
    use std::path::Path;

    pub(super) fn access_advice(_path: &Path) -> Option<String> {
        None
    }

    pub(super) fn effective_ids() -> Option<(u32, u32)> {
        None
    }

    pub(super) fn in_container() -> bool {
        false
    }
}

#[cfg(test)]
#[path = "../tests/unit/access.rs"]
mod tests;
