use super::legacy_pathname::decode_legacy_pathname;
use super::*;
use std::os::raw::{c_char, c_int};
use tracing::trace;

type SupportFunction = unsafe extern "C" fn(*mut archive) -> c_int;

// Appended to the staged archive_read_support_format_7zip.c by
// crates/rom-weaver-containers/libarchive/build.rs. Declared by hand rather than through
// bindgen because it is not in any libarchive header - the vendored tree stays a verbatim
// snapshot of the fork, and the accessor only exists in the staged build copy.
unsafe extern "C" {
    fn rom_weaver_7zip_entry_solid_block(archive: *mut archive) -> i64;
    fn rom_weaver_7zip_entry_decoder_bytes(archive: *mut archive) -> i64;
    // Appended to the staged archive_entry.c the same way.
    fn rom_weaver_archive_entry_stored_pathname(entry: *mut archive_entry) -> *const c_char;
}

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
    ("lz4 filter", archive_read_support_filter_lz4),
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
    Lz4,
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
        let reader = Self { ptr: Some(ptr) };
        ffi::configure_utf8(reader.as_ptr(), context)?;
        Ok(reader)
    }

    pub fn support_raw_format(&mut self, context: &str) -> Result<()> {
        // The raw bidder requires decoded bytes; explicit selection MUST also accept empty streams.
        let status =
            unsafe { sys::archive_read_set_format(self.as_ptr(), sys::ARCHIVE_FORMAT_RAW) };
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
                ReadFilter::Lz4 => archive_read_support_filter_lz4(self.as_ptr()),
            }
        };
        self.check_status(status, context)
    }

    /// Fails unless `filter` decodes the opened input. libarchive silently falls back to its
    /// pass-through filter when the decoder rejects the header, which would yield the input bytes.
    pub(crate) fn require_filter(
        &self,
        filter: ReadFilter,
        source: &Path,
        context: &str,
    ) -> Result<()> {
        let (expected, name) = match filter {
            ReadFilter::Gzip => (ARCHIVE_FILTER_GZIP, "gzip"),
            ReadFilter::Bzip2 => (ARCHIVE_FILTER_BZIP2, "bzip2"),
            ReadFilter::Xz => (ARCHIVE_FILTER_XZ, "xz"),
            ReadFilter::Zstd => (ARCHIVE_FILTER_ZSTD, "zstd"),
            ReadFilter::Lz4 => (ARCHIVE_FILTER_LZ4, "lz4"),
        };
        let actual = unsafe { archive_filter_code(self.as_ptr(), 0) };
        trace!(source = %source.display(), expected, actual, "libarchive read filter check");
        if actual == expected {
            return Ok(());
        }
        Err(RomWeaverError::Validation(format!(
            "{context}: `{}` is not a valid {name} stream",
            source.display()
        )))
    }

    pub fn open_filename(
        &mut self,
        input: &Path,
        label: &str,
        block_size: usize,
        context: &str,
    ) -> Result<()> {
        #[cfg(windows)]
        let status = {
            let input = ffi::path_to_wide(input, label)?;
            unsafe { sys::archive_read_open_filename_w(self.as_ptr(), input.as_ptr(), block_size) }
        };
        #[cfg(not(windows))]
        let status = {
            let input = path_to_cstring(input, label)?;
            unsafe { sys::archive_read_open_filename(self.as_ptr(), input.as_ptr(), block_size) }
        };
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

// libarchive normalizes archive_entry_filetype() to its own AE_IF* values
// (archive_entry.h) on every platform. Compare against those rather than
// libc's S_IF*, which only coincidentally match on Unix and don't exist as
// libc items on windows-msvc. The AE_IF* macros are casts, so bindgen cannot
// export them as constants.
const AE_IFMT: u32 = 0o170000;
const AE_IFREG: u32 = 0o100000;
const AE_IFDIR: u32 = 0o040000;

impl<'a> ReadArchiveEntry<'a> {
    fn filetype(&self) -> u32 {
        (unsafe { archive_entry_filetype(self.ptr.as_ptr()) }) as u32
    }

    pub(crate) fn is_dir(&self) -> bool {
        (self.filetype() & AE_IFMT) == AE_IFDIR
    }

    pub(crate) fn is_file(&self) -> bool {
        (self.filetype() & AE_IFMT) == AE_IFREG
    }

    pub(crate) fn size(&self) -> Option<u64> {
        if unsafe { archive_entry_size_is_set(self.ptr.as_ptr()) } == 0 {
            return None;
        }
        u64::try_from(unsafe { archive_entry_size(self.ptr.as_ptr()) }).ok()
    }

    /// The entry name as UTF-8, decoding names stored in a legacy charset.
    pub(crate) fn pathname(&self) -> io::Result<String> {
        // The stored bytes come first: on Windows the UTF-8 accessor widens raw legacy bytes to
        // Latin-1 code points instead of failing.
        let stored = unsafe { rom_weaver_archive_entry_stored_pathname(self.ptr.as_ptr()) };
        if !stored.is_null() {
            let stored = unsafe { CStr::from_ptr(stored) };
            return Ok(match stored.to_str() {
                Ok(path) => path.to_owned(),
                Err(_) => decode_legacy_pathname(stored.to_bytes(), self.archive.format()),
            });
        }
        if let Ok(path) = self.pathname_utf8() {
            return Ok(path.to_owned());
        }
        // libarchive's UTF-8 accessor can fail for names whose stored bytes are already UTF-8.
        let pathname = self.pathname_mb()?;
        if let Ok(path) = pathname.to_str() {
            return Ok(path.to_owned());
        }
        Ok(decode_legacy_pathname(
            pathname.to_bytes(),
            self.archive.format(),
        ))
    }

    fn pathname_mb(&self) -> io::Result<&CStr> {
        let pathname = unsafe { archive_entry_pathname(self.ptr.as_ptr()) };
        if pathname.is_null() {
            return Err(self.io_error("archive entry pathname was unavailable"));
        }
        Ok(unsafe { CStr::from_ptr(pathname) })
    }

    fn pathname_utf8(&self) -> io::Result<&str> {
        let pathname = unsafe { archive_entry_pathname_utf8(self.ptr.as_ptr()) };
        if pathname.is_null() {
            return Err(self.io_error("archive entry UTF-8 pathname was unavailable"));
        }
        unsafe { CStr::from_ptr(pathname) }
            .to_str()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    // Index of the 7z solid block (libarchive calls it a folder) holding this entry's
    // data, or `None` for any other format and for entries with no stream at all
    // (directories, empty files). Everything in one block decodes as a single chain, so
    // two workers assigned entries from the same block each decode the whole block.
    pub(crate) fn solid_block(&self) -> Option<u64> {
        let index = unsafe { rom_weaver_7zip_entry_solid_block(self.archive.as_ptr()) };
        u64::try_from(index).ok()
    }

    // Decoder working state (LZMA dictionaries, PPMd models) the 7z solid block holding this
    // entry declares, or `None` when `solid_block` is `None`. Each worker that decodes the
    // block allocates it, so it bounds how many workers fit the memory budget.
    pub(crate) fn decoder_bytes(&self) -> Option<u64> {
        let bytes = unsafe { rom_weaver_7zip_entry_decoder_bytes(self.archive.as_ptr()) };
        u64::try_from(bytes).ok()
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
    archive.require_filter(filter, source, &format!("{format_name} stream read failed"))?;

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
