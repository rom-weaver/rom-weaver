use std::{
    ffi::{CStr, CString, c_char, c_void},
    fmt,
    fs::File,
    io::Write,
    path::Path,
    ptr::NonNull,
};

#[allow(unused_imports)]
use zstd_sys as _;

const ERROR_BUFFER_LEN: usize = 1024;
pub const CHD_SHA1_LEN: usize = 20;
pub const CHD_MAX_COMPRESSORS: usize = 4;
pub const CD_FRAME_SIZE: u32 = 2352 + 96;
pub const CHD_METADATA_FLAG_CHECKSUM: u8 = 0x01;
pub const HARD_DISK_METADATA_TAG: u32 = make_tag(b'G', b'D', b'D', b'D');
pub const CDROM_TRACK_METADATA2_TAG: u32 = make_tag(b'C', b'H', b'T', b'2');
pub const GDROM_TRACK_METADATA_TAG: u32 = make_tag(b'C', b'H', b'G', b'D');
pub const DVD_METADATA_TAG: u32 = make_tag(b'D', b'V', b'D', b' ');
pub const HARD_DISK_METADATA_FORMAT: &str = "CYLS:%d,HEADS:%d,SECS:%d,BPS:%d";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChdCodec(u32);

impl ChdCodec {
    pub const NONE: Self = Self(0);
    pub const ZLIB: Self = Self(make_tag(b'z', b'l', b'i', b'b'));
    pub const ZSTD: Self = Self(make_tag(b'z', b's', b't', b'd'));
    pub const LZMA: Self = Self(make_tag(b'l', b'z', b'm', b'a'));
    pub const HUFFMAN: Self = Self(make_tag(b'h', b'u', b'f', b'f'));
    pub const FLAC: Self = Self(make_tag(b'f', b'l', b'a', b'c'));
    pub const CD_ZLIB: Self = Self(make_tag(b'c', b'd', b'z', b'l'));
    pub const CD_ZSTD: Self = Self(make_tag(b'c', b'd', b'z', b's'));
    pub const CD_LZMA: Self = Self(make_tag(b'c', b'd', b'l', b'z'));
    pub const CD_FLAC: Self = Self(make_tag(b'c', b'd', b'f', b'l'));

    pub const fn raw(self) -> u32 {
        self.0
    }
}

pub const fn make_tag(a: u8, b: u8, c: u8, d: u8) -> u32 {
    ((a as u32) << 24) | ((b as u32) << 16) | ((c as u32) << 8) | (d as u32)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChdMediaKind {
    Raw,
    HardDisk,
    CdRom,
    GdRom,
    Dvd,
    Av,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildInfo {
    pub backend_name: String,
    pub backend_available: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChdHeader {
    pub version: u32,
    pub logical_bytes: u64,
    pub hunk_bytes: u32,
    pub hunk_count: u32,
    pub unit_bytes: u32,
    pub unit_count: u64,
    pub compressed: bool,
    pub compression: [ChdCodec; CHD_MAX_COMPRESSORS],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreateOptions {
    pub logical_bytes: u64,
    pub hunk_bytes: u32,
    pub unit_bytes: u32,
    pub compression: [ChdCodec; CHD_MAX_COMPRESSORS],
}

impl Default for CreateOptions {
    fn default() -> Self {
        Self {
            logical_bytes: 0,
            hunk_bytes: 4096,
            unit_bytes: 1,
            compression: [ChdCodec::NONE; CHD_MAX_COMPRESSORS],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Metadata<'a> {
    pub tag: u32,
    pub index: u32,
    pub flags: u8,
    pub data: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: i32,
    pub message: String,
}

impl Error {
    pub fn backend_unavailable(&self) -> bool {
        self.code == error_codes::BACKEND_UNAVAILABLE
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.message.is_empty() {
            write!(f, "MAME CHD bridge failed with code {}", self.code)
        } else {
            write!(f, "{}", self.message)
        }
    }
}

impl std::error::Error for Error {}

pub struct ChdFile {
    handle: NonNull<c_void>,
    header: ChdHeader,
}

impl ChdFile {
    pub fn open(path: &Path, parent_path: Option<&Path>) -> Result<Self, Error> {
        Self::open_impl(path, parent_path, false)
    }

    pub fn open_writable(path: &Path, parent_path: Option<&Path>) -> Result<Self, Error> {
        Self::open_impl(path, parent_path, true)
    }

    fn open_impl(path: &Path, parent_path: Option<&Path>, writable: bool) -> Result<Self, Error> {
        let path = path_to_c_string(path)?;
        let parent_path = optional_path_to_c_string(parent_path)?;
        let mut handle = std::ptr::null_mut();
        let mut header = RawChdHeader::default();
        let mut error = [0 as c_char; ERROR_BUFFER_LEN];

        let status = unsafe {
            rw_mame_chd_open(
                path.as_ptr(),
                c_string_ptr(parent_path.as_ref()),
                writable.into(),
                &mut handle,
                &mut header,
                error.as_mut_ptr(),
                ERROR_BUFFER_LEN,
            )
        };

        handle_result(status, &error)?;
        let handle = NonNull::new(handle).ok_or_else(|| Error {
            code: error_codes::ALLOC,
            message: "MAME CHD bridge returned a null handle".into(),
        })?;

        Ok(Self {
            handle,
            header: header.into(),
        })
    }

    pub fn create(
        path: &Path,
        parent_path: Option<&Path>,
        options: &CreateOptions,
    ) -> Result<Self, Error> {
        let path = path_to_c_string(path)?;
        let parent_path = optional_path_to_c_string(parent_path)?;
        let codecs = options.compression.map(ChdCodec::raw);
        let mut handle = std::ptr::null_mut();
        let mut header = RawChdHeader::default();
        let mut error = [0 as c_char; ERROR_BUFFER_LEN];

        let status = unsafe {
            rw_mame_chd_create(
                path.as_ptr(),
                c_string_ptr(parent_path.as_ref()),
                options.logical_bytes,
                options.hunk_bytes,
                options.unit_bytes,
                codecs.as_ptr(),
                &mut handle,
                &mut header,
                error.as_mut_ptr(),
                ERROR_BUFFER_LEN,
            )
        };

        handle_result(status, &error)?;
        let handle = NonNull::new(handle).ok_or_else(|| Error {
            code: error_codes::ALLOC,
            message: "MAME CHD bridge returned a null handle".into(),
        })?;

        Ok(Self {
            handle,
            header: header.into(),
        })
    }

    pub fn compress_file(
        input_path: &Path,
        output_path: &Path,
        parent_path: Option<&Path>,
        options: &CreateOptions,
    ) -> Result<ChdHeader, Error> {
        let input_path = path_to_c_string(input_path)?;
        let output_path = path_to_c_string(output_path)?;
        let parent_path = optional_path_to_c_string(parent_path)?;
        let codecs = options.compression.map(ChdCodec::raw);
        let mut header = RawChdHeader::default();
        let mut error = [0 as c_char; ERROR_BUFFER_LEN];

        let status = unsafe {
            rw_mame_chd_compress_file(
                input_path.as_ptr(),
                output_path.as_ptr(),
                c_string_ptr(parent_path.as_ref()),
                options.logical_bytes,
                options.hunk_bytes,
                options.unit_bytes,
                codecs.as_ptr(),
                &mut header,
                error.as_mut_ptr(),
                ERROR_BUFFER_LEN,
            )
        };

        handle_result(status, &error)?;
        Ok(header.into())
    }

    pub fn header(&self) -> ChdHeader {
        self.header
    }

    pub fn refresh_header(&mut self) -> Result<ChdHeader, Error> {
        let mut header = RawChdHeader::default();
        let mut error = [0 as c_char; ERROR_BUFFER_LEN];
        let status = unsafe {
            rw_mame_chd_refresh_header(
                self.handle.as_ptr(),
                &mut header,
                error.as_mut_ptr(),
                ERROR_BUFFER_LEN,
            )
        };
        handle_result(status, &error)?;
        self.header = header.into();
        Ok(self.header)
    }

    pub fn media_kind(&self) -> Result<ChdMediaKind, Error> {
        let mut kind = 0_u32;
        let mut error = [0 as c_char; ERROR_BUFFER_LEN];
        let status = unsafe {
            rw_mame_chd_media_kind(
                self.handle.as_ptr(),
                &mut kind,
                error.as_mut_ptr(),
                ERROR_BUFFER_LEN,
            )
        };
        handle_result(status, &error)?;
        match kind {
            0 => Ok(ChdMediaKind::Raw),
            1 => Ok(ChdMediaKind::HardDisk),
            2 => Ok(ChdMediaKind::CdRom),
            3 => Ok(ChdMediaKind::GdRom),
            4 => Ok(ChdMediaKind::Dvd),
            5 => Ok(ChdMediaKind::Av),
            value => Err(Error {
                code: error_codes::INVALID_ARGUMENT,
                message: format!("MAME CHD bridge returned an unknown media kind: {value}"),
            }),
        }
    }

    pub fn read_hunk(&self, hunk_index: u32, buffer: &mut [u8]) -> Result<(), Error> {
        let mut error = [0 as c_char; ERROR_BUFFER_LEN];
        let status = unsafe {
            rw_mame_chd_read_hunk(
                self.handle.as_ptr(),
                hunk_index,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                error.as_mut_ptr(),
                ERROR_BUFFER_LEN,
            )
        };
        handle_result(status, &error)
    }

    pub fn write_hunk(&self, hunk_index: u32, buffer: &[u8]) -> Result<(), Error> {
        let mut error = [0 as c_char; ERROR_BUFFER_LEN];
        let status = unsafe {
            rw_mame_chd_write_hunk(
                self.handle.as_ptr(),
                hunk_index,
                buffer.as_ptr().cast(),
                buffer.len(),
                error.as_mut_ptr(),
                ERROR_BUFFER_LEN,
            )
        };
        handle_result(status, &error)
    }

    pub fn read_metadata(&self, tag: u32, index: u32) -> Result<Option<Vec<u8>>, Error> {
        let mut found = 0_u8;
        let mut len = 0_u32;
        let mut error = [0 as c_char; ERROR_BUFFER_LEN];

        let status = unsafe {
            rw_mame_chd_read_metadata(
                self.handle.as_ptr(),
                tag,
                index,
                &mut found,
                std::ptr::null_mut(),
                &mut len,
                error.as_mut_ptr(),
                ERROR_BUFFER_LEN,
            )
        };
        if status == error_codes::OK {
            return Ok((found != 0).then(Vec::new));
        }
        if status != error_codes::BUFFER_TOO_SMALL {
            handle_result(status, &error)?;
            return Ok(None);
        }

        let mut buffer = vec![
            0_u8;
            usize::try_from(len).map_err(|_| Error {
                code: error_codes::INVALID_ARGUMENT,
                message: "metadata length exceeded addressable memory".into(),
            })?
        ];
        let status = unsafe {
            rw_mame_chd_read_metadata(
                self.handle.as_ptr(),
                tag,
                index,
                &mut found,
                buffer.as_mut_ptr().cast(),
                &mut len,
                error.as_mut_ptr(),
                ERROR_BUFFER_LEN,
            )
        };
        handle_result(status, &error)?;
        if found == 0 {
            Ok(None)
        } else {
            buffer.truncate(usize::try_from(len).unwrap_or(buffer.len()));
            Ok(Some(buffer))
        }
    }

    pub fn write_metadata(&self, metadata: Metadata<'_>) -> Result<(), Error> {
        let mut error = [0 as c_char; ERROR_BUFFER_LEN];
        let status = unsafe {
            rw_mame_chd_write_metadata(
                self.handle.as_ptr(),
                metadata.tag,
                metadata.index,
                metadata.flags,
                metadata.data.as_ptr().cast(),
                metadata.data.len().try_into().map_err(|_| Error {
                    code: error_codes::INVALID_ARGUMENT,
                    message: "metadata payload is too large for the MAME CHD bridge".into(),
                })?,
                error.as_mut_ptr(),
                ERROR_BUFFER_LEN,
            )
        };
        handle_result(status, &error)
    }

    pub fn extract_to_file(
        path: &Path,
        parent_path: Option<&Path>,
        output_path: &Path,
    ) -> Result<ChdHeader, Error> {
        let chd = Self::open(path, parent_path)?;
        let header = chd.header();
        let mut output = File::create(output_path).map_err(|source| Error {
            code: error_codes::INVALID_ARGUMENT,
            message: format!("failed to create {}: {source}", output_path.display()),
        })?;

        let mut remaining = header.logical_bytes;
        let mut buffer = vec![
            0_u8;
            usize::try_from(header.hunk_bytes).map_err(|_| Error {
                code: error_codes::INVALID_ARGUMENT,
                message: "CHD hunk size exceeded addressable memory".into(),
            })?
        ];

        for hunk_index in 0..header.hunk_count {
            if remaining == 0 {
                break;
            }
            chd.read_hunk(hunk_index, &mut buffer)?;
            let write_len =
                usize::try_from(remaining.min(header.hunk_bytes as u64)).map_err(|_| Error {
                    code: error_codes::INVALID_ARGUMENT,
                    message: "extracted CHD hunk exceeded addressable memory".into(),
                })?;
            output
                .write_all(&buffer[..write_len])
                .map_err(|source| Error {
                    code: error_codes::INVALID_ARGUMENT,
                    message: format!("failed to write {}: {source}", output_path.display()),
                })?;
            remaining -= write_len as u64;
        }

        Ok(header)
    }
}

impl Drop for ChdFile {
    fn drop(&mut self) {
        unsafe { rw_mame_chd_close(self.handle.as_ptr()) };
    }
}

pub fn build_info() -> BuildInfo {
    let backend_name = unsafe {
        CStr::from_ptr(rw_mame_chd_backend_name())
            .to_string_lossy()
            .into_owned()
    };

    BuildInfo {
        backend_name,
        backend_available: unsafe { rw_mame_chd_backend_available() != 0 },
    }
}

#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
struct RawChdHeader {
    version: u32,
    logical_bytes: u64,
    hunk_bytes: u32,
    hunk_count: u32,
    unit_bytes: u32,
    unit_count: u64,
    compressed: u8,
    reserved: [u8; 3],
    compression: [u32; CHD_MAX_COMPRESSORS],
}

impl From<RawChdHeader> for ChdHeader {
    fn from(value: RawChdHeader) -> Self {
        Self {
            version: value.version,
            logical_bytes: value.logical_bytes,
            hunk_bytes: value.hunk_bytes,
            hunk_count: value.hunk_count,
            unit_bytes: value.unit_bytes,
            unit_count: value.unit_count,
            compressed: value.compressed != 0,
            compression: value.compression.map(ChdCodec),
        }
    }
}

fn path_to_c_string(path: &Path) -> Result<CString, Error> {
    CString::new(path.as_os_str().to_string_lossy().into_owned()).map_err(|_| Error {
        code: error_codes::INVALID_ARGUMENT,
        message: format!("path contains an interior NUL byte: {}", path.display()),
    })
}

fn optional_path_to_c_string(path: Option<&Path>) -> Result<Option<CString>, Error> {
    path.map(path_to_c_string).transpose()
}

fn c_string_ptr(value: Option<&CString>) -> *const c_char {
    value.map_or(std::ptr::null(), |value| value.as_ptr())
}

fn handle_result(status: i32, error: &[c_char; ERROR_BUFFER_LEN]) -> Result<(), Error> {
    if status == error_codes::OK {
        return Ok(());
    }

    let message = unsafe {
        CStr::from_ptr(error.as_ptr())
            .to_string_lossy()
            .into_owned()
    };
    Err(Error {
        code: status,
        message,
    })
}

mod error_codes {
    pub const OK: i32 = 0;
    pub const BUFFER_TOO_SMALL: i32 = -1;
    pub const BACKEND_UNAVAILABLE: i32 = -5;
    pub const INVALID_ARGUMENT: i32 = -2;
    pub const ALLOC: i32 = -3;
}

unsafe extern "C" {
    fn rw_mame_chd_backend_available() -> u8;
    fn rw_mame_chd_backend_name() -> *const c_char;
    fn rw_mame_chd_open(
        path: *const c_char,
        parent_path: *const c_char,
        writable: u8,
        out_handle: *mut *mut c_void,
        out_header: *mut RawChdHeader,
        error: *mut c_char,
        error_len: usize,
    ) -> i32;
    fn rw_mame_chd_create(
        path: *const c_char,
        parent_path: *const c_char,
        logical_bytes: u64,
        hunk_bytes: u32,
        unit_bytes: u32,
        compression: *const u32,
        out_handle: *mut *mut c_void,
        out_header: *mut RawChdHeader,
        error: *mut c_char,
        error_len: usize,
    ) -> i32;
    fn rw_mame_chd_compress_file(
        input_path: *const c_char,
        output_path: *const c_char,
        parent_path: *const c_char,
        logical_bytes: u64,
        hunk_bytes: u32,
        unit_bytes: u32,
        compression: *const u32,
        out_header: *mut RawChdHeader,
        error: *mut c_char,
        error_len: usize,
    ) -> i32;
    fn rw_mame_chd_close(handle: *mut c_void);
    fn rw_mame_chd_media_kind(
        handle: *mut c_void,
        media_kind: *mut u32,
        error: *mut c_char,
        error_len: usize,
    ) -> i32;
    fn rw_mame_chd_refresh_header(
        handle: *mut c_void,
        out_header: *mut RawChdHeader,
        error: *mut c_char,
        error_len: usize,
    ) -> i32;
    fn rw_mame_chd_read_hunk(
        handle: *mut c_void,
        hunk_index: u32,
        buffer: *mut c_void,
        buffer_len: usize,
        error: *mut c_char,
        error_len: usize,
    ) -> i32;
    fn rw_mame_chd_write_hunk(
        handle: *mut c_void,
        hunk_index: u32,
        buffer: *const c_void,
        buffer_len: usize,
        error: *mut c_char,
        error_len: usize,
    ) -> i32;
    fn rw_mame_chd_read_metadata(
        handle: *mut c_void,
        tag: u32,
        index: u32,
        found: *mut u8,
        data: *mut c_void,
        data_len: *mut u32,
        error: *mut c_char,
        error_len: usize,
    ) -> i32;
    fn rw_mame_chd_write_metadata(
        handle: *mut c_void,
        tag: u32,
        index: u32,
        flags: u8,
        data: *const c_void,
        data_len: u32,
        error: *mut c_char,
        error_len: usize,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use super::{ChdCodec, ChdFile, build_info, make_tag};

    fn assert_round_trip(codec: ChdCodec, suffix: &str) {
        let base = std::env::temp_dir().join(format!(
            "rom-weaver-chd-sys-{suffix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).expect("temp dir");

        let input_path = base.join("sample.bin");
        let output_path = base.join("sample.chd");
        let extract_path = base.join("sample.out.bin");
        let source = (0..16_384)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        std::fs::write(&input_path, &source).expect("write input");

        let header = ChdFile::compress_file(
            &input_path,
            &output_path,
            None,
            &super::CreateOptions {
                logical_bytes: source.len() as u64,
                hunk_bytes: 4096,
                unit_bytes: 1,
                compression: [
                    codec,
                    super::ChdCodec::NONE,
                    super::ChdCodec::NONE,
                    super::ChdCodec::NONE,
                ],
            },
        )
        .expect("compress");
        assert!(header.compressed);

        let reopened = ChdFile::open(&output_path, None).expect("open chd");
        assert_eq!(reopened.header().logical_bytes, source.len() as u64);

        let extracted =
            ChdFile::extract_to_file(&output_path, None, &extract_path).expect("extract");
        assert_eq!(extracted.hunk_bytes, 4096);
        assert_eq!(std::fs::read(&extract_path).expect("read extract"), source);
    }

    #[test]
    fn fourcc_tag_helper_matches_known_codecs() {
        assert_eq!(make_tag(b'z', b's', b't', b'd'), ChdCodec::ZSTD.raw());
        assert_eq!(make_tag(b'c', b'd', b'f', b'l'), ChdCodec::CD_FLAC.raw());
    }

    #[test]
    fn stub_backend_is_detectable() {
        let info = build_info();
        assert!(!info.backend_name.is_empty());
        assert!(info.backend_available);
    }

    #[test]
    fn general_codecs_round_trip() {
        assert_round_trip(ChdCodec::ZLIB, "zlib");
        assert_round_trip(ChdCodec::ZSTD, "zstd");
        assert_round_trip(ChdCodec::LZMA, "lzma");
    }
}
