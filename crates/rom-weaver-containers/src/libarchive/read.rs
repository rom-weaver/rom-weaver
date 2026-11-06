use super::legacy_pathname::decode_legacy_pathname;
use super::*;
use std::os::raw::{c_char, c_int};
use tracing::{trace, warn};

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
    fn rom_weaver_archive_entry_is_link(entry: *mut archive_entry) -> c_int;
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
                return Err(read_error_from_archive(
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
            .map_err(io::Error::other)?;
        Ok(entry.map(|ptr| ReadArchiveEntry { archive: self, ptr }))
    }

    pub(crate) fn format(&self) -> c_int {
        unsafe { archive_format(self.as_ptr()) }
    }

    /// Returns the next entry that is not a symbolic or hard link. Links carry no data of their
    /// own, so listing them would fabricate empty files; they are skipped with a warning instead.
    fn next_entry_ptr(&mut self, context: &str) -> Result<Option<NonNull<archive_entry>>> {
        loop {
            let mut entry = ptr::null_mut();
            let status = unsafe { archive_read_next_header(self.as_ptr(), &mut entry) };
            if status == ARCHIVE_EOF {
                return Ok(None);
            }
            self.check_status(status, context)?;
            let ptr = NonNull::new(entry).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "{context}: libarchive returned a null entry pointer"
                ))
            })?;
            if unsafe { rom_weaver_archive_entry_is_link(ptr.as_ptr()) } == 0 {
                return Ok(Some(ptr));
            }
            let entry = ReadArchiveEntry { archive: self, ptr };
            // A skipped link's name only feeds this warning, so a name that cannot be decoded must not
            // fail the whole archive.
            let pathname = entry.pathname().unwrap_or_else(|_| entry.pathname_lossy());
            warn!(
                path = %pathname,
                "skipping archive link: symbolic and hard links are not supported"
            );
        }
    }

    pub fn read_data(&mut self, buffer: &mut [u8], context: &str) -> Result<usize> {
        let read =
            unsafe { archive_read_data(self.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len()) };
        if read == 0 {
            return Ok(0);
        }
        if read < 0 {
            return Err(read_error_from_archive(self.as_ptr(), context));
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
        match status {
            ARCHIVE_OK | ARCHIVE_WARN => Ok(()),
            _ => Err(read_error_from_archive(self.as_ptr(), context)),
        }
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
        // RAR5 names MUST use the original UTF-8. The cached locale form can contain
        // asterisks after musl's iconv reports a successful, lossy conversion.
        if self.archive.format() == ARCHIVE_FORMAT_RAR_V5 {
            trace!("reading the original RAR5 UTF-8 pathname");
            return self.pathname_utf8().map(str::to_owned).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid UTF-8 archive entry pathname: {error}"),
                )
            });
        }
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

    /// The entry name with undecodable bytes replaced, for messages about entries that are not extracted.
    fn pathname_lossy(&self) -> String {
        let pathname = unsafe { archive_entry_pathname_utf8(self.ptr.as_ptr()) };
        if pathname.is_null() {
            return String::from("<unreadable name>");
        }
        unsafe { CStr::from_ptr(pathname) }
            .to_string_lossy()
            .into_owned()
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
        io::Error::other(read_error_from_archive(self.archive.as_ptr(), context).to_string())
    }
}

impl Drop for ReadArchive {
    fn drop(&mut self) {
        if let Some(ptr) = self.ptr.take() {
            let _ = unsafe { archive_read_free(ptr.as_ptr()) };
        }
    }
}
/// Data a streamed reader's read callback borrows; it MUST outlive the libarchive handle.
struct StreamCallbackData<'r> {
    reader: &'r mut dyn Read,
    buffer: Vec<u8>,
    tail: std::collections::VecDeque<u8>,
    bytes: u64,
}

// Completed ZIP listings MUST fit their directory and footer in this bounded snapshot.
const STREAMED_ZIP_TAIL_BYTES: usize = 1024 * 1024;

impl StreamCallbackData<'_> {
    fn zip_header_offset(&self, start: i64, end: i64, name: &str) -> Option<i64> {
        let tail_start = self.bytes.checked_sub(self.tail.len() as u64)?;
        let end = usize::try_from(u64::try_from(end).ok()?.checked_sub(tail_start)?).ok()?;
        let start = usize::try_from(u64::try_from(start).ok()?.saturating_sub(tail_start)).ok()?;
        let tail = &self.tail;
        if end > tail.len() {
            return None;
        }
        let mut matches = (start..end.checked_sub(29)?).filter_map(|offset| {
            if !tail.range(offset..offset + 4).copied().eq(*b"PK\x03\x04") {
                return None;
            }
            let name_len = usize::from(u16::from_le_bytes([tail[offset + 26], tail[offset + 27]]));
            let extra_len = usize::from(u16::from_le_bytes([tail[offset + 28], tail[offset + 29]]));
            if 30 + name_len + extra_len != end - offset
                || !tail
                    .range(offset + 30..offset + 30 + name_len)
                    .copied()
                    .eq(name.bytes())
            {
                return None;
            }
            i64::try_from(tail_start + offset as u64).ok()
        });
        let offset = matches.next()?;
        matches.next().is_none().then_some(offset)
    }

    fn read_block(&mut self) -> io::Result<usize> {
        let read = loop {
            match self.reader.read(&mut self.buffer) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                result => break result?,
            }
        };
        self.bytes = self
            .bytes
            .checked_add(read as u64)
            .ok_or_else(|| io::Error::other("nested archive input length overflowed u64"))?;
        let bytes = &self.buffer[..read];
        if read >= STREAMED_ZIP_TAIL_BYTES {
            self.tail.clear();
            self.tail.extend(&bytes[read - STREAMED_ZIP_TAIL_BYTES..]);
        } else {
            let discard = (self.tail.len() + read).saturating_sub(STREAMED_ZIP_TAIL_BYTES);
            self.tail.drain(..discard);
            self.tail.extend(bytes);
        }
        Ok(read)
    }
}

/// Stream a regular archive's listing and optional prefixes without seeking, freeing the handle
/// before returning. Completed ZIP listings MUST match a bounded central-directory snapshot;
/// unsupported layouts and formats that require seeking return an error for normal extraction.
pub(crate) fn with_streamed_regular_archive(
    reader: &mut dyn Read,
    block_size: usize,
    context: &str,
    max_len: usize,
    visitor: &rom_weaver_core::NestedEntryVisitor<'_>,
) -> Result<rom_weaver_core::NestedArchiveListing> {
    // Declared before the archive so it is dropped after it.
    let mut callback_data = StreamCallbackData {
        reader,
        buffer: vec![0; block_size.max(1)],
        tail: std::collections::VecDeque::new(),
        bytes: 0,
    };
    let mut archive = ReadArchive::new(context)?;
    archive.support_regular_archives(context)?;
    let callback_ptr = &mut callback_data as *mut StreamCallbackData<'_>;
    let status = unsafe {
        sys::archive_read_open2(
            archive.as_ptr(),
            callback_ptr.cast::<c_void>(),
            None,
            Some(stream_read_callback),
            None,
            None,
        )
    };
    archive.check_status(status, &format!("{context} while opening the stream"))?;
    let result = list_streamed_entries(&mut archive, callback_ptr, max_len, visitor);
    let is_zip = archive.format() == ARCHIVE_FORMAT_ZIP;
    let unfiltered =
        unsafe { archive_filter_code(archive.as_ptr(), 0) } == sys::ARCHIVE_FILTER_NONE;
    let directory_offset = unsafe { sys::archive_filter_bytes(archive.as_ptr(), 0) };
    let closed = archive.close(
        &format!("{context} while closing the stream"),
        &format!("{context} while releasing the stream"),
    );
    let (listing, offsets) = match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }?;
    if is_zip && !listing.stopped {
        while callback_data.read_block()? != 0 {}
        if !unfiltered
            || !streamed_zip_directory_matches(
                callback_data.tail.make_contiguous(),
                callback_data.bytes,
                directory_offset,
                &listing,
                &offsets,
            )
        {
            return Err(RomWeaverError::Validation(format!(
                "{context}: streamed ZIP listing does not match a supported central directory"
            )));
        }
    }
    Ok(listing)
}

fn list_streamed_entries(
    archive: &mut ReadArchive,
    callback_data: *mut StreamCallbackData<'_>,
    max_len: usize,
    visitor: &rom_weaver_core::NestedEntryVisitor<'_>,
) -> Result<(rom_weaver_core::NestedArchiveListing, Vec<i64>)> {
    use rom_weaver_core::NestedEntryAction;
    let mut listing = rom_weaver_core::NestedArchiveListing::default();
    let mut offsets = Vec::new();
    while let Some(entry) = archive
        .next_entry()
        .map_err(|error| RomWeaverError::Validation(format!("reading a nested entry: {error}")))?
    {
        let mut path = entry
            .pathname()
            .map_err(|error| RomWeaverError::Validation(format!("nested entry name: {error}")))?;
        if entry.archive.format() == ARCHIVE_FORMAT_ZIP {
            let ptr = entry.archive.as_ptr();
            // Header position precedes skipped ZIP data descriptors; the snapshot MUST locate
            // the actual local header ending at libarchive's consumed position.
            // The callback data MUST only be borrowed between libarchive calls.
            offsets.push(
                unsafe { &*callback_data }
                    .zip_header_offset(
                        unsafe { sys::archive_read_header_position(ptr) },
                        unsafe { sys::archive_filter_bytes(ptr, 0) },
                        &path,
                    )
                    .unwrap_or(-1),
            );
        }
        if entry.is_dir() {
            path = format!("{}/", path.trim_end_matches('/'));
        }
        let action = (visitor.action)(&path);
        let prefix = if action == NestedEntryAction::ReadPrefix && entry.is_file() && max_len > 0 {
            Some(rom_weaver_core::read_up_to(entry.into_reader(), max_len)?)
        } else {
            None
        };
        trace!(entry = %path, ?action, prefix = prefix.as_ref().map(Vec::len), "nested archive entry");
        let settled = prefix
            .as_deref()
            .is_some_and(|prefix| (visitor.stop_after_prefix)(&path, prefix));
        listing
            .entries
            .push(rom_weaver_core::NestedArchiveEntry { path, prefix });
        if action == NestedEntryAction::Stop || settled {
            listing.stopped = true;
            break;
        }
    }
    Ok((listing, offsets))
}

fn streamed_zip_directory_matches(
    tail: &[u8],
    bytes: u64,
    directory_offset: i64,
    listing: &rom_weaver_core::NestedArchiveListing,
    offsets: &[i64],
) -> bool {
    let le16 = |data: &[u8], offset| u16::from_le_bytes([data[offset], data[offset + 1]]);
    let le32 = |data: &[u8], offset| {
        u32::from_le_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ])
    };
    let Some(eocd) = (tail.len().saturating_sub(65535 + 22)..tail.len().saturating_sub(21))
        .rev()
        .find(|&index| {
            tail[index..].starts_with(b"PK\x05\x06")
                && index + 22 + usize::from(le16(tail, index + 20)) == tail.len()
        })
    else {
        return false;
    };
    // archive_read_format_zip_seekable_bid ignores comment lengths; later EOCD signatures
    // MUST force fallback rather than trusting a different directory.
    if tail[eocd + 4..]
        .windows(4)
        .any(|bytes| bytes == b"PK\x05\x06")
    {
        return false;
    }
    // The seekable bidder follows ZIP64 locators even without ZIP32 sentinel fields.
    if eocd >= 20 && tail[eocd - 20..eocd].starts_with(b"PK\x06\x07") {
        return false;
    }
    let footer = &tail[eocd..];
    let count = le16(footer, 10);
    let size = le32(footer, 12);
    let offset = le32(footer, 16);
    if le16(footer, 4) != 0
        || le16(footer, 6) != 0
        || le16(footer, 8) != count
        || count == u16::MAX
        || size == u32::MAX
        || offset == u32::MAX
        || usize::from(count) != listing.entries.len()
        || offsets.len() != listing.entries.len()
        || directory_offset < 0
        || i64::from(offset) < directory_offset
        || u64::from(offset) + u64::from(size) != bytes - (tail.len() - eocd) as u64
    {
        return false;
    }
    let Ok(size) = usize::try_from(size) else {
        return false;
    };
    let Some(start) = eocd.checked_sub(size) else {
        return false;
    };
    let mut directory = &tail[start..eocd];
    for (entry, &local_offset) in listing.entries.iter().zip(offsets) {
        if directory.len() < 46 || !directory.starts_with(b"PK\x01\x02") {
            return false;
        }
        let flags = le16(directory, 8);
        let name_len = usize::from(le16(directory, 28));
        let extra_len = usize::from(le16(directory, 30));
        let comment_len = usize::from(le16(directory, 32));
        let entry_len = 46 + name_len + extra_len + comment_len;
        if directory.len() < entry_len
            || flags & !0x080e != 0
            || le32(directory, 20) == u32::MAX
            || le32(directory, 24) == u32::MAX
            || le16(directory, 34) != 0
            || i64::from(le32(directory, 42)) != local_offset
        {
            return false;
        }
        let name = &directory[46..46 + name_len];
        if (!name.is_ascii() && flags & 0x0800 == 0) || name != entry.path.as_bytes() {
            return false;
        }
        let mut extra = &directory[46 + name_len..46 + name_len + extra_len];
        while !extra.is_empty() {
            if extra.len() < 4 {
                return false;
            }
            let tag = le16(extra, 0);
            let length = usize::from(le16(extra, 2));
            if matches!(tag, 0x0001 | 0x7075) || extra.len() < 4 + length {
                return false;
            }
            extra = &extra[4 + length..];
        }
        directory = &directory[entry_len..];
    }
    directory.is_empty()
}

unsafe extern "C" fn stream_read_callback(
    _archive: *mut archive,
    client_data: *mut c_void,
    buffer: *mut *const c_void,
) -> sys::la_ssize_t {
    if client_data.is_null() || buffer.is_null() {
        return -1;
    }
    let callback_data = unsafe { &mut *client_data.cast::<StreamCallbackData<'_>>() };
    // A panic MUST NOT unwind across the extern "C" boundary; report it as a read error.
    let read =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback_data.read_block()));
    match read {
        Ok(Ok(read)) => {
            unsafe { *buffer = callback_data.buffer.as_ptr().cast::<c_void>() };
            sys::la_ssize_t::try_from(read).unwrap_or(-1)
        }
        Ok(Err(error)) => {
            trace!(%error, "libarchive stream read callback failed");
            -1
        }
        Err(_) => {
            trace!("libarchive stream read callback panicked");
            -1
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
