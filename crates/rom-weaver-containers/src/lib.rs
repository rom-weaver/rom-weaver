use std::collections::BTreeMap;
use std::{
    collections::BTreeSet,
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    os::raw::c_uint,
    path::{Component, Path, PathBuf},
    ptr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use akv::reader::ArchiveReader as LibarchiveReadArchive;
use bzip2::read::MultiBzDecoder as Bzip2Decoder;
use ciso::{read::CSOReader as CsoReader, split::SplitFileReader};
use flate2::read::MultiGzDecoder;
use lz4_flex::frame::{
    BlockMode as Lz4BlockMode, BlockSize as Lz4BlockSize, FrameEncoder as Lz4FrameEncoder,
    FrameInfo as Lz4FrameInfo,
};
use lzma_rust2::{XzReader, XzReaderMt};
use nod::{
    common::{Compression as NodCompression, Format as NodFormat},
    read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader},
    util::buf_copy as nod_buf_copy,
    write::{
        DiscWriter as NodDiscWriter, FormatOptions as NodFormatOptions,
        ProcessOptions as NodProcessOptions,
    },
};
use rayon::prelude::*;
#[cfg(test)]
use rom_weaver_chd::ChdCodec;
use rom_weaver_chd::ChdContainerHandler;
use rom_weaver_codecs::{
    CanonicalCodec, CodecRegistry, RequestedCodec, decode_deflate_into_buffer,
    normalize_codec_label, parse_requested_codec,
};
use rom_weaver_core::{
    CodecBackend, CodecOperationRequest, ContainerCapabilities, ContainerCreateRequest,
    ContainerExtractRequest, ContainerHandler, ContainerInspectRequest, FormatDescriptor,
    OperationContext, OperationFamily, OperationReport, OperationStatus, OrderedChunkWriter,
    ProbeConfidence, ProgressEvent, Result, RomWeaverError, ThreadCapability, ThreadExecution,
    bounded_items_for_threads,
};
use rom_weaver_libarchive_sys::{
    ARCHIVE_FORMAT_7ZIP, ARCHIVE_FORMAT_BASE_MASK, ARCHIVE_FORMAT_RAR, ARCHIVE_FORMAT_RAR_V5,
    ARCHIVE_FORMAT_TAR, ARCHIVE_FORMAT_ZIP, ARCHIVE_OK, ARCHIVE_WARN, archive, archive_entry_free,
    archive_entry_new, archive_entry_set_filetype, archive_entry_set_pathname,
    archive_entry_set_perm, archive_entry_set_size, archive_errno, archive_error_string,
    archive_write_add_filter_bzip2, archive_write_add_filter_gzip, archive_write_add_filter_none,
    archive_write_add_filter_xz, archive_write_close, archive_write_data,
    archive_write_finish_entry, archive_write_free, archive_write_header, archive_write_new,
    archive_write_open_filename, archive_write_set_filter_option, archive_write_set_format_7zip,
    archive_write_set_format_option, archive_write_set_format_pax_restricted,
    archive_write_set_format_zip,
};
use xdvdfs::{
    blockdev::OffsetWrapper as XdvdfsOffsetWrapper, write::fs::XDVDFSFilesystem as XdvdfsFilesystem,
};
use zeekstd::{Decoder as ZeekstdDecoder, SeekTable as ZeekstdSeekTable};
use zstd::bulk::compress as zstd_compress;

const ZIP: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "zip",
    aliases: &[],
    extensions: &[".zip"],
};
const ZIPX: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "zipx",
    aliases: &[],
    extensions: &[".zipx"],
};
const SEVEN_Z: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "7z",
    aliases: &["7zip"],
    extensions: &[".7z"],
};
const RAR: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "rar",
    aliases: &[],
    extensions: &[".rar"],
};
const TAR: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar",
    aliases: &[],
    extensions: &[".tar"],
};
const TAR_GZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar.gz",
    aliases: &["tgz"],
    extensions: &[".tar.gz", ".tgz"],
};
const TAR_BZ2: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar.bz2",
    aliases: &["tbz2"],
    extensions: &[".tar.bz2", ".tbz2"],
};
const TAR_XZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar.xz",
    aliases: &["txz"],
    extensions: &[".tar.xz", ".txz"],
};
const GZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "gz",
    aliases: &["gzip"],
    extensions: &[".gz"],
};
const BZ2: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "bz2",
    aliases: &["bzip2"],
    extensions: &[".bz2"],
};
const XZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "xz",
    aliases: &["lzma", "lzma2"],
    extensions: &[".xz"],
};
const ZST: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "zst",
    aliases: &["zstd", "zstandard"],
    extensions: &[".zst"],
};
const CSO: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "cso",
    aliases: &["ciso"],
    extensions: &[".cso", ".ciso"],
};
const PBP: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "pbp",
    aliases: &[],
    extensions: &[".pbp"],
};
const GCZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "gcz",
    aliases: &[],
    extensions: &[".gcz"],
};
const WBFS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "wbfs",
    aliases: &[],
    extensions: &[".wbfs"],
};
const WIA: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "wia",
    aliases: &[],
    extensions: &[".wia"],
};
const TGC: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tgc",
    aliases: &[],
    extensions: &[".tgc"],
};
const NFS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "nfs",
    aliases: &[],
    extensions: &[".nfs"],
};
const RVZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "rvz",
    aliases: &[],
    extensions: &[".rvz"],
};
const Z3DS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "z3ds",
    aliases: &["3ds"],
    extensions: &[".z3ds", ".zcci", ".zcxi", ".zcia", ".z3dsx"],
};
const XISO: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "xiso",
    aliases: &[],
    extensions: &[".xiso", ".xiso.iso"],
};

pub struct ContainerRegistry {
    handlers: Vec<Arc<dyn ContainerHandler>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompressFormatRecommendation {
    pub format_name: &'static str,
    pub reason: &'static str,
}

impl Default for ContainerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ContainerRegistry {
    pub fn new() -> Self {
        let mut handlers: Vec<Arc<dyn ContainerHandler>> = vec![
            Arc::new(ZipContainerHandler::new(&ZIP, ZipContainerFlavor::Zip)),
            Arc::new(ZipContainerHandler::new(&ZIPX, ZipContainerFlavor::Zipx)),
            Arc::new(SevenZContainerHandler::new(&SEVEN_Z)),
        ];
        handlers.push(Arc::new(RarContainerHandler::new(&RAR)));
        handlers.push(Arc::new(TarContainerHandler::new(
            &TAR,
            TarCompression::None,
        )));
        handlers.push(Arc::new(TarContainerHandler::new(
            &TAR_GZ,
            TarCompression::Gzip,
        )));
        handlers.push(Arc::new(TarContainerHandler::new(
            &TAR_BZ2,
            TarCompression::Bzip2,
        )));
        handlers.push(Arc::new(TarContainerHandler::new(
            &TAR_XZ,
            TarCompression::Xz,
        )));
        handlers.push(Arc::new(StreamContainerHandler::new(
            &GZ,
            StreamCompression::Gzip,
        )));
        handlers.push(Arc::new(StreamContainerHandler::new(
            &BZ2,
            StreamCompression::Bzip2,
        )));
        handlers.push(Arc::new(StreamContainerHandler::new(
            &XZ,
            StreamCompression::Xz,
        )));
        handlers.push(Arc::new(StreamContainerHandler::new(
            &ZST,
            StreamCompression::Zstd,
        )));
        handlers.push(Arc::new(CsoContainerHandler::new(&CSO)));
        handlers.push(Arc::new(PbpContainerHandler));
        handlers.push(Arc::new(ChdContainerHandler));
        handlers.push(Arc::new(GczContainerHandler));
        handlers.push(Arc::new(WiaContainerHandler));
        handlers.push(Arc::new(TgcContainerHandler));
        handlers.push(Arc::new(NfsContainerHandler));
        handlers.push(Arc::new(WbfsContainerHandler));
        handlers.push(Arc::new(RvzContainerHandler));
        handlers.push(Arc::new(Z3dsContainerHandler));
        handlers.push(Arc::new(XisoContainerHandler));
        Self {
            handlers: handlers
                .into_iter()
                .map(rom_weaver_core::traced_container_handler)
                .collect(),
        }
    }

    pub fn handlers(&self) -> &[Arc<dyn ContainerHandler>] {
        &self.handlers
    }

    pub fn probe(&self, path: &Path) -> Option<Arc<dyn ContainerHandler>> {
        let mut extension_match = None;
        for handler in self
            .handlers
            .iter()
            .filter(|handler| handler.descriptor().matches_path(path))
        {
            match handler.probe(path) {
                ProbeConfidence::Signature => return Some(handler.clone()),
                ProbeConfidence::Extension => {
                    if extension_match.is_none() {
                        extension_match = Some(handler.clone());
                    }
                }
            }
        }
        self.handlers
            .iter()
            .find(|handler| matches!(handler.probe(path), ProbeConfidence::Signature))
            .cloned()
            .or(extension_match)
    }

    pub fn find_by_name(&self, name: &str) -> Option<Arc<dyn ContainerHandler>> {
        self.handlers
            .iter()
            .find(|handler| handler.descriptor().matches_name(name))
            .cloned()
    }

    pub fn recommend_compress_format(&self, path: &Path) -> CompressFormatRecommendation {
        let mut options = NodDiscOptions::default();
        options.preloader_threads = 0;
        if let Ok(disc) = NodDiscReader::new(path, &options) {
            let header = disc.header();
            if header.is_wii() || header.is_gamecube() {
                return CompressFormatRecommendation {
                    format_name: RVZ.name,
                    reason: "wii-gc-disc",
                };
            }
        }
        CompressFormatRecommendation {
            format_name: "chd",
            reason: "not-wii-gc-or-unrecognized",
        }
    }
}

const GZIP_SIGNATURE: [u8; 2] = [0x1F, 0x8B];
const BZIP2_SIGNATURE: [u8; 3] = [b'B', b'Z', b'h'];
const XZ_SIGNATURE: [u8; 6] = [0xFD, b'7', b'z', b'X', b'Z', 0x00];
const ZSTD_SIGNATURE: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
const CSO_SIGNATURE: [u8; 4] = [b'C', b'I', b'S', b'O'];
const PBP_SIGNATURE: [u8; 4] = [0x00, b'P', b'B', b'P'];

fn file_starts_with(source: &Path, signature: &[u8]) -> bool {
    let mut bytes = vec![0u8; signature.len()];
    if let Ok(mut file) = File::open(source) {
        return file.read_exact(&mut bytes).is_ok() && bytes == signature;
    }
    false
}

fn resolve_container_codec_backend(
    descriptor_name: &str,
    codec_name: &str,
) -> Result<Arc<dyn CodecBackend>> {
    CodecRegistry::new()
        .find_by_name(codec_name)
        .ok_or_else(|| {
            RomWeaverError::Unsupported(format!(
                "codec backend `{codec_name}` is not registered for {descriptor_name}"
            ))
        })
}

#[derive(Clone, Debug)]
struct ArchiveInputEntry {
    source: PathBuf,
    archive_name: String,
    is_dir: bool,
}

#[derive(Clone, Debug)]
enum SelectionPatternKind {
    ExactOrPrefix,
    Wildcard(WildcardPattern),
}

#[derive(Clone, Debug)]
struct SelectionPattern {
    requested: String,
    kind: SelectionPatternKind,
}

impl SelectionPattern {
    fn new(requested: String) -> Self {
        if Self::contains_glob_syntax(&requested) {
            let wildcard = WildcardPattern::new(&requested);
            return Self {
                requested,
                kind: SelectionPatternKind::Wildcard(wildcard),
            };
        }
        Self {
            requested,
            kind: SelectionPatternKind::ExactOrPrefix,
        }
    }

    fn contains_glob_syntax(value: &str) -> bool {
        value
            .bytes()
            .any(|byte| matches!(byte, b'*' | b'?' | b'[' | b'{' | b']' | b'}'))
    }

    fn matches(&self, entry_name: &str) -> bool {
        match &self.kind {
            SelectionPatternKind::ExactOrPrefix => {
                entry_name == self.requested
                    || entry_name.starts_with(&format!("{}/", self.requested))
            }
            SelectionPatternKind::Wildcard(pattern) => pattern.matches(entry_name),
        }
    }
}

#[derive(Clone, Debug)]
struct WildcardPattern {
    segments: Vec<PathPatternSegment>,
}

#[derive(Clone, Debug)]
enum PathPatternSegment {
    AnyDepth,
    OneSegment(String),
}

impl WildcardPattern {
    fn new(pattern: &str) -> Self {
        let segments = pattern
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(|segment| {
                if segment == "**" {
                    PathPatternSegment::AnyDepth
                } else {
                    PathPatternSegment::OneSegment(segment.to_string())
                }
            })
            .collect::<Vec<_>>();
        Self { segments }
    }

    fn matches(&self, entry_name: &str) -> bool {
        let path_segments = entry_name
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        Self::matches_path_segments(&self.segments, &path_segments)
    }

    fn matches_path_segments(
        pattern_segments: &[PathPatternSegment],
        path_segments: &[&str],
    ) -> bool {
        match pattern_segments.split_first() {
            None => path_segments.is_empty(),
            Some((PathPatternSegment::AnyDepth, remaining)) => {
                if Self::matches_path_segments(remaining, path_segments) {
                    return true;
                }
                if let Some((_, tail)) = path_segments.split_first() {
                    return Self::matches_path_segments(pattern_segments, tail);
                }
                false
            }
            Some((PathPatternSegment::OneSegment(pattern), remaining)) => {
                let Some((segment, tail)) = path_segments.split_first() else {
                    return false;
                };
                if !matches_wildcard_segment(pattern, segment) {
                    return false;
                }
                Self::matches_path_segments(remaining, tail)
            }
        }
    }
}

fn matches_wildcard_segment(pattern: &str, candidate: &str) -> bool {
    let pattern_chars = pattern.chars().collect::<Vec<_>>();
    let candidate_chars = candidate.chars().collect::<Vec<_>>();
    matches_wildcard_segment_inner(&pattern_chars, &candidate_chars, 0, 0)
}

fn matches_wildcard_segment_inner(
    pattern: &[char],
    candidate: &[char],
    pattern_index: usize,
    candidate_index: usize,
) -> bool {
    let mut pattern_index = pattern_index;
    let mut candidate_index = candidate_index;

    while pattern_index < pattern.len() {
        match pattern[pattern_index] {
            '*' => {
                while pattern_index < pattern.len() && pattern[pattern_index] == '*' {
                    pattern_index += 1;
                }
                if pattern_index == pattern.len() {
                    return true;
                }
                for next_candidate_index in candidate_index..=candidate.len() {
                    if matches_wildcard_segment_inner(
                        pattern,
                        candidate,
                        pattern_index,
                        next_candidate_index,
                    ) {
                        return true;
                    }
                }
                return false;
            }
            '?' => {
                if candidate_index == candidate.len() {
                    return false;
                }
                pattern_index += 1;
                candidate_index += 1;
            }
            '[' => {
                let Some(class_end) = find_character_class_end(pattern, pattern_index + 1) else {
                    if candidate_index == candidate.len() || candidate[candidate_index] != '[' {
                        return false;
                    }
                    pattern_index += 1;
                    candidate_index += 1;
                    continue;
                };
                if candidate_index == candidate.len() {
                    return false;
                }
                if !character_class_matches(
                    &pattern[pattern_index + 1..class_end],
                    candidate[candidate_index],
                ) {
                    return false;
                }
                pattern_index = class_end + 1;
                candidate_index += 1;
            }
            expected => {
                if candidate_index == candidate.len() || candidate[candidate_index] != expected {
                    return false;
                }
                pattern_index += 1;
                candidate_index += 1;
            }
        }
    }

    candidate_index == candidate.len()
}

fn find_character_class_end(pattern: &[char], class_start: usize) -> Option<usize> {
    let mut index = class_start;
    while index < pattern.len() {
        if pattern[index] == ']' {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn character_class_matches(class: &[char], value: char) -> bool {
    if class.is_empty() {
        return false;
    }

    let mut index = 0usize;
    let mut negated = false;
    if matches!(class.first(), Some('!') | Some('^')) {
        negated = true;
        index = 1;
    }

    let mut matched = false;
    while index < class.len() {
        let current = class[index];
        if index + 2 < class.len() && class[index + 1] == '-' {
            let range_end = class[index + 2];
            if current <= value && value <= range_end {
                matched = true;
            }
            index += 3;
            continue;
        }

        if current == value {
            matched = true;
        }
        index += 1;
    }

    if negated { !matched } else { matched }
}

#[derive(Debug, Default)]
struct SelectionMatcher {
    requested: Vec<SelectionPattern>,
    matched: BTreeSet<String>,
}

impl SelectionMatcher {
    fn new(requested: &[String]) -> Self {
        let requested = requested
            .iter()
            .map(|value| normalize_archive_name(value))
            .filter(|value| !value.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(SelectionPattern::new)
            .collect::<Vec<_>>();
        Self {
            requested,
            matched: BTreeSet::new(),
        }
    }

    fn matches(&mut self, entry_name: &str) -> bool {
        if self.requested.is_empty() {
            return true;
        }
        let entry_name = normalize_archive_name(entry_name);
        if entry_name.is_empty() {
            return false;
        }
        for requested in &self.requested {
            if requested.matches(&entry_name) {
                self.matched.insert(requested.requested.clone());
                return true;
            }
        }
        false
    }

    fn ensure_all_matched(&self) -> Result<()> {
        let missing = self
            .requested
            .iter()
            .filter_map(|requested| {
                (!self.matched.contains(&requested.requested))
                    .then_some(requested.requested.clone())
            })
            .collect::<Vec<_>>();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(RomWeaverError::Validation(format!(
                "requested selections were not found: {}",
                missing.join(", ")
            )))
        }
    }
}

fn normalize_archive_name(name: &str) -> String {
    name.trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_matches('/')
        .to_string()
}

fn sanitize_archive_relative_path_from_str(name: &str) -> Result<PathBuf> {
    let normalized = name.replace('\\', "/");
    let path = Path::new(&normalized);
    sanitize_archive_relative_path(path)
}

fn sanitize_archive_relative_path(path: &Path) -> Result<PathBuf> {
    let mut sanitized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => sanitized.push(value),
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err(RomWeaverError::Validation(format!(
                    "archive entry path is not safe for extraction: `{}`",
                    path.display()
                )));
            }
        }
    }
    if sanitized.as_os_str().is_empty() {
        return Err(RomWeaverError::Validation(format!(
            "archive entry path is empty: `{}`",
            path.display()
        )));
    }
    Ok(sanitized)
}

fn archive_path_to_name(path: &Path) -> Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err(RomWeaverError::Validation(format!(
                    "path cannot be represented inside archive: `{}`",
                    path.display()
                )));
            }
        }
    }
    if parts.is_empty() {
        return Err(RomWeaverError::Validation(format!(
            "path cannot be represented inside archive: `{}`",
            path.display()
        )));
    }
    Ok(parts.join("/"))
}

const LIBARCHIVE_CREATE_IO_BUFFER_BYTES: usize = 128 * 1024;
const LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES: usize = 1024 * 1024;
const AE_IFREG_MODE: c_uint = 0o100000;
const AE_IFDIR_MODE: c_uint = 0o040000;

#[derive(Clone, Copy, Debug)]
enum LibarchiveCreateFormat {
    Zip,
    SevenZ,
    TarPax,
}

#[derive(Clone, Copy, Debug)]
enum LibarchiveCreateFilter {
    None,
    Gzip,
    Bzip2,
    Xz,
}

impl LibarchiveCreateFilter {
    const fn module_name(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Gzip => Some("gzip"),
            Self::Bzip2 => Some("bzip2"),
            Self::Xz => Some("xz"),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct LibarchiveCreateConfig {
    format_name: &'static str,
    format: LibarchiveCreateFormat,
    filter: LibarchiveCreateFilter,
    format_compression: Option<&'static str>,
    compression_level: Option<i32>,
    format_threads: Option<usize>,
    filter_threads: Option<usize>,
    io_buffer_bytes: usize,
}

fn libarchive_open_create_archive(
    output: &Path,
    config: LibarchiveCreateConfig,
) -> Result<*mut archive> {
    let archive_ptr = unsafe { archive_write_new() };
    if archive_ptr.is_null() {
        return Err(RomWeaverError::Validation(format!(
            "{} create failed: libarchive writer allocation returned null",
            config.format_name
        )));
    }

    let output_path = path_to_libarchive_cstring(output, "container output")?;
    let setup_result = (|| -> Result<()> {
        match config.format {
            LibarchiveCreateFormat::Zip => libarchive_check_status(
                unsafe { archive_write_set_format_zip(archive_ptr) },
                archive_ptr,
                &format!(
                    "{} create failed while selecting zip format",
                    config.format_name
                ),
            )?,
            LibarchiveCreateFormat::SevenZ => libarchive_check_status(
                unsafe { archive_write_set_format_7zip(archive_ptr) },
                archive_ptr,
                &format!(
                    "{} create failed while selecting 7z format",
                    config.format_name
                ),
            )?,
            LibarchiveCreateFormat::TarPax => libarchive_check_status(
                unsafe { archive_write_set_format_pax_restricted(archive_ptr) },
                archive_ptr,
                &format!(
                    "{} create failed while selecting tar format",
                    config.format_name
                ),
            )?,
        }

        match config.filter {
            LibarchiveCreateFilter::None => libarchive_check_status(
                unsafe { archive_write_add_filter_none(archive_ptr) },
                archive_ptr,
                &format!(
                    "{} create failed while enabling no-op filter",
                    config.format_name
                ),
            )?,
            LibarchiveCreateFilter::Gzip => libarchive_check_status(
                unsafe { archive_write_add_filter_gzip(archive_ptr) },
                archive_ptr,
                &format!(
                    "{} create failed while enabling gzip filter",
                    config.format_name
                ),
            )?,
            LibarchiveCreateFilter::Bzip2 => libarchive_check_status(
                unsafe { archive_write_add_filter_bzip2(archive_ptr) },
                archive_ptr,
                &format!(
                    "{} create failed while enabling bzip2 filter",
                    config.format_name
                ),
            )?,
            LibarchiveCreateFilter::Xz => libarchive_check_status(
                unsafe { archive_write_add_filter_xz(archive_ptr) },
                archive_ptr,
                &format!(
                    "{} create failed while enabling xz filter",
                    config.format_name
                ),
            )?,
        }

        if let Some(compression) = config.format_compression {
            libarchive_set_format_option(
                archive_ptr,
                config.format_name,
                None,
                "compression",
                compression,
            )?;
        }

        if let Some(level) = config.compression_level {
            if config.format_compression.is_some() {
                libarchive_set_format_option(
                    archive_ptr,
                    config.format_name,
                    None,
                    "compression-level",
                    &level.to_string(),
                )?;
            } else {
                match config.filter {
                    LibarchiveCreateFilter::Gzip => libarchive_set_filter_option(
                        archive_ptr,
                        config.format_name,
                        "gzip",
                        "compression-level",
                        &level.to_string(),
                    )?,
                    LibarchiveCreateFilter::Bzip2 => libarchive_set_filter_option(
                        archive_ptr,
                        config.format_name,
                        "bzip2",
                        "compression-level",
                        &level.to_string(),
                    )?,
                    LibarchiveCreateFilter::Xz => libarchive_set_filter_option(
                        archive_ptr,
                        config.format_name,
                        "xz",
                        "compression-level",
                        &level.to_string(),
                    )?,
                    LibarchiveCreateFilter::None => {}
                }
            }
        }

        if let Some(threads) = config.format_threads {
            if config.format_compression.is_some() {
                libarchive_try_set_format_option(
                    archive_ptr,
                    config.format_name,
                    None,
                    "threads",
                    &threads.to_string(),
                )?;
            }
        }

        if let Some(threads) = config.filter_threads {
            if let Some(module) = config.filter.module_name() {
                libarchive_try_set_filter_option(
                    archive_ptr,
                    config.format_name,
                    module,
                    "threads",
                    &threads.to_string(),
                )?;
            }
        }

        libarchive_check_status(
            unsafe { archive_write_open_filename(archive_ptr, output_path.as_ptr()) },
            archive_ptr,
            &format!(
                "{} create failed while opening output `{}`",
                config.format_name,
                output.display()
            ),
        )?;
        Ok(())
    })();

    if let Err(error) = setup_result {
        let _ = unsafe { archive_write_free(archive_ptr) };
        return Err(error);
    }

    Ok(archive_ptr)
}

fn libarchive_write_archive_entry(
    archive_ptr: *mut archive,
    format_name: &str,
    entry: &ArchiveInputEntry,
    io_buffer_bytes: usize,
) -> Result<u64> {
    let entry_ptr = unsafe { archive_entry_new() };
    if entry_ptr.is_null() {
        return Err(RomWeaverError::Validation(format!(
            "{format_name} create failed: libarchive entry allocation returned null"
        )));
    }

    let path_name = if entry.is_dir && !entry.archive_name.ends_with('/') {
        format!("{}/", entry.archive_name)
    } else {
        entry.archive_name.clone()
    };
    let path_name = CString::new(path_name).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: archive entry name contained interior NUL"
        ))
    })?;

    let entry_size = if entry.is_dir {
        0u64
    } else {
        fs::metadata(&entry.source)?.len()
    };
    let entry_size = i64::try_from(entry_size).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: input length exceeded libarchive entry size range"
        ))
    })?;

    let write_result = (|| -> Result<u64> {
        unsafe {
            archive_entry_set_pathname(entry_ptr, path_name.as_ptr());
            archive_entry_set_filetype(
                entry_ptr,
                if entry.is_dir {
                    AE_IFDIR_MODE
                } else {
                    AE_IFREG_MODE
                },
            );
            archive_entry_set_perm(entry_ptr, if entry.is_dir { 0o755 } else { 0o644 });
            archive_entry_set_size(entry_ptr, entry_size);
        }

        libarchive_check_status(
            unsafe { archive_write_header(archive_ptr, entry_ptr) },
            archive_ptr,
            &format!(
                "{format_name} create failed while writing header for `{}`",
                entry.archive_name
            ),
        )?;

        let mut logical_bytes = 0u64;
        if !entry.is_dir {
            let mut source = BufReader::new(File::open(&entry.source)?);
            let mut buffer = vec![0u8; io_buffer_bytes];
            loop {
                let read = source.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                libarchive_write_payload(archive_ptr, format_name, &buffer[..read])?;
                logical_bytes = logical_bytes.saturating_add(read as u64);
            }
        }

        libarchive_check_status(
            unsafe { archive_write_finish_entry(archive_ptr) },
            archive_ptr,
            &format!(
                "{format_name} create failed while finalizing entry `{}`",
                entry.archive_name
            ),
        )?;
        Ok(logical_bytes)
    })();

    unsafe { archive_entry_free(entry_ptr) };
    write_result
}

fn libarchive_write_payload(
    archive_ptr: *mut archive,
    format_name: &str,
    payload: &[u8],
) -> Result<()> {
    let mut offset = 0usize;
    while offset < payload.len() {
        let written = unsafe {
            archive_write_data(
                archive_ptr,
                payload[offset..].as_ptr() as *const std::os::raw::c_void,
                payload.len() - offset,
            )
        };
        if written < 0 {
            return Err(libarchive_error(
                archive_ptr,
                &format!("{format_name} create failed while writing payload"),
            ));
        }
        if written == 0 {
            return Err(RomWeaverError::Validation(format!(
                "{format_name} create failed: libarchive reported a zero-length write"
            )));
        }
        let written = usize::try_from(written).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{format_name} create failed: libarchive reported an invalid write length"
            ))
        })?;
        if written > payload.len() - offset {
            return Err(RomWeaverError::Validation(format!(
                "{format_name} create failed: libarchive wrote more bytes than provided"
            )));
        }
        offset = offset.saturating_add(written);
    }
    Ok(())
}

fn libarchive_close_create_archive(archive_ptr: *mut archive, format_name: &str) -> Result<()> {
    let close_result = libarchive_check_status(
        unsafe { archive_write_close(archive_ptr) },
        archive_ptr,
        &format!("{format_name} create failed while closing output"),
    );
    let free_result = libarchive_check_status(
        unsafe { archive_write_free(archive_ptr) },
        archive_ptr,
        &format!("{format_name} create failed while releasing writer"),
    );
    close_result.and(free_result)
}

fn write_archive_with_libarchive(
    request: &ContainerCreateRequest,
    entries: &[ArchiveInputEntry],
    context: &OperationContext,
    execution: &ThreadExecution,
    config: LibarchiveCreateConfig,
) -> Result<u64> {
    if let Some(parent) = request.output.parent() {
        fs::create_dir_all(parent)?;
    }

    let archive_ptr = libarchive_open_create_archive(&request.output, config)?;
    let result = (|| -> Result<u64> {
        let total_entries = entries.len();
        let mut logical_bytes = 0u64;
        for (entry_index, entry) in entries.iter().enumerate() {
            logical_bytes = logical_bytes.saturating_add(libarchive_write_archive_entry(
                archive_ptr,
                config.format_name,
                entry,
                config.io_buffer_bytes,
            )?);
            emit_container_step_progress(
                context,
                "compress",
                config.format_name,
                "create",
                entry_index.saturating_add(1),
                total_entries,
                format!(
                    "creating `{}` ({}/{})",
                    config.format_name,
                    entry_index.saturating_add(1),
                    total_entries
                ),
                Some(execution),
            );
        }
        Ok(logical_bytes)
    })();

    match (
        result,
        libarchive_close_create_archive(archive_ptr, config.format_name),
    ) {
        (Ok(bytes), Ok(())) => Ok(bytes),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn libarchive_set_format_option(
    archive_ptr: *mut archive,
    format_name: &str,
    module: Option<&str>,
    option: &str,
    value: &str,
) -> Result<()> {
    let module_cstring = match module {
        Some(value) => Some(CString::new(value).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{format_name} create failed: format option module contained interior NUL"
            ))
        })?),
        None => None,
    };
    let option_cstring = CString::new(option).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: format option key contained interior NUL"
        ))
    })?;
    let value_cstring = CString::new(value).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: format option value contained interior NUL"
        ))
    })?;

    libarchive_check_status(
        unsafe {
            archive_write_set_format_option(
                archive_ptr,
                module_cstring
                    .as_ref()
                    .map_or(ptr::null(), |value| value.as_ptr()),
                option_cstring.as_ptr(),
                value_cstring.as_ptr(),
            )
        },
        archive_ptr,
        &format!("{format_name} create failed while setting format option `{option}`"),
    )
}

fn libarchive_set_filter_option(
    archive_ptr: *mut archive,
    format_name: &str,
    module: &str,
    option: &str,
    value: &str,
) -> Result<()> {
    let module_cstring = CString::new(module).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: filter module contained interior NUL"
        ))
    })?;
    let option_cstring = CString::new(option).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: filter option key contained interior NUL"
        ))
    })?;
    let value_cstring = CString::new(value).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: filter option value contained interior NUL"
        ))
    })?;

    libarchive_check_status(
        unsafe {
            archive_write_set_filter_option(
                archive_ptr,
                module_cstring.as_ptr(),
                option_cstring.as_ptr(),
                value_cstring.as_ptr(),
            )
        },
        archive_ptr,
        &format!("{format_name} create failed while setting {module}:{option}={value}"),
    )
}

fn libarchive_try_set_format_option(
    archive_ptr: *mut archive,
    format_name: &str,
    module: Option<&str>,
    option: &str,
    value: &str,
) -> Result<()> {
    let module_cstring = match module {
        Some(value) => Some(CString::new(value).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{format_name} create failed: format option module contained interior NUL"
            ))
        })?),
        None => None,
    };
    let option_cstring = CString::new(option).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: format option key contained interior NUL"
        ))
    })?;
    let value_cstring = CString::new(value).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: format option value contained interior NUL"
        ))
    })?;

    let status = unsafe {
        archive_write_set_format_option(
            archive_ptr,
            module_cstring
                .as_ref()
                .map_or(ptr::null(), |value| value.as_ptr()),
            option_cstring.as_ptr(),
            value_cstring.as_ptr(),
        )
    };
    match status {
        ARCHIVE_OK | ARCHIVE_WARN => Ok(()),
        _ if libarchive_unsupported_option_error(archive_ptr) => Ok(()),
        _ => Err(libarchive_error(
            archive_ptr,
            &format!("{format_name} create failed while setting format option `{option}`"),
        )),
    }
}

fn libarchive_try_set_filter_option(
    archive_ptr: *mut archive,
    format_name: &str,
    module: &str,
    option: &str,
    value: &str,
) -> Result<()> {
    let module_cstring = CString::new(module).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: filter module contained interior NUL"
        ))
    })?;
    let option_cstring = CString::new(option).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: filter option key contained interior NUL"
        ))
    })?;
    let value_cstring = CString::new(value).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{format_name} create failed: filter option value contained interior NUL"
        ))
    })?;

    let status = unsafe {
        archive_write_set_filter_option(
            archive_ptr,
            module_cstring.as_ptr(),
            option_cstring.as_ptr(),
            value_cstring.as_ptr(),
        )
    };
    match status {
        ARCHIVE_OK | ARCHIVE_WARN => Ok(()),
        _ if libarchive_unsupported_option_error(archive_ptr) => Ok(()),
        _ => Err(libarchive_error(
            archive_ptr,
            &format!("{format_name} create failed while setting {module}:{option}={value}"),
        )),
    }
}

fn libarchive_check_status(status: i32, archive_ptr: *mut archive, context: &str) -> Result<()> {
    match status {
        ARCHIVE_OK | ARCHIVE_WARN => Ok(()),
        _ => Err(libarchive_error(archive_ptr, context)),
    }
}

fn libarchive_error(archive_ptr: *mut archive, context: &str) -> RomWeaverError {
    let message = unsafe {
        let error_ptr = archive_error_string(archive_ptr);
        if error_ptr.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(error_ptr)
                .to_string_lossy()
                .into_owned()
        }
    };
    let message = if message.trim().is_empty() {
        "unknown libarchive failure".to_string()
    } else {
        message
    };
    let errno = unsafe { archive_errno(archive_ptr) };
    RomWeaverError::Validation(format!("{context}: {message} (errno={errno})"))
}

fn libarchive_unsupported_option_error(archive_ptr: *mut archive) -> bool {
    let message = unsafe {
        let error_ptr = archive_error_string(archive_ptr);
        if error_ptr.is_null() {
            return false;
        }
        std::ffi::CStr::from_ptr(error_ptr)
            .to_string_lossy()
            .to_ascii_lowercase()
    };
    message.contains("undefined option") || message.contains("unknown module name")
}

fn path_to_libarchive_cstring(path: &Path, label: &str) -> Result<CString> {
    CString::new(path.to_string_lossy().as_bytes()).map_err(|_| {
        RomWeaverError::Validation(format!(
            "{label} path contains interior NUL bytes: `{}`",
            path.display()
        ))
    })
}

fn emit_container_running_progress(
    context: &OperationContext,
    command: &str,
    format: &str,
    stage: &str,
    label: impl Into<String>,
    percent: f32,
    thread_execution: Option<&ThreadExecution>,
) {
    let clamped_percent = percent.clamp(0.0, 100.0);
    context.emit(ProgressEvent {
        command: command.to_string(),
        family: OperationFamily::Container,
        format: Some(format.to_string()),
        stage: stage.to_string(),
        label: label.into(),
        details: None,
        percent: Some(clamped_percent),
        requested_threads: thread_execution.map(|value| value.requested_threads),
        effective_threads: thread_execution.map(|value| value.effective_threads),
        thread_mode: thread_execution.map(|value| value.thread_mode),
        used_parallelism: thread_execution.map(|value| value.used_parallelism),
        thread_fallback: thread_execution.map(|value| value.thread_fallback),
        thread_fallback_reason: thread_execution
            .and_then(|value| value.thread_fallback_reason.clone()),
        status: OperationStatus::Running,
    });
}

fn emit_container_step_progress(
    context: &OperationContext,
    command: &str,
    format: &str,
    stage: &str,
    completed_steps: usize,
    total_steps: usize,
    label: impl Into<String>,
    thread_execution: Option<&ThreadExecution>,
) {
    if total_steps == 0 {
        return;
    }
    let completed = completed_steps.min(total_steps);
    let percent = (completed as f32 / total_steps as f32) * 100.0;
    emit_container_running_progress(
        context,
        command,
        format,
        stage,
        label,
        percent,
        thread_execution,
    );
}

#[derive(Clone, Debug)]
struct LibarchiveExtractTask {
    index: usize,
    archive_name: String,
    output_path: PathBuf,
    is_dir: bool,
}

#[derive(Clone, Copy, Debug)]
enum LibarchiveProbeFormat {
    Zip,
    SevenZ,
    Rar,
    Tar,
}

#[derive(Clone, Debug)]
struct LibarchiveInspectSummary {
    entries_total: usize,
    files: usize,
    directories: usize,
    archive_bytes: u64,
    logical_bytes: u64,
}

fn open_libarchive_reader(
    source: &Path,
    format_name: &str,
) -> Result<LibarchiveReadArchive<'static>> {
    let file = File::open(source)?;
    LibarchiveReadArchive::open_io(file).map_err(|error| {
        RomWeaverError::Validation(format!("{format_name} archive is invalid: {error}"))
    })
}

fn libarchive_format_matches(format: i32, expected: LibarchiveProbeFormat) -> bool {
    let base_format = format & ARCHIVE_FORMAT_BASE_MASK;
    match expected {
        LibarchiveProbeFormat::Zip => base_format == ARCHIVE_FORMAT_ZIP,
        LibarchiveProbeFormat::SevenZ => base_format == ARCHIVE_FORMAT_7ZIP,
        LibarchiveProbeFormat::Rar => {
            base_format == ARCHIVE_FORMAT_RAR || base_format == ARCHIVE_FORMAT_RAR_V5
        }
        LibarchiveProbeFormat::Tar => base_format == ARCHIVE_FORMAT_TAR,
    }
}

fn detect_libarchive_format(source: &Path, format_name: &str) -> Result<i32> {
    let mut reader = open_libarchive_reader(source, format_name)?;
    let first_entry = reader.next_entry().map_err(|error| {
        RomWeaverError::Validation(format!(
            "{format_name} probe failed while reading header: {error}"
        ))
    })?;
    drop(first_entry);
    Ok(reader.format())
}

fn probe_regular_archive_with_libarchive(
    source: &Path,
    format_name: &str,
    expected: LibarchiveProbeFormat,
) -> ProbeConfidence {
    match detect_libarchive_format(source, format_name) {
        Ok(format) if libarchive_format_matches(format, expected) => ProbeConfidence::Signature,
        _ => ProbeConfidence::Extension,
    }
}

fn inspect_regular_archive_with_libarchive(
    source: &Path,
    format_name: &str,
) -> Result<LibarchiveInspectSummary> {
    let mut reader = open_libarchive_reader(source, format_name)?;
    let mut summary = LibarchiveInspectSummary {
        entries_total: 0,
        files: 0,
        directories: 0,
        archive_bytes: fs::metadata(source)?.len(),
        logical_bytes: 0,
    };
    let mut index = 0usize;

    while let Some(entry) = reader.next_entry().map_err(|error| {
        RomWeaverError::Validation(format!(
            "{format_name} inspect failed while reading entry {index}: {error}"
        ))
    })? {
        let entry_path = match entry.pathname_utf8() {
            Ok(path) => path.to_owned(),
            Err(_) => entry
                .pathname_mb()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "{format_name} inspect failed while decoding entry {index}: {error}"
                    ))
                })?,
        };
        if normalize_archive_name(&entry_path).is_empty() {
            index = index.saturating_add(1);
            continue;
        }

        summary.entries_total = summary.entries_total.saturating_add(1);
        if entry.is_dir() {
            summary.directories = summary.directories.saturating_add(1);
        } else {
            summary.files = summary.files.saturating_add(1);
            if let Some(size) = entry.size() {
                summary.logical_bytes = summary.logical_bytes.saturating_add(size);
            }
        }
        index = index.saturating_add(1);
    }

    Ok(summary)
}

fn list_regular_archive_entries_with_libarchive(
    source: &Path,
    format_name: &str,
) -> Result<Vec<String>> {
    let mut reader = open_libarchive_reader(source, format_name)?;
    let mut entries = Vec::new();
    let mut index = 0usize;

    while let Some(entry) = reader.next_entry().map_err(|error| {
        RomWeaverError::Validation(format!(
            "{format_name} list failed while reading entry {index}: {error}"
        ))
    })? {
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
        let archive_name = normalize_archive_name(&entry_path);
        if !archive_name.is_empty() {
            entries.push(archive_name);
        }
        index = index.saturating_add(1);
    }

    Ok(entries)
}

fn build_libarchive_extract_tasks(
    source: &Path,
    out_dir: &Path,
    selections: &[String],
    format_name: &str,
) -> Result<Vec<LibarchiveExtractTask>> {
    let mut reader = open_libarchive_reader(source, format_name)?;
    let mut matcher = SelectionMatcher::new(selections);
    let mut tasks = Vec::new();
    let mut index = 0usize;

    while let Some(entry) = reader.next_entry().map_err(|error| {
        RomWeaverError::Validation(format!(
            "{format_name} extract failed while reading entry {index}: {error}"
        ))
    })? {
        let entry_path = match entry.pathname_utf8() {
            Ok(path) => path.to_owned(),
            Err(_) => entry
                .pathname_mb()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "{format_name} extract failed while decoding entry {index}: {error}"
                    ))
                })?,
        };
        let archive_name = normalize_archive_name(&entry_path);
        if archive_name.is_empty() || !matcher.matches(&archive_name) {
            index = index.saturating_add(1);
            continue;
        }
        let relative = sanitize_archive_relative_path_from_str(&entry_path)?;
        tasks.push(LibarchiveExtractTask {
            index,
            archive_name,
            output_path: out_dir.join(relative),
            is_dir: entry.is_dir() || entry_path.ends_with('/') || entry_path.ends_with('\\'),
        });
        index = index.saturating_add(1);
    }

    matcher.ensure_all_matched()?;
    Ok(tasks)
}

fn extract_libarchive_task_chunk<F>(
    source: &Path,
    chunk: &[LibarchiveExtractTask],
    format_name: &str,
    mut on_task_complete: F,
) -> Result<u64>
where
    F: FnMut(),
{
    if chunk.is_empty() {
        return Ok(0);
    }

    let mut reader = open_libarchive_reader(source, format_name)?;
    let mut tasks_by_index = BTreeMap::new();
    for task in chunk {
        tasks_by_index.insert(task.index, task);
    }

    let mut current_index = 0usize;
    let mut matched_tasks = 0usize;
    let mut written_bytes = 0u64;

    while let Some(entry) = reader.next_entry().map_err(|error| {
        RomWeaverError::Validation(format!(
            "{format_name} extract failed while reading entry {current_index}: {error}"
        ))
    })? {
        let Some(task) = tasks_by_index.get(&current_index).copied() else {
            current_index = current_index.saturating_add(1);
            continue;
        };

        if task.is_dir {
            fs::create_dir_all(&task.output_path)?;
        } else {
            if let Some(parent) = task.output_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut input = entry.into_reader();
            let mut output = BufWriter::new(File::create(&task.output_path)?);
            let copied = io::copy(&mut input, &mut output).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{format_name} extract failed while reading entry {} (`{}`): {error}",
                    task.index, task.archive_name
                ))
            })?;
            output.flush()?;
            written_bytes = written_bytes.saturating_add(copied);
        }

        matched_tasks = matched_tasks.saturating_add(1);
        on_task_complete();
        if matched_tasks == tasks_by_index.len() {
            break;
        }
        current_index = current_index.saturating_add(1);
    }

    if matched_tasks != tasks_by_index.len() {
        return Err(RomWeaverError::Validation(format!(
            "{format_name} extract failed because selected entries changed while processing"
        )));
    }

    Ok(written_bytes)
}

fn extract_regular_archive_with_libarchive(
    request: &ContainerExtractRequest,
    context: &OperationContext,
    format_name: &'static str,
    limit_threads_to_task_count: bool,
) -> Result<OperationReport> {
    fs::create_dir_all(&request.out_dir)?;
    let tasks = build_libarchive_extract_tasks(
        &request.source,
        &request.out_dir,
        &request.selections,
        format_name,
    )?;
    let total_tasks = tasks.len();

    let mut output_paths = BTreeSet::new();
    let mut duplicate_output_paths = false;
    for task in &tasks {
        if task.is_dir {
            continue;
        }
        duplicate_output_paths |= !output_paths.insert(task.output_path.clone());
    }

    let (execution, written_bytes) = if tasks.is_empty() || duplicate_output_paths {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let mut completed = 0usize;
        let written = extract_libarchive_task_chunk(&request.source, &tasks, format_name, || {
            completed = completed.saturating_add(1);
            emit_container_step_progress(
                context,
                "extract",
                format_name,
                "extract",
                completed,
                total_tasks,
                format!("extracting `{format_name}` ({completed}/{total_tasks})"),
                Some(&execution),
            );
        })?;
        (execution, written)
    } else {
        let file_task_count = tasks.iter().filter(|task| !task.is_dir).count().max(1);
        let capability = if limit_threads_to_task_count {
            ThreadCapability::parallel(Some(file_task_count))
        } else {
            ThreadCapability::parallel(None)
        };
        let (execution, pool) = context.build_pool(capability)?;
        let source = request.source.clone();
        let completed_tasks = Arc::new(AtomicUsize::new(0));
        let progress_context = context.clone();
        let progress_execution = execution.clone();

        let written_bytes = if execution.used_parallelism {
            let worker_count = execution.effective_threads.max(1);
            let chunk_size = tasks.len().div_ceil(worker_count).max(1);
            let chunk_results = pool.install(|| {
                tasks
                    .par_chunks(chunk_size)
                    .map(|chunk| {
                        let completed_tasks = Arc::clone(&completed_tasks);
                        let progress_context = progress_context.clone();
                        let progress_execution = progress_execution.clone();
                        extract_libarchive_task_chunk(&source, chunk, format_name, || {
                            let completed = completed_tasks
                                .fetch_add(1, Ordering::Relaxed)
                                .saturating_add(1);
                            emit_container_step_progress(
                                &progress_context,
                                "extract",
                                format_name,
                                "extract",
                                completed,
                                total_tasks,
                                format!("extracting `{format_name}` ({completed}/{total_tasks})"),
                                Some(&progress_execution),
                            );
                        })
                    })
                    .collect::<Result<Vec<_>>>()
            })?;
            chunk_results
                .into_iter()
                .fold(0u64, |acc, value| acc.saturating_add(value))
        } else {
            let mut completed = 0usize;
            extract_libarchive_task_chunk(&source, &tasks, format_name, || {
                completed = completed.saturating_add(1);
                emit_container_step_progress(
                    &progress_context,
                    "extract",
                    format_name,
                    "extract",
                    completed,
                    total_tasks,
                    format!("extracting `{format_name}` ({completed}/{total_tasks})"),
                    Some(&progress_execution),
                );
            })?
        };
        (execution, written_bytes)
    };

    Ok(OperationReport::succeeded(
        OperationFamily::Container,
        Some(format_name.to_string()),
        "extract",
        format!(
            "extracted `{}` to `{}` ({} file(s), {} bytes written)",
            request.source.display(),
            request.out_dir.display(),
            tasks.iter().filter(|task| !task.is_dir).count(),
            written_bytes
        ),
        Some(100.0),
        Some(execution),
    ))
}

fn collect_archive_inputs(inputs: &[PathBuf]) -> Result<Vec<ArchiveInputEntry>> {
    if inputs.is_empty() {
        return Err(RomWeaverError::Validation(
            "at least one input path is required".into(),
        ));
    }

    let mut entries = Vec::new();
    for input in inputs {
        let root = input.parent().unwrap_or_else(|| Path::new(""));
        collect_archive_inputs_from_path(input, root, &mut entries)?;
    }
    Ok(entries)
}

fn collect_archive_inputs_from_path(
    source: &Path,
    root: &Path,
    entries: &mut Vec<ArchiveInputEntry>,
) -> Result<()> {
    let metadata = fs::metadata(source)?;
    let relative = source.strip_prefix(root).map_err(|_| {
        RomWeaverError::Validation(format!(
            "failed to derive archive entry name from input `{}`",
            source.display()
        ))
    })?;
    let archive_name = archive_path_to_name(relative)?;

    if metadata.is_dir() {
        entries.push(ArchiveInputEntry {
            source: source.to_path_buf(),
            archive_name,
            is_dir: true,
        });

        let mut children = fs::read_dir(source)?.collect::<io::Result<Vec<_>>>()?;
        children.sort_by(|left, right| left.path().cmp(&right.path()));
        for child in children {
            let file_type = child.file_type()?;
            if file_type.is_dir() || file_type.is_file() {
                collect_archive_inputs_from_path(&child.path(), root, entries)?;
            }
        }
    } else if metadata.is_file() {
        entries.push(ArchiveInputEntry {
            source: source.to_path_buf(),
            archive_name,
            is_dir: false,
        });
    } else {
        return Err(RomWeaverError::Validation(format!(
            "unsupported input type for archive creation: `{}`",
            source.display()
        )));
    }

    Ok(())
}

include!("handlers/zip.rs");

include!("handlers/tar.rs");

include!("handlers/stream.rs");

include!("handlers/cso.rs");

include!("handlers/sevenz.rs");

include!("handlers/rar.rs");

include!("handlers/pbp.rs");

include!("handlers/xiso.rs");

include!("handlers/gcz.rs");

include!("handlers/wia.rs");

include!("handlers/tgc.rs");

include!("handlers/nfs.rs");

include!("handlers/wbfs.rs");

include!("handlers/rvz.rs");

include!("handlers/z3ds.rs");

include!("../tests/unit/handlers.rs");
