//! When replacing an output by rename would lose something that writing it in place
//! keeps. [`crate::StagedOutput`] only stages a replacement when it loses nothing.

use std::{fs::Metadata, path::Path};

/// Why renaming a new file over `target` would lose something that writing `target`
/// in place keeps, or `None` when it loses nothing. `fresh` is a new, empty file in the
/// same directory; it shows the owner, group, and attributes a new file gets there.
/// Only Unix can tell; elsewhere a rename is taken to lose nothing.
pub(crate) fn rename_would_lose(
    target: &Path,
    metadata: &Metadata,
    fresh: &Path,
) -> Option<&'static str> {
    platform::rename_would_lose(target, metadata, fresh)
}

#[cfg(all(unix, not(target_family = "wasm")))]
mod platform {
    use std::{
        ffi::{CStr, CString},
        fs::{self, Metadata},
        io,
        os::unix::{ffi::OsStrExt, fs::MetadataExt},
        path::Path,
    };

    pub(super) fn rename_would_lose(
        target: &Path,
        metadata: &Metadata,
        fresh: &Path,
    ) -> Option<&'static str> {
        if metadata.nlink() > 1 {
            return Some("other hard links would keep the old content");
        }
        let Ok(fresh_metadata) = fs::metadata(fresh) else {
            return Some("a new file in the directory could not be inspected");
        };
        if metadata.uid() != fresh_metadata.uid() || metadata.gid() != fresh_metadata.gid() {
            return Some("a new file would change the owner or group");
        }
        // The replacement gets the old file's permissions on commit, which can change
        // mode-derived ACL entries, so compare against a file that has them too.
        let _ = fs::set_permissions(fresh, metadata.permissions());
        let Some(kept) = extended_attributes(target) else {
            return Some("the file's extended attributes could not be read");
        };
        let fresh_attributes = extended_attributes(fresh).unwrap_or_default();
        if kept.iter().any(|attribute| {
            !follows_content(&attribute.0) && !fresh_attributes.contains(attribute)
        }) {
            return Some("a new file would drop or change extended attributes or ACLs");
        }
        let parent = target
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        if free_bytes(parent).is_some_and(|free| free < metadata.len()) {
            return Some("the volume has no room for both copies");
        }
        None
    }

    fn c_path(path: &Path) -> Option<CString> {
        CString::new(path.as_os_str().as_bytes()).ok()
    }

    /// Integrity hashes of the content, which the new content gets anyway.
    fn follows_content(name: &[u8]) -> bool {
        matches!(name, b"security.ima" | b"security.evm")
    }

    /// The extended attribute names and values on `path` (POSIX ACLs on Linux are among
    /// them), or `None` when they cannot be read. A filesystem without extended
    /// attributes has none.
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    fn extended_attributes(path: &Path) -> Option<Vec<(Vec<u8>, Vec<u8>)>> {
        let path = c_path(path)?;
        let names = match read_sized(|buffer| list_names(&path, buffer)) {
            Ok(names) => names,
            Err(error)
                if error.raw_os_error() == Some(libc::ENOTSUP)
                    || error.raw_os_error() == Some(libc::EOPNOTSUPP) =>
            {
                return Some(Vec::new());
            }
            Err(_) => return None,
        };
        names
            .split(|&byte| byte == 0)
            .filter(|name| !name.is_empty())
            .map(|name| {
                let c_name = CString::new(name).ok()?;
                let value = read_sized(|buffer| read_value(&path, &c_name, buffer)).ok()?;
                Some((name.to_vec(), value))
            })
            .collect()
    }

    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    fn extended_attributes(_path: &Path) -> Option<Vec<(Vec<u8>, Vec<u8>)>> {
        Some(Vec::new())
    }

    /// Calls `call` once with an empty buffer for the size, then with a buffer of that
    /// size, retrying when the data grew in between.
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    fn read_sized(mut call: impl FnMut(&mut [u8]) -> isize) -> io::Result<Vec<u8>> {
        for _ in 0..4 {
            let size = usize::try_from(call(&mut [])).map_err(|_| io::Error::last_os_error())?;
            let mut buffer = vec![0u8; size];
            match usize::try_from(call(&mut buffer)) {
                Ok(len) => {
                    buffer.truncate(len);
                    return Ok(buffer);
                }
                Err(_) => {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(libc::ERANGE) {
                        return Err(error);
                    }
                }
            }
        }
        Err(io::Error::from_raw_os_error(libc::ERANGE))
    }

    // SAFETY, for both helpers below: `path` and `name` are valid C strings and `buffer`
    // is valid for `buffer.len()` bytes; a zero length only asks for the size.
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    fn list_names(path: &CStr, buffer: &mut [u8]) -> isize {
        #[cfg(target_os = "macos")]
        let len =
            unsafe { libc::listxattr(path.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len(), 0) };
        #[cfg(not(target_os = "macos"))]
        let len =
            unsafe { libc::listxattr(path.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len()) };
        len
    }

    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    fn read_value(path: &CStr, name: &CStr, buffer: &mut [u8]) -> isize {
        #[cfg(target_os = "macos")]
        let len = unsafe {
            libc::getxattr(
                path.as_ptr(),
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                0,
                0,
            )
        };
        #[cfg(not(target_os = "macos"))]
        let len = unsafe {
            libc::getxattr(
                path.as_ptr(),
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
            )
        };
        len
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

    pub(super) fn rename_would_lose(
        _target: &Path,
        _metadata: &Metadata,
        _fresh: &Path,
    ) -> Option<&'static str> {
        None
    }
}
