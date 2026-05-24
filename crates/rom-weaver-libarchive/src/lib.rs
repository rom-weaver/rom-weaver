use std::{
    borrow::Cow,
    ffi::{CStr, CString},
    fs::File,
    io::{self, Read, Write},
    path::Path,
    ptr::{self, NonNull},
};

use akv::reader::ArchiveReader as RegularArchiveReader;
use rom_weaver_core::{Result, RomWeaverError};

pub use rom_weaver_libarchive_sys as sys;

use sys::{
    ARCHIVE_EOF, ARCHIVE_OK, ARCHIVE_WARN, archive, archive_entry_free, archive_entry_new,
    archive_entry_set_filetype, archive_entry_set_pathname, archive_entry_set_perm,
    archive_entry_set_size, archive_errno, archive_error_string, archive_read_close,
    archive_read_data, archive_read_free, archive_read_new, archive_read_next_header,
    archive_read_open_filename, archive_read_support_filter_bzip2,
    archive_read_support_filter_gzip, archive_read_support_filter_xz,
    archive_read_support_filter_zstd, archive_read_support_format_raw,
    archive_write_add_filter_bzip2, archive_write_add_filter_gzip, archive_write_add_filter_none,
    archive_write_add_filter_xz, archive_write_add_filter_zstd, archive_write_close,
    archive_write_data, archive_write_finish_entry, archive_write_free, archive_write_header,
    archive_write_new, archive_write_open_filename, archive_write_set_filter_option,
    archive_write_set_format_7zip, archive_write_set_format_option,
    archive_write_set_format_pax_restricted, archive_write_set_format_raw,
    archive_write_set_format_zip,
};

#[derive(Clone, Copy, Debug)]
pub enum WriteFormat {
    Zip,
    SevenZ,
    TarPax,
    Raw,
}

#[derive(Clone, Copy, Debug)]
pub enum WriteFilter {
    None,
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

impl WriteFilter {
    pub const fn module_name(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Gzip => Some("gzip"),
            Self::Bzip2 => Some("bzip2"),
            Self::Xz => Some("xz"),
            Self::Zstd => Some("zstd"),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ReadFilter {
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

#[derive(Clone, Debug)]
pub struct RegularArchiveFileEntry {
    pub index: usize,
    pub name: String,
    pub size: Option<u64>,
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
    Complete,
    Error,
}

pub struct WriteArchive {
    ptr: Option<NonNull<archive>>,
}

impl WriteArchive {
    pub fn new(context: &str) -> Result<Self> {
        let ptr = unsafe { archive_write_new() };
        let ptr = NonNull::new(ptr).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "{context}: libarchive writer allocation returned null"
            ))
        })?;
        Ok(Self { ptr: Some(ptr) })
    }

    pub fn set_format(&mut self, format: WriteFormat, context: &str) -> Result<()> {
        let status = unsafe {
            match format {
                WriteFormat::Zip => archive_write_set_format_zip(self.as_ptr()),
                WriteFormat::SevenZ => archive_write_set_format_7zip(self.as_ptr()),
                WriteFormat::TarPax => archive_write_set_format_pax_restricted(self.as_ptr()),
                WriteFormat::Raw => archive_write_set_format_raw(self.as_ptr()),
            }
        };
        self.check_status(status, context)
    }

    pub fn add_filter(&mut self, filter: WriteFilter, context: &str) -> Result<()> {
        let status = unsafe {
            match filter {
                WriteFilter::None => archive_write_add_filter_none(self.as_ptr()),
                WriteFilter::Gzip => archive_write_add_filter_gzip(self.as_ptr()),
                WriteFilter::Bzip2 => archive_write_add_filter_bzip2(self.as_ptr()),
                WriteFilter::Xz => archive_write_add_filter_xz(self.as_ptr()),
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
        zero_write_behavior: ZeroWriteBehavior,
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
                match zero_write_behavior {
                    ZeroWriteBehavior::Complete => return Ok(()),
                    ZeroWriteBehavior::Error => {
                        return Err(RomWeaverError::Validation(format!(
                            "{context}: libarchive reported a zero-length write"
                        )));
                    }
                }
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

impl Drop for WriteArchive {
    fn drop(&mut self) {
        if let Some(ptr) = self.ptr.take() {
            let _ = unsafe { archive_write_free(ptr.as_ptr()) };
        }
    }
}

pub struct ReadArchive {
    ptr: Option<NonNull<archive>>,
}

impl ReadArchive {
    pub fn new(context: &str) -> Result<Self> {
        let ptr = unsafe { archive_read_new() };
        let ptr = NonNull::new(ptr).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "{context}: libarchive reader allocation returned null"
            ))
        })?;
        Ok(Self { ptr: Some(ptr) })
    }

    pub fn support_raw_format(&mut self, context: &str) -> Result<()> {
        let status = unsafe { archive_read_support_format_raw(self.as_ptr()) };
        self.check_status(status, context)
    }

    pub fn support_filter(&mut self, filter: ReadFilter, context: &str) -> Result<()> {
        let status = unsafe {
            match filter {
                ReadFilter::Gzip => archive_read_support_filter_gzip(self.as_ptr()),
                ReadFilter::Bzip2 => archive_read_support_filter_bzip2(self.as_ptr()),
                ReadFilter::Xz => archive_read_support_filter_xz(self.as_ptr()),
                ReadFilter::Zstd => archive_read_support_filter_zstd(self.as_ptr()),
            }
        };
        self.check_status(status, context)
    }

    pub fn open_filename(
        &mut self,
        input: &Path,
        label: &str,
        block_size: usize,
        context: &str,
    ) -> Result<()> {
        let input = path_to_cstring(input, label)?;
        let status =
            unsafe { archive_read_open_filename(self.as_ptr(), input.as_ptr(), block_size) };
        self.check_status(status, context)
    }

    pub fn next_header(&mut self, context: &str) -> Result<bool> {
        let mut entry = ptr::null_mut();
        let status = unsafe { archive_read_next_header(self.as_ptr(), &mut entry) };
        if status == ARCHIVE_EOF {
            return Ok(false);
        }
        self.check_status(status, context)?;
        Ok(true)
    }

    pub fn read_data(&mut self, buffer: &mut [u8], context: &str) -> Result<usize> {
        let read =
            unsafe { archive_read_data(self.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len()) };
        if read == 0 {
            return Ok(0);
        }
        if read < 0 {
            return Err(error_from_archive(self.as_ptr(), context));
        }
        let read = usize::try_from(read).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{context}: libarchive returned an invalid read length"
            ))
        })?;
        if read > buffer.len() {
            return Err(RomWeaverError::Validation(format!(
                "{context}: libarchive returned a read length larger than the buffer"
            )));
        }
        Ok(read)
    }

    pub fn read_entry_to_writer<W: Write>(
        &mut self,
        output: &mut W,
        buffer_bytes: usize,
        context: &str,
    ) -> Result<u64> {
        let mut copied = 0u64;
        let mut buffer = vec![0u8; buffer_bytes];
        loop {
            let read = self.read_data(&mut buffer, context)?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read])?;
            copied = copied.saturating_add(read as u64);
        }
        Ok(copied)
    }

    pub fn close(mut self, close_context: &str, free_context: &str) -> Result<()> {
        let Some(ptr) = self.ptr.take() else {
            return Ok(());
        };
        let close_result = check_status_for_ptr(
            unsafe { archive_read_close(ptr.as_ptr()) },
            ptr.as_ptr(),
            close_context,
        );
        let free_status = unsafe { archive_read_free(ptr.as_ptr()) };
        close_result.and(check_free_status(free_status, free_context))
    }

    fn check_status(&self, status: i32, context: &str) -> Result<()> {
        check_status_for_ptr(status, self.as_ptr(), context)
    }

    fn as_ptr(&self) -> *mut archive {
        self.ptr
            .expect("libarchive read handle used after close")
            .as_ptr()
    }
}

impl Drop for ReadArchive {
    fn drop(&mut self) {
        if let Some(ptr) = self.ptr.take() {
            let _ = unsafe { archive_read_free(ptr.as_ptr()) };
        }
    }
}

pub fn list_regular_archive_file_entries(
    source: &Path,
    format_name: &str,
) -> Result<Vec<RegularArchiveFileEntry>> {
    let mut reader = open_regular_archive_reader(source, format_name)?;
    let result = (|| -> Result<Vec<RegularArchiveFileEntry>> {
        let mut entries = Vec::new();
        let mut index = 0usize;

        while let Some(entry) = reader.next_entry().map_err(|error| {
            RomWeaverError::Validation(format!(
                "{format_name} list failed while reading entry {index}: {error}"
            ))
        })? {
            if entry.is_file() {
                let entry_path = match entry.pathname_utf8() {
                    Ok(path) => path.to_owned(),
                    Err(_) => entry
                        .pathname_mb()
                        .map(|path| path.to_string_lossy().into_owned())
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "{format_name} list failed while decoding entry {index}: {error}"
                            ))
                        })?,
                };
                if let Some(name) = normalize_archive_name(&entry_path) {
                    entries.push(RegularArchiveFileEntry {
                        index,
                        name,
                        size: entry.size(),
                    });
                }
            }
            index = index.saturating_add(1);
        }

        Ok(entries)
    })();

    match (result, close_regular_archive_reader(reader, format_name)) {
        (Ok(entries), Ok(())) => Ok(entries),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub fn with_regular_archive_file_entry_reader<T, F>(
    source: &Path,
    format_name: &str,
    expected_index: usize,
    expected_name: &str,
    read_entry: F,
) -> Result<T>
where
    F: FnOnce(&mut dyn Read) -> Result<T>,
{
    let mut reader = open_regular_archive_reader(source, format_name)?;
    let result = (|| -> Result<T> {
        let mut index = 0usize;

        while let Some(entry) = reader.next_entry().map_err(|error| {
            RomWeaverError::Validation(format!(
                "{format_name} read failed while reading entry {index}: {error}"
            ))
        })? {
            if index != expected_index {
                index = index.saturating_add(1);
                continue;
            }

            if !entry.is_file() {
                return Err(RomWeaverError::Validation(format!(
                    "{format_name} entry `{expected_name}` is no longer a file entry"
                )));
            }

            let entry_path = match entry.pathname_utf8() {
                Ok(path) => path.to_owned(),
                Err(_) => entry
                    .pathname_mb()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "{format_name} read failed while decoding entry {index}: {error}"
                        ))
                    })?,
            };
            let entry_name = normalize_archive_name(&entry_path).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "{format_name} read failed because entry {index} could not be normalized"
                ))
            })?;
            if entry_name != expected_name {
                return Err(RomWeaverError::Validation(format!(
                    "{format_name} entry changed while reading: expected `{expected_name}`, found `{entry_name}`"
                )));
            }

            let mut entry_reader = entry.into_reader();
            return read_entry(&mut entry_reader);
        }

        Err(RomWeaverError::Validation(format!(
            "{format_name} entry `{expected_name}` was not found"
        )))
    })();

    match (result, close_regular_archive_reader(reader, format_name)) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub fn with_raw_stream_reader<T, F>(
    source: &Path,
    format_name: &str,
    filter: ReadFilter,
    block_size: usize,
    read_entry: F,
) -> Result<T>
where
    F: FnOnce(&mut dyn Read) -> Result<T>,
{
    let mut archive = ReadArchive::new(&format!("{format_name} stream reader allocation failed"))?;
    archive.support_raw_format(&format!(
        "{format_name} stream read failed while enabling raw format"
    ))?;
    archive.support_filter(
        filter,
        &format!("{format_name} stream read failed while enabling filter"),
    )?;
    archive.open_filename(
        source,
        "stream source",
        block_size,
        &format!(
            "{format_name} stream read failed while opening input `{}`",
            source.display()
        ),
    )?;

    let result = (|| -> Result<T> {
        if !archive.next_header(&format!(
            "{format_name} stream read failed while reading header"
        ))? {
            return Err(RomWeaverError::Validation(format!(
                "{format_name} stream read found no compressed payload entries"
            )));
        }

        let mut reader = RawStreamEntryReader {
            archive: &mut archive,
            context: format!("{format_name} stream read failed while reading payload"),
        };
        read_entry(&mut reader)
    })();

    match (
        result,
        archive.close(
            &format!("{format_name} stream read failed while closing reader"),
            &format!("{format_name} stream read failed while releasing reader"),
        ),
    ) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

struct RawStreamEntryReader<'a> {
    archive: &'a mut ReadArchive,
    context: String,
}

impl Read for RawStreamEntryReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.archive
            .read_data(buf, &self.context)
            .map_err(|error| io::Error::other(error.to_string()))
    }
}

fn open_regular_archive_reader(
    source: &Path,
    format_name: &str,
) -> Result<RegularArchiveReader<'static>> {
    let file = File::open(source)?;
    RegularArchiveReader::open_io(file).map_err(|error| {
        RomWeaverError::Validation(format!("{format_name} archive is invalid: {error}"))
    })
}

fn close_regular_archive_reader(
    reader: RegularArchiveReader<'static>,
    format_name: &str,
) -> Result<()> {
    reader.close().map_err(|error| {
        RomWeaverError::Validation(format!("{format_name} archive close failed: {error}"))
    })
}

fn normalize_archive_name(name: &str) -> Option<String> {
    let normalized = name.trim().replace('\\', "/");
    if normalized.starts_with('/') {
        return None;
    }

    let mut parts = Vec::new();
    for segment in normalized.split('/') {
        let segment = segment.trim();
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        parts.push(segment);
    }

    (!parts.is_empty()).then(|| parts.join("/"))
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

fn check_status_for_ptr(status: i32, archive_ptr: *mut archive, context: &str) -> Result<()> {
    match status {
        ARCHIVE_OK | ARCHIVE_WARN => Ok(()),
        _ => Err(error_from_archive(archive_ptr, context)),
    }
}

fn check_free_status(status: i32, context: &str) -> Result<()> {
    match status {
        ARCHIVE_OK | ARCHIVE_WARN => Ok(()),
        _ => Err(RomWeaverError::Validation(format!(
            "{context}: libarchive free returned status {status}"
        ))),
    }
}

fn error_from_archive(archive_ptr: *mut archive, context: &str) -> RomWeaverError {
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

fn path_to_cstring(path: &Path, label: &str) -> Result<CString> {
    CString::new(path_bytes(path).as_ref()).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{label} path contains an interior NUL byte: `{}`",
            path.display()
        ))
    })
}

#[cfg(unix)]
fn path_bytes(path: &Path) -> Cow<'_, [u8]> {
    use std::os::unix::ffi::OsStrExt;

    Cow::Borrowed(path.as_os_str().as_bytes())
}

#[cfg(all(not(unix), target_os = "wasi"))]
fn path_bytes(path: &Path) -> Cow<'_, [u8]> {
    use std::os::wasi::ffi::OsStrExt;

    Cow::Borrowed(path.as_os_str().as_bytes())
}

#[cfg(not(any(unix, target_os = "wasi")))]
fn path_bytes(path: &Path) -> Cow<'_, [u8]> {
    Cow::Owned(path.to_string_lossy().as_bytes().to_vec())
}
