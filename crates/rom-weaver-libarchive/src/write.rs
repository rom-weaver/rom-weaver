use super::*;
use tracing::trace;

#[derive(Clone, Copy, Debug)]
pub enum WriteFormat {
    Zip,
    SevenZ,
    #[cfg(feature = "write-extra")]
    TarPax,
    #[cfg(feature = "write-extra")]
    Raw,
}
#[derive(Clone, Copy, Debug)]
pub enum WriteFilter {
    None,
    #[cfg(feature = "write-extra")]
    Gzip,
    #[cfg(feature = "write-extra")]
    Bzip2,
    #[cfg(feature = "write-extra")]
    Xz,
    #[cfg(feature = "write-extra")]
    Zstd,
}

impl WriteFilter {
    pub const fn module_name(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            #[cfg(feature = "write-extra")]
            Self::Gzip => Some("gzip"),
            #[cfg(feature = "write-extra")]
            Self::Bzip2 => Some("bzip2"),
            #[cfg(feature = "write-extra")]
            Self::Xz => Some("xz"),
            #[cfg(feature = "write-extra")]
            Self::Zstd => Some("zstd"),
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub enum EntryFileType {
    Regular,
    Directory,
}

impl EntryFileType {
    const fn libarchive_mode(self) -> u32 {
        match self {
            Self::Regular => 0o100000,
            Self::Directory => 0o040000,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct EntrySpec<'a> {
    pub pathname: &'a str,
    pub file_type: EntryFileType,
    pub perm: u32,
    pub size: u64,
}

#[derive(Clone, Copy, Debug)]
pub enum ZeroWriteBehavior {
    Error,
}
pub struct WriteArchive {
    ptr: Option<NonNull<archive>>,
    codec_progress_callback_data: Option<Box<CodecProgressCallbackData>>,
    write_callback_data: Option<Box<WriteCallbackData>>,
}

struct CodecProgressCallbackData {
    on_bytes_processed: Box<dyn FnMut(u64)>,
}

struct WriteCallbackData {
    file: File,
    on_bytes_written: Box<dyn FnMut(u64)>,
}

impl WriteArchive {
    pub fn new(context: &str) -> Result<Self> {
        let ptr = unsafe { archive_write_new() };
        let ptr = NonNull::new(ptr).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "{context}: libarchive writer allocation returned null"
            ))
        })?;
        Ok(Self {
            ptr: Some(ptr),
            codec_progress_callback_data: None,
            write_callback_data: None,
        })
    }

    pub fn set_format(&mut self, format: WriteFormat, context: &str) -> Result<()> {
        let status = unsafe {
            match format {
                WriteFormat::Zip => archive_write_set_format_zip(self.as_ptr()),
                WriteFormat::SevenZ => archive_write_set_format_7zip(self.as_ptr()),
                #[cfg(feature = "write-extra")]
                WriteFormat::TarPax => archive_write_set_format_pax_restricted(self.as_ptr()),
                #[cfg(feature = "write-extra")]
                WriteFormat::Raw => archive_write_set_format_raw(self.as_ptr()),
            }
        };
        self.check_status(status, context)
    }

    pub fn add_filter(&mut self, filter: WriteFilter, context: &str) -> Result<()> {
        let status = unsafe {
            match filter {
                WriteFilter::None => archive_write_add_filter_none(self.as_ptr()),
                #[cfg(feature = "write-extra")]
                WriteFilter::Gzip => archive_write_add_filter_gzip(self.as_ptr()),
                #[cfg(feature = "write-extra")]
                WriteFilter::Bzip2 => archive_write_add_filter_bzip2(self.as_ptr()),
                #[cfg(feature = "write-extra")]
                WriteFilter::Xz => archive_write_add_filter_xz(self.as_ptr()),
                #[cfg(feature = "write-extra")]
                WriteFilter::Zstd => archive_write_add_filter_zstd(self.as_ptr()),
            }
        };
        self.check_status(status, context)
    }

    pub fn set_format_option(
        &mut self,
        module: Option<&str>,
        option: &str,
        value: &str,
        context: &str,
    ) -> Result<()> {
        let module = optional_cstring(module, "format option module", context)?;
        let option = cstring(option, "format option key", context)?;
        let value = cstring(value, "format option value", context)?;
        let status = unsafe {
            archive_write_set_format_option(
                self.as_ptr(),
                module.as_ref().map_or(ptr::null(), |value| value.as_ptr()),
                option.as_ptr(),
                value.as_ptr(),
            )
        };
        self.check_status(status, context)
    }

    pub fn try_set_format_option(
        &mut self,
        module: Option<&str>,
        option: &str,
        value: &str,
        context: &str,
    ) -> Result<()> {
        let module = optional_cstring(module, "format option module", context)?;
        let option = cstring(option, "format option key", context)?;
        let value = cstring(value, "format option value", context)?;
        let status = unsafe {
            archive_write_set_format_option(
                self.as_ptr(),
                module.as_ref().map_or(ptr::null(), |value| value.as_ptr()),
                option.as_ptr(),
                value.as_ptr(),
            )
        };
        self.check_optional_status(status, context)
    }

    pub fn set_filter_option(
        &mut self,
        module: &str,
        option: &str,
        value: &str,
        context: &str,
    ) -> Result<()> {
        let module = cstring(module, "filter module", context)?;
        let option = cstring(option, "filter option key", context)?;
        let value = cstring(value, "filter option value", context)?;
        let status = unsafe {
            archive_write_set_filter_option(
                self.as_ptr(),
                module.as_ptr(),
                option.as_ptr(),
                value.as_ptr(),
            )
        };
        self.check_status(status, context)
    }

    pub fn try_set_filter_option(
        &mut self,
        module: &str,
        option: &str,
        value: &str,
        context: &str,
    ) -> Result<()> {
        let module = cstring(module, "filter module", context)?;
        let option = cstring(option, "filter option key", context)?;
        let value = cstring(value, "filter option value", context)?;
        let status = unsafe {
            archive_write_set_filter_option(
                self.as_ptr(),
                module.as_ptr(),
                option.as_ptr(),
                value.as_ptr(),
            )
        };
        self.check_optional_status(status, context)
    }

    pub fn open_filename(&mut self, output: &Path, label: &str, context: &str) -> Result<()> {
        let output = path_to_cstring(output, label)?;
        let status = unsafe { archive_write_open_filename(self.as_ptr(), output.as_ptr()) };
        self.check_status(status, context)
    }

    pub fn set_7zip_progress_callback<F>(
        &mut self,
        on_bytes_processed: F,
        context: &str,
    ) -> Result<()>
    where
        F: FnMut(u64) + 'static,
    {
        if self.codec_progress_callback_data.is_some() {
            return Err(RomWeaverError::Validation(format!(
                "{context}: libarchive 7z progress callback is already set"
            )));
        }
        let mut callback_data = Box::new(CodecProgressCallbackData {
            on_bytes_processed: Box::new(on_bytes_processed),
        });
        let status = unsafe {
            archive_write_set_format_7zip_progress_callback(
                self.as_ptr(),
                Some(codec_progress_callback),
                (&mut *callback_data as *mut CodecProgressCallbackData).cast::<c_void>(),
            )
        };
        self.check_status(status, context)?;
        self.codec_progress_callback_data = Some(callback_data);
        Ok(())
    }

    /// Hint the total uncompressed bytes that will be written so the 7z LZMA2
    /// dictionary can be reduced to fit the data instead of allocating a window
    /// larger than the input can reference.
    /// Must be called after the 7z format is selected and before writing data.
    pub fn set_7zip_size_hint(&mut self, uncompressed_bytes: u64, context: &str) -> Result<()> {
        let status =
            unsafe { archive_write_set_format_7zip_size_hint(self.as_ptr(), uncompressed_bytes) };
        self.check_status(status, context)
    }

    pub fn open_file_with_write_callback<F>(
        &mut self,
        output: &Path,
        on_bytes_written: F,
        context: &str,
    ) -> Result<()>
    where
        F: FnMut(u64) + 'static,
    {
        if self.write_callback_data.is_some() {
            return Err(RomWeaverError::Validation(format!(
                "{context}: libarchive writer is already open"
            )));
        }
        let file = File::create(output)?;
        let mut callback_data = Box::new(WriteCallbackData {
            file,
            on_bytes_written: Box::new(on_bytes_written),
        });
        let status = unsafe {
            archive_write_open(
                self.as_ptr(),
                (&mut *callback_data as *mut WriteCallbackData).cast::<c_void>(),
                None,
                Some(write_file_callback),
                None,
            )
        };
        self.check_status(status, context)?;
        self.write_callback_data = Some(callback_data);
        Ok(())
    }

    pub fn start_entry(&mut self, spec: EntrySpec<'_>, context: &str) -> Result<()> {
        let entry = ArchiveEntry::new(context)?;
        let pathname = cstring(spec.pathname, "archive entry name", context)?;
        let size = i64::try_from(spec.size).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{context}: input length exceeded libarchive entry size range"
            ))
        })?;

        unsafe {
            archive_entry_set_pathname(entry.as_ptr(), pathname.as_ptr());
            archive_entry_set_filetype(entry.as_ptr(), spec.file_type.libarchive_mode() as _);
            archive_entry_set_perm(entry.as_ptr(), spec.perm as _);
            archive_entry_set_size(entry.as_ptr(), size);
        }

        let status = unsafe { archive_write_header(self.as_ptr(), entry.as_ptr()) };
        self.check_status(status, context)
    }

    pub fn write_data_all(
        &mut self,
        payload: &[u8],
        context: &str,
        // Retained for API/test compatibility; a zero-length write is always an error now.
        _zero_write_behavior: ZeroWriteBehavior,
    ) -> Result<()> {
        let mut offset = 0usize;
        while offset < payload.len() {
            let written = unsafe {
                archive_write_data(
                    self.as_ptr(),
                    payload[offset..].as_ptr().cast(),
                    payload.len() - offset,
                )
            };
            if written < 0 {
                return Err(error_from_archive(self.as_ptr(), context));
            }
            if written == 0 {
                // A zero-length write means libarchive accepted none of the payload; treating
                // it as success would silently truncate the entry (a parity violation), so it is
                // always surfaced as an error.
                return Err(RomWeaverError::Validation(format!(
                    "{context}: libarchive reported a zero-length write"
                )));
            }
            let written = usize::try_from(written).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "{context}: libarchive reported an invalid write length"
                ))
            })?;
            if written > payload.len() - offset {
                return Err(RomWeaverError::Validation(format!(
                    "{context}: libarchive wrote more bytes than provided"
                )));
            }
            offset = offset.saturating_add(written);
        }
        Ok(())
    }

    pub fn finish_entry(&mut self, context: &str) -> Result<()> {
        let status = unsafe { archive_write_finish_entry(self.as_ptr()) };
        self.check_status(status, context)
    }

    pub fn close(mut self, close_context: &str, free_context: &str) -> Result<()> {
        let Some(ptr) = self.ptr.take() else {
            return Ok(());
        };
        let close_result = check_status_for_ptr(
            unsafe { archive_write_close(ptr.as_ptr()) },
            ptr.as_ptr(),
            close_context,
        );
        let free_status = unsafe { archive_write_free(ptr.as_ptr()) };
        close_result.and(check_free_status(free_status, free_context))
    }

    fn check_status(&self, status: i32, context: &str) -> Result<()> {
        check_status_for_ptr(status, self.as_ptr(), context)
    }

    fn check_optional_status(&self, status: i32, context: &str) -> Result<()> {
        match status {
            ARCHIVE_OK | ARCHIVE_WARN => Ok(()),
            _ if unsupported_option_error(self.as_ptr()) => Ok(()),
            _ => Err(error_from_archive(self.as_ptr(), context)),
        }
    }

    fn as_ptr(&self) -> *mut archive {
        self.ptr
            .expect("libarchive write handle used after close")
            .as_ptr()
    }
}

unsafe extern "C" fn codec_progress_callback(client_data: *mut c_void, processed_bytes: u64) {
    if client_data.is_null() {
        return;
    }
    let callback_data = unsafe { &mut *client_data.cast::<CodecProgressCallbackData>() };
    let on_bytes_processed = &mut callback_data.on_bytes_processed;
    // This callback has no return channel (libarchive ignores its result), so a user-supplied
    // progress closure that panics can only be contained here. Catching it keeps the panic from
    // unwinding across the extern "C" boundary and aborting the process; progress is best-effort,
    // so the dropped update is logged rather than failing the compression.
    let notified = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        on_bytes_processed(processed_bytes);
    }));
    if notified.is_err() {
        trace!("libarchive 7z progress callback panicked; dropping progress update");
    }
}

unsafe extern "C" fn write_file_callback(
    archive_ptr: *mut archive,
    client_data: *mut c_void,
    buffer: *const c_void,
    length: usize,
) -> sys::la_ssize_t {
    if client_data.is_null() || (buffer.is_null() && length > 0) {
        return -1;
    }
    let callback_data = unsafe { &mut *client_data.cast::<WriteCallbackData>() };
    let payload = if length == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(buffer.cast::<u8>(), length) }
    };
    if let Err(error) = callback_data.file.write_all(payload) {
        // Record the concrete OS error (disk-full / EACCES / OPFS quota) on the handle so the
        // writer's next status check surfaces it instead of an opaque "unknown libarchive failure".
        set_archive_io_error(archive_ptr, &error);
        return -1;
    }
    let on_bytes_written = &mut callback_data.on_bytes_written;
    // A panic in the user-supplied write closure must not unwind across this extern "C" boundary
    // (that aborts the process via the cannot-unwind guard); record it on the handle and fail the
    // write so it surfaces as a RomWeaverError.
    let notified = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        on_bytes_written(length as u64);
    }));
    if notified.is_err() {
        trace!("libarchive write progress callback panicked; failing write");
        set_archive_error(
            archive_ptr,
            0,
            "libarchive write progress callback panicked",
        );
        return -1;
    }
    length as sys::la_ssize_t
}

/// Record an I/O failure on the libarchive handle so the next status check produces a specific
/// `RomWeaverError` (errno + message) instead of an opaque "unknown libarchive failure". Used by
/// the write callback, which can only signal failure by returning a negative length.
fn set_archive_io_error(archive_ptr: *mut archive, error: &io::Error) {
    set_archive_error(
        archive_ptr,
        error.raw_os_error().unwrap_or(0),
        &error.to_string(),
    );
}

fn set_archive_error(archive_ptr: *mut archive, errno: i32, message: &str) {
    let Ok(message) = CString::new(message) else {
        return;
    };
    // Pass the message as a `%s` argument rather than as the format string itself so a `%` in an
    // OS error string is never interpreted as a printf directive.
    unsafe {
        sys::archive_set_error(archive_ptr, errno, c"%s".as_ptr(), message.as_ptr());
    }
}

impl Drop for WriteArchive {
    fn drop(&mut self) {
        if let Some(ptr) = self.ptr.take() {
            let _ = unsafe { archive_write_free(ptr.as_ptr()) };
        }
    }
}
struct ArchiveEntry {
    ptr: NonNull<sys::archive_entry>,
}

impl ArchiveEntry {
    fn new(context: &str) -> Result<Self> {
        let ptr = unsafe { archive_entry_new() };
        let ptr = NonNull::new(ptr).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "{context}: libarchive entry allocation returned null"
            ))
        })?;
        Ok(Self { ptr })
    }

    fn as_ptr(&self) -> *mut sys::archive_entry {
        self.ptr.as_ptr()
    }
}

impl Drop for ArchiveEntry {
    fn drop(&mut self) {
        unsafe { archive_entry_free(self.ptr.as_ptr()) };
    }
}
fn unsupported_option_error(archive_ptr: *mut archive) -> bool {
    unsafe {
        let error_ptr = archive_error_string(archive_ptr);
        if error_ptr.is_null() {
            return false;
        }
        let message = CStr::from_ptr(error_ptr)
            .to_string_lossy()
            .to_ascii_lowercase();
        message.contains("undefined option") || message.contains("unknown module name")
    }
}

fn optional_cstring(value: Option<&str>, label: &str, context: &str) -> Result<Option<CString>> {
    value
        .map(|value| cstring(value, label, context))
        .transpose()
}

fn cstring(value: &str, label: &str, context: &str) -> Result<CString> {
    CString::new(value).map_err(|_| {
        RomWeaverError::Validation(format!("{context}: {label} contained interior NUL"))
    })
}
