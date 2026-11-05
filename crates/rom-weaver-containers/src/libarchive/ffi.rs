use super::*;
use rom_weaver_core::{ERROR_CODE_ARCHIVE_READ_FAILED, ERROR_CODE_ARCHIVE_STORAGE_FAILED};

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
    archive_error(archive_ptr, context, None)
}

/// [`error_from_archive`] for the read side: a failure that is not a storage
/// problem is coded as an archive read failure (damaged or unreadable data).
pub(crate) fn read_error_from_archive(archive_ptr: *mut archive, context: &str) -> RomWeaverError {
    archive_error(archive_ptr, context, Some(ERROR_CODE_ARCHIVE_READ_FAILED))
}

fn archive_error(
    archive_ptr: *mut archive,
    context: &str,
    fallback_code: Option<&'static str>,
) -> RomWeaverError {
    let message = archive_error_message(archive_ptr);
    // libarchive's file reader and writer name the file in these failures: the
    // file itself could not be opened or read, a storage problem rather than
    // archive damage.
    let code = if message.starts_with("Failed to open '") || message.starts_with("Error reading '")
    {
        Some(ERROR_CODE_ARCHIVE_STORAGE_FAILED)
    } else {
        fallback_code
    };
    let message = format!("{context}: {message}");
    match code {
        Some(code) => RomWeaverError::coded(code, message),
        None => RomWeaverError::Validation(message),
    }
}

fn archive_error_message(archive_ptr: *mut archive) -> String {
    unsafe {
        let error_ptr = archive_error_string(archive_ptr);
        if !error_ptr.is_null() {
            let message = CStr::from_ptr(error_ptr).to_string_lossy().into_owned();
            if !message.trim().is_empty() {
                return message;
            }
        }

        let error_number = archive_errno(archive_ptr);
        if error_number != 0 {
            io::Error::from_raw_os_error(error_number).to_string()
        } else {
            "unknown libarchive failure".to_string()
        }
    }
}
#[cfg(any(not(windows), test))]
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

#[cfg(all(not(any(unix, target_os = "wasi")), any(not(windows), test)))]
fn path_bytes(path: &Path) -> Cow<'_, [u8]> {
    Cow::Owned(path.to_string_lossy().as_bytes().to_vec())
}

#[cfg(windows)]
pub(crate) fn path_to_wide(path: &Path, label: &str) -> Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;

    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.contains(&0) {
        return Err(RomWeaverError::Validation(format!(
            "{label} path contains an interior NUL: `{}`",
            path.display()
        )));
    }
    wide.push(0);
    Ok(wide)
}
