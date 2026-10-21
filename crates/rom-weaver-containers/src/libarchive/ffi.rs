use super::*;

// The project adapter is appended to archive_string.c to keep conversion state per archive.
unsafe extern "C" {
    fn rom_weaver_archive_set_utf8(archive: *mut archive) -> i32;
}

pub(crate) fn configure_utf8(archive_ptr: *mut archive, context: &str) -> Result<()> {
    let status = unsafe { rom_weaver_archive_set_utf8(archive_ptr) };
    check_status_for_ptr(status, archive_ptr, context)?;
    tracing::trace!("configured libarchive UTF-8 pathname conversion");
    Ok(())
}

pub(crate) fn check_status_for_ptr(
    status: i32,
    archive_ptr: *mut archive,
    context: &str,
) -> Result<()> {
    match status {
        ARCHIVE_OK | ARCHIVE_WARN => Ok(()),
        _ => Err(error_from_archive(archive_ptr, context)),
    }
}

pub(crate) fn check_free_status(status: i32, context: &str) -> Result<()> {
    match status {
        ARCHIVE_OK | ARCHIVE_WARN => Ok(()),
        _ => Err(RomWeaverError::Validation(format!(
            "{context}: libarchive free returned status {status}"
        ))),
    }
}

pub(crate) fn error_from_archive(archive_ptr: *mut archive, context: &str) -> RomWeaverError {
    unsafe {
        let error_ptr = archive_error_string(archive_ptr);
        if !error_ptr.is_null() {
            let message = CStr::from_ptr(error_ptr).to_string_lossy().into_owned();
            if !message.trim().is_empty() {
                return RomWeaverError::Validation(format!("{context}: {message}"));
            }
        }

        let error_number = archive_errno(archive_ptr);
        let message = if error_number != 0 {
            io::Error::from_raw_os_error(error_number).to_string()
        } else {
            "unknown libarchive failure".to_string()
        };
        RomWeaverError::Validation(format!("{context}: {message}"))
    }
}
pub(crate) fn path_to_cstring(path: &Path, label: &str) -> Result<CString> {
    CString::new(path_bytes(path).as_ref()).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{label} path contains an interior NUL byte: `{}`",
            path.display()
        ))
    })
}

#[cfg(any(unix, target_os = "wasi"))]
fn path_bytes(path: &Path) -> Cow<'_, [u8]> {
    #[cfg(unix)]
    use std::os::unix::ffi::OsStrExt;

    #[cfg(all(not(unix), target_os = "wasi"))]
    use std::os::wasi::ffi::OsStrExt;

    Cow::Borrowed(path.as_os_str().as_bytes())
}

#[cfg(not(any(unix, target_os = "wasi")))]
fn path_bytes(path: &Path) -> Cow<'_, [u8]> {
    Cow::Owned(path.to_string_lossy().as_bytes().to_vec())
}
