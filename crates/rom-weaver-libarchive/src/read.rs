use super::*;
use libc::{S_IFDIR, S_IFMT, S_IFREG, mode_t};
use std::os::raw::c_int;
use tracing::trace;

type SupportFunction = unsafe extern "C" fn(*mut archive) -> c_int;

const REGULAR_ARCHIVE_SUPPORT: &[(&str, SupportFunction)] = &[
    ("ar format", archive_read_support_format_ar),
    ("cpio format", archive_read_support_format_cpio),
    ("empty format", archive_read_support_format_empty),
    ("lha format", archive_read_support_format_lha),
    ("mtree format", archive_read_support_format_mtree),
    ("tar format", archive_read_support_format_tar),
    ("warc format", archive_read_support_format_warc),
    ("7zip format", archive_read_support_format_7zip),
    ("cab format", archive_read_support_format_cab),
    ("rar format", archive_read_support_format_rar),
    ("rar5 format", archive_read_support_format_rar5),
    ("iso9660 format", archive_read_support_format_iso9660),
    ("zip format", archive_read_support_format_zip),
    ("bzip2 filter", archive_read_support_filter_bzip2),
    ("compress filter", archive_read_support_filter_compress),
    ("gzip filter", archive_read_support_filter_gzip),
    ("lzip filter", archive_read_support_filter_lzip),
    ("lzma filter", archive_read_support_filter_lzma),
    ("xz filter", archive_read_support_filter_xz),
    ("uu filter", archive_read_support_filter_uu),
    ("rpm filter", archive_read_support_filter_rpm),
    ("zstd filter", archive_read_support_filter_zstd),
];

#[derive(Clone, Copy, Debug)]
pub enum ReadFilter {
    Gzip,
    Bzip2,
    Xz,
    Zstd,
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

    pub(crate) fn support_regular_archives(&mut self, context: &str) -> Result<()> {
        for (name, support) in REGULAR_ARCHIVE_SUPPORT {
            let status = unsafe { support(self.as_ptr()) };
            if status != ARCHIVE_OK {
                return Err(error_from_archive(
                    self.as_ptr(),
                    &format!("{context} while enabling {name}"),
                ));
            }
        }
        Ok(())
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
        Ok(self.next_entry_ptr(context)?.is_some())
    }

    pub(crate) fn next_entry(&mut self) -> io::Result<Option<ReadArchiveEntry<'_>>> {
        let entry = self
            .next_entry_ptr("archive read header failed")
            .map_err(|error| io::Error::other(error.to_string()))?;
        Ok(entry.map(|ptr| ReadArchiveEntry { archive: self, ptr }))
    }

    pub(crate) fn format(&self) -> c_int {
        unsafe { archive_format(self.as_ptr()) }
    }

    fn next_entry_ptr(&mut self, context: &str) -> Result<Option<NonNull<archive_entry>>> {
        let mut entry = ptr::null_mut();
        let status = unsafe { archive_read_next_header(self.as_ptr(), &mut entry) };
        if status == ARCHIVE_EOF {
            return Ok(None);
        }
        self.check_status(status, context)?;
        NonNull::new(entry).map(Some).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "{context}: libarchive returned a null entry pointer"
            ))
        })
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
        trace!(decoded_bytes = copied, "libarchive read entry to writer");
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

pub(crate) struct ReadArchiveEntry<'a> {
    archive: &'a mut ReadArchive,
    ptr: NonNull<archive_entry>,
}

impl<'a> ReadArchiveEntry<'a> {
    fn filetype(&self) -> mode_t {
        unsafe { archive_entry_filetype(self.ptr.as_ptr()) }
    }

    pub(crate) fn is_dir(&self) -> bool {
        (self.filetype() & S_IFMT as mode_t) == S_IFDIR as mode_t
    }

    pub(crate) fn is_file(&self) -> bool {
        (self.filetype() & S_IFMT as mode_t) == S_IFREG as mode_t
    }

    pub(crate) fn size(&self) -> Option<u64> {
        if unsafe { archive_entry_size_is_set(self.ptr.as_ptr()) } == 0 {
            return None;
        }
        u64::try_from(unsafe { archive_entry_size(self.ptr.as_ptr()) }).ok()
    }

    pub(crate) fn pathname_mb(&self) -> io::Result<&CStr> {
        let pathname = unsafe { archive_entry_pathname(self.ptr.as_ptr()) };
        if pathname.is_null() {
            return Err(self.io_error("archive entry pathname was unavailable"));
        }
        Ok(unsafe { CStr::from_ptr(pathname) })
    }

    pub(crate) fn pathname_utf8(&self) -> io::Result<&str> {
        let pathname = unsafe { archive_entry_pathname_utf8(self.ptr.as_ptr()) };
        if pathname.is_null() {
            return Err(self.io_error("archive entry UTF-8 pathname was unavailable"));
        }
        unsafe { CStr::from_ptr(pathname) }
            .to_str()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    pub(crate) fn into_reader(self) -> ArchiveDataReader<'a> {
        ArchiveDataReader {
            archive: self.archive,
            context: "archive entry read failed".to_string(),
        }
    }

    fn io_error(&self, context: &str) -> io::Error {
        io::Error::other(error_from_archive(self.archive.as_ptr(), context).to_string())
    }
}

impl Drop for ReadArchive {
    fn drop(&mut self) {
        if let Some(ptr) = self.ptr.take() {
            let _ = unsafe { archive_read_free(ptr.as_ptr()) };
        }
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

        let mut reader = ArchiveDataReader {
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

pub(crate) struct ArchiveDataReader<'a> {
    archive: &'a mut ReadArchive,
    context: String,
}

impl Read for ArchiveDataReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.archive
            .read_data(buf, &self.context)
            .map_err(|error| io::Error::other(error.to_string()))
    }
}
