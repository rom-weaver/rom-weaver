//! When replacing an output by rename would lose something that writing it in place
//! keeps. [`crate::StagedOutput`] only stages a replacement when it loses nothing.

use std::{fs::Metadata, path::Path};

/// Why renaming a new file over `target` would lose something that writing `target`
/// in place keeps, or `None` when it loses nothing. Only Unix can tell; elsewhere a
/// rename is taken to lose nothing.
pub(crate) fn rename_would_lose(target: &Path, metadata: &Metadata) -> Option<&'static str> {
    platform::rename_would_lose(target, metadata)
}

#[cfg(all(unix, not(target_family = "wasm")))]
mod platform {
    use std::{
        ffi::CString,
        fs::{self, Metadata},
        os::unix::{ffi::OsStrExt, fs::MetadataExt},
        path::Path,
    };

    pub(super) fn rename_would_lose(target: &Path, metadata: &Metadata) -> Option<&'static str> {
        if metadata.nlink() > 1 {
            return Some("other hard links would keep the old content");
        }
        let parent = target
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        if let (Some((uid, gid)), Ok(parent_metadata)) =
            (crate::effective_ids(), fs::metadata(parent))
        {
            // A new file takes the directory's group on the BSDs (macOS included), and on
            // Linux when the directory is setgid.
            let bsd_groups = cfg!(any(
                target_vendor = "apple",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd",
                target_os = "dragonfly"
            ));
            let new_gid = if bsd_groups || parent_metadata.mode() & 0o2000 != 0 {
                parent_metadata.gid()
            } else {
                gid
            };
            if metadata.uid() != uid || metadata.gid() != new_gid {
                return Some("a new file would change the owner or group");
            }
        }
        if has_extended_attributes(target) {
            return Some("a new file would drop extended attributes or ACLs");
        }
        if free_bytes(parent).is_some_and(|free| free < metadata.len()) {
            return Some("the volume has no room for both copies");
        }
        None
    }

    fn c_path(path: &Path) -> Option<CString> {
        CString::new(path.as_os_str().as_bytes()).ok()
    }

    /// Attribute names that a new file gets anyway, so losing the old values loses nothing
    /// the user set: the SELinux label and macOS download provenance.
    fn is_ambient_attribute(name: &[u8]) -> bool {
        matches!(name, b"security.selinux" | b"com.apple.provenance")
    }

    /// Whether `path` carries extended attributes (POSIX ACLs on Linux are among them).
    /// An unreadable list counts as having some, so the file is written in place.
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    fn has_extended_attributes(path: &Path) -> bool {
        let Some(path) = c_path(path) else {
            return true;
        };
        let list = |buffer: &mut [u8]| {
            // SAFETY: `path` is a valid C string and `buffer` is valid for `buffer.len()`
            // bytes; a zero length only asks for the size of the name list.
            #[cfg(target_os = "macos")]
            let len = unsafe {
                libc::listxattr(path.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len(), 0)
            };
            #[cfg(not(target_os = "macos"))]
            let len =
                unsafe { libc::listxattr(path.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len()) };
            len
        };
        let size = list(&mut []);
        // No attributes, or a filesystem without them.
        if size <= 0 {
            return false;
        }
        let mut names = vec![0u8; size.unsigned_abs()];
        let Ok(len) = usize::try_from(list(&mut names)) else {
            return true;
        };
        names[..len]
            .split(|&byte| byte == 0)
            .any(|name| !name.is_empty() && !is_ambient_attribute(name))
    }

    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    fn has_extended_attributes(_path: &Path) -> bool {
        false
    }

    /// Bytes an unprivileged writer can still use on the volume holding `dir`.
    fn free_bytes(dir: &Path) -> Option<u64> {
        let dir = c_path(dir)?;
        let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: `dir` is a valid C string and `stats` is valid for one `statvfs`.
        if unsafe { libc::statvfs(dir.as_ptr(), stats.as_mut_ptr()) } != 0 {
            return None;
        }
        // SAFETY: a successful `statvfs` filled `stats`.
        let stats = unsafe { stats.assume_init() };
        Some(widen(stats.f_bavail).saturating_mul(widen(stats.f_frsize)))
    }

    /// `statvfs` field widths differ by platform; some are already `u64`.
    fn widen(value: impl Into<u64>) -> u64 {
        value.into()
    }
}

#[cfg(not(all(unix, not(target_family = "wasm"))))]
mod platform {
    use std::{fs::Metadata, path::Path};

    pub(super) fn rename_would_lose(_target: &Path, _metadata: &Metadata) -> Option<&'static str> {
        None
    }
}
