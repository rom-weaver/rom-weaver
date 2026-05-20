use std::collections::BTreeMap;
#[cfg(target_family = "wasm")]
use std::io::Cursor;
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    num::NonZeroU64,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};

use bzip2::{
    Compression as Bzip2Compression, read::MultiBzDecoder as Bzip2Decoder, write::BzEncoder,
};
use ciso::{read::CSOReader as CsoReader, split::SplitFileReader};
use flate2::{
    Compression as GzipCompression, read::DeflateDecoder, read::MultiGzDecoder,
    write::DeflateEncoder, write::GzEncoder,
};
use lz4_flex::frame::{
    BlockMode as Lz4BlockMode, BlockSize as Lz4BlockSize, FrameEncoder as Lz4FrameEncoder,
    FrameInfo as Lz4FrameInfo,
};
use lzma_rust2::{LzmaOptions, LzmaWriter, XzOptions, XzReader, XzReaderMt, XzWriter, XzWriterMt};
use nod::{
    common::{Compression as NodCompression, Format as NodFormat},
    read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader},
    util::buf_copy as nod_buf_copy,
    write::{
        DiscWriter as NodDiscWriter, FormatOptions as NodFormatOptions,
        ProcessOptions as NodProcessOptions,
    },
};
use rars::ArchiveReader as RarRsArchiveReader;
use rayon::prelude::*;
use rom_weaver_codecs::{
    CanonicalCodec, CodecRegistry, RequestedCodec, normalize_codec_label, parse_requested_codec,
};
use rom_weaver_core::{
    CodecBackend, CodecOperationRequest, ContainerCapabilities, ContainerCreateRequest,
    ContainerExtractRequest, ContainerHandler, ContainerInspectRequest, FormatDescriptor,
    OperationContext, OperationFamily, OperationReport, OperationStatus, ProbeConfidence,
    ProgressEvent, Result, RomWeaverError, ThreadCapability, ThreadExecution,
};
use sevenz_rust::{
    ArchiveEntry as SevenZArchiveEntry, ArchiveReader as SevenZReader,
    ArchiveWriter as SevenZWriter, EncoderConfiguration as SevenZMethodConfiguration,
    EncoderMethod as SevenZMethod, Password as SevenZPassword,
};
use sha1::{Digest, Sha1};
use tar::{Archive as TarArchive, Builder as TarBuilder};
use xdvdfs::{
    blockdev::OffsetWrapper as XdvdfsOffsetWrapper, write::fs::XDVDFSFilesystem as XdvdfsFilesystem,
};
use zip::{
    CompressionMethod as ZipCompressionMethod, ZipArchive as ZipFileArchive,
    ZipWriter as ZipFileWriter, write::SimpleFileOptions as ZipFileOptions,
};
use zstd::bulk::compress as zstd_compress;
use zstd_seekable::Seekable;

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
const CHD: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "chd",
    aliases: &["chd-cd", "chd-dvd", "chd-raw", "chd-hd"],
    extensions: &[".chd"],
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
            format_name: CHD.name,
            reason: "not-wii-gc-or-unrecognized",
        }
    }
}

const SEVEN_Z_SIGNATURE: [u8; 6] = [b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C];
const RAR4_SIGNATURE: [u8; 7] = [b'R', b'a', b'r', b'!', 0x1A, 0x07, 0x00];
const RAR5_SIGNATURE: [u8; 8] = [b'R', b'a', b'r', b'!', 0x1A, 0x07, 0x01, 0x00];
const GZIP_SIGNATURE: [u8; 2] = [0x1F, 0x8B];
const BZIP2_SIGNATURE: [u8; 3] = [b'B', b'Z', b'h'];
const XZ_SIGNATURE: [u8; 6] = [0xFD, b'7', b'z', b'X', b'Z', 0x00];
const ZSTD_SIGNATURE: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
const CSO_SIGNATURE: [u8; 4] = [b'C', b'I', b'S', b'O'];
const PBP_SIGNATURE: [u8; 4] = [0x00, b'P', b'B', b'P'];
const CHD_SIGNATURE: [u8; 8] = *b"MComprHD";
const CHD_MAX_COMPRESSORS: usize = 4;
const CHD_METADATA_FLAG_CHECKSUM: u8 = 0x01;
const CD_FRAME_SIZE: u32 = 2352 + 96;
const HARD_DISK_METADATA_TAG: u32 = make_tag(b'G', b'D', b'D', b'D');
const CDROM_TRACK_METADATA2_TAG: u32 = make_tag(b'C', b'H', b'T', b'2');
const GDROM_TRACK_METADATA_TAG: u32 = make_tag(b'C', b'H', b'G', b'D');
const DVD_METADATA_TAG: u32 = make_tag(b'D', b'V', b'D', b' ');

const fn make_tag(a: u8, b: u8, c: u8, d: u8) -> u32 {
    ((a as u32) << 24) | ((b as u32) << 16) | ((c as u32) << 8) | (d as u32)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChdCodec(u32);

impl ChdCodec {
    const NONE: Self = Self(0);
    const ZLIB: Self = Self(make_tag(b'z', b'l', b'i', b'b'));
    const ZSTD: Self = Self(make_tag(b'z', b's', b't', b'd'));
    const LZMA: Self = Self(make_tag(b'l', b'z', b'm', b'a'));
    const HUFFMAN: Self = Self(make_tag(b'h', b'u', b'f', b'f'));
    const AVHUFF: Self = Self(make_tag(b'a', b'v', b'h', b'u'));
    const FLAC: Self = Self(make_tag(b'f', b'l', b'a', b'c'));
    const CD_ZLIB: Self = Self(make_tag(b'c', b'd', b'z', b'l'));
    const CD_ZSTD: Self = Self(make_tag(b'c', b'd', b'z', b's'));
    const CD_LZMA: Self = Self(make_tag(b'c', b'd', b'l', b'z'));
    const CD_FLAC: Self = Self(make_tag(b'c', b'd', b'f', b'l'));

    const fn raw(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChdMediaKind {
    Raw,
    HardDisk,
    CdRom,
    GdRom,
    Dvd,
    Av,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChdHeader {
    version: u32,
    logical_bytes: u64,
    hunk_bytes: u32,
    hunk_count: u32,
    unit_bytes: u32,
    unit_count: u64,
    compressed: bool,
    compression: [ChdCodec; CHD_MAX_COMPRESSORS],
}

fn file_starts_with(source: &Path, signature: &[u8]) -> bool {
    let mut bytes = vec![0u8; signature.len()];
    if let Ok(mut file) = File::open(source) {
        return file.read_exact(&mut bytes).is_ok() && bytes == signature;
    }
    false
}

fn is_ustar_header(header: &[u8]) -> bool {
    header.len() >= 512
        && (header[257..263] == [b'u', b's', b't', b'a', b'r', 0x00]
            || header[257..263] == [b'u', b's', b't', b'a', b'r', b' '])
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

#[derive(Clone, Copy, Debug)]
enum ZipContainerFlavor {
    Zip,
    Zipx,
}

struct ZipContainerHandler {
    descriptor: &'static FormatDescriptor,
    flavor: ZipContainerFlavor,
}

#[derive(Clone, Debug)]
struct ZipExtractTask {
    index: usize,
    archive_name: String,
    output_path: PathBuf,
}

#[derive(Clone, Debug)]
struct ZipCreateTask {
    entry_index: usize,
    source: PathBuf,
    archive_name: String,
    temp_archive: PathBuf,
}

#[derive(Clone, Debug)]
struct ZipCreateArtifact {
    entry_index: usize,
    archive_name: String,
    logical_bytes: u64,
    temp_archive: PathBuf,
}

impl ZipContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor, flavor: ZipContainerFlavor) -> Self {
        Self { descriptor, flavor }
    }

    fn parse_codec(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<(ZipCompressionMethod, Option<i32>)> {
        let default = match self.flavor {
            ZipContainerFlavor::Zip => ZipCompressionMethod::Deflated,
            ZipContainerFlavor::Zipx => ZipCompressionMethod::Zstd,
        };
        let method = match parse_requested_codec(codec) {
            RequestedCodec::Unspecified => default,
            RequestedCodec::Known(CanonicalCodec::Store) => ZipCompressionMethod::Stored,
            RequestedCodec::Known(CanonicalCodec::Deflate) => ZipCompressionMethod::Deflated,
            RequestedCodec::Known(CanonicalCodec::Bzip2) => ZipCompressionMethod::Bzip2,
            RequestedCodec::Known(CanonicalCodec::Zstd) => ZipCompressionMethod::Zstd,
            RequestedCodec::Known(codec) => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported {} codec `{}`; supported codecs are store, deflate, bzip2, and zstd",
                    self.descriptor.name,
                    codec.name()
                )));
            }
            RequestedCodec::Unknown(name) => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported {} codec `{name}`; supported codecs are store, deflate, bzip2, and zstd",
                    self.descriptor.name
                )));
            }
        };

        if let Some(level) = level {
            let in_range = match method {
                ZipCompressionMethod::Stored => false,
                ZipCompressionMethod::Deflated | ZipCompressionMethod::Bzip2 => {
                    (0..=9).contains(&level)
                }
                ZipCompressionMethod::Zstd => (-7..=22).contains(&level),
                _ => false,
            };
            if !in_range {
                return Err(RomWeaverError::Validation(format!(
                    "level `{level}` is invalid for {} codec `{}`",
                    self.descriptor.name,
                    self.method_name(method)
                )));
            }
        }

        if method == ZipCompressionMethod::Stored && level.is_some() {
            return Err(RomWeaverError::Validation(format!(
                "{} codec `store` does not accept --level",
                self.descriptor.name
            )));
        }

        Ok((method, level))
    }

    fn method_name(&self, method: ZipCompressionMethod) -> &'static str {
        match method {
            ZipCompressionMethod::Stored => "store",
            ZipCompressionMethod::Deflated => "deflate",
            ZipCompressionMethod::Bzip2 => "bzip2",
            ZipCompressionMethod::Zstd => "zstd",
            _ => "unknown",
        }
    }

    fn build_options(&self, method: ZipCompressionMethod, level: Option<i32>) -> ZipFileOptions {
        ZipFileOptions::default()
            .compression_method(method)
            .compression_level(level.map(i64::from))
    }

    fn open_archive(&self, source: &Path) -> Result<ZipFileArchive<BufReader<File>>> {
        let file = File::open(source)?;
        ZipFileArchive::new(BufReader::new(file)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} archive is invalid: {error}",
                self.descriptor.name
            ))
        })
    }

    fn extract_task_with_archive(
        &self,
        archive: &mut ZipFileArchive<BufReader<File>>,
        task: &ZipExtractTask,
    ) -> Result<u64> {
        let mut entry = archive.by_index(task.index).map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} extract failed while reading entry {} (`{}`): {error}",
                self.descriptor.name, task.index, task.archive_name
            ))
        })?;
        if entry.is_dir() {
            fs::create_dir_all(&task.output_path)?;
            return Ok(0);
        }
        if let Some(parent) = task.output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(&task.output_path)?);
        io::copy(&mut entry, &mut output).map_err(Into::into)
    }

    fn extract_task_chunk<F>(
        &self,
        source: &Path,
        chunk: &[ZipExtractTask],
        mut on_task_complete: F,
    ) -> Result<u64>
    where
        F: FnMut(),
    {
        let mut archive = self.open_archive(source)?;
        let mut chunk_bytes = 0u64;
        for task in chunk {
            chunk_bytes =
                chunk_bytes.saturating_add(self.extract_task_with_archive(&mut archive, task)?);
            on_task_complete();
        }
        Ok(chunk_bytes)
    }

    fn build_create_tasks(
        &self,
        entries: &[ArchiveInputEntry],
        context: &OperationContext,
    ) -> Vec<ZipCreateTask> {
        entries
            .iter()
            .enumerate()
            .filter_map(|(entry_index, entry)| {
                (!entry.is_dir).then(|| ZipCreateTask {
                    entry_index,
                    source: entry.source.clone(),
                    archive_name: entry.archive_name.clone(),
                    temp_archive: context.temp_paths().next_path(
                        &format!("{}-create-{entry_index}", self.descriptor.name),
                        Some("zip"),
                    ),
                })
            })
            .collect()
    }

    fn compress_create_task(
        &self,
        task: &ZipCreateTask,
        method: ZipCompressionMethod,
        level: Option<i32>,
    ) -> Result<ZipCreateArtifact> {
        if let Some(parent) = task.temp_archive.parent() {
            fs::create_dir_all(parent)?;
        }

        let output = File::create(&task.temp_archive)?;
        let mut staged_archive = ZipFileWriter::new(BufWriter::new(output));
        staged_archive
            .start_file(task.archive_name.clone(), self.build_options(method, level))
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} create failed for `{}`: {error}",
                    self.descriptor.name, task.archive_name
                ))
            })?;

        let mut source = BufReader::new(File::open(&task.source)?);
        let logical_bytes = io::copy(&mut source, &mut staged_archive)?;
        staged_archive.finish().map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} create failed for `{}`: {error}",
                self.descriptor.name, task.archive_name
            ))
        })?;

        Ok(ZipCreateArtifact {
            entry_index: task.entry_index,
            archive_name: task.archive_name.clone(),
            logical_bytes,
            temp_archive: task.temp_archive.clone(),
        })
    }

    fn merge_create_artifact(
        &self,
        archive: &mut ZipFileWriter<BufWriter<File>>,
        artifact: &ZipCreateArtifact,
    ) -> Result<()> {
        let staged_file = File::open(&artifact.temp_archive)?;
        let mut staged_archive =
            ZipFileArchive::new(BufReader::new(staged_file)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} create failed while reading staged entry `{}`: {error}",
                    self.descriptor.name, artifact.archive_name
                ))
            })?;
        let staged_entry = staged_archive.by_index(0).map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} create failed while reading staged entry `{}`: {error}",
                self.descriptor.name, artifact.archive_name
            ))
        })?;
        archive.raw_copy_file(staged_entry).map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} create failed for `{}`: {error}",
                self.descriptor.name, artifact.archive_name
            ))
        })?;
        Ok(())
    }

    fn cleanup_create_artifacts(&self, artifacts: &[ZipCreateArtifact]) {
        for artifact in artifacts {
            let _ = fs::remove_file(&artifact.temp_archive);
        }
    }

    fn cleanup_create_tasks(&self, tasks: &[ZipCreateTask]) {
        for task in tasks {
            let _ = fs::remove_file(&task.temp_archive);
        }
    }
}

impl ContainerHandler for ZipContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.open_archive(source).is_ok() {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let mut archive = self.open_archive(&request.source)?;
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut compressed_bytes = 0u64;
        let mut logical_bytes = 0u64;

        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} inspect failed while reading entry {index}: {error}",
                    self.descriptor.name
                ))
            })?;
            if entry.is_dir() {
                directories += 1;
            } else {
                files += 1;
            }
            compressed_bytes = compressed_bytes.saturating_add(entry.compressed_size());
            logical_bytes = logical_bytes.saturating_add(entry.size());
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} entries ({} files, {} directories), {} bytes compressed, {} bytes uncompressed",
                self.descriptor.name,
                archive.len(),
                files,
                directories,
                compressed_bytes,
                logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        let mut archive = self.open_archive(&request.source)?;
        let mut entries = Vec::new();
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} list failed while reading entry {index}: {error}",
                    self.descriptor.name
                ))
            })?;
            let entry_name = normalize_archive_name(entry.name());
            if !entry_name.is_empty() {
                entries.push(entry_name);
            }
        }
        Ok(entries)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        fs::create_dir_all(&request.out_dir)?;

        let mut archive = self.open_archive(&request.source)?;
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut tasks = Vec::new();
        let mut output_paths = BTreeSet::new();
        let mut duplicate_output_paths = false;

        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} extract failed while reading entry {index}: {error}",
                    self.descriptor.name
                ))
            })?;
            let entry_name = normalize_archive_name(entry.name());
            if entry_name.is_empty() || !selections.matches(&entry_name) {
                continue;
            }

            let relative = sanitize_archive_relative_path_from_str(entry.name())?;
            let output_path = request.out_dir.join(relative);
            if entry.is_dir() {
                fs::create_dir_all(&output_path)?;
                continue;
            }
            duplicate_output_paths |= !output_paths.insert(output_path.clone());
            tasks.push(ZipExtractTask {
                index,
                archive_name: entry_name,
                output_path,
            });
        }

        selections.ensure_all_matched()?;
        let total_tasks = tasks.len();

        let (execution, written_bytes) = if tasks.is_empty() || duplicate_output_paths {
            let execution = context.plan_threads(ThreadCapability::single_threaded());
            let mut archive = self.open_archive(&request.source)?;
            let mut written_bytes = 0u64;
            for (task_index, task) in tasks.iter().enumerate() {
                written_bytes = written_bytes
                    .saturating_add(self.extract_task_with_archive(&mut archive, task)?);
                emit_container_step_progress(
                    context,
                    "extract",
                    self.descriptor.name,
                    "extract",
                    task_index.saturating_add(1),
                    total_tasks,
                    format!(
                        "extracting `{}` ({}/{})",
                        self.descriptor.name,
                        task_index.saturating_add(1),
                        total_tasks
                    ),
                    Some(&execution),
                );
            }
            (execution, written_bytes)
        } else {
            let task_count = tasks.len().max(1);
            let (execution, pool) =
                context.build_pool(ThreadCapability::parallel(Some(task_count)))?;
            let source = request.source.clone();
            let completed_tasks = Arc::new(AtomicUsize::new(0));
            let progress_context = context.clone();
            let progress_execution = execution.clone();
            let progress_format = self.descriptor.name;
            let written_bytes = if execution.used_parallelism {
                let worker_count = execution.effective_threads.max(1);
                let chunk_size = tasks.len().div_ceil(worker_count).max(1);
                let chunk_bytes = pool.install(|| {
                    tasks
                        .par_chunks(chunk_size)
                        .map(|chunk| {
                            let completed_tasks = Arc::clone(&completed_tasks);
                            let progress_context = progress_context.clone();
                            let progress_execution = progress_execution.clone();
                            self.extract_task_chunk(&source, chunk, || {
                                let completed = completed_tasks
                                    .fetch_add(1, Ordering::Relaxed)
                                    .saturating_add(1);
                                emit_container_step_progress(
                                    &progress_context,
                                    "extract",
                                    progress_format,
                                    "extract",
                                    completed,
                                    total_tasks,
                                    format!(
                                        "extracting `{}` ({}/{})",
                                        progress_format, completed, total_tasks
                                    ),
                                    Some(&progress_execution),
                                );
                            })
                        })
                        .collect::<Result<Vec<_>>>()
                })?;
                chunk_bytes
                    .into_iter()
                    .fold(0u64, |acc, value| acc.saturating_add(value))
            } else {
                self.extract_task_chunk(&source, &tasks, || {
                    let completed = completed_tasks
                        .fetch_add(1, Ordering::Relaxed)
                        .saturating_add(1);
                    emit_container_step_progress(
                        &progress_context,
                        "extract",
                        progress_format,
                        "extract",
                        completed,
                        total_tasks,
                        format!(
                            "extracting `{}` ({}/{})",
                            progress_format, completed, total_tasks
                        ),
                        Some(&progress_execution),
                    );
                })?
            };
            (execution, written_bytes)
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} file(s), {} bytes written)",
                request.source.display(),
                request.out_dir.display(),
                tasks.len(),
                written_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let (method, level) = self.parse_codec(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;
        let create_tasks = self.build_create_tasks(&entries, context);
        let total_create_tasks = create_tasks.len();
        let (execution, staged_artifacts) = if create_tasks.is_empty() {
            (
                context.plan_threads(ThreadCapability::parallel(None)),
                Vec::new(),
            )
        } else {
            let (execution, pool) =
                context.build_pool(ThreadCapability::parallel(Some(create_tasks.len())))?;
            let completed_tasks = Arc::new(AtomicUsize::new(0));
            let progress_context = context.clone();
            let progress_execution = execution.clone();
            let progress_format = self.descriptor.name;
            let staged_result = if execution.used_parallelism {
                pool.install(|| {
                    create_tasks
                        .par_iter()
                        .map(|task| {
                            let artifact = self.compress_create_task(task, method, level)?;
                            let completed = completed_tasks
                                .fetch_add(1, Ordering::Relaxed)
                                .saturating_add(1);
                            emit_container_step_progress(
                                &progress_context,
                                "compress",
                                progress_format,
                                "create",
                                completed,
                                total_create_tasks,
                                format!(
                                    "creating `{}` ({}/{})",
                                    progress_format, completed, total_create_tasks
                                ),
                                Some(&progress_execution),
                            );
                            Ok(artifact)
                        })
                        .collect::<Result<Vec<_>>>()
                })
            } else {
                create_tasks
                    .iter()
                    .map(|task| {
                        let artifact = self.compress_create_task(task, method, level)?;
                        let completed = completed_tasks
                            .fetch_add(1, Ordering::Relaxed)
                            .saturating_add(1);
                        emit_container_step_progress(
                            &progress_context,
                            "compress",
                            progress_format,
                            "create",
                            completed,
                            total_create_tasks,
                            format!(
                                "creating `{}` ({}/{})",
                                progress_format, completed, total_create_tasks
                            ),
                            Some(&progress_execution),
                        );
                        Ok(artifact)
                    })
                    .collect::<Result<Vec<_>>>()
            };
            let mut staged_artifacts = match staged_result {
                Ok(staged_artifacts) => staged_artifacts,
                Err(error) => {
                    self.cleanup_create_tasks(&create_tasks);
                    return Err(error);
                }
            };
            staged_artifacts.sort_by_key(|artifact| artifact.entry_index);
            (execution, staged_artifacts)
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = File::create(&request.output)?;
        let writer = BufWriter::new(file);
        let mut archive = ZipFileWriter::new(writer);
        let create_result: Result<u64> = (|| {
            let mut logical_bytes = 0u64;
            let mut staged_iter = staged_artifacts.iter();

            for (entry_index, entry) in entries.iter().enumerate() {
                if entry.is_dir {
                    let directory_name = format!("{}/", entry.archive_name);
                    archive
                        .add_directory(directory_name, self.build_options(method, level))
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "{} create failed for `{}`: {error}",
                                self.descriptor.name, entry.archive_name
                            ))
                        })?;
                    continue;
                }

                let staged = staged_iter.next().ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "{} create failed while finalizing staged entries for `{}`",
                        self.descriptor.name, entry.archive_name
                    ))
                })?;
                if staged.entry_index != entry_index {
                    return Err(RomWeaverError::Validation(format!(
                        "{} create failed due to staged entry order mismatch for `{}`",
                        self.descriptor.name, entry.archive_name
                    )));
                }
                self.merge_create_artifact(&mut archive, staged)?;
                logical_bytes = logical_bytes.saturating_add(staged.logical_bytes);
            }
            if staged_iter.next().is_some() {
                return Err(RomWeaverError::Validation(format!(
                    "{} create failed due to unexpected staged entries",
                    self.descriptor.name
                )));
            }

            archive.finish().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} create failed while finalizing archive: {error}",
                    self.descriptor.name
                ))
            })?;
            Ok(logical_bytes)
        })();
        self.cleanup_create_artifacts(&staged_artifacts);
        let logical_bytes = create_result?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from {} input(s) with {} ({} bytes)",
                request.output.display(),
                request.inputs.len(),
                self.method_name(method),
                logical_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: true,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum TarCompression {
    None,
    Gzip,
    Bzip2,
    Xz,
}

struct TarContainerHandler {
    descriptor: &'static FormatDescriptor,
    compression: TarCompression,
}

#[derive(Clone, Debug)]
struct TarExtractTask {
    index: usize,
    archive_name: String,
    output_path: PathBuf,
    file_offset: u64,
    file_size: u64,
    is_dir: bool,
}

#[derive(Clone, Debug)]
struct TarCreateTask {
    entry_index: usize,
    source: PathBuf,
    archive_name: String,
    is_dir: bool,
    temp_archive: PathBuf,
}

#[derive(Clone, Debug)]
struct TarCreateArtifact {
    entry_index: usize,
    archive_name: String,
    logical_bytes: u64,
    temp_archive: PathBuf,
}

impl TarContainerHandler {
    const XZ_MT_BLOCK_BYTES: u64 = 1 << 20;

    const fn new(descriptor: &'static FormatDescriptor, compression: TarCompression) -> Self {
        Self {
            descriptor,
            compression,
        }
    }

    fn parse_codec_and_level(&self, codec: Option<&str>, level: Option<i32>) -> Result<u32> {
        let codec = parse_requested_codec(codec);
        match self.compression {
            TarCompression::None => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Store) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar codec `{}`; use store or omit --codec",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar codec `{codec}`; use store or omit --codec"
                        )));
                    }
                }
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "tar does not accept --level".into(),
                    ));
                }
                Ok(0)
            }
            TarCompression::Gzip => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Deflate) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.gz codec `{}`; use gzip",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.gz codec `{codec}`; use gzip"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value as u32),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "tar.gz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
            TarCompression::Bzip2 => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Bzip2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.bz2 codec `{}`; use bzip2",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.bz2 codec `{codec}`; use bzip2"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (1..=9).contains(&value) => Ok(value as u32),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "tar.bz2 level `{value}` is out of range (1..=9)"
                    ))),
                }
            }
            TarCompression::Xz => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Lzma)
                    | RequestedCodec::Known(CanonicalCodec::Lzma2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.xz codec `{}`; use xz",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported tar.xz codec `{codec}`; use xz"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value as u32),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "tar.xz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
        }
    }

    fn append_entries<W: Write>(
        &self,
        builder: &mut TarBuilder<W>,
        entries: &[ArchiveInputEntry],
        context: &OperationContext,
        execution: &ThreadExecution,
    ) -> Result<u64> {
        let mut logical_bytes = 0u64;
        let total_entries = entries.len();
        for (entry_index, entry) in entries.iter().enumerate() {
            if entry.is_dir {
                builder.append_dir(&entry.archive_name, &entry.source)?;
            } else {
                builder.append_path_with_name(&entry.source, &entry.archive_name)?;
                logical_bytes = logical_bytes.saturating_add(fs::metadata(&entry.source)?.len());
            }
            emit_container_step_progress(
                context,
                "compress",
                self.descriptor.name,
                "create",
                entry_index.saturating_add(1),
                total_entries,
                format!(
                    "creating `{}` ({}/{})",
                    self.descriptor.name,
                    entry_index.saturating_add(1),
                    total_entries
                ),
                Some(execution),
            );
        }
        Ok(logical_bytes)
    }

    fn build_uncompressed_extract_tasks(
        &self,
        request: &ContainerExtractRequest,
    ) -> Result<Vec<TarExtractTask>> {
        let file = File::open(&request.source)?;
        let mut archive = TarArchive::new(BufReader::new(file));
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut tasks = Vec::new();

        for (index, entry) in archive.entries()?.enumerate() {
            let entry = entry?;
            let raw_path = entry.path()?;
            let relative = sanitize_archive_relative_path(raw_path.as_ref())?;
            let archive_name = archive_path_to_name(&relative)?;
            if !selections.matches(&archive_name) {
                continue;
            }

            let output_path = request.out_dir.join(&relative);
            let entry_type = entry.header().entry_type();
            if entry_type.is_dir() {
                tasks.push(TarExtractTask {
                    index,
                    archive_name,
                    output_path,
                    file_offset: 0,
                    file_size: 0,
                    is_dir: true,
                });
                continue;
            }
            if !entry_type.is_file() {
                return Err(RomWeaverError::Validation(format!(
                    "{} extract does not support {} entries yet (`{}`)",
                    self.descriptor.name,
                    entry_type.as_byte(),
                    archive_name
                )));
            }

            tasks.push(TarExtractTask {
                index,
                archive_name,
                output_path,
                file_offset: entry.raw_file_position(),
                file_size: entry.size(),
                is_dir: false,
            });
        }

        selections.ensure_all_matched()?;
        Ok(tasks)
    }

    fn extract_uncompressed_task(&self, source: &Path, task: &TarExtractTask) -> Result<u64> {
        if task.is_dir {
            fs::create_dir_all(&task.output_path)?;
            return Ok(0);
        }

        if let Some(parent) = task.output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut input = BufReader::new(File::open(source)?);
        input.seek(SeekFrom::Start(task.file_offset))?;
        let mut limited = input.take(task.file_size);
        let mut output = BufWriter::new(File::create(&task.output_path)?);
        let copied = io::copy(&mut limited, &mut output).map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} extract failed while reading entry {} (`{}`): {error}",
                self.descriptor.name, task.index, task.archive_name
            ))
        })?;
        if copied != task.file_size {
            return Err(RomWeaverError::Validation(format!(
                "{} extract failed while reading entry {} (`{}`): expected {} bytes, copied {} bytes",
                self.descriptor.name, task.index, task.archive_name, task.file_size, copied
            )));
        }
        output.flush()?;
        Ok(copied)
    }

    fn extract_uncompressed_archive(
        &self,
        source: &Path,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let mut local_request = request.clone();
        local_request.source = source.to_path_buf();
        let tasks = self.build_uncompressed_extract_tasks(&local_request)?;
        let total_selected_entries = tasks.len();
        let total_selected_file_bytes = tasks
            .iter()
            .filter_map(|task| (!task.is_dir).then_some(task.file_size))
            .fold(0u64, |acc, size| acc.saturating_add(size));
        let directory_tasks = tasks
            .iter()
            .filter(|task| task.is_dir)
            .cloned()
            .collect::<Vec<_>>();
        let file_tasks = tasks
            .iter()
            .filter(|task| !task.is_dir)
            .cloned()
            .collect::<Vec<_>>();

        let (execution, maybe_pool) = if file_tasks.is_empty() {
            (context.plan_threads(self.extract_thread_capability()), None)
        } else {
            let (execution, pool) =
                context.build_pool(ThreadCapability::parallel(Some(file_tasks.len())))?;
            (execution, Some(pool))
        };

        if total_selected_entries > 0 {
            emit_container_running_progress(
                context,
                "extract",
                self.descriptor.name,
                "extract",
                format!(
                    "extracting `{}` ({} selected entries)",
                    self.descriptor.name, total_selected_entries
                ),
                0.0,
                Some(&execution),
            );
        }

        let mut selected_entries_completed = 0usize;
        for task in &directory_tasks {
            fs::create_dir_all(&task.output_path)?;
            selected_entries_completed = selected_entries_completed.saturating_add(1);
            if total_selected_file_bytes == 0 {
                emit_container_step_progress(
                    context,
                    "extract",
                    self.descriptor.name,
                    "extract",
                    selected_entries_completed,
                    total_selected_entries,
                    format!(
                        "extracting `{}` ({}/{})",
                        self.descriptor.name, selected_entries_completed, total_selected_entries
                    ),
                    Some(&execution),
                );
            }
        }

        let extracted_files = file_tasks.len();
        let written_bytes = if file_tasks.is_empty() {
            0
        } else if execution.used_parallelism {
            let pool = maybe_pool.ok_or_else(|| {
                RomWeaverError::Validation(
                    "internal validation error: parallel extraction planned without a thread pool"
                        .into(),
                )
            })?;
            let progress_context = context.clone();
            let progress_execution = execution.clone();
            let progress_format = self.descriptor.name;
            let copied_bytes = Arc::new(AtomicU64::new(0));
            let copied_bytes_for_progress = Arc::clone(&copied_bytes);
            let source_path = source.to_path_buf();
            let chunk_bytes = pool.install(|| {
                file_tasks
                    .par_iter()
                    .map(|task| {
                        let copied = self.extract_uncompressed_task(&source_path, task)?;
                        let completed_bytes = copied_bytes_for_progress
                            .fetch_add(copied, Ordering::Relaxed)
                            .saturating_add(copied);
                        if total_selected_file_bytes > 0 {
                            let percent =
                                (completed_bytes as f32 / total_selected_file_bytes as f32) * 100.0;
                            emit_container_running_progress(
                                &progress_context,
                                "extract",
                                progress_format,
                                "extract",
                                format!(
                                    "extracting `{}` ({}/{})",
                                    progress_format, completed_bytes, total_selected_file_bytes
                                ),
                                percent,
                                Some(&progress_execution),
                            );
                        }
                        Ok(copied)
                    })
                    .collect::<Result<Vec<_>>>()
            })?;
            chunk_bytes
                .into_iter()
                .fold(0u64, |acc, value| acc.saturating_add(value))
        } else {
            let mut written_bytes = 0u64;
            let mut selected_file_bytes_written = 0u64;
            let mut last_percent_bucket = -1i32;
            for task in &file_tasks {
                let copied = self.extract_uncompressed_task(source, task)?;
                written_bytes = written_bytes.saturating_add(copied);
                selected_file_bytes_written = selected_file_bytes_written.saturating_add(copied);
                if total_selected_file_bytes > 0 {
                    let percent = (selected_file_bytes_written as f32
                        / total_selected_file_bytes as f32)
                        * 100.0;
                    let bucket = percent.floor() as i32;
                    if bucket > last_percent_bucket || percent >= 100.0 {
                        last_percent_bucket = bucket;
                        emit_container_running_progress(
                            context,
                            "extract",
                            self.descriptor.name,
                            "extract",
                            format!(
                                "extracting `{}` ({}/{})",
                                self.descriptor.name,
                                selected_file_bytes_written,
                                total_selected_file_bytes
                            ),
                            percent,
                            Some(&execution),
                        );
                    }
                }
            }
            written_bytes
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} file(s), {} bytes written)",
                request.source.display(),
                request.out_dir.display(),
                extracted_files,
                written_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn build_uncompressed_create_tasks(
        &self,
        entries: &[ArchiveInputEntry],
        context: &OperationContext,
    ) -> Vec<TarCreateTask> {
        entries
            .iter()
            .enumerate()
            .map(|(entry_index, entry)| TarCreateTask {
                entry_index,
                source: entry.source.clone(),
                archive_name: entry.archive_name.clone(),
                is_dir: entry.is_dir,
                temp_archive: context.temp_paths().next_path(
                    &format!("{}-create-{entry_index}", self.descriptor.name),
                    Some("tar"),
                ),
            })
            .collect()
    }

    fn stage_uncompressed_create_task(&self, task: &TarCreateTask) -> Result<TarCreateArtifact> {
        if let Some(parent) = task.temp_archive.parent() {
            fs::create_dir_all(parent)?;
        }
        let output = BufWriter::new(File::create(&task.temp_archive)?);
        let mut builder = TarBuilder::new(output);
        if task.is_dir {
            builder.append_dir(&task.archive_name, &task.source)?;
        } else {
            builder.append_path_with_name(&task.source, &task.archive_name)?;
        }
        builder.finish()?;

        Ok(TarCreateArtifact {
            entry_index: task.entry_index,
            archive_name: task.archive_name.clone(),
            logical_bytes: if task.is_dir {
                0
            } else {
                fs::metadata(&task.source)?.len()
            },
            temp_archive: task.temp_archive.clone(),
        })
    }

    fn merge_uncompressed_create_artifact<W: Write>(
        &self,
        output: &mut W,
        artifact: &TarCreateArtifact,
    ) -> Result<()> {
        let staged_len = fs::metadata(&artifact.temp_archive)?.len();
        if staged_len < 1024 {
            return Err(RomWeaverError::Validation(format!(
                "{} create failed while finalizing staged entry `{}`",
                self.descriptor.name, artifact.archive_name
            )));
        }
        let payload_len = staged_len.saturating_sub(1024);
        let mut staged = BufReader::new(File::open(&artifact.temp_archive)?);
        let copied = io::copy(&mut staged.by_ref().take(payload_len), output).map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} create failed while reading staged entry `{}`: {error}",
                self.descriptor.name, artifact.archive_name
            ))
        })?;
        if copied != payload_len {
            return Err(RomWeaverError::Validation(format!(
                "{} create failed while reading staged entry `{}`: expected {} bytes, copied {} bytes",
                self.descriptor.name, artifact.archive_name, payload_len, copied
            )));
        }
        Ok(())
    }

    fn cleanup_uncompressed_create_tasks(&self, tasks: &[TarCreateTask]) {
        for task in tasks {
            let _ = fs::remove_file(&task.temp_archive);
        }
    }

    fn cleanup_uncompressed_create_artifacts(&self, artifacts: &[TarCreateArtifact]) {
        for artifact in artifacts {
            let _ = fs::remove_file(&artifact.temp_archive);
        }
    }

    fn open_reader(&self, source: &Path) -> Result<Box<dyn Read>> {
        let file = File::open(source)?;
        let reader: Box<dyn Read> = match self.compression {
            TarCompression::None => Box::new(BufReader::new(file)),
            TarCompression::Gzip => Box::new(MultiGzDecoder::new(BufReader::new(file))),
            TarCompression::Bzip2 => Box::new(Bzip2Decoder::new(BufReader::new(file))),
            TarCompression::Xz => Box::new(XzReader::new(BufReader::new(file), false)),
        };
        Ok(reader)
    }

    fn extract_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            TarCompression::None
            | TarCompression::Gzip
            | TarCompression::Bzip2
            | TarCompression::Xz => ThreadCapability::parallel(None),
        }
    }

    fn create_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            TarCompression::None
            | TarCompression::Gzip
            | TarCompression::Bzip2
            | TarCompression::Xz => ThreadCapability::parallel(None),
        }
    }

    fn xz_thread_count(effective_threads: usize) -> u32 {
        match u32::try_from(effective_threads) {
            Ok(count) => count.clamp(1, 256),
            Err(_) => 256,
        }
    }

    fn xz_mt_options(level: u32) -> Result<XzOptions> {
        let mut options = XzOptions::with_preset(level);
        let block_size = NonZeroU64::new(Self::XZ_MT_BLOCK_BYTES).ok_or_else(|| {
            RomWeaverError::Validation("tar.xz internal block size must be non-zero".into())
        })?;
        options.set_block_size(Some(block_size));
        Ok(options)
    }

    fn open_reader_for_extract(
        &self,
        source: &Path,
        execution: &rom_weaver_core::ThreadExecution,
    ) -> Result<Box<dyn Read>> {
        match self.compression {
            TarCompression::Xz if execution.used_parallelism => {
                let workers = Self::xz_thread_count(execution.effective_threads);
                let file = File::open(source)?;
                Ok(Box::new(XzReaderMt::new(
                    BufReader::new(file),
                    false,
                    workers,
                )?))
            }
            _ => self.open_reader(source),
        }
    }

    fn looks_like_tar_archive(&self, source: &Path) -> bool {
        let mut reader = match self.open_reader(source) {
            Ok(reader) => reader,
            Err(_) => return false,
        };
        let mut header = [0u8; 512];
        reader.read_exact(&mut header).is_ok() && is_ustar_header(&header)
    }
}

impl ContainerHandler for TarContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.looks_like_tar_archive(source) {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let reader = self.open_reader(&request.source)?;
        let mut archive = TarArchive::new(reader);
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut logical_bytes = 0u64;
        let mut entries_total = 0usize;

        for entry in archive.entries()? {
            let entry = entry?;
            entries_total += 1;
            let entry_type = entry.header().entry_type();
            if entry_type.is_dir() {
                directories += 1;
            } else if entry_type.is_file() {
                files += 1;
                logical_bytes = logical_bytes.saturating_add(entry.header().size()?);
            }
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} entries ({} files, {} directories), {} bytes uncompressed",
                self.descriptor.name, entries_total, files, directories, logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        let reader = self.open_reader(&request.source)?;
        let mut archive = TarArchive::new(reader);
        let mut entries = Vec::new();
        for entry in archive.entries()? {
            let entry = entry?;
            let raw_path = entry.path()?;
            let relative = sanitize_archive_relative_path(raw_path.as_ref())?;
            let archive_name = archive_path_to_name(&relative)?;
            if !archive_name.is_empty() {
                entries.push(archive_name);
            }
        }
        Ok(entries)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        fs::create_dir_all(&request.out_dir)?;

        if matches!(self.compression, TarCompression::None) {
            return self.extract_uncompressed_archive(&request.source, request, context);
        }

        if matches!(
            self.compression,
            TarCompression::Gzip | TarCompression::Bzip2
        ) {
            let (codec_name, staged_label) = match self.compression {
                TarCompression::Gzip => ("deflate", "tar-gz-extract-stage"),
                TarCompression::Bzip2 => ("bzip2", "tar-bz2-extract-stage"),
                TarCompression::None | TarCompression::Xz => unreachable!(),
            };
            let staged_tar = context.temp_paths().next_path(staged_label, Some("tar"));
            let staged_result = (|| -> Result<OperationReport> {
                if let Some(parent) = staged_tar.parent() {
                    fs::create_dir_all(parent)?;
                }
                let backend = CodecRegistry::new()
                    .find_by_name(codec_name)
                    .ok_or_else(|| {
                        RomWeaverError::Unsupported(format!(
                            "codec backend `{codec_name}` is not registered for {}",
                            self.descriptor.name
                        ))
                    })?;
                let decode_report = backend.decode(
                    &CodecOperationRequest {
                        input: request.source.clone(),
                        output: staged_tar.clone(),
                        level: None,
                    },
                    context,
                )?;
                if decode_report.status != OperationStatus::Succeeded {
                    return Err(RomWeaverError::Unsupported(decode_report.label));
                }
                self.extract_uncompressed_archive(&staged_tar, request, context)
            })();
            let _ = fs::remove_file(&staged_tar);
            return staged_result;
        }

        let execution = context.plan_threads(self.extract_thread_capability());
        let reader = self.open_reader_for_extract(&request.source, &execution)?;
        let mut archive = TarArchive::new(reader);
        let mut preview_selections = SelectionMatcher::new(&request.selections);
        let mut total_selected_entries = 0usize;
        let mut total_selected_file_bytes = 0u64;

        for entry in archive.entries()? {
            let entry = entry?;
            let raw_path = entry.path()?;
            let relative = sanitize_archive_relative_path(raw_path.as_ref())?;
            let archive_name = archive_path_to_name(&relative)?;
            if !preview_selections.matches(&archive_name) {
                continue;
            }
            total_selected_entries = total_selected_entries.saturating_add(1);
            let entry_type = entry.header().entry_type();
            if entry_type.is_file() {
                total_selected_file_bytes =
                    total_selected_file_bytes.saturating_add(entry.header().size()?);
            }
        }

        let reader = self.open_reader_for_extract(&request.source, &execution)?;
        let mut archive = TarArchive::new(reader);
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut extracted_files = 0usize;
        let mut written_bytes = 0u64;
        let mut selected_entries_completed = 0usize;
        let mut selected_file_bytes_written = 0u64;
        let mut last_percent_bucket = -1i32;

        if total_selected_entries > 0 {
            emit_container_running_progress(
                context,
                "extract",
                self.descriptor.name,
                "extract",
                format!(
                    "extracting `{}` ({} selected entries)",
                    self.descriptor.name, total_selected_entries
                ),
                0.0,
                Some(&execution),
            );
        }

        for entry in archive.entries()? {
            let mut entry = entry?;
            let raw_path = entry.path()?;
            let relative = sanitize_archive_relative_path(raw_path.as_ref())?;
            let archive_name = archive_path_to_name(&relative)?;
            if !selections.matches(&archive_name) {
                continue;
            }

            let output_path = request.out_dir.join(&relative);
            let entry_type = entry.header().entry_type();
            if entry_type.is_dir() {
                fs::create_dir_all(&output_path)?;
                selected_entries_completed = selected_entries_completed.saturating_add(1);
                if total_selected_file_bytes == 0 {
                    emit_container_step_progress(
                        context,
                        "extract",
                        self.descriptor.name,
                        "extract",
                        selected_entries_completed,
                        total_selected_entries,
                        format!(
                            "extracting `{}` ({}/{})",
                            self.descriptor.name,
                            selected_entries_completed,
                            total_selected_entries
                        ),
                        Some(&execution),
                    );
                }
                continue;
            }
            if !entry_type.is_file() {
                return Err(RomWeaverError::Validation(format!(
                    "{} extract does not support {} entries yet (`{}`)",
                    self.descriptor.name,
                    entry_type.as_byte(),
                    archive_name
                )));
            }

            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut output = BufWriter::new(File::create(&output_path)?);
            let mut buffer = [0u8; 64 * 1024];
            let mut copied = 0u64;
            loop {
                let read = entry.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                output.write_all(&buffer[..read])?;
                copied = copied.saturating_add(read as u64);
                if total_selected_file_bytes > 0 {
                    selected_file_bytes_written =
                        selected_file_bytes_written.saturating_add(read as u64);
                    let percent = (selected_file_bytes_written as f32
                        / total_selected_file_bytes as f32)
                        * 100.0;
                    let bucket = percent.floor() as i32;
                    if bucket > last_percent_bucket || percent >= 100.0 {
                        last_percent_bucket = bucket;
                        emit_container_running_progress(
                            context,
                            "extract",
                            self.descriptor.name,
                            "extract",
                            format!(
                                "extracting `{}` ({}/{})",
                                self.descriptor.name,
                                selected_file_bytes_written,
                                total_selected_file_bytes
                            ),
                            percent,
                            Some(&execution),
                        );
                    }
                }
            }
            output.flush()?;
            extracted_files += 1;
            written_bytes = written_bytes.saturating_add(copied);
            selected_entries_completed = selected_entries_completed.saturating_add(1);
            if total_selected_file_bytes == 0 {
                emit_container_step_progress(
                    context,
                    "extract",
                    self.descriptor.name,
                    "extract",
                    selected_entries_completed,
                    total_selected_entries,
                    format!(
                        "extracting `{}` ({}/{})",
                        self.descriptor.name, selected_entries_completed, total_selected_entries
                    ),
                    Some(&execution),
                );
            }
        }

        selections.ensure_all_matched()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} file(s), {} bytes written)",
                request.source.display(),
                request.out_dir.display(),
                extracted_files,
                written_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let mut execution = context.plan_threads(self.create_thread_capability());
        let level = self.parse_codec_and_level(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let logical_bytes = match self.compression {
            TarCompression::None => {
                let create_tasks = self.build_uncompressed_create_tasks(&entries, context);
                if create_tasks.is_empty() || !execution.used_parallelism {
                    let output = BufWriter::new(File::create(&request.output)?);
                    let mut builder = TarBuilder::new(output);
                    let bytes = self.append_entries(&mut builder, &entries, context, &execution)?;
                    builder.finish()?;
                    bytes
                } else {
                    let (create_execution, pool) =
                        context.build_pool(ThreadCapability::parallel(Some(create_tasks.len())))?;
                    execution = create_execution;
                    let completed_tasks = Arc::new(AtomicUsize::new(0));
                    let progress_context = context.clone();
                    let progress_execution = execution.clone();
                    let progress_format = self.descriptor.name;
                    let total_create_tasks = create_tasks.len();
                    let staged_result = if execution.used_parallelism {
                        pool.install(|| {
                            create_tasks
                                .par_iter()
                                .map(|task| {
                                    let artifact = self.stage_uncompressed_create_task(task)?;
                                    let completed = completed_tasks
                                        .fetch_add(1, Ordering::Relaxed)
                                        .saturating_add(1);
                                    emit_container_step_progress(
                                        &progress_context,
                                        "compress",
                                        progress_format,
                                        "create",
                                        completed,
                                        total_create_tasks,
                                        format!(
                                            "creating `{}` ({}/{})",
                                            progress_format, completed, total_create_tasks
                                        ),
                                        Some(&progress_execution),
                                    );
                                    Ok(artifact)
                                })
                                .collect::<Result<Vec<_>>>()
                        })
                    } else {
                        create_tasks
                            .iter()
                            .map(|task| {
                                let artifact = self.stage_uncompressed_create_task(task)?;
                                let completed = completed_tasks
                                    .fetch_add(1, Ordering::Relaxed)
                                    .saturating_add(1);
                                emit_container_step_progress(
                                    &progress_context,
                                    "compress",
                                    progress_format,
                                    "create",
                                    completed,
                                    total_create_tasks,
                                    format!(
                                        "creating `{}` ({}/{})",
                                        progress_format, completed, total_create_tasks
                                    ),
                                    Some(&progress_execution),
                                );
                                Ok(artifact)
                            })
                            .collect::<Result<Vec<_>>>()
                    };
                    let mut staged_artifacts = match staged_result {
                        Ok(artifacts) => artifacts,
                        Err(error) => {
                            self.cleanup_uncompressed_create_tasks(&create_tasks);
                            return Err(error);
                        }
                    };
                    staged_artifacts.sort_by_key(|artifact| artifact.entry_index);

                    let create_result: Result<u64> = (|| {
                        let output = BufWriter::new(File::create(&request.output)?);
                        let mut output = output;
                        let mut logical_bytes = 0u64;
                        let mut staged_iter = staged_artifacts.iter();

                        for (entry_index, entry) in entries.iter().enumerate() {
                            let staged = staged_iter.next().ok_or_else(|| {
                                RomWeaverError::Validation(format!(
                                    "{} create failed while finalizing staged entries for `{}`",
                                    self.descriptor.name, entry.archive_name
                                ))
                            })?;
                            if staged.entry_index != entry_index {
                                return Err(RomWeaverError::Validation(format!(
                                    "{} create failed due to staged entry order mismatch for `{}`",
                                    self.descriptor.name, entry.archive_name
                                )));
                            }
                            self.merge_uncompressed_create_artifact(&mut output, staged)?;
                            logical_bytes = logical_bytes.saturating_add(staged.logical_bytes);
                        }
                        if staged_iter.next().is_some() {
                            return Err(RomWeaverError::Validation(format!(
                                "{} create failed due to unexpected staged entries",
                                self.descriptor.name
                            )));
                        }
                        output.write_all(&[0u8; 1024])?;
                        output.flush()?;
                        Ok(logical_bytes)
                    })();
                    self.cleanup_uncompressed_create_artifacts(&staged_artifacts);
                    create_result?
                }
            }
            TarCompression::Gzip => {
                if execution.used_parallelism {
                    let staged_tar = context
                        .temp_paths()
                        .next_path("tar-gz-create-stage", Some("tar"));
                    let staged_result = (|| -> Result<(u64, Option<ThreadExecution>)> {
                        if let Some(parent) = staged_tar.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        let staged_output = BufWriter::new(File::create(&staged_tar)?);
                        let mut builder = TarBuilder::new(staged_output);
                        let bytes =
                            self.append_entries(&mut builder, &entries, context, &execution)?;
                        builder.finish()?;

                        let backend =
                            CodecRegistry::new()
                                .find_by_name("deflate")
                                .ok_or_else(|| {
                                    RomWeaverError::Unsupported(
                                        "codec backend `deflate` is not registered for tar.gz"
                                            .into(),
                                    )
                                })?;
                        let encode_report = backend.encode(
                            &CodecOperationRequest {
                                input: staged_tar.clone(),
                                output: request.output.clone(),
                                level: Some(level as i32),
                            },
                            context,
                        )?;
                        if encode_report.status != OperationStatus::Succeeded {
                            return Err(RomWeaverError::Unsupported(encode_report.label));
                        }
                        Ok((bytes, encode_report.thread_execution))
                    })();
                    let _ = fs::remove_file(&staged_tar);
                    let (bytes, encode_execution) = staged_result?;
                    if let Some(encode_execution) = encode_execution {
                        execution = encode_execution;
                    }
                    bytes
                } else {
                    let output = BufWriter::new(File::create(&request.output)?);
                    let encoder = GzEncoder::new(output, GzipCompression::new(level));
                    let mut builder = TarBuilder::new(encoder);
                    let bytes = self.append_entries(&mut builder, &entries, context, &execution)?;
                    let encoder = builder.into_inner()?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                    bytes
                }
            }
            TarCompression::Bzip2 => {
                if execution.used_parallelism {
                    let staged_tar = context
                        .temp_paths()
                        .next_path("tar-bz2-create-stage", Some("tar"));
                    let staged_result = (|| -> Result<(u64, Option<ThreadExecution>)> {
                        if let Some(parent) = staged_tar.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        let staged_output = BufWriter::new(File::create(&staged_tar)?);
                        let mut builder = TarBuilder::new(staged_output);
                        let bytes =
                            self.append_entries(&mut builder, &entries, context, &execution)?;
                        builder.finish()?;

                        let backend =
                            CodecRegistry::new().find_by_name("bzip2").ok_or_else(|| {
                                RomWeaverError::Unsupported(
                                    "codec backend `bzip2` is not registered for tar.bz2".into(),
                                )
                            })?;
                        let encode_report = backend.encode(
                            &CodecOperationRequest {
                                input: staged_tar.clone(),
                                output: request.output.clone(),
                                level: Some(level as i32),
                            },
                            context,
                        )?;
                        if encode_report.status != OperationStatus::Succeeded {
                            return Err(RomWeaverError::Unsupported(encode_report.label));
                        }
                        Ok((bytes, encode_report.thread_execution))
                    })();
                    let _ = fs::remove_file(&staged_tar);
                    let (bytes, encode_execution) = staged_result?;
                    if let Some(encode_execution) = encode_execution {
                        execution = encode_execution;
                    }
                    bytes
                } else {
                    let output = BufWriter::new(File::create(&request.output)?);
                    let encoder = BzEncoder::new(output, Bzip2Compression::new(level));
                    let mut builder = TarBuilder::new(encoder);
                    let bytes = self.append_entries(&mut builder, &entries, context, &execution)?;
                    let mut output = builder.into_inner()?.finish()?;
                    output.flush()?;
                    bytes
                }
            }
            TarCompression::Xz => {
                let output = BufWriter::new(File::create(&request.output)?);
                if execution.used_parallelism {
                    let options = Self::xz_mt_options(level)?;
                    let encoder = XzWriterMt::new(
                        output,
                        options,
                        Self::xz_thread_count(execution.effective_threads),
                    )?;
                    let mut builder = TarBuilder::new(encoder);
                    let bytes = self.append_entries(&mut builder, &entries, context, &execution)?;
                    let mut output = builder.into_inner()?.finish()?;
                    output.flush()?;
                    bytes
                } else {
                    let encoder = XzWriter::new(output, XzOptions::with_preset(level))?;
                    let mut builder = TarBuilder::new(encoder);
                    let bytes = self.append_entries(&mut builder, &entries, context, &execution)?;
                    let mut output = builder.into_inner()?.finish()?;
                    output.flush()?;
                    bytes
                }
            }
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from {} input(s) ({} bytes)",
                request.output.display(),
                request.inputs.len(),
                logical_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: true,
            extract_threads: self.extract_thread_capability(),
            create_threads: self.create_thread_capability(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum StreamCompression {
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

struct StreamContainerHandler {
    descriptor: &'static FormatDescriptor,
    compression: StreamCompression,
}

impl StreamContainerHandler {
    const INSPECT_READ_BUFFER_BYTES: usize = 64 * 1024;

    const fn new(descriptor: &'static FormatDescriptor, compression: StreamCompression) -> Self {
        Self {
            descriptor,
            compression,
        }
    }

    fn parse_codec_and_level(&self, codec: Option<&str>, level: Option<i32>) -> Result<i32> {
        let codec = parse_requested_codec(codec);
        match self.compression {
            StreamCompression::Gzip => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Deflate) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported gz codec `{}`; use gzip",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported gz codec `{codec}`; use gzip"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "gz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
            StreamCompression::Bzip2 => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Bzip2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported bz2 codec `{}`; use bzip2",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported bz2 codec `{codec}`; use bzip2"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (1..=9).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "bz2 level `{value}` is out of range (1..=9)"
                    ))),
                }
            }
            StreamCompression::Xz => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Lzma)
                    | RequestedCodec::Known(CanonicalCodec::Lzma2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported xz codec `{}`; use xz",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported xz codec `{codec}`; use xz"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "xz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
            StreamCompression::Zstd => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Zstd) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported zst codec `{}`; use zstd",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported zst codec `{codec}`; use zstd"
                        )));
                    }
                }
                match level {
                    None => Ok(3),
                    Some(value) if (-7..=22).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "zst level `{value}` is out of range (-7..=22)"
                    ))),
                }
            }
        }
    }

    fn backend_codec_name(&self) -> &'static str {
        match self.compression {
            StreamCompression::Gzip => "deflate",
            StreamCompression::Bzip2 => "bzip2",
            StreamCompression::Xz => "lzma2",
            StreamCompression::Zstd => "zstd",
        }
    }

    fn extract_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            StreamCompression::Gzip
            | StreamCompression::Bzip2
            | StreamCompression::Xz
            | StreamCompression::Zstd => ThreadCapability::parallel(None),
        }
    }

    fn create_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            StreamCompression::Gzip
            | StreamCompression::Bzip2
            | StreamCompression::Xz
            | StreamCompression::Zstd => ThreadCapability::parallel(None),
        }
    }

    fn codec_backend(&self) -> Result<Arc<dyn CodecBackend>> {
        let codec = self.backend_codec_name();
        CodecRegistry::new().find_by_name(codec).ok_or_else(|| {
            RomWeaverError::Unsupported(format!(
                "codec backend `{codec}` is not registered for {}",
                self.descriptor.name
            ))
        })
    }

    fn xz_thread_count(effective_threads: usize) -> u32 {
        match u32::try_from(effective_threads) {
            Ok(count) => count.clamp(1, 256),
            Err(_) => 256,
        }
    }

    fn open_reader_for_inspect(
        &self,
        source: &Path,
        execution: &ThreadExecution,
    ) -> Result<Box<dyn Read>> {
        let file = File::open(source)?;
        let reader: Box<dyn Read> = match self.compression {
            StreamCompression::Gzip => Box::new(MultiGzDecoder::new(BufReader::new(file))),
            StreamCompression::Bzip2 => Box::new(Bzip2Decoder::new(BufReader::new(file))),
            StreamCompression::Xz if execution.used_parallelism => {
                let workers = Self::xz_thread_count(execution.effective_threads);
                Box::new(XzReaderMt::new(BufReader::new(file), false, workers)?)
            }
            StreamCompression::Xz => Box::new(XzReader::new(BufReader::new(file), false)),
            StreamCompression::Zstd => Box::new(zstd::stream::Decoder::new(BufReader::new(file))?),
        };
        Ok(reader)
    }

    fn output_name(&self, source: &Path) -> String {
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(self.descriptor.name);
        let file_name_lower = file_name.to_ascii_lowercase();
        let mut longest_extension = 0usize;
        for extension in self.descriptor.extensions {
            let extension_lower = extension.to_ascii_lowercase();
            if file_name_lower.ends_with(&extension_lower)
                && extension_lower.len() > longest_extension
            {
                longest_extension = extension_lower.len();
            }
        }

        let trimmed = if longest_extension > 0 && longest_extension < file_name.len() {
            file_name[..file_name.len() - longest_extension].to_string()
        } else {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(file_name)
                .to_string()
        };

        let normalized = trimmed.trim().trim_matches('.');
        if normalized.is_empty() {
            format!("{}.out", self.descriptor.name)
        } else {
            normalized.to_string()
        }
    }

    fn matches_signature(&self, source: &Path) -> bool {
        match self.compression {
            StreamCompression::Gzip => file_starts_with(source, &GZIP_SIGNATURE),
            StreamCompression::Bzip2 => file_starts_with(source, &BZIP2_SIGNATURE),
            StreamCompression::Xz => file_starts_with(source, &XZ_SIGNATURE),
            StreamCompression::Zstd => file_starts_with(source, &ZSTD_SIGNATURE),
        }
    }
}

impl ContainerHandler for StreamContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.matches_signature(source) {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let compressed_bytes = fs::metadata(&request.source)?.len();
        let execution = context.plan_threads(self.extract_thread_capability());
        let mut reader = self.open_reader_for_inspect(&request.source, &execution)?;
        let mut logical_bytes = 0u64;
        let mut buffer = vec![0u8; Self::INSPECT_READ_BUFFER_BYTES];

        loop {
            context.cancel().check()?;
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            logical_bytes = logical_bytes.saturating_add(read as u64);
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} bytes compressed, {} bytes uncompressed",
                self.descriptor.name, compressed_bytes, logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(vec![self.output_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let mut execution = context.plan_threads(self.extract_thread_capability());
        fs::create_dir_all(&request.out_dir)?;

        let output_name = self.output_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }

        let output_path = request.out_dir.join(&output_name);
        let backend = self.codec_backend()?;
        let decode_report = backend.decode(
            &CodecOperationRequest {
                input: request.source.clone(),
                output: output_path.clone(),
                level: None,
            },
            context,
        )?;
        if decode_report.status != OperationStatus::Succeeded {
            return Err(RomWeaverError::Unsupported(decode_report.label));
        }
        if let Some(decode_execution) = decode_report.thread_execution {
            execution = decode_execution;
        }
        let written = fs::metadata(&output_path)?.len();
        selections.ensure_all_matched()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` (1 file, {} bytes written)",
                request.source.display(),
                output_path.display(),
                written
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(format!(
                "{} create currently requires exactly one input file",
                self.descriptor.name
            )));
        }

        let mut execution = context.plan_threads(self.create_thread_capability());
        let level = self.parse_codec_and_level(request.codec.as_deref(), request.level)?;
        let input = &request.inputs[0];
        let metadata = fs::metadata(input)?;
        if !metadata.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "{} create requires a file input: `{}`",
                self.descriptor.name,
                input.display()
            )));
        }
        let logical_bytes = metadata.len();

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let backend = self.codec_backend()?;
        let encode_report = backend.encode(
            &CodecOperationRequest {
                input: input.clone(),
                output: request.output.clone(),
                level: Some(level),
            },
            context,
        )?;
        if encode_report.status != OperationStatus::Succeeded {
            return Err(RomWeaverError::Unsupported(encode_report.label));
        }
        if let Some(encode_execution) = encode_report.thread_execution {
            execution = encode_execution;
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from `{}` ({} bytes)",
                request.output.display(),
                input.display(),
                logical_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: true,
            extract_threads: self.extract_thread_capability(),
            create_threads: self.create_thread_capability(),
        }
    }
}

const CSO_DEFAULT_BLOCK_BYTES: usize = 2 * 1024;
const CSO_EXTRACT_TASK_BYTES: u64 = 8 * 1024 * 1024;
const CSO_CREATE_TASK_SECTORS: usize = 2048;

#[derive(Clone, Debug)]
struct CsoExtractTask {
    index: usize,
    offset: u64,
    len: u64,
    temp_path: PathBuf,
}

#[derive(Clone, Debug)]
struct CsoCreateTask {
    index: usize,
    start_sector: usize,
    sector_count: usize,
    temp_path: PathBuf,
}

#[derive(Clone, Copy, Debug)]
struct CsoSectorEncoding {
    encoded_len: u32,
    is_compressed: bool,
}

#[derive(Clone, Debug)]
struct CsoEncodedTask {
    index: usize,
    start_sector: usize,
    temp_path: PathBuf,
    sector_encodings: Vec<CsoSectorEncoding>,
}

struct ExactCsoFileReader {
    file: File,
}

impl ExactCsoFileReader {
    fn open(path: &Path) -> std::result::Result<Self, io::Error> {
        Ok(Self {
            file: File::open(path)?,
        })
    }
}

impl ciso::read::Read<io::Error> for ExactCsoFileReader {
    fn size(&mut self) -> std::result::Result<u64, io::Error> {
        self.file.seek(SeekFrom::End(0))
    }

    fn read(&mut self, pos: u64, buf: &mut [u8]) -> std::result::Result<(), io::Error> {
        self.file.seek(SeekFrom::Start(pos))?;
        self.file.read_exact(buf)?;
        Ok(())
    }
}

enum CsoSourceReader {
    Single(ExactCsoFileReader),
    Split(SplitFileReader<io::Error, ExactCsoFileReader>),
}

impl ciso::read::Read<io::Error> for CsoSourceReader {
    fn size(&mut self) -> std::result::Result<u64, io::Error> {
        match self {
            Self::Single(reader) => ciso::read::Read::size(reader),
            Self::Split(reader) => ciso::read::Read::size(reader),
        }
    }

    fn read(&mut self, pos: u64, buf: &mut [u8]) -> std::result::Result<(), io::Error> {
        match self {
            Self::Single(reader) => ciso::read::Read::read(reader, pos, buf),
            Self::Split(reader) => ciso::read::Read::read(reader, pos, buf),
        }
    }
}

type CsoImageReader = CsoReader<io::Error, CsoSourceReader>;

struct CsoContainerHandler {
    descriptor: &'static FormatDescriptor,
}

impl CsoContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn open_split_source(&self, source: &Path) -> Result<Option<CsoSourceReader>> {
        let file_extension = source.extension().and_then(|value| value.to_str());
        let Some(file_extension) = file_extension else {
            return Ok(None);
        };
        if !file_extension.eq_ignore_ascii_case("cso") {
            return Ok(None);
        }

        let source_base = source.with_extension("");
        let split_root = source_base
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == "1");
        if !split_root {
            return Ok(None);
        }

        let mut parts = Vec::new();
        for index in 1.. {
            let part_path = source_base.with_extension(format!("{index}.{file_extension}"));
            if !part_path.exists() {
                break;
            }
            parts.push(ExactCsoFileReader::open(&part_path).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open cso split part `{}`: {error}",
                    part_path.display()
                ))
            })?);
        }

        if parts.is_empty() {
            return Ok(None);
        }

        let split_reader = SplitFileReader::new(parts).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open split cso source `{}`: {error}",
                source.display()
            ))
        })?;
        Ok(Some(CsoSourceReader::Split(split_reader)))
    }

    fn open_source(&self, source: &Path) -> Result<CsoSourceReader> {
        if let Some(split_reader) = self.open_split_source(source)? {
            return Ok(split_reader);
        }
        let file = ExactCsoFileReader::open(source).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open cso source `{}`: {error}",
                source.display()
            ))
        })?;
        Ok(CsoSourceReader::Single(file))
    }

    fn open_reader(&self, source: &Path) -> Result<CsoImageReader> {
        CsoReader::new(self.open_source(source)?).map_err(|error| {
            RomWeaverError::Validation(format!(
                "cso source `{}` is invalid: {error}",
                source.display()
            ))
        })
    }

    fn output_name(&self, source: &Path) -> String {
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(self.descriptor.name);
        let file_name_lower = file_name.to_ascii_lowercase();

        let mut trimmed = if file_name_lower.ends_with(".cso") {
            file_name[..file_name.len() - ".cso".len()].to_string()
        } else if file_name_lower.ends_with(".ciso") {
            file_name[..file_name.len() - ".ciso".len()].to_string()
        } else {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(file_name)
                .to_string()
        };
        if let Some(without_split_suffix) = trimmed.strip_suffix(".1") {
            trimmed = without_split_suffix.to_string();
        }

        let normalized = trimmed.trim().trim_matches('.');
        if normalized.is_empty() {
            "cso.iso".to_string()
        } else {
            format!("{normalized}.iso")
        }
    }

    fn build_extract_tasks(
        &self,
        logical_bytes: u64,
        context: &OperationContext,
    ) -> Vec<CsoExtractTask> {
        if logical_bytes == 0 {
            return Vec::new();
        }
        let mut tasks = Vec::new();
        let mut offset = 0_u64;
        let mut index = 0_usize;
        while offset < logical_bytes {
            let len = (logical_bytes - offset).min(CSO_EXTRACT_TASK_BYTES);
            tasks.push(CsoExtractTask {
                index,
                offset,
                len,
                temp_path: context
                    .temp_paths()
                    .next_path(&format!("cso-extract-{index}"), Some("chunk")),
            });
            offset = offset.saturating_add(len);
            index += 1;
        }
        tasks
    }

    fn decode_extract_task(&self, source: &Path, task: &CsoExtractTask) -> Result<()> {
        let read_len = usize::try_from(task.len).map_err(|_| {
            RomWeaverError::Validation("cso extract task length overflowed usize".into())
        })?;
        let mut reader = self.open_reader(source)?;
        let mut decoded = vec![0_u8; read_len];
        reader
            .read_offset(task.offset, &mut decoded)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "cso extract failed while decoding `{}` chunk {} at offset {}: {error}",
                    source.display(),
                    task.index,
                    task.offset
                ))
            })?;

        if let Some(parent) = task.temp_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(&task.temp_path)?);
        output.write_all(&decoded)?;
        output.flush()?;
        Ok(())
    }

    fn cleanup_extract_tasks(&self, tasks: &[CsoExtractTask]) {
        for task in tasks {
            let _ = fs::remove_file(&task.temp_path);
        }
    }

    fn assemble_extract_output(&self, tasks: &[CsoExtractTask], output_path: &Path) -> Result<()> {
        let mut output = BufWriter::new(File::create(output_path)?);
        for task in tasks {
            let mut input = BufReader::new(File::open(&task.temp_path)?);
            io::copy(&mut input, &mut output)?;
        }
        output.flush()?;
        Ok(())
    }

    fn build_create_tasks(
        &self,
        logical_bytes: u64,
        context: &OperationContext,
    ) -> Vec<CsoCreateTask> {
        let mut header = ciso::layout::CSOHeader::new();
        header.uncompressed_size = logical_bytes;
        let sector_count = header.index_table_len().saturating_sub(1);
        if sector_count == 0 {
            return Vec::new();
        }

        let mut tasks = Vec::new();
        let mut start_sector = 0_usize;
        let mut index = 0_usize;
        while start_sector < sector_count {
            let sector_count = (sector_count - start_sector).min(CSO_CREATE_TASK_SECTORS);
            tasks.push(CsoCreateTask {
                index,
                start_sector,
                sector_count,
                temp_path: context
                    .temp_paths()
                    .next_path(&format!("cso-create-{index}"), Some("chunk")),
            });
            start_sector += sector_count;
            index += 1;
        }
        tasks
    }

    fn compress_sector_for_create(&self, sector: &[u8]) -> Result<(Vec<u8>, bool)> {
        let frame_info = Lz4FrameInfo::new()
            .block_mode(Lz4BlockMode::Independent)
            .block_size(Lz4BlockSize::Max64KB)
            .content_checksum(false)
            .block_checksums(false)
            .legacy_frame(true)
            .content_size(None);
        let mut encoder = Lz4FrameEncoder::with_frame_info(frame_info, Vec::new());
        encoder.write_all(sector).map_err(|error| {
            RomWeaverError::Validation(format!(
                "cso create failed while compressing sector: {error}"
            ))
        })?;
        let encoded = encoder.finish().map_err(|error| {
            RomWeaverError::Validation(format!(
                "cso create failed while finalizing sector compression: {error}"
            ))
        })?;
        if encoded.len() <= 11 {
            return Err(RomWeaverError::Validation(
                "cso create produced an invalid compressed sector frame".into(),
            ));
        }

        let payload = encoded[7..encoded.len() - 4].to_vec();
        if payload.len() + 12 < sector.len() {
            Ok((payload, true))
        } else {
            Ok((sector.to_vec(), false))
        }
    }

    fn encode_create_task(&self, source: &Path, task: &CsoCreateTask) -> Result<CsoEncodedTask> {
        let mut input = BufReader::new(File::open(source)?);
        let start_offset = u64::try_from(task.start_sector)
            .ok()
            .and_then(|sector| sector.checked_mul(CSO_DEFAULT_BLOCK_BYTES as u64))
            .ok_or_else(|| {
                RomWeaverError::Validation("cso create source offset overflowed".into())
            })?;
        input.seek(SeekFrom::Start(start_offset))?;

        if let Some(parent) = task.temp_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(&task.temp_path)?);

        let mut sector = vec![0_u8; CSO_DEFAULT_BLOCK_BYTES];
        let mut sector_encodings = Vec::with_capacity(task.sector_count);
        for _ in 0..task.sector_count {
            input.read_exact(&mut sector)?;
            let (encoded, is_compressed) = self.compress_sector_for_create(&sector)?;
            let encoded_len = u32::try_from(encoded.len()).map_err(|_| {
                RomWeaverError::Validation("cso create encoded sector length overflowed u32".into())
            })?;
            output.write_all(&encoded)?;
            sector_encodings.push(CsoSectorEncoding {
                encoded_len,
                is_compressed,
            });
        }
        output.flush()?;

        Ok(CsoEncodedTask {
            index: task.index,
            start_sector: task.start_sector,
            temp_path: task.temp_path.clone(),
            sector_encodings,
        })
    }

    fn cleanup_create_tasks(&self, tasks: &[CsoCreateTask]) {
        for task in tasks {
            let _ = fs::remove_file(&task.temp_path);
        }
    }

    fn assemble_create_output(
        &self,
        output_path: &Path,
        logical_bytes: u64,
        encoded_tasks: &[CsoEncodedTask],
    ) -> Result<u64> {
        let mut header = ciso::layout::CSOHeader::new();
        header.uncompressed_size = logical_bytes;

        let sector_count = header.index_table_len().saturating_sub(1);
        let index_entry_count = sector_count
            .checked_add(1)
            .ok_or_else(|| RomWeaverError::Validation("cso index table size overflowed".into()))?;
        let index_table_len = index_entry_count
            .checked_mul(4)
            .ok_or_else(|| RomWeaverError::Validation("cso index table size overflowed".into()))?;

        let mut output = BufWriter::new(File::create(output_path)?);
        output.write_all(&header.serialize())?;
        output.write_all(&vec![0_u8; index_table_len])?;

        let align_base = 1_u64 << header.alignment;
        let align_mask = align_base - 1;
        let mut position = u64::from(header.header_size)
            .checked_add(u64::try_from(index_table_len).map_err(|_| {
                RomWeaverError::Validation("cso index table size overflowed".into())
            })?)
            .ok_or_else(|| RomWeaverError::Validation("cso output offset overflowed".into()))?;

        let mut index_table = Vec::with_capacity(index_entry_count);
        let mut expected_sector = 0_usize;
        for task in encoded_tasks {
            if task.start_sector != expected_sector {
                return Err(RomWeaverError::Validation(format!(
                    "cso create task order is invalid (expected sector {}, found {})",
                    expected_sector, task.start_sector
                )));
            }

            let mut input = BufReader::new(File::open(&task.temp_path)?);
            for sector in &task.sector_encodings {
                let align = position & align_mask;
                if align != 0 {
                    let pad = align_base - align;
                    output.write_all(&vec![
                        0_u8;
                        usize::try_from(pad).map_err(|_| {
                            RomWeaverError::Validation(
                                "cso alignment padding overflowed usize".into(),
                            )
                        })?
                    ])?;
                    position = position.saturating_add(pad);
                }

                let index_position = u32::try_from(position >> header.alignment).map_err(|_| {
                    RomWeaverError::Validation(
                        "cso output exceeded supported index table range".into(),
                    )
                })?;
                let mut entry = index_position & 0x7FFF_FFFF;
                if sector.is_compressed {
                    entry |= 0x8000_0000;
                }
                index_table.push(entry);

                let encoded_len = usize::try_from(sector.encoded_len).map_err(|_| {
                    RomWeaverError::Validation("cso encoded sector length overflowed usize".into())
                })?;
                let mut payload = vec![0_u8; encoded_len];
                input.read_exact(&mut payload)?;
                output.write_all(&payload)?;
                position = position.saturating_add(u64::from(sector.encoded_len));
                expected_sector += 1;
            }

            let mut trailing = [0_u8; 1];
            if input.read(&mut trailing)? != 0 {
                return Err(RomWeaverError::Validation(format!(
                    "cso create task {} produced trailing bytes after encoded sectors",
                    task.index
                )));
            }
        }

        if expected_sector != sector_count {
            return Err(RomWeaverError::Validation(format!(
                "cso create encoded {} sector(s) but expected {}",
                expected_sector, sector_count
            )));
        }

        let final_position = u32::try_from(position >> header.alignment).map_err(|_| {
            RomWeaverError::Validation("cso output exceeded supported index table range".into())
        })?;
        index_table.push(final_position & 0x7FFF_FFFF);
        if index_table.len() != index_entry_count {
            return Err(RomWeaverError::Validation(
                "cso index table entry count did not match expected value".into(),
            ));
        }

        output.flush()?;
        let output_file = output.get_mut();
        output_file.seek(SeekFrom::Start(u64::from(header.header_size)))?;
        for entry in &index_table {
            output_file.write_all(&entry.to_le_bytes())?;
        }
        output.flush()?;

        Ok(fs::metadata(output_path)?.len())
    }

    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Store) => {
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "cso codec `store` does not accept --level".into(),
                    ));
                }
                Ok(NodCompression::None)
            }
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported cso codec `{}`; supported codec is store",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported cso codec `{name}`; supported codec is store"
            ))),
        }
    }
}

impl ContainerHandler for CsoContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if file_starts_with(source, &CSO_SIGNATURE) {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let compressed_bytes = fs::metadata(&request.source)?.len();
        let reader = self.open_reader(&request.source)?;
        let logical_bytes = reader.file_size();
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} bytes compressed, {} bytes uncompressed",
                self.descriptor.name, compressed_bytes, logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(vec![self.output_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        fs::create_dir_all(&request.out_dir)?;

        let output_name = self.output_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;

        let output_path = request.out_dir.join(&output_name);
        let reader = self.open_reader(&request.source)?;
        let logical_bytes = reader.file_size();
        let tasks = self.build_extract_tasks(logical_bytes, context);
        let (execution, decode_result) = if tasks.is_empty() {
            (
                context.plan_threads(ThreadCapability::parallel(None)),
                Ok(Vec::new()),
            )
        } else {
            let (execution, pool) =
                context.build_pool(ThreadCapability::parallel(Some(tasks.len().max(1))))?;
            let source = request.source.clone();
            let decode_result = if execution.used_parallelism {
                pool.install(|| {
                    tasks
                        .par_iter()
                        .map(|task| self.decode_extract_task(&source, task))
                        .collect::<Result<Vec<_>>>()
                })
            } else {
                tasks
                    .iter()
                    .map(|task| self.decode_extract_task(&source, task))
                    .collect::<Result<Vec<_>>>()
            };
            (execution, decode_result)
        };
        if let Err(error) = decode_result {
            self.cleanup_extract_tasks(&tasks);
            return Err(error);
        }

        let assemble_result = self.assemble_extract_output(&tasks, &output_path);
        self.cleanup_extract_tasks(&tasks);
        assemble_result?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` (1 file, {} bytes written)",
                request.source.display(),
                output_path.display(),
                logical_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(
                "cso create currently requires exactly one input file".into(),
            ));
        }

        let input = &request.inputs[0];
        let _compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let logical_bytes = fs::metadata(input)?.len();
        let create_tasks = self.build_create_tasks(logical_bytes, context);

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let (execution, encode_result) = if create_tasks.is_empty() {
            (
                context.plan_threads(ThreadCapability::parallel(None)),
                Ok(Vec::new()),
            )
        } else {
            let (execution, pool) =
                context.build_pool(ThreadCapability::parallel(Some(create_tasks.len().max(1))))?;
            let source = input.clone();
            let encode_result = if execution.used_parallelism {
                pool.install(|| {
                    create_tasks
                        .par_iter()
                        .map(|task| self.encode_create_task(&source, task))
                        .collect::<Result<Vec<_>>>()
                })
            } else {
                create_tasks
                    .iter()
                    .map(|task| self.encode_create_task(&source, task))
                    .collect::<Result<Vec<_>>>()
            };
            (execution, encode_result)
        };

        let mut encoded_tasks = match encode_result {
            Ok(tasks) => tasks,
            Err(error) => {
                self.cleanup_create_tasks(&create_tasks);
                return Err(error);
            }
        };
        encoded_tasks.sort_by_key(|task| task.start_sector);
        let output_bytes =
            match self.assemble_create_output(&request.output, logical_bytes, &encoded_tasks) {
                Ok(bytes) => bytes,
                Err(error) => {
                    self.cleanup_create_tasks(&create_tasks);
                    return Err(error);
                }
            };
        self.cleanup_create_tasks(&create_tasks);

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} `{}` from `{}` (codec=store, {} bytes)",
                self.descriptor.name,
                request.output.display(),
                input.display(),
                output_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: true,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}

struct SevenZContainerHandler {
    descriptor: &'static FormatDescriptor,
}

impl SevenZContainerHandler {
    const DEFAULT_LZMA2_LEVEL: u32 = 6;
    const LZMA2_MT_CHUNK_BYTES: u64 = 1 << 20;

    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn open_reader(&self, source: &Path) -> Result<SevenZReader<File>> {
        let file = File::open(source)?;
        SevenZReader::new(file, SevenZPassword::empty())
            .map_err(|error| RomWeaverError::Validation(format!("7z archive is invalid: {error}")))
    }

    fn parse_codec(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
        execution: &rom_weaver_core::ThreadExecution,
    ) -> Result<SevenZMethodConfiguration> {
        let mut method = match parse_requested_codec(codec) {
            RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Lzma2) => {
                Ok(SevenZMethodConfiguration::new(SevenZMethod::LZMA2))
            }
            RequestedCodec::Known(CanonicalCodec::Lzma) => {
                Ok(SevenZMethodConfiguration::new(SevenZMethod::LZMA))
            }
            RequestedCodec::Known(CanonicalCodec::Store) => {
                Ok(SevenZMethodConfiguration::new(SevenZMethod::COPY))
            }
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported 7z codec `{}`; supported codecs are lzma2, lzma, and store",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported 7z codec `{name}`; supported codecs are lzma2, lzma, and store"
            ))),
        }?;

        let level = if let Some(level) = level {
            if !(0..=9).contains(&level) {
                return Err(RomWeaverError::Validation(format!(
                    "7z level `{level}` is out of range (0..=9)"
                )));
            }
            Some(level as u32)
        } else {
            None
        };

        if method.method == SevenZMethod::COPY && level.is_some() {
            return Err(RomWeaverError::Validation(
                "7z codec `store` does not accept --level".into(),
            ));
        }

        match method.method {
            SevenZMethod::LZMA2 if execution.used_parallelism => {
                #[cfg(target_family = "wasm")]
                let mut options = sevenz_rust::encoder_options::Lzma2Options::from_level_mt(
                    level.unwrap_or(Self::DEFAULT_LZMA2_LEVEL),
                    self.thread_count(execution.effective_threads),
                    Self::LZMA2_MT_CHUNK_BYTES,
                );
                #[cfg(not(target_family = "wasm"))]
                let options = sevenz_rust::encoder_options::Lzma2Options::from_level_mt(
                    level.unwrap_or(Self::DEFAULT_LZMA2_LEVEL),
                    self.thread_count(execution.effective_threads),
                    Self::LZMA2_MT_CHUNK_BYTES,
                );
                #[cfg(target_family = "wasm")]
                options.set_dictionary_size(1 << 12);
                method = method.with_options(options.into());
            }
            SevenZMethod::LZMA2 => {
                #[cfg(target_family = "wasm")]
                {
                    let mut options = sevenz_rust::encoder_options::Lzma2Options::from_level(
                        level.unwrap_or(Self::DEFAULT_LZMA2_LEVEL),
                    );
                    options.set_dictionary_size(1 << 12);
                    method = method.with_options(options.into());
                }
                #[cfg(not(target_family = "wasm"))]
                if let Some(level) = level {
                    let options = sevenz_rust::encoder_options::Lzma2Options::from_level(level);
                    method = method.with_options(options.into());
                }
            }
            SevenZMethod::LZMA => {
                #[cfg(target_family = "wasm")]
                {
                    let options = sevenz_rust::encoder_options::LzmaOptions::from_level(
                        level.unwrap_or(Self::DEFAULT_LZMA2_LEVEL),
                    );
                    method = method
                        .with_options(sevenz_rust::encoder_options::EncoderOptions::Lzma(options));
                }
                #[cfg(not(target_family = "wasm"))]
                if let Some(level) = level {
                    method =
                        method.with_options(sevenz_rust::encoder_options::EncoderOptions::Lzma(
                            sevenz_rust::encoder_options::LzmaOptions::from_level(level),
                        ));
                }
            }
            _ => {}
        }

        Ok(method)
    }

    fn thread_count(&self, effective_threads: usize) -> u32 {
        match u32::try_from(effective_threads) {
            Ok(count) => count.clamp(1, 256),
            Err(_) => 256,
        }
    }

    fn method_name(method: &SevenZMethodConfiguration) -> &'static str {
        match method.method {
            SevenZMethod::COPY => "store",
            SevenZMethod::LZMA2 => "lzma2",
            SevenZMethod::LZMA => "lzma",
            _ => "unknown",
        }
    }

    fn create_archive_entry(&self, entry: &ArchiveInputEntry) -> SevenZArchiveEntry {
        #[cfg(target_family = "wasm")]
        {
            // Avoid filesystem timestamp conversion in sevenz-rust on wasm, which can panic on
            // platforms that cannot represent pre-UNIX-EPOCH SystemTime values.
            if entry.is_dir {
                SevenZArchiveEntry::new_directory(&entry.archive_name)
            } else {
                SevenZArchiveEntry::new_file(&entry.archive_name)
            }
        }
        #[cfg(not(target_family = "wasm"))]
        {
            SevenZArchiveEntry::from_path(&entry.source, entry.archive_name.clone())
        }
    }
}

impl ContainerHandler for SevenZContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        let mut signature = [0u8; SEVEN_Z_SIGNATURE.len()];
        if let Ok(mut file) = File::open(source) {
            if file.read_exact(&mut signature).is_ok() && signature == SEVEN_Z_SIGNATURE {
                return ProbeConfidence::Signature;
            }
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let reader = self.open_reader(&request.source)?;
        let archive = reader.archive();
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut compressed_bytes = 0u64;
        let mut logical_bytes = 0u64;

        for entry in &archive.files {
            if entry.is_directory() {
                directories += 1;
            } else {
                files += 1;
            }
            compressed_bytes = compressed_bytes.saturating_add(entry.compressed_size);
            logical_bytes = logical_bytes.saturating_add(entry.size());
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "7z: {} entries ({} files, {} directories), {} bytes compressed, {} bytes uncompressed",
                archive.files.len(),
                files,
                directories,
                compressed_bytes,
                logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        let reader = self.open_reader(&request.source)?;
        let archive = reader.archive();
        let mut entries = Vec::new();
        for entry in &archive.files {
            let entry_name = normalize_archive_name(entry.name());
            if !entry_name.is_empty() {
                entries.push(entry_name);
            }
        }
        Ok(entries)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        fs::create_dir_all(&request.out_dir)?;

        let mut reader = self.open_reader(&request.source)?;
        reader.set_thread_count(self.thread_count(execution.effective_threads));
        let mut preview_selections = SelectionMatcher::new(&request.selections);
        let total_selected_entries = reader
            .archive()
            .files
            .iter()
            .filter(|entry| {
                let entry_name = normalize_archive_name(entry.name());
                !entry_name.is_empty() && preview_selections.matches(&entry_name)
            })
            .count();
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut extracted_files = 0usize;
        let mut written_bytes = 0u64;
        let mut selected_entries_completed = 0usize;

        if total_selected_entries > 0 {
            emit_container_running_progress(
                context,
                "extract",
                self.descriptor.name,
                "extract",
                format!(
                    "extracting `{}` ({} selected entries)",
                    self.descriptor.name, total_selected_entries
                ),
                0.0,
                Some(&execution),
            );
        }

        reader
            .for_each_entries(|entry, source| {
                let entry_name = normalize_archive_name(entry.name());
                if entry_name.is_empty() || !selections.matches(&entry_name) {
                    if entry.size() > 0 {
                        io::copy(source, &mut io::sink())?;
                    }
                    return Ok(true);
                }

                let relative = sanitize_archive_relative_path_from_str(entry.name())
                    .map_err(|error| io::Error::other(error.to_string()))?;
                let output_path = request.out_dir.join(relative);

                if entry.is_directory() {
                    fs::create_dir_all(&output_path)?;
                    selected_entries_completed = selected_entries_completed.saturating_add(1);
                    emit_container_step_progress(
                        context,
                        "extract",
                        self.descriptor.name,
                        "extract",
                        selected_entries_completed,
                        total_selected_entries,
                        format!(
                            "extracting `{}` ({}/{})",
                            self.descriptor.name,
                            selected_entries_completed,
                            total_selected_entries
                        ),
                        Some(&execution),
                    );
                    return Ok(true);
                }

                if let Some(parent) = output_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut output = BufWriter::new(File::create(&output_path)?);
                let copied = io::copy(source, &mut output)?;
                extracted_files += 1;
                written_bytes = written_bytes.saturating_add(copied);
                selected_entries_completed = selected_entries_completed.saturating_add(1);
                emit_container_step_progress(
                    context,
                    "extract",
                    self.descriptor.name,
                    "extract",
                    selected_entries_completed,
                    total_selected_entries,
                    format!(
                        "extracting `{}` ({}/{})",
                        self.descriptor.name, selected_entries_completed, total_selected_entries
                    ),
                    Some(&execution),
                );
                Ok(true)
            })
            .map_err(|error| RomWeaverError::Validation(format!("7z extract failed: {error}")))?;

        selections.ensure_all_matched()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} file(s), {} bytes written)",
                request.source.display(),
                request.out_dir.display(),
                extracted_files,
                written_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let method = self.parse_codec(request.codec.as_deref(), request.level, &execution)?;
        let entries = collect_archive_inputs(&request.inputs)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let output = File::create(&request.output)?;
        let mut writer = SevenZWriter::new(output).map_err(|error| {
            RomWeaverError::Validation(format!("7z create failed to initialize writer: {error}"))
        })?;
        writer.set_content_methods(vec![method.clone()]);

        let mut logical_bytes = 0u64;
        let total_entries = entries.len();
        for (entry_index, entry) in entries.iter().enumerate() {
            let archive_entry = self.create_archive_entry(entry);
            if entry.is_dir {
                writer
                    .push_archive_entry::<&[u8]>(archive_entry, None)
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "7z create failed for `{}`: {error}",
                            entry.archive_name
                        ))
                    })?;
                emit_container_step_progress(
                    context,
                    "compress",
                    self.descriptor.name,
                    "create",
                    entry_index.saturating_add(1),
                    total_entries,
                    format!(
                        "creating `{}` ({}/{})",
                        self.descriptor.name,
                        entry_index.saturating_add(1),
                        total_entries
                    ),
                    Some(&execution),
                );
                continue;
            }

            writer
                .push_archive_entry(
                    archive_entry,
                    Some({
                        #[cfg(target_family = "wasm")]
                        {
                            Cursor::new(fs::read(&entry.source)?)
                        }
                        #[cfg(not(target_family = "wasm"))]
                        {
                            File::open(&entry.source)?
                        }
                    }),
                )
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "7z create failed for `{}`: {error}",
                        entry.archive_name
                    ))
                })?;
            logical_bytes = logical_bytes.saturating_add(fs::metadata(&entry.source)?.len());
            emit_container_step_progress(
                context,
                "compress",
                self.descriptor.name,
                "create",
                entry_index.saturating_add(1),
                total_entries,
                format!(
                    "creating `{}` ({}/{})",
                    self.descriptor.name,
                    entry_index.saturating_add(1),
                    total_entries
                ),
                Some(&execution),
            );
        }

        writer.finish().map_err(|error| {
            RomWeaverError::Validation(format!(
                "7z create failed while finalizing archive: {error}"
            ))
        })?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from {} input(s) with {} ({} bytes)",
                request.output.display(),
                request.inputs.len(),
                Self::method_name(&method),
                logical_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: true,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}

struct RarContainerHandler {
    descriptor: &'static FormatDescriptor,
}

#[derive(Clone, Debug)]
struct RarExtractTask {
    index: usize,
    output_path: PathBuf,
    is_directory: bool,
}

impl RarContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn open_archive(&self, source: &Path) -> Result<rars::Archive> {
        RarRsArchiveReader::read_path(source)
            .map_err(|error| RomWeaverError::Validation(format!("rar archive is invalid: {error}")))
    }

    fn build_extract_tasks(
        &self,
        request: &ContainerExtractRequest,
        archive: &rars::Archive,
    ) -> Result<Vec<RarExtractTask>> {
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut tasks = Vec::new();

        for (index, member) in archive.members().enumerate() {
            let entry_name =
                normalize_archive_name(&String::from_utf8_lossy(member.meta.name_bytes()));
            if entry_name.is_empty() || !selections.matches(&entry_name) {
                continue;
            }

            let relative = sanitize_archive_relative_path_from_str(&entry_name)?;
            tasks.push(RarExtractTask {
                index,
                output_path: request.out_dir.join(relative),
                is_directory: member.meta.is_directory,
            });
        }

        selections.ensure_all_matched()?;
        Ok(tasks)
    }

    fn extract_task_chunk(&self, source: &Path, chunk: &[RarExtractTask]) -> Result<(usize, u64)> {
        if chunk.is_empty() {
            return Ok((0, 0));
        }

        let archive = self.open_archive(source)?;
        let mut task_by_index = BTreeMap::new();
        for task in chunk {
            task_by_index.insert(task.index, task);
        }

        let mut entry_index = 0usize;
        let mut matched_tasks = 0usize;
        let mut extracted_paths = Vec::new();

        archive
            .extract_to(None, |meta| {
                let current_index = entry_index;
                entry_index = entry_index.saturating_add(1);
                let Some(task) = task_by_index.get(&current_index).copied() else {
                    return Ok(Box::new(io::sink()) as Box<dyn Write>);
                };

                matched_tasks = matched_tasks.saturating_add(1);
                if task.is_directory || meta.is_directory {
                    fs::create_dir_all(&task.output_path)?;
                    return Ok(Box::new(io::sink()) as Box<dyn Write>);
                }

                if let Some(parent) = task.output_path.parent() {
                    fs::create_dir_all(parent)?;
                }

                extracted_paths.push(task.output_path.clone());
                Ok(Box::new(BufWriter::new(File::create(&task.output_path)?)) as Box<dyn Write>)
            })
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "rar extract failed for `{}`: {error}",
                    source.display()
                ))
            })?;

        if matched_tasks != task_by_index.len() {
            return Err(RomWeaverError::Validation(
                "rar extract failed because selected entries changed while processing".into(),
            ));
        }

        let mut extracted_files = 0usize;
        let mut written_bytes = 0u64;
        for path in extracted_paths {
            let metadata = fs::metadata(&path)?;
            if metadata.is_file() {
                extracted_files = extracted_files.saturating_add(1);
                written_bytes = written_bytes.saturating_add(metadata.len());
            }
        }

        Ok((extracted_files, written_bytes))
    }
}

impl ContainerHandler for RarContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        let mut signature = [0u8; RAR5_SIGNATURE.len()];
        if let Ok(mut file) = File::open(source) {
            if let Ok(read) = file.read(&mut signature) {
                if read >= RAR4_SIGNATURE.len()
                    && signature[..RAR4_SIGNATURE.len()] == RAR4_SIGNATURE
                {
                    return ProbeConfidence::Signature;
                }
                if read >= RAR5_SIGNATURE.len() && signature == RAR5_SIGNATURE {
                    return ProbeConfidence::Signature;
                }
            }
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let archive = self.open_archive(&request.source)?;
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut logical_bytes = 0u64;
        let mut entries_total = 0usize;

        for member in archive.members() {
            let entry_name =
                normalize_archive_name(&String::from_utf8_lossy(member.meta.name_bytes()));
            if entry_name.is_empty() {
                continue;
            }
            entries_total = entries_total.saturating_add(1);
            if member.meta.is_directory {
                directories = directories.saturating_add(1);
            } else {
                files = files.saturating_add(1);
                logical_bytes = logical_bytes.saturating_add(member.meta.unpacked_size);
            }
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "rar: {} entries ({} files, {} directories), {} bytes uncompressed",
                entries_total, files, directories, logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        let archive = self.open_archive(&request.source)?;
        let mut entries = Vec::new();
        for member in archive.members() {
            let entry_name =
                normalize_archive_name(&String::from_utf8_lossy(member.meta.name_bytes()));
            if !entry_name.is_empty() {
                entries.push(entry_name);
            }
        }
        Ok(entries)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        fs::create_dir_all(&request.out_dir)?;
        let archive = self.open_archive(&request.source)?;
        let tasks = self.build_extract_tasks(request, &archive)?;
        let mut output_paths = BTreeSet::new();
        let mut duplicate_output_paths = false;
        for task in &tasks {
            if task.is_directory {
                continue;
            }
            duplicate_output_paths |= !output_paths.insert(task.output_path.clone());
        }

        let (execution, extracted_files, written_bytes) =
            if tasks.is_empty() || duplicate_output_paths {
                let execution = context.plan_threads(ThreadCapability::single_threaded());
                let (extracted_files, written_bytes) =
                    self.extract_task_chunk(&request.source, &tasks)?;
                (execution, extracted_files, written_bytes)
            } else {
                let task_count = tasks.len().max(1);
                let (execution, pool) =
                    context.build_pool(ThreadCapability::parallel(Some(task_count)))?;
                let source = request.source.clone();
                let (extracted_files, written_bytes) = if execution.used_parallelism {
                    let worker_count = execution.effective_threads.max(1);
                    let chunk_size = tasks.len().div_ceil(worker_count).max(1);
                    let chunk_results = pool.install(|| {
                        tasks
                            .par_chunks(chunk_size)
                            .map(|chunk| self.extract_task_chunk(&source, chunk))
                            .collect::<Result<Vec<_>>>()
                    })?;
                    chunk_results.into_iter().fold(
                        (0usize, 0u64),
                        |(files_acc, bytes_acc), (files, bytes)| {
                            (
                                files_acc.saturating_add(files),
                                bytes_acc.saturating_add(bytes),
                            )
                        },
                    )
                } else {
                    self.extract_task_chunk(&source, &tasks)?
                };
                (execution, extracted_files, written_bytes)
            };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} file(s), {} bytes written)",
                request.source.display(),
                request.out_dir.display(),
                extracted_files,
                written_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "rar create is not supported".into(),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: false,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

#[derive(Clone, Debug)]
struct PbpIsoIndexEntry {
    offset: u64,
    length: u64,
}

#[derive(Clone, Debug)]
struct PbpTocTrack {
    track_type: u8,
    track_number: u8,
    start_frames: u32,
}

impl PbpTocTrack {
    fn cue_track_type(&self) -> Result<&'static str> {
        match self.track_type {
            0x41 => Ok("MODE2/2352"),
            0x01 => Ok("AUDIO"),
            other => Err(RomWeaverError::Validation(format!(
                "pbp toc uses unsupported track type 0x{other:02X}; supported types are 0x41 (MODE2/2352) and 0x01 (AUDIO)"
            ))),
        }
    }
}

#[derive(Clone, Debug)]
struct PbpDiscEntry {
    disc_number: usize,
    disc_id: String,
    psar_offset: u64,
    iso_size: u64,
    toc_tracks: Vec<PbpTocTrack>,
    iso_indexes: Vec<PbpIsoIndexEntry>,
}

#[derive(Clone, Debug)]
struct PbpArchive {
    discs: Vec<PbpDiscEntry>,
}

#[derive(Clone, Debug)]
struct PbpDiscOutput {
    cue_name: String,
    bin_name: String,
}

#[derive(Clone, Debug)]
struct PbpDiscExtractTask {
    disc_index: usize,
    task_index: usize,
    start_block: usize,
    block_count: usize,
    expected_len: u64,
    temp_path: PathBuf,
}

struct PbpContainerHandler;

impl PbpContainerHandler {
    const PBP_HEADER_SIZE: usize = 0x28;
    const PBP_SECTION_COUNT: usize = 8;
    const PSAR_INDEX_FIELD_OFFSET: usize = 0x24;
    const PSAR_GAME_ID_OFFSET: u64 = 0x400;
    const PSAR_TOC_OFFSET: u64 = 0x800;
    const PSAR_INDEX_OFFSET: u64 = 0x4000;
    const PSAR_ISO_OFFSET: u64 = 0x100000;
    const PSAR_INDEX_ENTRY_SIZE: usize = 0x20;
    const ISO_SECTOR_BYTES: usize = 0x930;
    const ISO_BLOCK_SECTORS: usize = 16;
    const ISO_BLOCK_BYTES: usize = Self::ISO_SECTOR_BYTES * Self::ISO_BLOCK_SECTORS;
    const PBP_EXTRACT_TASK_BLOCKS: usize = 128;
    const MULTI_DISC_SLOT_COUNT: usize = 5;
    const MULTI_DISC_MAGIC: [u8; 16] = *b"PSTITLEIMG000000";
    const SINGLE_DISC_MAGIC: [u8; 12] = *b"PSISOIMG0000";
    const MULTI_DISC_HEADER_KEYS: [u32; 4] = [0x2CC9_C5BC, 0x33B5_A90F, 0x06F6_B4B3, 0xB259_45BA];

    fn parse_archive(&self, source: &Path) -> Result<PbpArchive> {
        let mut file = File::open(source).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open pbp source `{}`: {error}",
                source.display()
            ))
        })?;
        let file_size = file.metadata()?.len();
        if file_size < Self::PBP_HEADER_SIZE as u64 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` is too small to be a pbp container",
                source.display()
            )));
        }

        let psar_offset = self.parse_psar_offset(source, &mut file, file_size)?;
        let disc_offsets = self.parse_disc_offsets(source, &mut file, psar_offset, file_size)?;
        let mut discs = Vec::with_capacity(disc_offsets.len());
        for (index, disc_offset) in disc_offsets.into_iter().enumerate() {
            discs.push(self.parse_disc_entry(
                source,
                &mut file,
                disc_offset,
                index + 1,
                file_size,
            )?);
        }
        if discs.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "pbp source `{}` contains no disc entries",
                source.display()
            )));
        }
        Ok(PbpArchive { discs })
    }

    fn parse_psar_offset(&self, source: &Path, file: &mut File, file_size: u64) -> Result<u64> {
        let mut header = [0u8; Self::PBP_HEADER_SIZE];
        self.read_exact_at(source, file, 0, &mut header, "PBP header")?;
        if header[..4] != PBP_SIGNATURE {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` is not a pbp container (missing \\0PBP magic)",
                source.display()
            )));
        }

        let mut previous = 0u32;
        for section_index in 0..Self::PBP_SECTION_COUNT {
            let offset_index = 8 + (section_index * 4);
            let offset = u32::from_le_bytes([
                header[offset_index],
                header[offset_index + 1],
                header[offset_index + 2],
                header[offset_index + 3],
            ]);
            if section_index == 0 && offset < Self::PBP_HEADER_SIZE as u32 {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has an invalid PBP section table (first section offset is {offset:#X})",
                    source.display()
                )));
            }
            if section_index > 0 && offset < previous {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has non-monotonic PBP section offsets",
                    source.display()
                )));
            }
            if u64::from(offset) > file_size {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has an out-of-range PBP section offset ({offset:#X})",
                    source.display()
                )));
            }
            previous = offset;
        }

        let psar_offset = u32::from_le_bytes([
            header[Self::PSAR_INDEX_FIELD_OFFSET],
            header[Self::PSAR_INDEX_FIELD_OFFSET + 1],
            header[Self::PSAR_INDEX_FIELD_OFFSET + 2],
            header[Self::PSAR_INDEX_FIELD_OFFSET + 3],
        ]) as u64;
        if psar_offset >= file_size {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has an invalid DATA.PSAR offset ({psar_offset:#X})",
                source.display()
            )));
        }
        Ok(psar_offset)
    }

    fn parse_disc_offsets(
        &self,
        source: &Path,
        file: &mut File,
        psar_offset: u64,
        file_size: u64,
    ) -> Result<Vec<u64>> {
        let mut signature = [0u8; 16];
        self.read_exact_at(
            source,
            file,
            psar_offset,
            &mut signature,
            "DATA.PSAR signature",
        )?;

        if signature[..12] == Self::SINGLE_DISC_MAGIC {
            return Ok(vec![psar_offset]);
        }

        if signature != Self::MULTI_DISC_MAGIC {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` does not contain a supported PS1 DATA.PSAR signature",
                source.display()
            )));
        }

        let mut cursor = psar_offset + 16;
        cursor = cursor
            .checked_add(8)
            .ok_or_else(|| RomWeaverError::Validation("pbp multi-disc header overflowed".into()))?;
        for (index, expected) in Self::MULTI_DISC_HEADER_KEYS.iter().enumerate() {
            let value = self.read_u32_le_at(source, file, cursor)?;
            if value != *expected {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has an unexpected multi-disc key at slot {}",
                    source.display(),
                    index + 1
                )));
            }
            cursor = cursor.checked_add(4).ok_or_else(|| {
                RomWeaverError::Validation("pbp multi-disc header overflowed".into())
            })?;
        }

        cursor = cursor
            .checked_add(0x76 * 4)
            .ok_or_else(|| RomWeaverError::Validation("pbp multi-disc header overflowed".into()))?;

        let mut raw_offsets = [0u8; Self::MULTI_DISC_SLOT_COUNT * 4];
        self.read_exact_at(
            source,
            file,
            cursor,
            &mut raw_offsets,
            "multi-disc offset table",
        )?;

        let mut discs = Vec::new();
        for index in 0..Self::MULTI_DISC_SLOT_COUNT {
            let offset_index = index * 4;
            let relative = u32::from_le_bytes([
                raw_offsets[offset_index],
                raw_offsets[offset_index + 1],
                raw_offsets[offset_index + 2],
                raw_offsets[offset_index + 3],
            ]) as u64;
            if relative == 0 {
                continue;
            }
            let absolute = psar_offset
                .checked_add(relative)
                .ok_or_else(|| RomWeaverError::Validation("pbp disc offset overflowed".into()))?;
            if absolute >= file_size {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` contains an out-of-range disc offset ({absolute:#X})",
                    source.display()
                )));
            }
            discs.push(absolute);
        }
        if discs.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` contains a multi-disc header with no disc offsets",
                source.display()
            )));
        }
        Ok(discs)
    }

    fn parse_disc_entry(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
        disc_number: usize,
        file_size: u64,
    ) -> Result<PbpDiscEntry> {
        let mut header = [0u8; 12];
        self.read_exact_at(
            source,
            file,
            disc_psar_offset,
            &mut header,
            "PSISOIMG header",
        )?;
        if header != Self::SINGLE_DISC_MAGIC {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` disc {} does not start with a PSISOIMG section",
                source.display(),
                disc_number
            )));
        }

        let disc_id = self.read_disc_id(source, file, disc_psar_offset)?;
        let toc_tracks = self.read_toc_tracks(source, file, disc_psar_offset)?;
        let iso_indexes = self.read_iso_indexes(source, file, disc_psar_offset, file_size)?;
        if iso_indexes.len() < 2 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` disc {} has too few ISO index blocks",
                source.display(),
                disc_number
            )));
        }
        let iso_size =
            self.read_iso_size_from_index(source, file, disc_psar_offset, &iso_indexes)?;
        let required_blocks = self.required_block_count(iso_size)?;
        if iso_indexes.len() < required_blocks {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` disc {} index table is incomplete ({} blocks required, {} present)",
                source.display(),
                disc_number,
                required_blocks,
                iso_indexes.len()
            )));
        }

        Ok(PbpDiscEntry {
            disc_number,
            disc_id,
            psar_offset: disc_psar_offset,
            iso_size,
            toc_tracks,
            iso_indexes,
        })
    }

    fn read_disc_id(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
    ) -> Result<String> {
        let mut bytes = [0u8; 11];
        self.read_exact_at(
            source,
            file,
            disc_psar_offset + Self::PSAR_GAME_ID_OFFSET,
            &mut bytes,
            "disc id",
        )?;
        let mut disc_id_bytes = [0u8; 9];
        disc_id_bytes[..4].copy_from_slice(&bytes[1..5]);
        disc_id_bytes[4..].copy_from_slice(&bytes[6..11]);
        let disc_id = String::from_utf8_lossy(&disc_id_bytes)
            .trim_matches(char::from(0))
            .trim()
            .to_string();
        if disc_id.is_empty() {
            Ok("unknown".to_string())
        } else {
            Ok(disc_id)
        }
    }

    fn read_toc_tracks(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
    ) -> Result<Vec<PbpTocTrack>> {
        let mut entry = [0u8; 10];
        let mut cursor = disc_psar_offset + Self::PSAR_TOC_OFFSET;
        self.read_exact_at(source, file, cursor, &mut entry, "TOC start-track entry")?;
        if entry[2] != 0xA0 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has an invalid PBP TOC (missing A0 entry)",
                source.display()
            )));
        }
        let start_track = Self::decode_bcd(entry[7], "TOC start track")?;
        cursor += 10;

        self.read_exact_at(source, file, cursor, &mut entry, "TOC end-track entry")?;
        if entry[2] != 0xA1 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has an invalid PBP TOC (missing A1 entry)",
                source.display()
            )));
        }
        let end_track = Self::decode_bcd(entry[7], "TOC end track")?;
        if start_track == 0 || end_track < start_track {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has an invalid TOC track range ({start_track}..={end_track})",
                source.display()
            )));
        }
        cursor += 10;

        self.read_exact_at(source, file, cursor, &mut entry, "TOC leadout entry")?;
        if entry[2] != 0xA2 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has an invalid PBP TOC (missing A2 entry)",
                source.display()
            )));
        }
        let _leadout = Self::msf_to_frames(
            Self::decode_bcd(entry[7], "TOC leadout minute")?,
            Self::decode_bcd(entry[8], "TOC leadout second")?,
            Self::decode_bcd(entry[9], "TOC leadout frame")?,
        )?;
        cursor += 10;

        let mut tracks = Vec::new();
        for expected_track in start_track..=end_track {
            self.read_exact_at(source, file, cursor, &mut entry, "TOC track entry")?;
            cursor += 10;
            let track_number = Self::decode_bcd(entry[2], "TOC track number")?;
            if track_number != expected_track {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has an invalid TOC track order (expected {}, found {})",
                    source.display(),
                    expected_track,
                    track_number
                )));
            }

            let start_frames = Self::msf_to_frames(
                Self::decode_bcd(entry[3], "TOC track minute")?,
                Self::decode_bcd(entry[4], "TOC track second")?,
                Self::decode_bcd(entry[5], "TOC track frame")?,
            )?;
            let track = PbpTocTrack {
                track_type: entry[0],
                track_number,
                start_frames,
            };
            track.cue_track_type()?;
            tracks.push(track);
        }
        Ok(tracks)
    }

    fn read_iso_indexes(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
        file_size: u64,
    ) -> Result<Vec<PbpIsoIndexEntry>> {
        let index_span = usize::try_from(Self::PSAR_ISO_OFFSET - Self::PSAR_INDEX_OFFSET)
            .map_err(|_| RomWeaverError::Validation("pbp index table length overflowed".into()))?;
        let mut bytes = vec![0u8; index_span];
        self.read_exact_at(
            source,
            file,
            disc_psar_offset + Self::PSAR_INDEX_OFFSET,
            &mut bytes,
            "ISO index table",
        )?;

        let mut indexes = Vec::new();
        for chunk in bytes.chunks_exact(Self::PSAR_INDEX_ENTRY_SIZE) {
            let offset = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as u64;
            let length = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
            if offset == 0 && length == 0 {
                continue;
            }
            if length == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has a malformed ISO index entry",
                    source.display()
                )));
            }
            let data_start = disc_psar_offset
                .checked_add(Self::PSAR_ISO_OFFSET)
                .and_then(|value| value.checked_add(offset))
                .ok_or_else(|| {
                    RomWeaverError::Validation("pbp ISO index offset overflowed".into())
                })?;
            let data_end = data_start.checked_add(length).ok_or_else(|| {
                RomWeaverError::Validation("pbp ISO index length overflowed".into())
            })?;
            if data_end > file_size {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has an out-of-range ISO index entry",
                    source.display()
                )));
            }
            indexes.push(PbpIsoIndexEntry { offset, length });
        }

        if indexes.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` does not contain any ISO index blocks",
                source.display()
            )));
        }
        Ok(indexes)
    }

    fn read_iso_size_from_index(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
        indexes: &[PbpIsoIndexEntry],
    ) -> Result<u64> {
        let mut block = vec![0u8; Self::ISO_BLOCK_BYTES];
        let decoded =
            self.read_iso_block(source, file, disc_psar_offset, indexes, 1, &mut block)?;
        if decoded < 108 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has a truncated ISO size descriptor block",
                source.display()
            )));
        }
        let sector_count = u32::from_le_bytes([block[104], block[105], block[106], block[107]]);
        if sector_count == 0 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` reported an invalid ISO sector count of zero",
                source.display()
            )));
        }
        u64::from(sector_count)
            .checked_mul(Self::ISO_SECTOR_BYTES as u64)
            .ok_or_else(|| RomWeaverError::Validation("pbp ISO size overflowed".into()))
    }

    fn read_iso_block(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
        indexes: &[PbpIsoIndexEntry],
        block_index: usize,
        output: &mut [u8],
    ) -> Result<usize> {
        let entry = indexes.get(block_index).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "source `{}` is missing ISO block index {}",
                source.display(),
                block_index
            ))
        })?;
        let compressed_len = usize::try_from(entry.length).map_err(|_| {
            RomWeaverError::Validation("pbp ISO block length overflowed usize".into())
        })?;
        if compressed_len == 0 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` contains an empty ISO block entry",
                source.display()
            )));
        }
        let mut compressed = vec![0u8; compressed_len];
        let source_offset = disc_psar_offset
            .checked_add(Self::PSAR_ISO_OFFSET)
            .and_then(|value| value.checked_add(entry.offset))
            .ok_or_else(|| RomWeaverError::Validation("pbp ISO block offset overflowed".into()))?;
        self.read_exact_at(
            source,
            file,
            source_offset,
            &mut compressed,
            "ISO block payload",
        )?;

        if compressed_len == Self::ISO_BLOCK_BYTES {
            output[..Self::ISO_BLOCK_BYTES].copy_from_slice(&compressed);
            return Ok(Self::ISO_BLOCK_BYTES);
        }

        let mut decoder = DeflateDecoder::new(compressed.as_slice());
        let mut written = 0usize;
        while written < output.len() {
            let read = decoder.read(&mut output[written..])?;
            if read == 0 {
                break;
            }
            written = written.saturating_add(read);
        }
        if written == output.len() {
            let mut trailing = [0u8; 1];
            if decoder.read(&mut trailing)? != 0 {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` contains an oversized deflate ISO block",
                    source.display()
                )));
            }
        }
        if written == 0 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` contains an undecodable deflate ISO block",
                source.display()
            )));
        }
        Ok(written)
    }

    fn required_block_count(&self, iso_size: u64) -> Result<usize> {
        if iso_size == 0 {
            return Ok(0);
        }
        let block_bytes = Self::ISO_BLOCK_BYTES as u64;
        let blocks = iso_size.div_ceil(block_bytes);
        usize::try_from(blocks).map_err(|_| {
            RomWeaverError::Validation("pbp ISO block count exceeds supported size".into())
        })
    }

    fn build_disc_extract_tasks(
        &self,
        disc_index: usize,
        disc: &PbpDiscEntry,
        context: &OperationContext,
    ) -> Result<Vec<PbpDiscExtractTask>> {
        let required_blocks = self.required_block_count(disc.iso_size)?;
        if required_blocks == 0 {
            return Ok(Vec::new());
        }

        let mut tasks = Vec::new();
        let mut start_block = 0usize;
        let mut task_index = 0usize;
        while start_block < required_blocks {
            let block_count = (required_blocks - start_block).min(Self::PBP_EXTRACT_TASK_BLOCKS);
            let start_offset = u64::try_from(start_block)
                .ok()
                .and_then(|value| value.checked_mul(Self::ISO_BLOCK_BYTES as u64))
                .ok_or_else(|| {
                    RomWeaverError::Validation("pbp extract block offset overflowed".into())
                })?;
            let max_task_len = u64::try_from(block_count)
                .ok()
                .and_then(|value| value.checked_mul(Self::ISO_BLOCK_BYTES as u64))
                .ok_or_else(|| {
                    RomWeaverError::Validation("pbp extract block length overflowed".into())
                })?;
            let expected_len = disc.iso_size.saturating_sub(start_offset).min(max_task_len);
            tasks.push(PbpDiscExtractTask {
                disc_index,
                task_index,
                start_block,
                block_count,
                expected_len,
                temp_path: context.temp_paths().next_path(
                    &format!("pbp-disc{}-extract-{task_index}", disc.disc_number),
                    Some("binchunk"),
                ),
            });
            start_block += block_count;
            task_index += 1;
        }
        Ok(tasks)
    }

    fn decode_disc_extract_task(
        &self,
        source: &Path,
        disc: &PbpDiscEntry,
        task: &PbpDiscExtractTask,
    ) -> Result<u64> {
        if let Some(parent) = task.temp_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut source_file = File::open(source).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open pbp source `{}`: {error}",
                source.display()
            ))
        })?;
        let mut output = BufWriter::new(File::create(&task.temp_path)?);
        let mut block = vec![0u8; Self::ISO_BLOCK_BYTES];
        let mut remaining = task.expected_len;
        let mut total_written = 0u64;

        for block_offset in 0..task.block_count {
            if remaining == 0 {
                break;
            }
            let block_index = task.start_block + block_offset;
            let decoded = self.read_iso_block(
                source,
                &mut source_file,
                disc.psar_offset,
                &disc.iso_indexes,
                block_index,
                &mut block,
            )?;
            if decoded == 0 {
                break;
            }
            let to_write = remaining.min(decoded as u64);
            let to_write_usize = usize::try_from(to_write).map_err(|_| {
                RomWeaverError::Validation("pbp block write length overflowed usize".into())
            })?;
            output.write_all(&block[..to_write_usize])?;
            total_written = total_written.saturating_add(to_write);
            remaining -= to_write;
        }

        output.flush()?;
        if total_written != task.expected_len {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` disc {} chunk {} wrote {} bytes but expected {}",
                source.display(),
                disc.disc_number,
                task.task_index,
                total_written,
                task.expected_len
            )));
        }

        Ok(total_written)
    }

    fn cleanup_disc_extract_tasks(&self, tasks: &[PbpDiscExtractTask]) {
        for task in tasks {
            let _ = fs::remove_file(&task.temp_path);
        }
    }

    fn assemble_disc_extract_output(
        &self,
        tasks: &[PbpDiscExtractTask],
        output_path: &Path,
    ) -> Result<u64> {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(output_path)?);
        let mut total_written = 0u64;
        for task in tasks {
            let mut input = BufReader::new(File::open(&task.temp_path)?);
            let copied = io::copy(&mut input, &mut output)?;
            total_written = total_written.saturating_add(copied);
        }
        output.flush()?;
        Ok(total_written)
    }

    fn write_cue_sheet(
        &self,
        cue_path: &Path,
        bin_name: &str,
        tracks: &[PbpTocTrack],
    ) -> Result<()> {
        let mut writer = BufWriter::new(File::create(cue_path)?);
        writer.write_all(format!("FILE \"{bin_name}\" BINARY\n").as_bytes())?;
        for track in tracks {
            let track_type = track.cue_track_type()?;
            writer.write_all(
                format!("  TRACK {:02} {track_type}\n", track.track_number).as_bytes(),
            )?;
            if track.track_type == 0x01 {
                let index00 = track.start_frames.saturating_sub(150);
                writer.write_all(
                    format!("    INDEX 00 {}\n", Self::format_msf(index00)).as_bytes(),
                )?;
            }
            writer.write_all(
                format!("    INDEX 01 {}\n", Self::format_msf(track.start_frames)).as_bytes(),
            )?;
        }
        writer.flush()?;
        Ok(())
    }

    fn build_disc_outputs(&self, source: &Path, disc_count: usize) -> Vec<PbpDiscOutput> {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        if disc_count <= 1 {
            return vec![PbpDiscOutput {
                cue_name: format!("{stem}.cue"),
                bin_name: format!("{stem}.bin"),
            }];
        }
        (1..=disc_count)
            .map(|disc_number| PbpDiscOutput {
                cue_name: format!("{stem}.disc{disc_number:02}.cue"),
                bin_name: format!("{stem}.disc{disc_number:02}.bin"),
            })
            .collect()
    }

    fn decode_bcd(value: u8, label: &str) -> Result<u8> {
        let ones = value & 0x0F;
        let tens = value >> 4;
        if ones > 9 || tens > 9 {
            return Err(RomWeaverError::Validation(format!(
                "pbp toc contains invalid BCD value for {label}: 0x{value:02X}"
            )));
        }
        Ok(tens * 10 + ones)
    }

    fn msf_to_frames(minutes: u8, seconds: u8, frames: u8) -> Result<u32> {
        if seconds >= 60 || frames >= 75 {
            return Err(RomWeaverError::Validation(format!(
                "pbp toc contains invalid MSF timestamp {minutes:02}:{seconds:02}:{frames:02}"
            )));
        }
        Ok(u32::from(minutes) * 60 * 75 + u32::from(seconds) * 75 + u32::from(frames))
    }

    fn format_msf(frames: u32) -> String {
        let minutes = frames / (60 * 75);
        let seconds = (frames / 75) % 60;
        let frame = frames % 75;
        format!("{minutes:02}:{seconds:02}:{frame:02}")
    }

    fn read_u32_le_at(&self, source: &Path, file: &mut File, offset: u64) -> Result<u32> {
        let mut bytes = [0u8; 4];
        self.read_exact_at(source, file, offset, &mut bytes, "u32 value")?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_exact_at(
        &self,
        source: &Path,
        file: &mut File,
        offset: u64,
        output: &mut [u8],
        label: &str,
    ) -> Result<()> {
        file.seek(SeekFrom::Start(offset))?;
        if let Err(error) = file.read_exact(output) {
            return if error.kind() == io::ErrorKind::UnexpectedEof {
                Err(RomWeaverError::Validation(format!(
                    "source `{}` is truncated while reading {label}",
                    source.display()
                )))
            } else {
                Err(error.into())
            };
        }
        Ok(())
    }
}

impl ContainerHandler for PbpContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &PBP
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if file_starts_with(source, &PBP_SIGNATURE) {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let archive = self.parse_archive(&request.source)?;
        let disc_count = archive.discs.len();
        let total_tracks = archive
            .discs
            .iter()
            .map(|disc| disc.toc_tracks.len())
            .sum::<usize>();
        let total_bytes = archive.discs.iter().map(|disc| disc.iso_size).sum::<u64>();
        let disc_ids = archive
            .discs
            .iter()
            .map(|disc| format!("{}={}", disc.disc_number, disc.disc_id))
            .collect::<Vec<_>>()
            .join(", ");

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(PBP.name.to_string()),
            "inspect",
            format!(
                "pbp: {disc_count} disc(s), {total_tracks} track(s), {total_bytes} bytes; disc_ids=[{disc_ids}]"
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        let archive = self.parse_archive(&request.source)?;
        let outputs = self.build_disc_outputs(&request.source, archive.discs.len());
        let mut entries = Vec::with_capacity(outputs.len() * 2);
        for output in outputs {
            entries.push(output.cue_name);
            entries.push(output.bin_name);
        }
        Ok(entries)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let archive = self.parse_archive(&request.source)?;
        let outputs = self.build_disc_outputs(&request.source, archive.discs.len());
        fs::create_dir_all(&request.out_dir)?;

        let selection_requested = !request.selections.is_empty();
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut extract_plan = Vec::new();
        for (disc_index, output) in outputs.iter().enumerate() {
            let cue_selected = selections.matches(&output.cue_name);
            let bin_selected = selections.matches(&output.bin_name);
            let write_cue = !selection_requested || cue_selected;
            let mut write_bin = !selection_requested || bin_selected;
            if selection_requested && cue_selected && !write_bin {
                write_bin = true;
            }
            if write_cue || write_bin {
                extract_plan.push((disc_index, write_cue, write_bin));
            }
        }
        selections.ensure_all_matched()?;
        if selection_requested && extract_plan.is_empty() {
            return Err(RomWeaverError::Validation(
                "requested selections resolved to no extractable pbp outputs".into(),
            ));
        }

        let mut disc_extract_tasks = Vec::new();
        let mut disc_task_ranges = BTreeMap::new();
        for (disc_index, _write_cue, write_bin) in &extract_plan {
            if !*write_bin {
                continue;
            }
            let disc = &archive.discs[*disc_index];
            let start = disc_extract_tasks.len();
            let mut tasks = self.build_disc_extract_tasks(*disc_index, disc, context)?;
            let len = tasks.len();
            disc_extract_tasks.append(&mut tasks);
            disc_task_ranges.insert(*disc_index, (start, len));
        }

        let (execution, decode_result) = if disc_extract_tasks.is_empty() {
            (
                context.plan_threads(ThreadCapability::parallel(None)),
                Ok(Vec::new()),
            )
        } else {
            let (execution, pool) = context.build_pool(ThreadCapability::parallel(Some(
                disc_extract_tasks.len().max(1),
            )))?;
            let source = request.source.clone();
            let decode_result = if execution.used_parallelism {
                pool.install(|| {
                    disc_extract_tasks
                        .par_iter()
                        .map(|task| {
                            let disc = &archive.discs[task.disc_index];
                            self.decode_disc_extract_task(&source, disc, task)
                        })
                        .collect::<Result<Vec<_>>>()
                })
            } else {
                disc_extract_tasks
                    .iter()
                    .map(|task| {
                        let disc = &archive.discs[task.disc_index];
                        self.decode_disc_extract_task(&source, disc, task)
                    })
                    .collect::<Result<Vec<_>>>()
            };
            (execution, decode_result)
        };
        if let Err(error) = decode_result {
            self.cleanup_disc_extract_tasks(&disc_extract_tasks);
            return Err(error);
        }

        let mut produced_outputs = Vec::new();
        let mut total_written = 0u64;

        for (disc_index, write_cue, write_bin) in extract_plan {
            let disc = &archive.discs[disc_index];
            let output = &outputs[disc_index];
            let bin_path = request.out_dir.join(&output.bin_name);
            if write_bin {
                let (start, len) = disc_task_ranges.get(&disc_index).copied().ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "pbp extract could not locate chunk plan for disc {}",
                        disc.disc_number
                    ))
                })?;
                let task_end = start.checked_add(len).ok_or_else(|| {
                    RomWeaverError::Validation("pbp extract chunk plan overflowed".into())
                })?;
                let tasks = &disc_extract_tasks[start..task_end];
                let written = match self.assemble_disc_extract_output(tasks, &bin_path) {
                    Ok(written) => written,
                    Err(error) => {
                        self.cleanup_disc_extract_tasks(&disc_extract_tasks);
                        return Err(error);
                    }
                };
                if written != disc.iso_size {
                    self.cleanup_disc_extract_tasks(&disc_extract_tasks);
                    return Err(RomWeaverError::Validation(format!(
                        "source `{}` disc {} extraction wrote {} bytes but expected {}",
                        request.source.display(),
                        disc.disc_number,
                        written,
                        disc.iso_size
                    )));
                }
                total_written = total_written.saturating_add(written);
                produced_outputs.push(bin_path.clone());
            }
            if write_cue {
                let cue_path = request.out_dir.join(&output.cue_name);
                if let Err(error) =
                    self.write_cue_sheet(&cue_path, &output.bin_name, &disc.toc_tracks)
                {
                    self.cleanup_disc_extract_tasks(&disc_extract_tasks);
                    return Err(error);
                }
                produced_outputs.push(cue_path);
            }
        }
        self.cleanup_disc_extract_tasks(&disc_extract_tasks);

        if selection_requested && produced_outputs.is_empty() {
            return Err(RomWeaverError::Validation(
                "requested selections resolved to no extractable pbp outputs".into(),
            ));
        }

        let label = if selection_requested {
            let outputs = produced_outputs
                .iter()
                .map(|path| format!("`{}`", path.display()))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "extracted `{}` to selected outputs: {} ({} disc(s), {} bytes written)",
                request.source.display(),
                outputs,
                archive.discs.len(),
                total_written
            )
        } else if archive.discs.len() == 1 {
            let output = &outputs[0];
            format!(
                "extracted `{}` to `{}` and `{}` ({} bytes written)",
                request.source.display(),
                request.out_dir.join(&output.cue_name).display(),
                request.out_dir.join(&output.bin_name).display(),
                total_written
            )
        } else {
            format!(
                "extracted `{}` to {} cue/bin pair(s) ({} bytes written)",
                request.source.display(),
                archive.discs.len(),
                total_written
            )
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(PBP.name.to_string()),
            "extract",
            label,
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "pbp create is not supported".into(),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: false,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

type XisoSourceDevice = XdvdfsOffsetWrapper<BufReader<File>, io::Error>;
type XisoSourceFilesystem = XdvdfsFilesystem<io::Error, XisoSourceDevice>;

struct XisoContainerHandler;

impl XisoContainerHandler {
    fn open_source_filesystem(&self, source_path: &Path) -> Result<XisoSourceFilesystem> {
        let source_file = File::options()
            .read(true)
            .open(source_path)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open xiso source `{}`: {error}",
                    source_path.display()
                ))
            })?;
        let source_reader = BufReader::new(source_file);
        let source_device = XdvdfsOffsetWrapper::new(source_reader).map_err(|error| {
            RomWeaverError::Validation(format!(
                "source `{}` is not an Xbox XDVDFS image (raw/XGD probe failed: {error})",
                source_path.display()
            ))
        })?;
        XdvdfsFilesystem::new(source_device).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "source `{}` could not be read as an XDVDFS filesystem",
                source_path.display()
            ))
        })
    }
}

impl ContainerHandler for XisoContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &XISO
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.open_source_filesystem(source).is_ok() {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn inspect(
        &self,
        _request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "xiso inspect is not supported yet".into(),
        ))
    }

    fn extract(
        &self,
        _request: &ContainerExtractRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "xiso extract is not supported yet".into(),
        ))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "xiso container create is not supported; xiso is trim-only (use `trim`)".into(),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: false,
            extract: false,
            create: false,
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

struct GczContainerHandler;

impl GczContainerHandler {
    fn read_options(&self, preloader_threads: usize) -> NodDiscOptions {
        let mut options = NodDiscOptions::default();
        options.preloader_threads = preloader_threads;
        options
    }

    fn negotiated_threads(&self, used_parallelism: bool, effective_threads: usize) -> usize {
        if used_parallelism {
            effective_threads
        } else {
            0
        }
    }

    fn open_disc(&self, source: &Path) -> Result<NodDiscReader> {
        NodDiscReader::new(source, &self.read_options(0)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open gcz source `{}`: {error}",
                source.display()
            ))
        })
    }

    fn validate_gcz_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == NodFormat::Gcz {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not a gcz container (detected {})",
                source.display(),
                meta.format
            )))
        }
    }

    fn extract_name(&self, source: &Path) -> String {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        format!("{stem}.iso")
    }
}

impl ContainerHandler for GczContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &GCZ
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source)
            && disc.meta().format == NodFormat::Gcz
        {
            return ProbeConfidence::Signature;
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let disc = self.open_disc(&request.source)?;
        let meta = self.validate_gcz_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(GCZ.name.to_string()),
            "inspect",
            format!(
                "gcz: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
                compression_label,
                block_label,
                meta.lossless,
                meta.decrypted,
                meta.needs_hash_recovery
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(vec![self.extract_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let mut disc = NodDiscReader::new(&request.source, &self.read_options(preloader_threads))
            .map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open gcz source `{}`: {error}",
                request.source.display()
            ))
        })?;
        let meta = self.validate_gcz_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        fs::create_dir_all(&request.out_dir)?;
        let output_name = self.extract_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;
        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(File::create(&output_path)?);
        let bytes_written = nod_buf_copy(&mut disc, &mut output)?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(GCZ.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} bytes written, expected {}, compression={})",
                request.source.display(),
                output_path.display(),
                bytes_written,
                disc_size,
                compression_label
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "warning: gcz compression is not supported; use `--format rvz` instead".into(),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: false,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

struct WiaContainerHandler;

impl WiaContainerHandler {
    fn read_options(&self, preloader_threads: usize) -> NodDiscOptions {
        let mut options = NodDiscOptions::default();
        options.preloader_threads = preloader_threads;
        options
    }

    fn negotiated_threads(&self, used_parallelism: bool, effective_threads: usize) -> usize {
        if used_parallelism {
            effective_threads
        } else {
            0
        }
    }

    fn open_disc(&self, source: &Path) -> Result<NodDiscReader> {
        NodDiscReader::new(source, &self.read_options(0)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open wia source `{}`: {error}",
                source.display()
            ))
        })
    }

    fn validate_wia_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == NodFormat::Wia {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not a wia container (detected {})",
                source.display(),
                meta.format
            )))
        }
    }

    fn extract_name(&self, source: &Path) -> String {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        format!("{stem}.iso")
    }

    fn to_u8_level(&self, level: i32, codec: &str) -> Result<u8> {
        if level < 0 {
            return Err(RomWeaverError::Validation(format!(
                "wia codec `{codec}` requires a non-negative level"
            )));
        }
        u8::try_from(level).map_err(|_| {
            RomWeaverError::Validation(format!("wia codec `{codec}` level `{level}` is too large"))
        })
    }

    fn to_i8_level(&self, level: i32, codec: &str) -> Result<i8> {
        i8::try_from(level).map_err(|_| {
            RomWeaverError::Validation(format!(
                "wia codec `{codec}` level `{level}` is out of range"
            ))
        })
    }

    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified => {
                if let Some(level) = level {
                    return Ok(NodCompression::Lzma(self.to_u8_level(level, "lzma")?));
                }
                Ok(NodFormat::Wia.default_compression())
            }
            RequestedCodec::Known(CanonicalCodec::Store) => {
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "wia codec `store` does not accept --level".into(),
                    ));
                }
                Ok(NodCompression::None)
            }
            RequestedCodec::Known(CanonicalCodec::Bzip2) => Ok(NodCompression::Bzip2(
                self.to_u8_level(level.unwrap_or(0), "bzip2")?,
            )),
            RequestedCodec::Known(CanonicalCodec::Lzma) => Ok(NodCompression::Lzma(
                self.to_u8_level(level.unwrap_or(0), "lzma")?,
            )),
            RequestedCodec::Known(CanonicalCodec::Lzma2) => Ok(NodCompression::Lzma2(
                self.to_u8_level(level.unwrap_or(0), "lzma2")?,
            )),
            RequestedCodec::Known(CanonicalCodec::Zstd) => Ok(NodCompression::Zstandard(
                self.to_i8_level(level.unwrap_or(0), "zstd")?,
            )),
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported wia codec `{}`; supported codecs are store, bzip2, lzma, lzma2, and zstd",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported wia codec `{name}`; supported codecs are store, bzip2, lzma, lzma2, and zstd"
            ))),
        }
    }
}

impl ContainerHandler for WiaContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &WIA
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source)
            && disc.meta().format == NodFormat::Wia
        {
            return ProbeConfidence::Signature;
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let disc = self.open_disc(&request.source)?;
        let meta = self.validate_wia_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WIA.name.to_string()),
            "inspect",
            format!(
                "wia: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
                compression_label,
                block_label,
                meta.lossless,
                meta.decrypted,
                meta.needs_hash_recovery
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(vec![self.extract_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let output_name = self.extract_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let mut disc = NodDiscReader::new(&request.source, &self.read_options(preloader_threads))
            .map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open wia source `{}`: {error}",
                request.source.display()
            ))
        })?;
        let meta = self.validate_wia_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(File::create(&output_path)?);
        let bytes_written = nod_buf_copy(&mut disc, &mut output)?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WIA.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} bytes written, expected {}, compression={})",
                request.source.display(),
                output_path.display(),
                bytes_written,
                disc_size,
                compression_label
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(
                "wia create currently requires exactly one input file".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let input = &request.inputs[0];
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Wia,
            compression,
            block_size: NodFormat::Wia.default_block_size(),
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let input_disc =
            NodDiscReader::new(input, &self.read_options(preloader_threads)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open input `{}` for wia create: {error}",
                    input.display()
                ))
            })?;
        let writer = NodDiscWriter::new(input_disc, &options).map_err(|error| {
            RomWeaverError::Validation(format!("failed to initialize wia writer: {error}"))
        })?;

        let mut output = File::create(&request.output)?;
        let mut process_options = NodProcessOptions::default();
        process_options.processor_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let finalization = writer
            .process(
                |data, _processed, _total| output.write_all(data.as_ref()),
                &process_options,
            )
            .map_err(|error| RomWeaverError::Validation(format!("wia create failed: {error}")))?;
        if !finalization.header.is_empty() {
            output.seek(SeekFrom::Start(0))?;
            output.write_all(finalization.header.as_ref())?;
        }
        output.flush()?;
        let output_bytes = fs::metadata(&request.output)?.len();

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WIA.name.to_string()),
            "create",
            format!(
                "created wia `{}` from `{}` (codec={}, block={} bytes, {} bytes)",
                request.output.display(),
                input.display(),
                normalize_codec_label(&options.compression.to_string()),
                options.block_size,
                output_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: true,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}

struct TgcContainerHandler;

impl TgcContainerHandler {
    fn read_options(&self, preloader_threads: usize) -> NodDiscOptions {
        let mut options = NodDiscOptions::default();
        options.preloader_threads = preloader_threads;
        options
    }

    fn negotiated_threads(&self, used_parallelism: bool, effective_threads: usize) -> usize {
        if used_parallelism {
            effective_threads
        } else {
            0
        }
    }

    fn open_disc(&self, source: &Path, preloader_threads: usize) -> Result<NodDiscReader> {
        NodDiscReader::new(source, &self.read_options(preloader_threads)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open tgc source `{}`: {error}",
                source.display()
            ))
        })
    }

    fn validate_tgc_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == NodFormat::Tgc {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not a tgc container (detected {})",
                source.display(),
                meta.format
            )))
        }
    }

    fn extract_name(&self, source: &Path) -> String {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        format!("{stem}.iso")
    }

    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Store) => {
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "tgc codec `store` does not accept --level".into(),
                    ));
                }
                Ok(NodCompression::None)
            }
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported tgc codec `{}`; supported codec is store",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported tgc codec `{name}`; supported codec is store"
            ))),
        }
    }
}

impl ContainerHandler for TgcContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &TGC
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source, 0)
            && disc.meta().format == NodFormat::Tgc
        {
            return ProbeConfidence::Signature;
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let disc = self.open_disc(&request.source, 0)?;
        let meta = self.validate_tgc_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(TGC.name.to_string()),
            "inspect",
            format!(
                "tgc: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
                compression_label,
                block_label,
                meta.lossless,
                meta.decrypted,
                meta.needs_hash_recovery
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(vec![self.extract_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let output_name = self.extract_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let mut disc = self.open_disc(&request.source, preloader_threads)?;
        let meta = self.validate_tgc_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(File::create(&output_path)?);
        let bytes_written = nod_buf_copy(&mut disc, &mut output)?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(TGC.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} bytes written, expected {}, compression={})",
                request.source.display(),
                output_path.display(),
                bytes_written,
                disc_size,
                compression_label
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(
                "tgc create currently requires exactly one input file".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let input = &request.inputs[0];
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Tgc,
            compression,
            block_size: NodFormat::Tgc.default_block_size(),
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let input_disc =
            NodDiscReader::new(input, &self.read_options(preloader_threads)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open input `{}` for tgc create: {error}",
                    input.display()
                ))
            })?;
        let writer = NodDiscWriter::new(input_disc, &options).map_err(|error| {
            RomWeaverError::Validation(format!("failed to initialize tgc writer: {error}"))
        })?;

        let mut output = File::create(&request.output)?;
        let mut process_options = NodProcessOptions::default();
        process_options.processor_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let finalization = writer
            .process(
                |data, _processed, _total| output.write_all(data.as_ref()),
                &process_options,
            )
            .map_err(|error| RomWeaverError::Validation(format!("tgc create failed: {error}")))?;
        if !finalization.header.is_empty() {
            output.seek(SeekFrom::Start(0))?;
            output.write_all(finalization.header.as_ref())?;
        }
        output.flush()?;
        let output_bytes = fs::metadata(&request.output)?.len();

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(TGC.name.to_string()),
            "create",
            format!(
                "created tgc `{}` from `{}` (codec=store, {} bytes)",
                request.output.display(),
                input.display(),
                output_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: true,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}

struct NfsContainerHandler;

impl NfsContainerHandler {
    fn read_options(&self, preloader_threads: usize) -> NodDiscOptions {
        let mut options = NodDiscOptions::default();
        options.preloader_threads = preloader_threads;
        options
    }

    fn open_disc(&self, source: &Path, preloader_threads: usize) -> Result<NodDiscReader> {
        NodDiscReader::new(source, &self.read_options(preloader_threads)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open nfs source `{}`: {error}",
                source.display()
            ))
        })
    }

    fn validate_nfs_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == NodFormat::Nfs {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not an nfs container (detected {})",
                source.display(),
                meta.format
            )))
        }
    }

    fn extract_name(&self, source: &Path) -> String {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        format!("{stem}.iso")
    }
}

impl ContainerHandler for NfsContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &NFS
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source, 0)
            && disc.meta().format == NodFormat::Nfs
        {
            return ProbeConfidence::Signature;
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let disc = self.open_disc(&request.source, 0)?;
        let meta = self.validate_nfs_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(NFS.name.to_string()),
            "inspect",
            format!(
                "nfs: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
                compression_label,
                block_label,
                meta.lossless,
                meta.decrypted,
                meta.needs_hash_recovery
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(vec![self.extract_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let output_name = self.extract_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let preloader_threads = if execution.used_parallelism {
            execution.effective_threads
        } else {
            0
        };
        let mut disc = self.open_disc(&request.source, preloader_threads)?;
        let meta = self.validate_nfs_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(File::create(&output_path)?);
        let bytes_written = nod_buf_copy(&mut disc, &mut output)?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(NFS.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} bytes written, expected {}, compression={})",
                request.source.display(),
                output_path.display(),
                bytes_written,
                disc_size,
                compression_label
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "nfs compression is not supported; nfs can only be decompressed with `extract`".into(),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: false,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

struct WbfsContainerHandler;

impl WbfsContainerHandler {
    fn read_options(&self, preloader_threads: usize) -> NodDiscOptions {
        let mut options = NodDiscOptions::default();
        options.preloader_threads = preloader_threads;
        options
    }

    fn negotiated_threads(&self, used_parallelism: bool, effective_threads: usize) -> usize {
        if used_parallelism {
            effective_threads
        } else {
            0
        }
    }

    fn open_disc(&self, source: &Path) -> Result<NodDiscReader> {
        NodDiscReader::new(source, &self.read_options(0)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open wbfs source `{}`: {error}",
                source.display()
            ))
        })
    }

    fn validate_wbfs_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == NodFormat::Wbfs {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not a wbfs container (detected {})",
                source.display(),
                meta.format
            )))
        }
    }

    fn extract_name(&self, source: &Path) -> String {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        format!("{stem}.iso")
    }

    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Store) => {
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "wbfs codec `store` does not accept --level".into(),
                    ));
                }
                Ok(NodCompression::None)
            }
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported wbfs codec `{}`; supported codec is store",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported wbfs codec `{name}`; supported codec is store"
            ))),
        }
    }
}

impl ContainerHandler for WbfsContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &WBFS
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source)
            && disc.meta().format == NodFormat::Wbfs
        {
            return ProbeConfidence::Signature;
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let disc = self.open_disc(&request.source)?;
        let meta = self.validate_wbfs_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WBFS.name.to_string()),
            "inspect",
            format!(
                "wbfs: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
                compression_label,
                block_label,
                meta.lossless,
                meta.decrypted,
                meta.needs_hash_recovery
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(vec![self.extract_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let mut disc = NodDiscReader::new(&request.source, &self.read_options(preloader_threads))
            .map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open wbfs source `{}`: {error}",
                request.source.display()
            ))
        })?;
        let meta = self.validate_wbfs_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        fs::create_dir_all(&request.out_dir)?;
        let output_name = self.extract_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;
        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(File::create(&output_path)?);
        let bytes_written = nod_buf_copy(&mut disc, &mut output)?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WBFS.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} bytes written, expected {}, compression={})",
                request.source.display(),
                output_path.display(),
                bytes_written,
                disc_size,
                compression_label
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(
                "wbfs create currently requires exactly one input file".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let input = &request.inputs[0];
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Wbfs,
            compression,
            block_size: NodFormat::Wbfs.default_block_size(),
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let input_disc =
            NodDiscReader::new(input, &self.read_options(preloader_threads)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open input `{}` for wbfs create: {error}",
                    input.display()
                ))
            })?;
        let writer = NodDiscWriter::new(input_disc, &options).map_err(|error| {
            RomWeaverError::Validation(format!("failed to initialize wbfs writer: {error}"))
        })?;

        let mut output = File::create(&request.output)?;
        let mut process_options = NodProcessOptions::default();
        process_options.processor_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let finalization = writer
            .process(
                |data, _processed, _total| output.write_all(data.as_ref()),
                &process_options,
            )
            .map_err(|error| RomWeaverError::Validation(format!("wbfs create failed: {error}")))?;
        if !finalization.header.is_empty() {
            output.seek(SeekFrom::Start(0))?;
            output.write_all(finalization.header.as_ref())?;
        }
        output.flush()?;
        let output_bytes = fs::metadata(&request.output)?.len();

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WBFS.name.to_string()),
            "create",
            format!(
                "created wbfs `{}` from `{}` (codec=store, block={} bytes, {} bytes)",
                request.output.display(),
                input.display(),
                options.block_size,
                output_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: true,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}

struct RvzContainerHandler;

impl RvzContainerHandler {
    fn read_options(&self, preloader_threads: usize) -> NodDiscOptions {
        let mut options = NodDiscOptions::default();
        options.preloader_threads = preloader_threads;
        options
    }

    fn negotiated_threads(&self, used_parallelism: bool, effective_threads: usize) -> usize {
        if used_parallelism {
            effective_threads
        } else {
            0
        }
    }

    fn open_disc(&self, source: &Path) -> Result<NodDiscReader> {
        NodDiscReader::new(source, &self.read_options(0)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open rvz source `{}`: {error}",
                source.display()
            ))
        })
    }

    fn validate_rvz_meta(
        &self,
        source: &Path,
        disc: &NodDiscReader,
    ) -> Result<nod::read::DiscMeta> {
        let meta = disc.meta();
        if meta.format == NodFormat::Rvz {
            Ok(meta)
        } else {
            Err(RomWeaverError::Validation(format!(
                "source `{}` is not an rvz container (detected {})",
                source.display(),
                meta.format
            )))
        }
    }

    fn extract_name(&self, source: &Path) -> String {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        format!("{stem}.iso")
    }

    fn to_u8_level(&self, level: i32, codec: &str) -> Result<u8> {
        if level < 0 {
            return Err(RomWeaverError::Validation(format!(
                "rvz codec `{codec}` requires a non-negative level"
            )));
        }
        u8::try_from(level).map_err(|_| {
            RomWeaverError::Validation(format!("rvz codec `{codec}` level `{level}` is too large"))
        })
    }

    fn to_i8_level(&self, level: i32, codec: &str) -> Result<i8> {
        i8::try_from(level).map_err(|_| {
            RomWeaverError::Validation(format!(
                "rvz codec `{codec}` level `{level}` is out of range"
            ))
        })
    }

    fn resolve_create_compression(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<NodCompression> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified => {
                let mut compression = NodFormat::Rvz.default_compression();
                if let Some(level) = level {
                    compression = NodCompression::Zstandard(self.to_i8_level(level, "zstd")?);
                }
                Ok(compression)
            }
            RequestedCodec::Known(CanonicalCodec::Store) => {
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "rvz codec `store` does not accept --level".into(),
                    ));
                }
                Ok(NodCompression::None)
            }
            RequestedCodec::Known(CanonicalCodec::Bzip2) => Ok(NodCompression::Bzip2(
                self.to_u8_level(level.unwrap_or(0), "bzip2")?,
            )),
            RequestedCodec::Known(CanonicalCodec::Lzma) => Ok(NodCompression::Lzma(
                self.to_u8_level(level.unwrap_or(0), "lzma")?,
            )),
            RequestedCodec::Known(CanonicalCodec::Lzma2) => Ok(NodCompression::Lzma2(
                self.to_u8_level(level.unwrap_or(0), "lzma2")?,
            )),
            RequestedCodec::Known(CanonicalCodec::Zstd) => Ok(NodCompression::Zstandard(
                self.to_i8_level(level.unwrap_or(0), "zstd")?,
            )),
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported rvz codec `{}`; supported codecs are store, zstd, bzip2, lzma, and lzma2",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported rvz codec `{name}`; supported codecs are store, zstd, bzip2, lzma, and lzma2"
            ))),
        }
    }
}

impl ContainerHandler for RvzContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &RVZ
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if let Ok(disc) = self.open_disc(source)
            && disc.meta().format == NodFormat::Rvz
        {
            return ProbeConfidence::Signature;
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let disc = self.open_disc(&request.source)?;
        let meta = self.validate_rvz_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());
        let block_label = meta
            .block_size
            .map(|size| format!("{size} bytes"))
            .unwrap_or_else(|| "unknown".to_string());
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(RVZ.name.to_string()),
            "inspect",
            format!(
                "rvz: {disc_size} bytes, compression={}, block={}, lossless={}, decrypted={}, needs_hash_recovery={}",
                compression_label,
                block_label,
                meta.lossless,
                meta.decrypted,
                meta.needs_hash_recovery
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(vec![self.extract_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let output_name = self.extract_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let mut disc = NodDiscReader::new(&request.source, &self.read_options(preloader_threads))
            .map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open rvz source `{}`: {error}",
                request.source.display()
            ))
        })?;
        let meta = self.validate_rvz_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(File::create(&output_path)?);
        let bytes_written = nod_buf_copy(&mut disc, &mut output)?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(RVZ.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} bytes written, expected {}, compression={})",
                request.source.display(),
                output_path.display(),
                bytes_written,
                disc_size,
                compression_label
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(
                "rvz create currently requires exactly one input file".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::parallel(None));
        let input = &request.inputs[0];
        let compression =
            self.resolve_create_compression(request.codec.as_deref(), request.level)?;
        let options = NodFormatOptions {
            format: NodFormat::Rvz,
            compression,
            block_size: NodFormat::Rvz.default_block_size(),
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let preloader_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let input_disc =
            NodDiscReader::new(input, &self.read_options(preloader_threads)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open input `{}` for rvz create: {error}",
                    input.display()
                ))
            })?;
        let writer = NodDiscWriter::new(input_disc, &options).map_err(|error| {
            RomWeaverError::Validation(format!("failed to initialize rvz writer: {error}"))
        })?;

        let mut output = File::create(&request.output)?;
        let mut process_options = NodProcessOptions::default();
        process_options.processor_threads =
            self.negotiated_threads(execution.used_parallelism, execution.effective_threads);
        let finalization = writer
            .process(
                |data, _processed, _total| output.write_all(data.as_ref()),
                &process_options,
            )
            .map_err(|error| RomWeaverError::Validation(format!("rvz create failed: {error}")))?;
        if !finalization.header.is_empty() {
            output.seek(SeekFrom::Start(0))?;
            output.write_all(finalization.header.as_ref())?;
        }
        output.flush()?;
        let output_bytes = fs::metadata(&request.output)?.len();

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(RVZ.name.to_string()),
            "create",
            format!(
                "created rvz `{}` from `{}` (codec={}, block={} bytes, {} bytes)",
                request.output.display(),
                input.display(),
                normalize_codec_label(&options.compression.to_string()),
                options.block_size,
                output_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: true,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}

struct Z3dsContainerHandler;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Z3dsFileHeader {
    underlying_magic: [u8; 4],
    metadata_size: u32,
    compressed_size: u64,
    uncompressed_size: u64,
}

impl Z3dsFileHeader {
    const MAGIC: [u8; 4] = *b"Z3DS";
    const VERSION: u16 = 1;
    const HEADER_SIZE: u16 = 0x20;

    fn read_from(source: &Path, file: &mut File) -> Result<Self> {
        let mut raw = [0_u8; Self::HEADER_SIZE as usize];
        file.seek(SeekFrom::Start(0))?;
        if let Err(error) = file.read_exact(&mut raw) {
            return if error.kind() == io::ErrorKind::UnexpectedEof {
                Err(RomWeaverError::Validation(format!(
                    "source `{}` is too small to be a z3ds container",
                    source.display()
                )))
            } else {
                Err(error.into())
            };
        }

        if raw[..4] != Self::MAGIC {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` is not a z3ds container (missing Z3DS magic)",
                source.display()
            )));
        }

        let version = u16::from_le_bytes([raw[8], raw[9]]);
        if version != Self::VERSION {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` uses unsupported z3ds version {}; expected {}",
                source.display(),
                version,
                Self::VERSION
            )));
        }

        let header_size = u16::from_le_bytes([raw[10], raw[11]]);
        if header_size != Self::HEADER_SIZE {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has unsupported z3ds header size {}; expected {}",
                source.display(),
                header_size,
                Self::HEADER_SIZE
            )));
        }

        Ok(Self {
            underlying_magic: [raw[4], raw[5], raw[6], raw[7]],
            metadata_size: u32::from_le_bytes([raw[12], raw[13], raw[14], raw[15]]),
            compressed_size: u64::from_le_bytes([
                raw[16], raw[17], raw[18], raw[19], raw[20], raw[21], raw[22], raw[23],
            ]),
            uncompressed_size: u64::from_le_bytes([
                raw[24], raw[25], raw[26], raw[27], raw[28], raw[29], raw[30], raw[31],
            ]),
        })
    }

    fn write_to(self, file: &mut File) -> Result<()> {
        let mut raw = [0_u8; Self::HEADER_SIZE as usize];
        raw[..4].copy_from_slice(&Self::MAGIC);
        raw[4..8].copy_from_slice(&self.underlying_magic);
        raw[8..10].copy_from_slice(&Self::VERSION.to_le_bytes());
        raw[10..12].copy_from_slice(&Self::HEADER_SIZE.to_le_bytes());
        raw[12..16].copy_from_slice(&self.metadata_size.to_le_bytes());
        raw[16..24].copy_from_slice(&self.compressed_size.to_le_bytes());
        raw[24..32].copy_from_slice(&self.uncompressed_size.to_le_bytes());
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&raw)?;
        Ok(())
    }

    fn payload_offset(self) -> u64 {
        u64::from(Self::HEADER_SIZE) + u64::from(self.metadata_size)
    }
}

#[derive(Debug, Default)]
struct Z3dsMetadata {
    version: Option<u8>,
    item_names: Vec<String>,
}

impl Z3dsMetadata {
    const VERSION: u8 = 1;
    const TYPE_END: u8 = 0;
    const TYPE_BINARY: u8 = 1;

    fn parse(bytes: &[u8]) -> Self {
        if bytes.is_empty() {
            return Self::default();
        }
        let version = bytes[0];
        let mut metadata = Self {
            version: Some(version),
            item_names: Vec::new(),
        };
        if version != Self::VERSION {
            return metadata;
        }

        let mut cursor = 1_usize;
        while cursor + 4 <= bytes.len() {
            let item_type = bytes[cursor];
            let name_len = usize::from(bytes[cursor + 1]);
            let data_len = usize::from(u16::from_le_bytes([bytes[cursor + 2], bytes[cursor + 3]]));
            cursor += 4;

            if item_type == Self::TYPE_END {
                break;
            }
            if item_type != Self::TYPE_BINARY {
                break;
            }

            let Some(name_end) = cursor.checked_add(name_len) else {
                break;
            };
            let Some(item_end) = name_end.checked_add(data_len) else {
                break;
            };
            if item_end > bytes.len() {
                break;
            }

            let name = String::from_utf8_lossy(&bytes[cursor..name_end]).to_string();
            if !name.is_empty() {
                metadata.item_names.push(name);
            }
            cursor = item_end;
        }

        metadata
    }

    fn encode_default(frame_size: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.push(Self::VERSION);
        Self::push_binary_item(&mut bytes, "compressor", b"rom-weaver");
        Self::push_binary_item(
            &mut bytes,
            "maxframesize",
            frame_size.to_string().as_bytes(),
        );
        bytes.push(Self::TYPE_END);
        bytes.push(0);
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes
    }

    fn push_binary_item(buffer: &mut Vec<u8>, name: &str, data: &[u8]) {
        if name.is_empty()
            || name.len() > usize::from(u8::MAX)
            || data.len() > usize::from(u16::MAX)
        {
            return;
        }
        buffer.push(Self::TYPE_BINARY);
        buffer.push(name.len() as u8);
        buffer.extend_from_slice(&(data.len() as u16).to_le_bytes());
        buffer.extend_from_slice(name.as_bytes());
        buffer.extend_from_slice(data);
    }
}

struct Z3dsPayloadReader<R> {
    inner: R,
    start: u64,
    len: u64,
    pos: u64,
}

#[derive(Clone, Debug)]
struct Z3dsExtractTask {
    index: usize,
    offset: u64,
    len: u64,
    temp_path: PathBuf,
}

#[derive(Clone, Debug)]
struct Z3dsCreateTask {
    index: usize,
    offset: u64,
    len: u64,
    temp_path: PathBuf,
}

#[derive(Clone, Debug)]
struct Z3dsCompressedFrame {
    index: usize,
    decompressed_size: u32,
    compressed_size: u32,
    temp_path: PathBuf,
}

impl<R: Read + Seek> Z3dsPayloadReader<R> {
    fn new(mut inner: R, start: u64, len: u64) -> io::Result<Self> {
        inner.seek(SeekFrom::Start(start))?;
        Ok(Self {
            inner,
            start,
            len,
            pos: 0,
        })
    }
}

impl<R: Read + Seek> Read for Z3dsPayloadReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len {
            return Ok(0);
        }
        let remaining = usize::try_from(self.len - self.pos).unwrap_or(usize::MAX);
        let cap = remaining.min(buffer.len());
        let read = self.inner.read(&mut buffer[..cap])?;
        self.pos = self.pos.saturating_add(read as u64);
        Ok(read)
    }
}

impl<R: Read + Seek> Seek for Z3dsPayloadReader<R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let target = match position {
            SeekFrom::Start(value) => i128::from(value),
            SeekFrom::Current(delta) => i128::from(self.pos) + i128::from(delta),
            SeekFrom::End(delta) => i128::from(self.len) + i128::from(delta),
        };
        if target < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "negative seek offset",
            ));
        }
        let target = u64::try_from(target)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "seek offset overflow"))?;
        if target > self.len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek offset exceeds z3ds payload",
            ));
        }
        let absolute = self
            .start
            .checked_add(target)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek offset overflow"))?;
        self.inner.seek(SeekFrom::Start(absolute))?;
        self.pos = target;
        Ok(self.pos)
    }
}

impl Z3dsContainerHandler {
    const DEFAULT_FRAME_SIZE: usize = 256 * 1024;
    const DEFAULT_LEVEL: i32 = 3;
    const MIN_LEVEL: i32 = 0;
    const MAX_LEVEL: i32 = 22;
    const EXTRACT_CHUNK: usize = 8 * 1024 * 1024;
    const SEEKABLE_SKIPPABLE_MAGIC: u32 = 0x184D2A5E;
    const SEEKABLE_FOOTER_MAGIC: u32 = 0x8F92EAB1;
    const SEEKABLE_FOOTER_SIZE: usize = 9;

    fn align_16(size: usize) -> usize {
        let rem = size % 16;
        if rem == 0 { size } else { size + (16 - rem) }
    }

    fn format_magic(&self, magic: [u8; 4]) -> String {
        if magic.iter().all(|byte| byte.is_ascii_graphic()) {
            String::from_utf8_lossy(&magic).to_string()
        } else {
            format!(
                "{:02X}{:02X}{:02X}{:02X}",
                magic[0], magic[1], magic[2], magic[3]
            )
        }
    }

    fn decompressed_extension_for_source(&self, source: &Path) -> &'static str {
        let source_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        match source_name.as_deref() {
            Some(name) if name.ends_with(".zcci") => ".cci",
            Some(name) if name.ends_with(".zcxi") => ".cxi",
            Some(name) if name.ends_with(".zcia") => ".cia",
            Some(name) if name.ends_with(".z3dsx") => ".3dsx",
            Some(name) if name.ends_with(".z3ds") => ".3ds",
            _ => ".3ds",
        }
    }

    fn extract_name(&self, source: &Path) -> String {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        format!("{stem}{}", self.decompressed_extension_for_source(source))
    }

    fn map_zstd_error(&self, stage: &str, error: zstd_seekable::Error) -> RomWeaverError {
        RomWeaverError::Validation(format!("z3ds {stage} failed: {error}"))
    }

    fn resolve_level(&self, codec: Option<&str>, level: Option<i32>) -> Result<i32> {
        let level = level.unwrap_or(Self::DEFAULT_LEVEL);
        if !(Self::MIN_LEVEL..=Self::MAX_LEVEL).contains(&level) {
            return Err(RomWeaverError::Validation(format!(
                "z3ds level `{level}` is out of range; expected {}..={}",
                Self::MIN_LEVEL,
                Self::MAX_LEVEL
            )));
        }

        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Zstd) => Ok(level),
            RequestedCodec::Known(CanonicalCodec::Store) => Err(RomWeaverError::Validation(
                "z3ds does not support uncompressed output; use zstd".into(),
            )),
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported z3ds codec `{}`; supported codec is zstd",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported z3ds codec `{name}`; supported codec is zstd"
            ))),
        }
    }

    fn read_header(&self, source: &Path, file: &mut File) -> Result<Z3dsFileHeader> {
        let header = Z3dsFileHeader::read_from(source, file)?;
        let file_size = file.metadata()?.len();
        let payload_offset = header.payload_offset();
        if payload_offset > file_size {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has invalid z3ds metadata size",
                source.display()
            )));
        }
        if header.compressed_size > file_size.saturating_sub(payload_offset) {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has invalid z3ds compressed size",
                source.display()
            )));
        }
        Ok(header)
    }

    fn read_metadata(&self, file: &mut File, header: Z3dsFileHeader) -> Result<Vec<u8>> {
        let metadata_len = usize::try_from(header.metadata_size)
            .map_err(|_| RomWeaverError::Validation("z3ds metadata is too large to read".into()))?;
        if metadata_len == 0 {
            return Ok(Vec::new());
        }
        let mut metadata = vec![0_u8; metadata_len];
        file.seek(SeekFrom::Start(u64::from(Z3dsFileHeader::HEADER_SIZE)))?;
        file.read_exact(&mut metadata)?;
        Ok(metadata)
    }

    fn build_extract_tasks(
        &self,
        total_len: u64,
        context: &OperationContext,
    ) -> Result<Vec<Z3dsExtractTask>> {
        if total_len == 0 {
            return Ok(Vec::new());
        }

        let mut tasks = Vec::new();
        let chunk_len = Self::EXTRACT_CHUNK as u64;
        let mut offset = 0_u64;
        let mut index = 0_usize;
        while offset < total_len {
            let len = (total_len - offset).min(chunk_len);
            tasks.push(Z3dsExtractTask {
                index,
                offset,
                len,
                temp_path: context
                    .temp_paths()
                    .next_path(&format!("z3ds-extract-{index}"), Some("chunk")),
            });
            offset = offset.saturating_add(len);
            index += 1;
        }
        Ok(tasks)
    }

    fn extract_chunk_task(
        &self,
        source: &Path,
        payload_start: u64,
        compressed_size: u64,
        task: &Z3dsExtractTask,
    ) -> Result<()> {
        let source_file = File::open(source)?;
        let payload_reader = Z3dsPayloadReader::new(source_file, payload_start, compressed_size)?;
        let mut decompressor = Seekable::init(Box::new(payload_reader))
            .map_err(|error| self.map_zstd_error("extract initialize", error))?;

        if let Some(parent) = task.temp_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(&task.temp_path)?);
        let buffer_len = usize::try_from(task.len.min(Self::EXTRACT_CHUNK as u64))
            .unwrap_or(Self::EXTRACT_CHUNK)
            .max(1);
        let mut buffer = vec![0_u8; buffer_len];
        let mut written = 0_u64;
        while written < task.len {
            let remaining = task.len - written;
            let to_decode = usize::try_from(remaining)
                .unwrap_or(usize::MAX)
                .min(buffer.len());
            let read_offset = task.offset.checked_add(written).ok_or_else(|| {
                RomWeaverError::Validation("z3ds extract offset overflowed".into())
            })?;
            let decoded = decompressor
                .decompress(&mut buffer[..to_decode], read_offset)
                .map_err(|error| self.map_zstd_error("extract", error))?;
            if decoded == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "z3ds extract chunk {} stopped early at {} of {} bytes",
                    task.index, written, task.len
                )));
            }
            output.write_all(&buffer[..decoded])?;
            written = written.saturating_add(decoded as u64);
        }
        output.flush()?;
        Ok(())
    }

    fn cleanup_extract_tasks(&self, tasks: &[Z3dsExtractTask]) {
        for task in tasks {
            let _ = fs::remove_file(&task.temp_path);
        }
    }

    fn assemble_extract_output(&self, tasks: &[Z3dsExtractTask], output_path: &Path) -> Result<()> {
        let mut output = BufWriter::new(File::create(output_path)?);
        for task in tasks {
            let mut input = BufReader::new(File::open(&task.temp_path)?);
            io::copy(&mut input, &mut output)?;
        }
        output.flush()?;
        Ok(())
    }

    fn build_create_tasks(
        &self,
        total_len: u64,
        context: &OperationContext,
    ) -> Result<Vec<Z3dsCreateTask>> {
        if total_len == 0 {
            return Ok(Vec::new());
        }

        let mut tasks = Vec::new();
        let chunk_len = Self::DEFAULT_FRAME_SIZE as u64;
        let mut offset = 0_u64;
        let mut index = 0_usize;
        while offset < total_len {
            let len = (total_len - offset).min(chunk_len);
            tasks.push(Z3dsCreateTask {
                index,
                offset,
                len,
                temp_path: context
                    .temp_paths()
                    .next_path(&format!("z3ds-create-{index}"), Some("frame")),
            });
            offset = offset.saturating_add(len);
            index += 1;
        }
        Ok(tasks)
    }

    fn compress_create_task(
        &self,
        source: &Path,
        level: i32,
        task: &Z3dsCreateTask,
    ) -> Result<Z3dsCompressedFrame> {
        let mut file = BufReader::new(File::open(source)?);
        file.seek(SeekFrom::Start(task.offset))?;
        let read_len = usize::try_from(task.len).map_err(|_| {
            RomWeaverError::Validation("z3ds create chunk size exceeded supported range".into())
        })?;
        let mut data = vec![0_u8; read_len];
        file.read_exact(&mut data)?;

        let compressed = zstd_compress(&data, level)
            .map_err(|error| RomWeaverError::Validation(format!("z3ds create failed: {error}")))?;
        let compressed_size = u32::try_from(compressed.len()).map_err(|_| {
            RomWeaverError::Validation("z3ds compressed chunk exceeded 4 GiB".into())
        })?;
        let decompressed_size = u32::try_from(task.len).map_err(|_| {
            RomWeaverError::Validation("z3ds frame exceeded seekable format limits".into())
        })?;

        if let Some(parent) = task.temp_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(&task.temp_path)?);
        output.write_all(&compressed)?;
        output.flush()?;

        Ok(Z3dsCompressedFrame {
            index: task.index,
            decompressed_size,
            compressed_size,
            temp_path: task.temp_path.clone(),
        })
    }

    fn cleanup_create_frames(&self, frames: &[Z3dsCompressedFrame]) {
        for frame in frames {
            let _ = fs::remove_file(&frame.temp_path);
        }
    }

    fn write_seek_table(
        &self,
        output: &mut BufWriter<File>,
        frames: &[Z3dsCompressedFrame],
    ) -> Result<u64> {
        let frame_count = u32::try_from(frames.len()).map_err(|_| {
            RomWeaverError::Validation("z3ds frame count exceeded seekable format limits".into())
        })?;
        let entry_size = 8_u64;
        let entries_bytes = u64::from(frame_count)
            .checked_mul(entry_size)
            .ok_or_else(|| RomWeaverError::Validation("z3ds seek table size overflowed".into()))?;
        let frame_size_u64 = entries_bytes
            .checked_add(Self::SEEKABLE_FOOTER_SIZE as u64)
            .ok_or_else(|| RomWeaverError::Validation("z3ds seek table size overflowed".into()))?;
        let frame_size = u32::try_from(frame_size_u64)
            .map_err(|_| RomWeaverError::Validation("z3ds seek table exceeded 4 GiB".into()))?;

        output.write_all(&Self::SEEKABLE_SKIPPABLE_MAGIC.to_le_bytes())?;
        output.write_all(&frame_size.to_le_bytes())?;
        for frame in frames {
            output.write_all(&frame.compressed_size.to_le_bytes())?;
            output.write_all(&frame.decompressed_size.to_le_bytes())?;
        }
        output.write_all(&frame_count.to_le_bytes())?;
        output.write_all(&[0_u8])?; // Seek_Table_Descriptor (no checksum)
        output.write_all(&Self::SEEKABLE_FOOTER_MAGIC.to_le_bytes())?;

        Ok(u64::from(frame_size) + 8)
    }
}

impl ContainerHandler for Z3dsContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &Z3DS
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        match File::open(source).and_then(|mut file| {
            let mut magic = [0_u8; 4];
            file.read_exact(&mut magic)?;
            Ok(magic)
        }) {
            Ok(magic) if magic == Z3dsFileHeader::MAGIC => ProbeConfidence::Signature,
            _ => ProbeConfidence::Extension,
        }
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let mut file = File::open(&request.source)?;
        let header = self.read_header(&request.source, &mut file)?;
        let metadata = self.read_metadata(&mut file, header)?;
        let parsed_metadata = Z3dsMetadata::parse(&metadata);
        let ratio = if header.uncompressed_size == 0 {
            0.0
        } else {
            (header.compressed_size as f64 / header.uncompressed_size as f64) * 100.0
        };
        let metadata_label = if header.metadata_size == 0 {
            "metadata=none".to_string()
        } else if parsed_metadata.item_names.is_empty() {
            format!(
                "metadata={} bytes, version={}",
                header.metadata_size,
                parsed_metadata
                    .version
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            )
        } else {
            format!(
                "metadata={} bytes, keys={}",
                header.metadata_size,
                parsed_metadata.item_names.join(",")
            )
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(Z3DS.name.to_string()),
            "inspect",
            format!(
                "z3ds: {} bytes -> {} bytes ({ratio:.2}%), underlying_magic={}, {}",
                header.uncompressed_size,
                header.compressed_size,
                self.format_magic(header.underlying_magic),
                metadata_label
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(vec![self.extract_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let output_name = self.extract_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;

        let mut file = File::open(&request.source)?;
        let header = self.read_header(&request.source, &mut file)?;
        let payload_start = header.payload_offset();
        let tasks = self.build_extract_tasks(header.uncompressed_size, context)?;
        let (execution, pool) =
            context.build_pool(ThreadCapability::parallel(Some(tasks.len().max(1))))?;

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(&output_name);

        let source = request.source.clone();
        let decode_result = if execution.used_parallelism {
            pool.install(|| {
                tasks
                    .par_iter()
                    .map(|task| {
                        self.extract_chunk_task(
                            &source,
                            payload_start,
                            header.compressed_size,
                            task,
                        )
                    })
                    .collect::<Result<Vec<_>>>()
            })
        } else {
            tasks
                .iter()
                .map(|task| {
                    self.extract_chunk_task(&source, payload_start, header.compressed_size, task)
                })
                .collect::<Result<Vec<_>>>()
        };
        if let Err(error) = decode_result {
            self.cleanup_extract_tasks(&tasks);
            return Err(error);
        }

        let assemble_result = self.assemble_extract_output(&tasks, &output_path);
        self.cleanup_extract_tasks(&tasks);
        assemble_result?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(Z3DS.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} bytes written)",
                request.source.display(),
                output_path.display(),
                header.uncompressed_size
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(
                "z3ds create currently requires exactly one input file".into(),
            ));
        }

        let input_path = &request.inputs[0];
        let level = self.resolve_level(request.codec.as_deref(), request.level)?;
        let input_size = fs::metadata(input_path)?.len();
        let create_tasks = self.build_create_tasks(input_size, context)?;
        let (execution, pool) =
            context.build_pool(ThreadCapability::parallel(Some(create_tasks.len().max(1))))?;

        let mut input = BufReader::new(File::open(input_path)?);
        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(&request.output)?);

        let mut underlying_magic = [0_u8; 4];
        let magic_read = input.read(&mut underlying_magic)?;
        if magic_read < underlying_magic.len() {
            for byte in &mut underlying_magic[magic_read..] {
                *byte = 0;
            }
        }
        input.seek(SeekFrom::Start(0))?;

        let metadata = Z3dsMetadata::encode_default(Self::DEFAULT_FRAME_SIZE);
        let metadata_aligned = Self::align_16(metadata.len());
        let metadata_size = u32::try_from(metadata_aligned).map_err(|_| {
            RomWeaverError::Validation("z3ds metadata exceeded supported size".into())
        })?;

        let mut header = Z3dsFileHeader {
            underlying_magic,
            metadata_size,
            compressed_size: 0,
            uncompressed_size: 0,
        };
        header.write_to(output.get_mut())?;

        if !metadata.is_empty() {
            output.write_all(&metadata)?;
        }
        if metadata_aligned > metadata.len() {
            let padding = vec![0_u8; metadata_aligned - metadata.len()];
            output.write_all(&padding)?;
        }

        let source = input_path.clone();
        let compress_result = if execution.used_parallelism {
            pool.install(|| {
                create_tasks
                    .par_iter()
                    .map(|task| self.compress_create_task(&source, level, task))
                    .collect::<Result<Vec<_>>>()
            })
        } else {
            create_tasks
                .iter()
                .map(|task| self.compress_create_task(&source, level, task))
                .collect::<Result<Vec<_>>>()
        };
        let mut frames = match compress_result {
            Ok(frames) => frames,
            Err(error) => {
                let cleanup_targets = create_tasks
                    .iter()
                    .map(|task| Z3dsCompressedFrame {
                        index: task.index,
                        decompressed_size: 0,
                        compressed_size: 0,
                        temp_path: task.temp_path.clone(),
                    })
                    .collect::<Vec<_>>();
                self.cleanup_create_frames(&cleanup_targets);
                return Err(error);
            }
        };

        frames.sort_by_key(|frame| frame.index);

        let mut compressed_frame_bytes = 0_u64;
        let mut uncompressed_bytes = 0_u64;
        let copy_result: Result<()> = (|| {
            for frame in &frames {
                let mut reader = BufReader::new(File::open(&frame.temp_path)?);
                let copied = io::copy(&mut reader, &mut output)?;
                if copied != u64::from(frame.compressed_size) {
                    return Err(RomWeaverError::Validation(format!(
                        "z3ds frame {} copied {} bytes but expected {} bytes",
                        frame.index, copied, frame.compressed_size
                    )));
                }
                compressed_frame_bytes = compressed_frame_bytes.saturating_add(copied);
                uncompressed_bytes =
                    uncompressed_bytes.saturating_add(u64::from(frame.decompressed_size));
            }
            Ok(())
        })();
        if let Err(error) = copy_result {
            self.cleanup_create_frames(&frames);
            return Err(error);
        }

        let seek_table_bytes = match self.write_seek_table(&mut output, &frames) {
            Ok(bytes) => bytes,
            Err(error) => {
                self.cleanup_create_frames(&frames);
                return Err(error);
            }
        };
        self.cleanup_create_frames(&frames);

        output.flush()?;
        header.compressed_size = compressed_frame_bytes.saturating_add(seek_table_bytes);
        header.uncompressed_size = uncompressed_bytes;
        header.write_to(output.get_mut())?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(Z3DS.name.to_string()),
            "create",
            format!(
                "created z3ds `{}` from `{}` (zstd level={}, frame={} bytes, {} bytes, {} frame(s))",
                request.output.display(),
                input_path.display(),
                level,
                Self::DEFAULT_FRAME_SIZE,
                header.compressed_size,
                frames.len()
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: true,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::parallel(None),
        }
    }
}

mod chd_native {
    use super::*;

    pub(super) struct ChdContainerHandler;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct HdGeometry {
        cylinders: u32,
        heads: u32,
        sectors: u32,
        bytes_per_sector: u32,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct DiscLayout {
        kind: DiscKind,
        tracks: Vec<DiscTrack>,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct AvProfile {
        frame_bytes: u32,
        fps: u32,
        fpsfrac: u32,
        width: u32,
        height: u32,
        interlaced: u32,
        channels: u32,
        sample_rate: u32,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct DiscTrack {
        number: u32,
        mode: DiscTrackMode,
        file_path: PathBuf,
        file_offset_bytes: u64,
        frames: u32,
        pregap_frames: u32,
        postgap_frames: u32,
        pregap_has_data: bool,
        has_subcode: bool,
        pad_frames: u32,
        swap_audio_on_read: bool,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum DiscKind {
        CdRom,
        GdRom,
    }

    impl DiscKind {
        fn metadata_tag(self) -> u32 {
            match self {
                Self::CdRom => CDROM_TRACK_METADATA2_TAG,
                Self::GdRom => GDROM_TRACK_METADATA_TAG,
            }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum DiscTrackMode {
        Mode1,
        Mode1Raw,
        Mode2,
        Mode2Form1,
        Mode2Form2,
        Mode2FormMix,
        Mode2Raw,
        Audio,
    }

    impl DiscTrackMode {
        fn cue_label(self) -> &'static str {
            match self {
                Self::Mode1 => "MODE1/2048",
                Self::Mode1Raw => "MODE1/2352",
                Self::Mode2 => "MODE2/2336",
                Self::Mode2Form1 => "MODE2/2048",
                Self::Mode2Form2 => "MODE2/2324",
                Self::Mode2FormMix => "MODE2_FORM_MIX",
                Self::Mode2Raw => "MODE2/2352",
                Self::Audio => "AUDIO",
            }
        }

        fn metadata_label(self) -> &'static str {
            match self {
                Self::Mode1 => "MODE1",
                Self::Mode1Raw => "MODE1_RAW",
                Self::Mode2 => "MODE2",
                Self::Mode2Form1 => "MODE2_FORM1",
                Self::Mode2Form2 => "MODE2_FORM2",
                Self::Mode2FormMix => "MODE2_FORM_MIX",
                Self::Mode2Raw => "MODE2_RAW",
                Self::Audio => "AUDIO",
            }
        }

        fn data_bytes(self) -> usize {
            match self {
                Self::Mode1 | Self::Mode2Form1 => 2048,
                Self::Mode2 | Self::Mode2FormMix => 2336,
                Self::Mode2Form2 => 2324,
                Self::Mode1Raw | Self::Mode2Raw | Self::Audio => 2352,
            }
        }

        fn gdi_track_descriptor(self) -> Result<(u32, u32)> {
            match self {
                Self::Mode1Raw => Ok((4, 2352)),
                Self::Mode1 => Ok((4, 2048)),
                Self::Audio => Ok((0, 2352)),
                other => Err(RomWeaverError::Validation(format!(
                    "gd-rom output does not support {} tracks",
                    other.metadata_label()
                ))),
            }
        }

        fn swap_audio_bytes(self, buffer: &mut [u8]) {
            if !matches!(self, Self::Audio) {
                return;
            }
            for pair in buffer.chunks_exact_mut(2) {
                pair.swap(0, 1);
            }
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum ChdCreateKind {
        Raw,
        HardDisk(HdGeometry),
        Dvd,
        Disc(DiscLayout),
        Av(AvProfile),
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum ChdCreateModeOverride {
        Cd,
        Dvd,
        Raw,
        HardDisk,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct ChdCompressionPlan {
        codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
        primary_codec: ChdCodec,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct RustCompressedHunkEntry {
        compression_type: u8,
        offset: u64,
        length: u32,
        crc16: u16,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct RustMetadataEntry {
        tag: u32,
        flags: u8,
        data: Vec<u8>,
    }

    #[derive(Default)]
    struct MsbBitWriter {
        bytes: Vec<u8>,
        bit_len: usize,
    }

    impl MsbBitWriter {
        fn new() -> Self {
            Self::default()
        }

        fn write_bits(&mut self, value: u64, bit_count: u8) {
            if bit_count == 0 {
                return;
            }
            for shift in (0..bit_count).rev() {
                let bit = ((value >> shift) & 1) as u8;
                let byte_index = self.bit_len / 8;
                if byte_index == self.bytes.len() {
                    self.bytes.push(0);
                }
                let bit_index = 7 - (self.bit_len % 8);
                self.bytes[byte_index] |= bit << bit_index;
                self.bit_len += 1;
            }
        }

        fn finish(self) -> Vec<u8> {
            self.bytes
        }
    }

    const CDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'C', b'D');
    const CDROM_TRACK_METADATA_TAG: u32 = make_tag(b'C', b'H', b'T', b'R');
    const GDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'G', b'T');
    const AV_METADATA_TAG: u32 = make_tag(b'A', b'V', b'A', b'V');
    const AV_LD_METADATA_TAG: u32 = make_tag(b'A', b'V', b'L', b'D');

    enum ChdReadBackend {
        Rust {
            metadata_by_tag_and_index: BTreeMap<(u32, u32), Vec<u8>>,
        },
    }

    struct ChdReadSession {
        source: PathBuf,
        parent_source: Option<PathBuf>,
        header: ChdHeader,
        media_kind: ChdMediaKind,
        backend: ChdReadBackend,
    }

    impl ChdReadSession {
        fn open(source: &Path, parent_source: Option<&Path>) -> Result<Self> {
            Self::open_rust(source, parent_source).map_err(|rust_error| {
                RomWeaverError::Validation(format!(
                    "failed to open chd `{}` with rust backend ({rust_error})",
                    source.display()
                ))
            })
        }

        fn open_rust(
            source: &Path,
            parent_source: Option<&Path>,
        ) -> std::result::Result<Self, String> {
            let mut chd = Self::open_rust_chd(source, parent_source)?;

            let header = Self::convert_header(chd.header());
            let mut metadata_by_tag_and_index = BTreeMap::new();
            let metadatas: Vec<chd::metadata::Metadata> = chd
                .metadata_refs()
                .try_into()
                .map_err(|error| format!("failed to read CHD metadata: {error}"))?;
            for metadata in metadatas {
                metadata_by_tag_and_index
                    .insert((metadata.metatag, metadata.index), metadata.value);
            }
            let media_kind = Self::detect_media_kind(&metadata_by_tag_and_index);

            Ok(Self {
                source: source.to_path_buf(),
                parent_source: parent_source.map(Path::to_path_buf),
                header,
                media_kind,
                backend: ChdReadBackend::Rust {
                    metadata_by_tag_and_index,
                },
            })
        }

        fn detect_media_kind(
            metadata_by_tag_and_index: &BTreeMap<(u32, u32), Vec<u8>>,
        ) -> ChdMediaKind {
            let has_tag = |tag: u32| {
                metadata_by_tag_and_index
                    .keys()
                    .any(|(candidate, _)| *candidate == tag)
            };
            if has_tag(GDROM_TRACK_METADATA_TAG) || has_tag(GDROM_OLD_METADATA_TAG) {
                return ChdMediaKind::GdRom;
            }
            if has_tag(CDROM_TRACK_METADATA2_TAG)
                || has_tag(CDROM_TRACK_METADATA_TAG)
                || has_tag(CDROM_OLD_METADATA_TAG)
            {
                return ChdMediaKind::CdRom;
            }
            if has_tag(HARD_DISK_METADATA_TAG) {
                return ChdMediaKind::HardDisk;
            }
            if has_tag(DVD_METADATA_TAG) {
                return ChdMediaKind::Dvd;
            }
            if has_tag(AV_METADATA_TAG) || has_tag(AV_LD_METADATA_TAG) {
                return ChdMediaKind::Av;
            }
            ChdMediaKind::Raw
        }

        fn codec_from_raw(raw: u32) -> ChdCodec {
            match raw {
                0 => ChdCodec::NONE,
                1 | 2 => ChdCodec::ZLIB,
                value if value == ChdCodec::ZLIB.raw() => ChdCodec::ZLIB,
                value if value == ChdCodec::ZSTD.raw() => ChdCodec::ZSTD,
                value if value == ChdCodec::LZMA.raw() => ChdCodec::LZMA,
                value if value == ChdCodec::HUFFMAN.raw() => ChdCodec::HUFFMAN,
                value if value == ChdCodec::AVHUFF.raw() => ChdCodec::AVHUFF,
                value if value == ChdCodec::FLAC.raw() => ChdCodec::FLAC,
                value if value == ChdCodec::CD_ZLIB.raw() => ChdCodec::CD_ZLIB,
                value if value == ChdCodec::CD_ZSTD.raw() => ChdCodec::CD_ZSTD,
                value if value == ChdCodec::CD_LZMA.raw() => ChdCodec::CD_LZMA,
                value if value == ChdCodec::CD_FLAC.raw() => ChdCodec::CD_FLAC,
                _ => ChdCodec::NONE,
            }
        }

        fn convert_header(header: &chd::header::Header) -> ChdHeader {
            let compression = match header {
                chd::header::Header::V1Header(value) | chd::header::Header::V2Header(value) => {
                    [value.compression, 0, 0, 0]
                }
                chd::header::Header::V3Header(value) => [value.compression, 0, 0, 0],
                chd::header::Header::V4Header(value) => [value.compression, 0, 0, 0],
                chd::header::Header::V5Header(value) => value.compression,
            };
            ChdHeader {
                version: header.version() as u32,
                logical_bytes: header.logical_bytes(),
                hunk_bytes: header.hunk_size(),
                hunk_count: header.hunk_count(),
                unit_bytes: header.unit_bytes(),
                unit_count: header.unit_count(),
                compressed: header.is_compressed(),
                compression: compression.map(Self::codec_from_raw),
            }
        }

        fn header(&self) -> ChdHeader {
            self.header
        }

        fn media_kind(&self) -> ChdMediaKind {
            self.media_kind
        }

        fn read_metadata(&self, tag: u32, index: u32) -> Result<Option<Vec<u8>>> {
            match &self.backend {
                ChdReadBackend::Rust {
                    metadata_by_tag_and_index,
                } => Ok(metadata_by_tag_and_index.get(&(tag, index)).cloned()),
            }
        }

        fn open_rust_chd(
            source: &Path,
            parent_source: Option<&Path>,
        ) -> std::result::Result<chd::Chd<BufReader<File>>, String> {
            let parent = if let Some(parent_source) = parent_source {
                let parent_file = File::open(parent_source).map_err(|error| {
                    format!(
                        "failed to open parent chd `{}`: {error}",
                        parent_source.display()
                    )
                })?;
                let parent_reader = BufReader::new(parent_file);
                let parent_chd = chd::Chd::open(parent_reader, None).map_err(|error| {
                    format!(
                        "failed to parse parent chd `{}`: {error}",
                        parent_source.display()
                    )
                })?;
                Some(Box::new(parent_chd))
            } else {
                None
            };

            let file = File::open(source)
                .map_err(|error| format!("failed to open `{}`: {error}", source.display()))?;
            let reader = BufReader::new(file);
            match chd::Chd::open(reader, parent) {
                Ok(chd) => Ok(chd),
                Err(chd::Error::InvalidParameter) if parent_source.is_some() => {
                    let file = File::open(source).map_err(|error| {
                        format!("failed to open `{}`: {error}", source.display())
                    })?;
                    let reader = BufReader::new(file);
                    chd::Chd::open(reader, None)
                        .map_err(|error| format!("failed to parse `{}`: {error}", source.display()))
                }
                Err(error) => Err(format!("failed to parse `{}`: {error}", source.display())),
            }
        }

        fn extract_to_file(&self, output_path: &Path, thread_count: usize) -> Result<ChdHeader> {
            match &self.backend {
                ChdReadBackend::Rust { .. } => Self::extract_to_file_with_rust(
                    &self.source,
                    self.parent_source.as_deref(),
                    self.header.logical_bytes,
                    output_path,
                    thread_count,
                )
                .map_err(RomWeaverError::Validation)
                .map(|_| self.header),
            }
        }

        fn extract_to_file_with_rust(
            source: &Path,
            parent_source: Option<&Path>,
            logical_bytes: u64,
            output_path: &Path,
            thread_count: usize,
        ) -> std::result::Result<(), String> {
            #[cfg(any(unix, windows))]
            if thread_count > 1 {
                return Self::extract_to_file_with_rust_parallel(
                    source,
                    parent_source,
                    logical_bytes,
                    output_path,
                    thread_count,
                );
            }

            let mut chd = Self::open_rust_chd(source, parent_source)
                .map_err(|error| format!("failed to decode `{}`: {error}", source.display()))?;

            let mut output = File::create(output_path).map_err(|error| {
                format!("failed to create `{}`: {error}", output_path.display())
            })?;
            let mut remaining = logical_bytes;
            let mut hunk_buffer = chd.get_hunksized_buffer();
            let mut compressed_buffer = Vec::new();
            for hunk_index in 0..chd.header().hunk_count() {
                if remaining == 0 {
                    break;
                }
                let mut hunk = chd.hunk(hunk_index).map_err(|error| {
                    format!(
                        "failed to decode hunk {} of `{}`: {error}",
                        hunk_index,
                        source.display()
                    )
                })?;
                hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
                    .map_err(|error| {
                        format!(
                            "failed to read hunk {} of `{}`: {error}",
                            hunk_index,
                            source.display()
                        )
                    })?;
                let write_len = usize::try_from(remaining.min(hunk_buffer.len() as u64))
                    .map_err(|_| "decoded CHD chunk exceeded addressable memory".to_string())?;
                output
                    .write_all(&hunk_buffer[..write_len])
                    .map_err(|error| {
                        format!("failed to write `{}`: {error}", output_path.display())
                    })?;
                remaining -= write_len as u64;
            }

            Ok(())
        }

        #[cfg(any(unix, windows))]
        fn extract_to_file_with_rust_parallel(
            source: &Path,
            parent_source: Option<&Path>,
            logical_bytes: u64,
            output_path: &Path,
            thread_count: usize,
        ) -> std::result::Result<(), String> {
            let chd = Self::open_rust_chd(source, parent_source)
                .map_err(|error| format!("failed to decode `{}`: {error}", source.display()))?;
            let hunk_count = chd.header().hunk_count();
            let hunk_bytes = chd.header().hunk_size() as u64;
            drop(chd);

            let output = File::create(output_path).map_err(|error| {
                format!("failed to create `{}`: {error}", output_path.display())
            })?;
            output.set_len(logical_bytes).map_err(|error| {
                format!(
                    "failed to size `{}` to {} bytes: {error}",
                    output_path.display(),
                    logical_bytes
                )
            })?;

            let hunk_count_usize = usize::try_from(hunk_count)
                .map_err(|_| "CHD hunk count exceeded addressable memory".to_string())?;
            if hunk_count_usize == 0 {
                return Ok(());
            }
            let effective_threads = thread_count.max(1).min(hunk_count_usize);
            if effective_threads <= 1 {
                return Self::extract_to_file_with_rust(
                    source,
                    parent_source,
                    logical_bytes,
                    output_path,
                    1,
                );
            }

            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(effective_threads)
                .build()
                .map_err(|error| {
                    format!(
                        "failed to build CHD rust extraction pool (threads={}): {error}",
                        effective_threads
                    )
                })?;

            let source = source.to_path_buf();
            let parent_source = parent_source.map(Path::to_path_buf);
            let output = Arc::new(output);
            let hunk_indices: Vec<u32> = (0..hunk_count).collect();
            let chunk_size = hunk_indices.len().div_ceil(effective_threads).max(1);

            let chunk_results = pool.install(|| {
                hunk_indices
                    .par_chunks(chunk_size)
                    .map(|chunk| {
                        let mut chd = Self::open_rust_chd(&source, parent_source.as_deref())
                            .map_err(|error| {
                                format!("failed to decode `{}`: {error}", source.display())
                            })?;

                        let mut hunk_buffer = chd.get_hunksized_buffer();
                        let mut compressed_buffer = Vec::new();

                        for &hunk_index in chunk {
                            let mut hunk = chd.hunk(hunk_index).map_err(|error| {
                                format!(
                                    "failed to decode hunk {} of `{}`: {error}",
                                    hunk_index,
                                    source.display()
                                )
                            })?;
                            hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
                                .map_err(|error| {
                                    format!(
                                        "failed to read hunk {} of `{}`: {error}",
                                        hunk_index,
                                        source.display()
                                    )
                                })?;

                            let offset = u64::from(hunk_index).saturating_mul(hunk_bytes);
                            if offset >= logical_bytes {
                                continue;
                            }
                            let write_len = usize::try_from(
                                logical_bytes
                                    .saturating_sub(offset)
                                    .min(hunk_buffer.len() as u64),
                            )
                            .map_err(|_| {
                                "decoded CHD chunk exceeded addressable memory".to_string()
                            })?;
                            Self::write_all_at(&output, &hunk_buffer[..write_len], offset)
                                .map_err(|error| {
                                    format!(
                                        "failed to write `{}` at offset {}: {error}",
                                        output_path.display(),
                                        offset
                                    )
                                })?;
                        }
                        Ok(())
                    })
                    .collect::<Vec<std::result::Result<(), String>>>()
            });

            for result in chunk_results {
                result?;
            }
            Ok(())
        }

        #[cfg(unix)]
        fn write_all_at(file: &File, mut bytes: &[u8], mut offset: u64) -> io::Result<()> {
            use std::os::unix::fs::FileExt as _;

            while !bytes.is_empty() {
                let written = file.write_at(bytes, offset)?;
                if written == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "failed to write CHD chunk",
                    ));
                }
                offset = offset.saturating_add(written as u64);
                bytes = &bytes[written..];
            }
            Ok(())
        }

        #[cfg(all(not(unix), windows))]
        fn write_all_at(file: &File, mut bytes: &[u8], mut offset: u64) -> io::Result<()> {
            use std::os::windows::fs::FileExt as _;

            while !bytes.is_empty() {
                let written = file.seek_write(bytes, offset)?;
                if written == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "failed to write CHD chunk",
                    ));
                }
                offset = offset.saturating_add(written as u64);
                bytes = &bytes[written..];
            }
            Ok(())
        }
    }

    fn split_token(text: &str) -> Option<(&str, &str)> {
        let trimmed = text.trim_start();
        if trimmed.is_empty() {
            return None;
        }
        if let Some(rest) = trimmed.strip_prefix('"') {
            let end = rest.find('"')?;
            let token = &rest[..end];
            let remainder = &rest[end + 1..];
            Some((token, remainder))
        } else {
            let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
            Some((&trimmed[..end], &trimmed[end..]))
        }
    }

    impl ChdContainerHandler {
        const DEFAULT_HUNK_BYTES: u32 = 4096;
        const DVD_SECTOR_BYTES: u32 = 2048;
        const HD_SECTOR_BYTES: u32 = 512;
        const CD_FRAME_BYTES: u32 = CD_FRAME_SIZE;
        const CD_HUNK_BYTES: u32 = CD_FRAME_SIZE * 8;
        const CD_SECTOR_DATA_BYTES: usize = 2352;
        const CD_SUBCODE_BYTES: usize = 96;
        const ZLIB_LEVEL_MIN: i32 = 1;
        const ZLIB_LEVEL_MAX: i32 = 9;
        const ZSTD_LEVEL_MIN: i32 = -7;
        const LZMA_LEVEL_MIN: i32 = 0;
        const LZMA_LEVEL_MAX: i32 = 9;
        const CHD_V5_HEADER_BYTES: u64 = 124;
        const CHD_V5_MAP_TYPE_COMPRESSED_MAX: u8 = 3;
        const CHD_V5_MAP_TYPE_UNCOMPRESSED: u8 = 4;
        const CHD_V5_HEADER_MAP_OFFSET: u64 = 40;
        const CHD_V5_HEADER_META_OFFSET: u64 = 48;
        const CHD_V5_HEADER_RAW_SHA1_OFFSET: u64 = 64;
        const CHD_V5_HEADER_SHA1_OFFSET: u64 = 84;
        const CHD_SHA1_BYTES: usize = 20;

        fn supports_rust_create(
            &self,
            create_kind: &ChdCreateKind,
            codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
            primary_codec: ChdCodec,
        ) -> bool {
            let mut active_codecs = Vec::new();
            let mut saw_none = false;
            for codec in codecs {
                if codec == ChdCodec::NONE {
                    saw_none = true;
                    continue;
                }
                if saw_none {
                    // Codec slots must be contiguous.
                    return false;
                }
                active_codecs.push(codec);
            }
            if primary_codec == ChdCodec::NONE {
                return active_codecs.is_empty() && !matches!(create_kind, ChdCreateKind::Av(_));
            }
            if active_codecs.is_empty() || active_codecs[0] != primary_codec {
                return false;
            }
            active_codecs
                .into_iter()
                .all(|codec| self.supports_rust_create_codec(create_kind, codec))
        }

        fn supports_rust_create_codec(&self, create_kind: &ChdCreateKind, codec: ChdCodec) -> bool {
            match create_kind {
                ChdCreateKind::Raw | ChdCreateKind::Dvd | ChdCreateKind::HardDisk(_) => {
                    matches!(
                        codec,
                        ChdCodec::NONE | ChdCodec::ZSTD | ChdCodec::ZLIB | ChdCodec::LZMA
                    )
                }
                ChdCreateKind::Disc(_) => {
                    matches!(
                        codec,
                        ChdCodec::NONE | ChdCodec::CD_ZSTD | ChdCodec::CD_ZLIB | ChdCodec::CD_LZMA
                    )
                }
                ChdCreateKind::Av(_) => {
                    matches!(
                        codec,
                        ChdCodec::NONE | ChdCodec::ZSTD | ChdCodec::ZLIB | ChdCodec::LZMA
                    )
                }
            }
        }

        fn should_attempt_rust_create(
            &self,
            create_kind: &ChdCreateKind,
            codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
            primary_codec: ChdCodec,
        ) -> bool {
            self.supports_rust_create(create_kind, codecs, primary_codec)
        }

        fn media_kind_from_create_kind(&self, create_kind: &ChdCreateKind) -> ChdMediaKind {
            match create_kind {
                ChdCreateKind::Raw => ChdMediaKind::Raw,
                ChdCreateKind::HardDisk(_) => ChdMediaKind::HardDisk,
                ChdCreateKind::Dvd => ChdMediaKind::Dvd,
                ChdCreateKind::Disc(layout) => match layout.kind {
                    DiscKind::CdRom => ChdMediaKind::CdRom,
                    DiscKind::GdRom => ChdMediaKind::GdRom,
                },
                ChdCreateKind::Av(_) => ChdMediaKind::Av,
            }
        }

        fn media_label(&self, media_kind: ChdMediaKind) -> &'static str {
            match media_kind {
                ChdMediaKind::Raw => "raw",
                ChdMediaKind::HardDisk => "hd",
                ChdMediaKind::CdRom => "cd",
                ChdMediaKind::GdRom => "gd",
                ChdMediaKind::Dvd => "dvd",
                ChdMediaKind::Av => "av",
            }
        }

        fn resolve_compression_plan(
            &self,
            codec: Option<&str>,
            create_kind: &ChdCreateKind,
        ) -> Result<ChdCompressionPlan> {
            if let Some(codecs) = self.parse_explicit_codecs(codec)? {
                return self.explicit_codec_plan(codecs);
            }
            Ok(self.default_compression_plan(create_kind))
        }

        fn normalize_compression_plan_for_create_kind(
            &self,
            create_kind: &ChdCreateKind,
            mut plan: ChdCompressionPlan,
        ) -> ChdCompressionPlan {
            if matches!(create_kind, ChdCreateKind::Disc(_)) {
                let map_disc_codec = |codec: ChdCodec| match codec {
                    ChdCodec::ZSTD => ChdCodec::CD_ZSTD,
                    ChdCodec::ZLIB => ChdCodec::CD_ZLIB,
                    ChdCodec::LZMA => ChdCodec::CD_LZMA,
                    ChdCodec::FLAC => ChdCodec::CD_FLAC,
                    other => other,
                };
                plan.codecs = plan.codecs.map(map_disc_codec);
                plan.primary_codec = map_disc_codec(plan.primary_codec);
            }

            plan
        }

        #[cfg(test)]
        pub(super) fn default_cd_compression_plan_for_tests(
            &self,
        ) -> Result<([ChdCodec; CHD_MAX_COMPRESSORS], ChdCodec)> {
            let create_kind = ChdCreateKind::Disc(DiscLayout {
                kind: DiscKind::CdRom,
                tracks: Vec::new(),
            });
            let plan = self.resolve_compression_plan(None, &create_kind)?;
            Ok((plan.codecs, plan.primary_codec))
        }

        #[cfg(test)]
        pub(super) fn default_dvd_compression_plan_for_tests(
            &self,
        ) -> Result<([ChdCodec; CHD_MAX_COMPRESSORS], ChdCodec)> {
            let plan = self.resolve_compression_plan(None, &ChdCreateKind::Dvd)?;
            Ok((plan.codecs, plan.primary_codec))
        }

        #[cfg(test)]
        pub(super) fn explicit_compression_plan_for_tests(
            &self,
            codecs: &str,
        ) -> Result<([ChdCodec; CHD_MAX_COMPRESSORS], ChdCodec)> {
            let plan = self.resolve_compression_plan(Some(codecs), &ChdCreateKind::Raw)?;
            Ok((plan.codecs, plan.primary_codec))
        }

        #[cfg(test)]
        pub(super) fn rust_backend_can_create_with_codec_list_for_tests(
            &self,
            codecs: &str,
        ) -> Result<bool> {
            let plan = self.resolve_compression_plan(Some(codecs), &ChdCreateKind::Raw)?;
            Ok(self.should_attempt_rust_create(
                &ChdCreateKind::Raw,
                plan.codecs,
                plan.primary_codec,
            ))
        }

        #[cfg(test)]
        pub(super) fn create_raw_store_with_rust_backend_for_tests(
            &self,
            source: &Path,
            output: &Path,
        ) -> Result<ChdHeader> {
            let logical_bytes = fs::metadata(source)?.len();
            self.create_uncompressed_rust_raw(source, output, logical_bytes, &ChdCreateKind::Raw)
        }

        #[cfg(test)]
        pub(super) fn create_raw_with_rust_backend_codec_for_tests(
            &self,
            source: &Path,
            output: &Path,
            codec: ChdCodec,
            level: i32,
            thread_count: usize,
        ) -> Result<ChdHeader> {
            let logical_bytes = fs::metadata(source)?.len();
            if codec == ChdCodec::NONE {
                self.create_uncompressed_rust_raw(
                    source,
                    output,
                    logical_bytes,
                    &ChdCreateKind::Raw,
                )
            } else {
                self.create_compressed_rust_raw(
                    source,
                    output,
                    logical_bytes,
                    &ChdCreateKind::Raw,
                    [codec, ChdCodec::NONE, ChdCodec::NONE, ChdCodec::NONE],
                    level,
                    thread_count,
                )
            }
        }

        #[cfg(test)]
        pub(super) fn extract_raw_with_rust_backend_for_tests(
            &self,
            source: &Path,
            output: &Path,
            thread_count: usize,
        ) -> Result<()> {
            let session =
                ChdReadSession::open_rust(source, None).map_err(RomWeaverError::Validation)?;
            let media_kind = session.media_kind();
            if matches!(media_kind, ChdMediaKind::CdRom | ChdMediaKind::GdRom) {
                return Err(RomWeaverError::Validation(
                    "rust backend raw extract helper only supports non-disc media".to_string(),
                ));
            }
            session.extract_to_file(output, thread_count).map(|_| ())
        }

        fn explicit_codec_plan(&self, codecs: Vec<ChdCodec>) -> Result<ChdCompressionPlan> {
            if codecs.is_empty() {
                return Err(RomWeaverError::Validation(
                    "chd codec list cannot be empty".to_string(),
                ));
            }
            if codecs.len() > CHD_MAX_COMPRESSORS {
                return Err(RomWeaverError::Validation(format!(
                    "chd supports at most {CHD_MAX_COMPRESSORS} codecs; received {}",
                    codecs.len()
                )));
            }
            if codecs[0] == ChdCodec::NONE && codecs.len() > 1 {
                return Err(RomWeaverError::Validation(
                    "chd codec `store` cannot be combined with additional codecs".to_string(),
                ));
            }
            if codecs
                .iter()
                .enumerate()
                .skip(1)
                .any(|(_, codec)| *codec == ChdCodec::AVHUFF)
            {
                return Err(RomWeaverError::Validation(
                    "chd codec `avhuff` must be the first codec when multiple codecs are provided"
                        .to_string(),
                ));
            }
            let primary_codec = codecs[0];
            let mut resolved_codecs = [ChdCodec::NONE; CHD_MAX_COMPRESSORS];
            for (index, codec) in codecs.into_iter().enumerate() {
                resolved_codecs[index] = codec;
            }
            Ok(ChdCompressionPlan {
                codecs: resolved_codecs,
                primary_codec,
            })
        }

        fn default_compression_plan(&self, create_kind: &ChdCreateKind) -> ChdCompressionPlan {
            match create_kind {
                ChdCreateKind::Disc(layout) => match layout.kind {
                    DiscKind::CdRom | DiscKind::GdRom => ChdCompressionPlan {
                        codecs: [
                            ChdCodec::CD_ZSTD,
                            ChdCodec::CD_ZLIB,
                            ChdCodec::CD_LZMA,
                            ChdCodec::NONE,
                        ],
                        primary_codec: ChdCodec::CD_ZSTD,
                    },
                },
                ChdCreateKind::Dvd => ChdCompressionPlan {
                    codecs: [
                        ChdCodec::ZSTD,
                        ChdCodec::ZLIB,
                        ChdCodec::LZMA,
                        ChdCodec::NONE,
                    ],
                    primary_codec: ChdCodec::ZSTD,
                },
                _ => ChdCompressionPlan {
                    codecs: [
                        ChdCodec::ZSTD,
                        ChdCodec::NONE,
                        ChdCodec::NONE,
                        ChdCodec::NONE,
                    ],
                    primary_codec: ChdCodec::ZSTD,
                },
            }
        }

        fn parse_explicit_codecs(&self, codec: Option<&str>) -> Result<Option<Vec<ChdCodec>>> {
            let Some(codec) = codec else {
                return Ok(None);
            };
            let codec = codec.trim();
            if codec.is_empty() {
                return Ok(None);
            }

            let mut codecs = Vec::new();
            for entry in codec.split([',', '+']) {
                let entry = entry.trim();
                if entry.is_empty() {
                    return Err(RomWeaverError::Validation(
                        "chd codec list contains an empty entry".to_string(),
                    ));
                }
                codecs.push(self.map_codec(entry)?);
            }
            Ok(Some(codecs))
        }

        fn map_codec(&self, codec: &str) -> Result<ChdCodec> {
            let normalized = codec.trim().to_ascii_lowercase();
            match normalized.as_str() {
                "flac" => return Ok(ChdCodec::FLAC),
                "cdzl" => return Ok(ChdCodec::CD_ZLIB),
                "cdzs" => return Ok(ChdCodec::CD_ZSTD),
                "cdlz" => return Ok(ChdCodec::CD_LZMA),
                "cdfl" => return Ok(ChdCodec::CD_FLAC),
                "avhu" | "avhuff" => return Ok(ChdCodec::AVHUFF),
                _ => {}
            }

            match parse_requested_codec(Some(codec)) {
                RequestedCodec::Unspecified => Ok(ChdCodec::ZSTD),
                RequestedCodec::Known(CanonicalCodec::Store) => Ok(ChdCodec::NONE),
                RequestedCodec::Known(CanonicalCodec::Deflate) => Ok(ChdCodec::ZLIB),
                RequestedCodec::Known(CanonicalCodec::Zstd) => Ok(ChdCodec::ZSTD),
                RequestedCodec::Known(CanonicalCodec::Lzma)
                | RequestedCodec::Known(CanonicalCodec::Lzma2) => Ok(ChdCodec::LZMA),
                RequestedCodec::Known(CanonicalCodec::Huffman) => Ok(ChdCodec::HUFFMAN),
                RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                    "unsupported chd codec `{}`; supported codecs are store, zlib, zstd, lzma, huffman, flac, cdlz, cdzl, cdzs, cdfl, and avhu",
                    codec.name()
                ))),
                RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                    "unsupported chd codec `{name}`; supported codecs are store, zlib, zstd, lzma, huffman, flac, cdlz, cdzl, cdzs, cdfl, and avhu"
                ))),
            }
        }

        fn resolve_compression_level(&self, codec: ChdCodec, level: Option<i32>) -> Result<i32> {
            let Some(level) = level else {
                return Ok(0);
            };

            let codec_label = self.codec_label(codec);
            let zstd_max_level = zstd::zstd_safe::max_c_level() as i32;
            let range = match codec {
                ChdCodec::ZLIB | ChdCodec::CD_ZLIB => {
                    Some((Self::ZLIB_LEVEL_MIN, Self::ZLIB_LEVEL_MAX))
                }
                ChdCodec::ZSTD | ChdCodec::CD_ZSTD => Some((Self::ZSTD_LEVEL_MIN, zstd_max_level)),
                ChdCodec::LZMA | ChdCodec::CD_LZMA => {
                    Some((Self::LZMA_LEVEL_MIN, Self::LZMA_LEVEL_MAX))
                }
                ChdCodec::NONE
                | ChdCodec::HUFFMAN
                | ChdCodec::FLAC
                | ChdCodec::CD_FLAC
                | ChdCodec::AVHUFF => None,
                _ => None,
            };

            let Some((min, max)) = range else {
                return Err(RomWeaverError::Validation(format!(
                    "chd codec `{codec_label}` does not accept --level"
                )));
            };
            if (min..=max).contains(&level) {
                Ok(level)
            } else {
                Err(RomWeaverError::Validation(format!(
                    "chd codec `{codec_label}` level `{level}` is out of range; expected {min}..={max}"
                )))
            }
        }

        fn codec_label(&self, codec: ChdCodec) -> &'static str {
            match codec {
                ChdCodec::NONE => "store",
                ChdCodec::ZLIB => "zlib",
                ChdCodec::ZSTD => "zstd",
                ChdCodec::LZMA => "lzma",
                ChdCodec::HUFFMAN => "huffman",
                ChdCodec::AVHUFF => "avhuff",
                ChdCodec::FLAC => "flac",
                ChdCodec::CD_ZLIB => "cdzl",
                ChdCodec::CD_ZSTD => "cdzs",
                ChdCodec::CD_LZMA => "cdlz",
                ChdCodec::CD_FLAC => "cdfl",
                _ => "unknown",
            }
        }

        fn header_codec_label(&self, header: ChdHeader) -> String {
            let codecs = header
                .compression
                .into_iter()
                .filter(|codec| *codec != ChdCodec::NONE)
                .map(|codec| normalize_codec_label(self.codec_label(codec)))
                .collect::<Vec<_>>();
            if codecs.is_empty() {
                "store".to_string()
            } else {
                codecs.join("+")
            }
        }

        fn extract_extension(&self, media_kind: ChdMediaKind) -> Result<&'static str> {
            match media_kind {
                ChdMediaKind::Raw => Ok(".bin"),
                ChdMediaKind::HardDisk => Ok(".img"),
                ChdMediaKind::Dvd => Ok(".iso"),
                ChdMediaKind::CdRom => Ok(".cue"),
                ChdMediaKind::GdRom => Ok(".gdi"),
                ChdMediaKind::Av => Ok(".avi"),
            }
        }

        fn extract_name(&self, source: &Path, media_kind: ChdMediaKind) -> Result<String> {
            let stem = source
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("output");
            Ok(format!("{stem}{}", self.extract_extension(media_kind)?))
        }

        fn parse_disc_mode(&self, value: &str) -> Result<DiscTrackMode> {
            match value.trim().to_ascii_uppercase().as_str() {
                "MODE1" | "MODE1/2048" => Ok(DiscTrackMode::Mode1),
                "MODE1/2352" | "MODE1_RAW" => Ok(DiscTrackMode::Mode1Raw),
                "MODE2" | "MODE2/2336" => Ok(DiscTrackMode::Mode2),
                "MODE2_FORM1" | "MODE2/2048" => Ok(DiscTrackMode::Mode2Form1),
                "MODE2_FORM2" | "MODE2/2324" => Ok(DiscTrackMode::Mode2Form2),
                "MODE2_FORM_MIX" => Ok(DiscTrackMode::Mode2FormMix),
                "MODE2/2352" | "MODE2_RAW" | "CDI/2352" => Ok(DiscTrackMode::Mode2Raw),
                "AUDIO" => Ok(DiscTrackMode::Audio),
                other => Err(RomWeaverError::Validation(format!(
                    "unsupported disc track type `{other}`; supported types are MODE1/2048, MODE1/2352, MODE2/2336, MODE2/2048, MODE2/2324, MODE2_FORM_MIX, MODE2/2352, and AUDIO"
                ))),
            }
        }

        fn parse_msf(&self, value: &str) -> Result<u32> {
            let mut parts = value.split(':');
            let minutes = parts
                .next()
                .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
                .parse::<u32>()
                .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
            let seconds = parts
                .next()
                .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
                .parse::<u32>()
                .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
            let frames = parts
                .next()
                .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
                .parse::<u32>()
                .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
            if parts.next().is_some() || seconds >= 60 || frames >= 75 {
                return Err(RomWeaverError::Validation(format!(
                    "invalid cue time `{value}`"
                )));
            }
            Ok(minutes * 60 * 75 + seconds * 75 + frames)
        }

        fn format_msf(&self, frames: u32) -> String {
            let minutes = frames / (60 * 75);
            let seconds = (frames / 75) % 60;
            let frame = frames % 75;
            format!("{minutes:02}:{seconds:02}:{frame:02}")
        }

        fn parse_wave_file(&self, path: &Path) -> Result<(u64, u64)> {
            let mut reader = BufReader::new(File::open(path)?);
            let mut header = [0_u8; 12];
            reader.read_exact(&mut header)?;
            if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
                return Err(RomWeaverError::Validation(format!(
                    "wave track `{}` is not a RIFF/WAVE file",
                    path.display()
                )));
            }

            let mut audio_format = None;
            let mut channels = None;
            let mut sample_rate = None;
            let mut block_align = None;
            let mut bits_per_sample = None;
            let mut data = None;

            loop {
                let mut chunk_header = [0_u8; 8];
                match reader.read_exact(&mut chunk_header) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(error) => return Err(error.into()),
                }

                let chunk_size = u64::from(u32::from_le_bytes([
                    chunk_header[4],
                    chunk_header[5],
                    chunk_header[6],
                    chunk_header[7],
                ]));
                let chunk_data_offset = reader.stream_position()?;
                let padded_size = chunk_size + (chunk_size % 2);

                match &chunk_header[..4] {
                    b"fmt " => {
                        let chunk_len = usize::try_from(chunk_size).map_err(|_| {
                            RomWeaverError::Validation(format!(
                                "wave track `{}` has an oversized fmt chunk",
                                path.display()
                            ))
                        })?;
                        let mut chunk = vec![0_u8; chunk_len];
                        reader.read_exact(&mut chunk)?;
                        if chunk.len() < 16 {
                            return Err(RomWeaverError::Validation(format!(
                                "wave track `{}` has a truncated fmt chunk",
                                path.display()
                            )));
                        }
                        audio_format = Some(u16::from_le_bytes([chunk[0], chunk[1]]));
                        channels = Some(u16::from_le_bytes([chunk[2], chunk[3]]));
                        sample_rate =
                            Some(u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]));
                        block_align = Some(u16::from_le_bytes([chunk[12], chunk[13]]));
                        bits_per_sample = Some(u16::from_le_bytes([chunk[14], chunk[15]]));
                        if padded_size != chunk_size {
                            reader.seek(SeekFrom::Current(1))?;
                        }
                    }
                    b"data" => {
                        data = Some((chunk_data_offset, chunk_size));
                        let skip = i64::try_from(padded_size).map_err(|_| {
                            RomWeaverError::Validation(format!(
                                "wave track `{}` is too large for current parsing support",
                                path.display()
                            ))
                        })?;
                        reader.seek(SeekFrom::Current(skip))?;
                    }
                    _ => {
                        let skip = i64::try_from(padded_size).map_err(|_| {
                            RomWeaverError::Validation(format!(
                                "wave track `{}` is too large for current parsing support",
                                path.display()
                            ))
                        })?;
                        reader.seek(SeekFrom::Current(skip))?;
                    }
                }
            }

            let audio_format = audio_format.ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "wave track `{}` is missing a fmt chunk",
                    path.display()
                ))
            })?;
            if audio_format != 1 {
                return Err(RomWeaverError::Validation(format!(
                    "wave track `{}` uses unsupported format code {}; only PCM WAVE tracks are supported",
                    path.display(),
                    audio_format
                )));
            }
            if channels != Some(2)
                || sample_rate != Some(44_100)
                || block_align != Some(4)
                || bits_per_sample != Some(16)
            {
                return Err(RomWeaverError::Validation(format!(
                    "wave track `{}` must be 44.1 kHz 16-bit stereo PCM for chd audio tracks",
                    path.display()
                )));
            }

            let (data_offset, data_len) = data.ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "wave track `{}` is missing a data chunk",
                    path.display()
                ))
            })?;
            if data_len % 2352 != 0 {
                return Err(RomWeaverError::Validation(format!(
                    "wave track `{}` data length is not divisible by 2352 bytes",
                    path.display()
                )));
            }
            Ok((data_offset, data_len))
        }

        fn parse_cue_file(&self, path: &Path) -> Result<DiscLayout> {
            #[derive(Clone, Debug)]
            struct PendingTrack {
                number: u32,
                mode: DiscTrackMode,
                file_path: PathBuf,
                file_offset_base_bytes: u64,
                file_data_len_bytes: u64,
                index00_frames: Option<u32>,
                index01_frames: Option<u32>,
                pregap_frames: u32,
                postgap_frames: u32,
                swap_audio_on_read: bool,
            }

            #[derive(Clone, Debug)]
            struct PendingFile {
                path: PathBuf,
                data_offset_bytes: u64,
                data_len_bytes: u64,
                swap_audio_on_read: bool,
            }

            let cue_dir = path.parent().unwrap_or_else(|| Path::new("."));
            let text = fs::read_to_string(path)?;
            let mut tracks = Vec::<PendingTrack>::new();
            let mut current_file: Option<PendingFile> = None;
            let mut current_track: Option<usize> = None;

            for raw_line in text.lines() {
                let line = raw_line.trim();
                if line.is_empty() {
                    continue;
                }
                let keyword_end = line.find(char::is_whitespace).unwrap_or(line.len());
                let keyword = line[..keyword_end].to_ascii_uppercase();
                let remainder = line[keyword_end..].trim_start();
                match keyword.as_str() {
                    "REM" | "TITLE" | "PERFORMER" | "SONGWRITER" | "FLAGS" | "CATALOG" | "ISRC" => {
                    }
                    "FILE" => {
                        let (name, rest) = split_token(remainder).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "invalid FILE entry in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let (kind, _) = split_token(rest).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "missing FILE type in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let full_path = cue_dir.join(name);
                        let kind = kind.trim().to_ascii_uppercase();
                        current_file = Some(match kind.as_str() {
                            "BINARY" => PendingFile {
                                path: full_path.clone(),
                                data_offset_bytes: 0,
                                data_len_bytes: fs::metadata(&full_path)?.len(),
                                swap_audio_on_read: true,
                            },
                            "MOTOROLA" => PendingFile {
                                path: full_path.clone(),
                                data_offset_bytes: 0,
                                data_len_bytes: fs::metadata(&full_path)?.len(),
                                swap_audio_on_read: false,
                            },
                            "WAVE" => {
                                let (data_offset_bytes, data_len_bytes) =
                                    self.parse_wave_file(&full_path)?;
                                PendingFile {
                                    path: full_path,
                                    data_offset_bytes,
                                    data_len_bytes,
                                    swap_audio_on_read: true,
                                }
                            }
                            other => {
                                return Err(RomWeaverError::Validation(format!(
                                    "cue `{}` uses FILE type `{other}`; current chd cue support accepts BINARY, MOTOROLA, and WAVE files",
                                    path.display()
                                )));
                            }
                        });
                        current_track = None;
                    }
                    "TRACK" => {
                        let Some(file) = current_file.clone() else {
                            return Err(RomWeaverError::Validation(format!(
                                "TRACK entry appeared before FILE in cue `{}`",
                                path.display()
                            )));
                        };
                        let (number, rest) = split_token(remainder).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "invalid TRACK entry in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let (mode, _) = split_token(rest).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "missing TRACK type in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let number = number.parse::<u32>().map_err(|_| {
                            RomWeaverError::Validation(format!(
                                "invalid TRACK number `{number}` in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let mode = self.parse_disc_mode(mode)?;
                        if file.data_offset_bytes != 0 && mode != DiscTrackMode::Audio {
                            return Err(RomWeaverError::Validation(format!(
                                "cue `{}` uses a WAVE file for non-audio track {}",
                                path.display(),
                                number
                            )));
                        }
                        tracks.push(PendingTrack {
                            number,
                            mode,
                            file_path: file.path.clone(),
                            file_offset_base_bytes: file.data_offset_bytes,
                            file_data_len_bytes: file.data_len_bytes,
                            index00_frames: None,
                            index01_frames: None,
                            pregap_frames: 0,
                            postgap_frames: 0,
                            swap_audio_on_read: file.swap_audio_on_read,
                        });
                        current_track = Some(tracks.len() - 1);
                    }
                    "INDEX" => {
                        let Some(track_index) = current_track else {
                            return Err(RomWeaverError::Validation(format!(
                                "INDEX entry appeared before TRACK in cue `{}`",
                                path.display()
                            )));
                        };
                        let (index_number, rest) = split_token(remainder).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "invalid INDEX entry in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let (time, _) = split_token(rest).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "missing INDEX time in cue `{}`",
                                path.display()
                            ))
                        })?;
                        match index_number {
                            "00" => {
                                tracks[track_index].index00_frames = Some(self.parse_msf(time)?)
                            }
                            "01" => {
                                tracks[track_index].index01_frames = Some(self.parse_msf(time)?)
                            }
                            other => {
                                return Err(RomWeaverError::Validation(format!(
                                    "cue `{}` uses unsupported index `{other}`; current chd cue support accepts INDEX 00 and INDEX 01",
                                    path.display()
                                )));
                            }
                        }
                    }
                    "PREGAP" => {
                        let Some(track_index) = current_track else {
                            return Err(RomWeaverError::Validation(format!(
                                "PREGAP entry appeared before TRACK in cue `{}`",
                                path.display()
                            )));
                        };
                        tracks[track_index].pregap_frames = self.parse_msf(remainder)?;
                    }
                    "POSTGAP" => {
                        let Some(track_index) = current_track else {
                            return Err(RomWeaverError::Validation(format!(
                                "POSTGAP entry appeared before TRACK in cue `{}`",
                                path.display()
                            )));
                        };
                        tracks[track_index].postgap_frames = self.parse_msf(remainder)?;
                    }
                    other => {
                        return Err(RomWeaverError::Validation(format!(
                            "cue `{}` uses unsupported directive `{other}`",
                            path.display()
                        )));
                    }
                }
            }

            if tracks.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "cue `{}` did not define any tracks",
                    path.display()
                )));
            }

            let mut resolved = Vec::with_capacity(tracks.len());
            for (index, track) in tracks.iter().enumerate() {
                let index01_frames = track.index01_frames.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "cue track {} in `{}` is missing INDEX 01",
                        track.number,
                        path.display()
                    ))
                })?;
                if track.pregap_frames > 0 && track.index00_frames.is_some() {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} in `{}` uses both INDEX 00 and PREGAP; current chd cue support requires one pregap style",
                        track.number,
                        path.display()
                    )));
                }
                let start_frame = track.index00_frames.unwrap_or(index01_frames);
                let sector_bytes = u64::try_from(track.mode.data_bytes()).unwrap_or(2352);
                let start = track.file_offset_base_bytes + u64::from(start_frame) * sector_bytes;
                let file_end = track.file_offset_base_bytes + track.file_data_len_bytes;
                if start > file_end {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} starts past the end of `{}`",
                        track.number,
                        track.file_path.display()
                    )));
                }
                let mut next_start = file_end;
                for candidate in &tracks[index + 1..] {
                    if candidate.file_path != track.file_path
                        || candidate.file_offset_base_bytes != track.file_offset_base_bytes
                    {
                        continue;
                    }
                    if candidate.mode.data_bytes() != track.mode.data_bytes() {
                        return Err(RomWeaverError::Validation(format!(
                            "cue `{}` shares `{}` across tracks with different sector sizes; current chd cue support requires a separate file per sector size",
                            path.display(),
                            track.file_path.display()
                        )));
                    }
                    let candidate_index01 = candidate.index01_frames.ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "cue track {} in `{}` is missing INDEX 01",
                            candidate.number,
                            path.display()
                        ))
                    })?;
                    let candidate_start_frame =
                        candidate.index00_frames.unwrap_or(candidate_index01);
                    next_start = candidate.file_offset_base_bytes
                        + u64::from(candidate_start_frame) * sector_bytes;
                    break;
                }
                if next_start < start {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} has descending frame offsets in `{}`",
                        track.number,
                        path.display()
                    )));
                }
                let byte_len = next_start - start;
                if byte_len % sector_bytes != 0 {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} length in `{}` is not divisible by {} bytes",
                        track.number,
                        track.file_path.display(),
                        sector_bytes
                    )));
                }
                let frames = u32::try_from(byte_len / sector_bytes).map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "cue track {} is too large for current chd cd support",
                        track.number
                    ))
                })?;
                let pregap_from_index = index01_frames.saturating_sub(start_frame);
                let pregap_has_data = track.index00_frames.is_some() && pregap_from_index > 0;
                let pregap_frames = if pregap_has_data {
                    pregap_from_index
                } else {
                    track.pregap_frames
                };
                resolved.push(DiscTrack {
                    number: track.number,
                    mode: track.mode,
                    file_path: track.file_path.clone(),
                    file_offset_bytes: start,
                    frames,
                    pregap_frames,
                    postgap_frames: track.postgap_frames,
                    pregap_has_data,
                    has_subcode: false,
                    pad_frames: 0,
                    swap_audio_on_read: track.swap_audio_on_read,
                });
            }

            Ok(DiscLayout {
                kind: DiscKind::CdRom,
                tracks: resolved,
            })
        }

        fn parse_gdi_file(&self, path: &Path) -> Result<DiscLayout> {
            #[derive(Clone, Debug)]
            struct PendingTrack {
                number: u32,
                physframeofs: u32,
                mode: DiscTrackMode,
                file_path: PathBuf,
                file_offset_bytes: u64,
                data_frames: u32,
                swap_audio_on_read: bool,
            }

            let gdi_dir = path.parent().unwrap_or_else(|| Path::new("."));
            let text = fs::read_to_string(path)?;
            let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
            let track_count = lines
                .next()
                .ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` is missing its track count header",
                        path.display()
                    ))
                })?
                .parse::<usize>()
                .map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid track count header",
                        path.display()
                    ))
                })?;
            if track_count == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "gdi `{}` does not define any tracks",
                    path.display()
                )));
            }

            let mut tracks = Vec::with_capacity(track_count);
            for line in lines {
                let (number, remainder) = split_token(line).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid gdi track entry in `{}`",
                        path.display()
                    ))
                })?;
                let (physframeofs, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its physical offset",
                        path.display()
                    ))
                })?;
                let (track_type, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its track type",
                        path.display()
                    ))
                })?;
                let (sector_size, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its sector size",
                        path.display()
                    ))
                })?;
                let (name, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its filename",
                        path.display()
                    ))
                })?;
                let (file_offset, _) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its file offset",
                        path.display()
                    ))
                })?;

                let number = number.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid track number `{number}`",
                        path.display()
                    ))
                })?;
                let physframeofs = physframeofs.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid physical offset `{physframeofs}`",
                        path.display()
                    ))
                })?;
                let track_type = track_type.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid track type `{track_type}`",
                        path.display()
                    ))
                })?;
                let sector_size = sector_size.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid sector size `{sector_size}`",
                        path.display()
                    ))
                })?;
                let file_offset_bytes = file_offset.parse::<u64>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid file offset `{file_offset}`",
                        path.display()
                    ))
                })?;

                let (mode, swap_audio_on_read) = match (track_type, sector_size) {
                    (4, 2352) => (DiscTrackMode::Mode1Raw, false),
                    (4, 2048) => (DiscTrackMode::Mode1, false),
                    (0, 2352) => (DiscTrackMode::Audio, true),
                    _ => {
                        return Err(RomWeaverError::Validation(format!(
                            "gdi `{}` uses unsupported track type/sector-size pair `{track_type}/{sector_size}`",
                            path.display()
                        )));
                    }
                };

                let file_path = gdi_dir.join(name);
                let file_size = fs::metadata(&file_path)?.len();
                if file_offset_bytes > file_size {
                    return Err(RomWeaverError::Validation(format!(
                        "gdi track {} starts past the end of `{}`",
                        number,
                        file_path.display()
                    )));
                }
                let payload_bytes = file_size - file_offset_bytes;
                if payload_bytes % u64::from(sector_size) != 0 {
                    return Err(RomWeaverError::Validation(format!(
                        "gdi track {} length in `{}` is not divisible by {} bytes",
                        number,
                        file_path.display(),
                        sector_size
                    )));
                }
                let data_frames =
                    u32::try_from(payload_bytes / u64::from(sector_size)).map_err(|_| {
                        RomWeaverError::Validation(format!(
                            "gdi track {} is too large for current chd gd-rom support",
                            number
                        ))
                    })?;

                tracks.push(PendingTrack {
                    number,
                    physframeofs,
                    mode,
                    file_path,
                    file_offset_bytes,
                    data_frames,
                    swap_audio_on_read,
                });
            }

            if tracks.len() != track_count {
                return Err(RomWeaverError::Validation(format!(
                    "gdi `{}` declared {} tracks but defined {}",
                    path.display(),
                    track_count,
                    tracks.len()
                )));
            }

            tracks.sort_by_key(|track| track.number);
            for (index, track) in tracks.iter().enumerate() {
                let expected = u32::try_from(index + 1).unwrap_or(u32::MAX);
                if track.number != expected {
                    return Err(RomWeaverError::Validation(format!(
                        "gdi `{}` is missing track {}",
                        path.display(),
                        expected
                    )));
                }
            }

            let mut resolved = Vec::with_capacity(tracks.len());
            for (index, track) in tracks.iter().enumerate() {
                let next_physframeofs = tracks
                    .get(index + 1)
                    .map(|candidate| candidate.physframeofs);
                let pad_frames = next_physframeofs
                    .map(|next| {
                        next.checked_sub(track.physframeofs.saturating_add(track.data_frames))
                            .ok_or_else(|| {
                                RomWeaverError::Validation(format!(
                                    "gdi track {} overlaps the next track in `{}`",
                                    track.number,
                                    path.display()
                                ))
                            })
                    })
                    .transpose()?
                    .unwrap_or(0);

                resolved.push(DiscTrack {
                    number: track.number,
                    mode: track.mode,
                    file_path: track.file_path.clone(),
                    file_offset_bytes: track.file_offset_bytes,
                    frames: track.data_frames.saturating_add(pad_frames),
                    pregap_frames: 0,
                    postgap_frames: 0,
                    pregap_has_data: false,
                    has_subcode: false,
                    pad_frames,
                    swap_audio_on_read: track.swap_audio_on_read,
                });
            }

            Ok(DiscLayout {
                kind: DiscKind::GdRom,
                tracks: resolved,
            })
        }

        fn read_disc_tracks(&self, chd: &ChdReadSession, kind: DiscKind) -> Result<DiscLayout> {
            let mut tracks = Vec::new();
            for index in 0..99_u32 {
                let Some(metadata) = chd.read_metadata(kind.metadata_tag(), index)? else {
                    break;
                };
                let text = String::from_utf8_lossy(&metadata)
                    .trim_end_matches('\0')
                    .to_string();
                let mut number = None;
                let mut mode = None;
                let mut subtype = None;
                let mut frames = None;
                let mut pad_frames = 0_u32;
                let mut pregap = 0_u32;
                let mut pgtype = String::new();
                let mut postgap = 0_u32;

                for field in text.split_whitespace() {
                    let Some((key, value)) = field.split_once(':') else {
                        continue;
                    };
                    match key {
                        "TRACK" => number = value.parse::<u32>().ok(),
                        "TYPE" => mode = Some(self.parse_disc_mode(value)?),
                        "SUBTYPE" => subtype = Some(value.to_ascii_uppercase()),
                        "FRAMES" => frames = value.parse::<u32>().ok(),
                        "PAD" => pad_frames = value.parse::<u32>().unwrap_or(0),
                        "PREGAP" => pregap = value.parse::<u32>().unwrap_or(0),
                        "PGTYPE" => pgtype = value.to_string(),
                        "POSTGAP" => postgap = value.parse::<u32>().unwrap_or(0),
                        _ => {}
                    }
                }

                let number = number.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid cd metadata entry `{text}`: missing track number"
                    ))
                })?;
                let mode = mode.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid cd metadata entry `{text}`: missing track type"
                    ))
                })?;
                let frames = frames.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid cd metadata entry `{text}`: missing frame count"
                    ))
                })?;
                let subtype = subtype.unwrap_or_else(|| "NONE".to_string());
                tracks.push(DiscTrack {
                    number,
                    mode,
                    file_path: PathBuf::new(),
                    file_offset_bytes: 0,
                    frames,
                    pregap_frames: pregap,
                    postgap_frames: postgap,
                    pregap_has_data: pgtype.starts_with('V'),
                    has_subcode: subtype != "NONE",
                    pad_frames,
                    swap_audio_on_read: false,
                });
            }

            if tracks.is_empty() {
                return Err(RomWeaverError::Validation(
                    match kind {
                        DiscKind::CdRom => "cd chd is missing CD track metadata",
                        DiscKind::GdRom => "gd chd is missing GD track metadata",
                    }
                    .into(),
                ));
            }

            Ok(DiscLayout { kind, tracks })
        }

        fn create_temp_file_path(&self, stem: &str, extension: &str) -> PathBuf {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default();
            Self::runtime_temp_dir().join(format!(
                "rom-weaver-{stem}-{}-{timestamp}{extension}",
                Self::runtime_process_id()
            ))
        }

        fn runtime_temp_dir() -> PathBuf {
            #[cfg(target_family = "wasm")]
            {
                if let Some(path) = std::env::var_os("ROM_WEAVER_TMPDIR")
                    && !path.is_empty()
                {
                    return PathBuf::from(path);
                }

                return PathBuf::from("/tmp");
            }

            #[cfg(not(target_family = "wasm"))]
            {
                std::env::temp_dir()
            }
        }

        fn runtime_process_id() -> u32 {
            #[cfg(target_family = "wasm")]
            {
                return 1;
            }

            #[cfg(not(target_family = "wasm"))]
            {
                std::process::id()
            }
        }

        fn track_output_name(&self, stem: &str, track_number: u32) -> String {
            format!("{stem}.track{track_number:02}.bin")
        }

        fn materialize_disc_image(&self, layout: &DiscLayout) -> Result<PathBuf> {
            let temp_path = self.create_temp_file_path(
                match layout.kind {
                    DiscKind::CdRom => "cd-input",
                    DiscKind::GdRom => "gd-input",
                },
                ".bin",
            );
            let mut writer = BufWriter::new(File::create(&temp_path)?);
            let mut frame = vec![0_u8; Self::CD_FRAME_BYTES as usize];
            let zero_frame = frame.clone();

            for track in &layout.tracks {
                let mut reader = BufReader::new(File::open(&track.file_path)?);
                reader.seek(SeekFrom::Start(track.file_offset_bytes))?;
                let mut data = vec![0_u8; track.mode.data_bytes()];
                let data_frames = track.frames.saturating_sub(track.pad_frames);
                for _ in 0..data_frames {
                    reader.read_exact(&mut data)?;
                    if track.swap_audio_on_read {
                        track.mode.swap_audio_bytes(&mut data);
                    }
                    frame.fill(0);
                    frame[..data.len()].copy_from_slice(&data);
                    writer.write_all(&frame)?;
                }
                for _ in 0..track.pad_frames {
                    writer.write_all(&zero_frame)?;
                }
            }

            writer.flush()?;
            Ok(temp_path)
        }

        fn extract_cd(
            &self,
            chd: ChdReadSession,
            request: &ContainerExtractRequest,
            execution: rom_weaver_core::ThreadExecution,
        ) -> Result<OperationReport> {
            let header = chd.header();
            if header.unit_bytes != Self::CD_FRAME_BYTES {
                return Err(RomWeaverError::Validation(format!(
                    "cd chd uses {}-byte units; current extract expects {}-byte frames",
                    header.unit_bytes,
                    Self::CD_FRAME_BYTES
                )));
            }

            let layout = self.read_disc_tracks(&chd, DiscKind::CdRom)?;
            fs::create_dir_all(&request.out_dir)?;
            let stem = request
                .source
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("output");
            let cue_path = request.out_dir.join(format!("{stem}.cue"));
            let temp_path = self.create_temp_file_path("cd-extract", ".bin");
            let extract_result = chd.extract_to_file(&temp_path, execution.effective_threads);
            if extract_result.is_err() {
                let _ = fs::remove_file(&temp_path);
            }
            let _ = extract_result?;

            let first_data_bytes = layout
                .tracks
                .first()
                .map(|track| track.mode.data_bytes())
                .unwrap_or(2352);
            let natural_single_bin = layout
                .tracks
                .iter()
                .all(|track| track.mode.data_bytes() == first_data_bytes);
            let single_bin = natural_single_bin && !request.split_bin;
            let selection_requested = !request.selections.is_empty();
            let cue_name = format!("{stem}.cue");
            let mut selections = SelectionMatcher::new(&request.selections);
            let write_cue = selections.matches(&cue_name);
            let single_bin_name = format!("{stem}.bin");
            let mut write_single_bin = single_bin && selections.matches(&single_bin_name);
            let mut split_track_names = Vec::new();
            let mut write_split_tracks = Vec::new();
            if !single_bin {
                for track in &layout.tracks {
                    let track_name = self.track_output_name(stem, track.number);
                    write_split_tracks.push(selections.matches(&track_name));
                    split_track_names.push(track_name);
                }
            }
            if selection_requested && write_cue {
                let any_selected = if single_bin {
                    write_single_bin
                } else {
                    write_split_tracks.iter().any(|selected| *selected)
                };
                if !any_selected {
                    if single_bin {
                        write_single_bin = true;
                    } else {
                        for selected in &mut write_split_tracks {
                            *selected = true;
                        }
                    }
                }
            }
            selections.ensure_all_matched()?;

            let build_result: Result<(bool, Vec<PathBuf>, bool)> = (|| {
                let mut reader = BufReader::new(File::open(&temp_path)?);
                let mut frame = vec![0_u8; Self::CD_FRAME_BYTES as usize];
                let mut omitted_subcode = false;
                let mut produced_outputs = Vec::new();
                let mut cue_writer = if write_cue {
                    produced_outputs.push(cue_path.clone());
                    Some(BufWriter::new(File::create(&cue_path)?))
                } else {
                    None
                };
                let mut wrote_single_bin_output = false;

                if single_bin {
                    let bin_path = request.out_dir.join(&single_bin_name);
                    let mut bin_writer = if write_single_bin {
                        wrote_single_bin_output = true;
                        produced_outputs.push(bin_path.clone());
                        Some(BufWriter::new(File::create(&bin_path)?))
                    } else {
                        None
                    };
                    if let Some(writer) = cue_writer.as_mut() {
                        writer
                            .write_all(format!("FILE \"{single_bin_name}\" BINARY\n").as_bytes())?;
                    }
                    let mut output_frame_offset = 0_u32;
                    for track in &layout.tracks {
                        if let Some(writer) = cue_writer.as_mut() {
                            writer.write_all(
                                format!("  TRACK {:02} {}\n", track.number, track.mode.cue_label())
                                    .as_bytes(),
                            )?;
                            if track.pregap_frames > 0 && track.pregap_has_data {
                                writer.write_all(
                                    format!(
                                        "    INDEX 00 {}\n",
                                        self.format_msf(output_frame_offset)
                                    )
                                    .as_bytes(),
                                )?;
                                writer.write_all(
                                    format!(
                                        "    INDEX 01 {}\n",
                                        self.format_msf(output_frame_offset + track.pregap_frames)
                                    )
                                    .as_bytes(),
                                )?;
                            } else if track.pregap_frames > 0 {
                                writer.write_all(
                                    format!(
                                        "    PREGAP {}\n",
                                        self.format_msf(track.pregap_frames)
                                    )
                                    .as_bytes(),
                                )?;
                                writer.write_all(
                                    format!(
                                        "    INDEX 01 {}\n",
                                        self.format_msf(output_frame_offset)
                                    )
                                    .as_bytes(),
                                )?;
                            } else {
                                writer.write_all(
                                    format!(
                                        "    INDEX 01 {}\n",
                                        self.format_msf(output_frame_offset)
                                    )
                                    .as_bytes(),
                                )?;
                            }
                            if track.postgap_frames > 0 {
                                writer.write_all(
                                    format!(
                                        "    POSTGAP {}\n",
                                        self.format_msf(track.postgap_frames)
                                    )
                                    .as_bytes(),
                                )?;
                            }
                        }

                        let data_frames = track.frames.saturating_sub(track.pad_frames);
                        for _ in 0..data_frames {
                            reader.read_exact(&mut frame)?;
                            let data = &mut frame[..track.mode.data_bytes()];
                            if write_single_bin && track.has_subcode {
                                omitted_subcode = true;
                            }
                            track.mode.swap_audio_bytes(data);
                            if let Some(writer) = bin_writer.as_mut() {
                                writer.write_all(data)?;
                            }
                        }
                        for _ in 0..track.pad_frames {
                            reader.read_exact(&mut frame)?;
                        }
                        output_frame_offset = output_frame_offset.saturating_add(data_frames);
                    }
                    if let Some(writer) = bin_writer.as_mut() {
                        writer.flush()?;
                    }
                } else {
                    for (track_index, track) in layout.tracks.iter().enumerate() {
                        let track_name = &split_track_names[track_index];
                        let track_selected = write_split_tracks[track_index];
                        let track_path = request.out_dir.join(track_name);
                        if let Some(writer) = cue_writer.as_mut() {
                            if track_selected {
                                writer.write_all(
                                    format!("FILE \"{track_name}\" BINARY\n").as_bytes(),
                                )?;
                                writer.write_all(
                                    format!(
                                        "  TRACK {:02} {}\n",
                                        track.number,
                                        track.mode.cue_label()
                                    )
                                    .as_bytes(),
                                )?;
                                if track.pregap_frames > 0 && track.pregap_has_data {
                                    writer.write_all(b"    INDEX 00 00:00:00\n")?;
                                    writer.write_all(
                                        format!(
                                            "    INDEX 01 {}\n",
                                            self.format_msf(track.pregap_frames)
                                        )
                                        .as_bytes(),
                                    )?;
                                } else if track.pregap_frames > 0 {
                                    writer.write_all(
                                        format!(
                                            "    PREGAP {}\n",
                                            self.format_msf(track.pregap_frames)
                                        )
                                        .as_bytes(),
                                    )?;
                                    writer.write_all(b"    INDEX 01 00:00:00\n")?;
                                } else {
                                    writer.write_all(b"    INDEX 01 00:00:00\n")?;
                                }
                                if track.postgap_frames > 0 {
                                    writer.write_all(
                                        format!(
                                            "    POSTGAP {}\n",
                                            self.format_msf(track.postgap_frames)
                                        )
                                        .as_bytes(),
                                    )?;
                                }
                            }
                        }

                        let mut track_writer = if track_selected {
                            produced_outputs.push(track_path.clone());
                            Some(BufWriter::new(File::create(track_path)?))
                        } else {
                            None
                        };
                        let data_frames = track.frames.saturating_sub(track.pad_frames);
                        for _ in 0..data_frames {
                            reader.read_exact(&mut frame)?;
                            let data = &mut frame[..track.mode.data_bytes()];
                            if track_selected && track.has_subcode {
                                omitted_subcode = true;
                            }
                            track.mode.swap_audio_bytes(data);
                            if let Some(writer) = track_writer.as_mut() {
                                writer.write_all(data)?;
                            }
                        }
                        for _ in 0..track.pad_frames {
                            reader.read_exact(&mut frame)?;
                        }
                        if let Some(writer) = track_writer.as_mut() {
                            writer.flush()?;
                        }
                    }
                }

                if let Some(writer) = cue_writer.as_mut() {
                    writer.flush()?;
                }
                Ok((omitted_subcode, produced_outputs, wrote_single_bin_output))
            })();

            let _ = fs::remove_file(&temp_path);
            let (omitted_subcode, produced_outputs, wrote_single_bin_output) = build_result?;
            if selection_requested && produced_outputs.is_empty() {
                return Err(RomWeaverError::Validation(
                    "requested selections resolved to no extractable cd outputs".into(),
                ));
            }
            let suffix = if omitted_subcode {
                "; subcode data was omitted from cue/bin output"
            } else {
                ""
            };

            let split_bin_suffix = if request.split_bin {
                let emitted_files = produced_outputs
                    .iter()
                    .map(|path| {
                        path.strip_prefix(&request.out_dir)
                            .unwrap_or(path.as_path())
                            .to_string_lossy()
                            .replace('\\', "/")
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!("; splitbin=true emitted_files={emitted_files}")
            } else {
                String::new()
            };

            let label = if !selection_requested && wrote_single_bin_output {
                let bin_path = request.out_dir.join(&single_bin_name);
                format!(
                    "extracted `{}` to `{}` and `{}` (cd, {}){}{}",
                    request.source.display(),
                    cue_path.display(),
                    bin_path.display(),
                    self.header_codec_label(header),
                    suffix,
                    split_bin_suffix
                )
            } else if !selection_requested {
                format!(
                    "extracted `{}` to `{}` and per-track bin files (cd, {}){}{}",
                    request.source.display(),
                    cue_path.display(),
                    self.header_codec_label(header),
                    suffix,
                    split_bin_suffix
                )
            } else {
                let outputs = produced_outputs
                    .iter()
                    .map(|path| format!("`{}`", path.display()))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "extracted `{}` to selected outputs: {} (cd, {}){}{}",
                    request.source.display(),
                    outputs,
                    self.header_codec_label(header),
                    suffix,
                    split_bin_suffix
                )
            };

            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "extract",
                label,
                Some(100.0),
                Some(execution),
            ))
        }

        fn extract_gd(
            &self,
            chd: ChdReadSession,
            request: &ContainerExtractRequest,
            execution: rom_weaver_core::ThreadExecution,
        ) -> Result<OperationReport> {
            let header = chd.header();
            if header.unit_bytes != Self::CD_FRAME_BYTES {
                return Err(RomWeaverError::Validation(format!(
                    "gd chd uses {}-byte units; current extract expects {}-byte frames",
                    header.unit_bytes,
                    Self::CD_FRAME_BYTES
                )));
            }

            let layout = self.read_disc_tracks(&chd, DiscKind::GdRom)?;
            fs::create_dir_all(&request.out_dir)?;
            let stem = request
                .source
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("output");
            let gdi_path = request.out_dir.join(format!("{stem}.gdi"));
            let temp_path = self.create_temp_file_path("gd-extract", ".bin");
            let extract_result = chd.extract_to_file(&temp_path, execution.effective_threads);
            if extract_result.is_err() {
                let _ = fs::remove_file(&temp_path);
            }
            let _ = extract_result?;

            let selection_requested = !request.selections.is_empty();
            let gdi_name = format!("{stem}.gdi");
            let mut selections = SelectionMatcher::new(&request.selections);
            let write_gdi = selections.matches(&gdi_name);
            let mut track_names = Vec::with_capacity(layout.tracks.len());
            let mut write_tracks = Vec::with_capacity(layout.tracks.len());
            for track in &layout.tracks {
                let track_name = self.track_output_name(stem, track.number);
                write_tracks.push(selections.matches(&track_name));
                track_names.push(track_name);
            }
            if selection_requested && write_gdi && !write_tracks.iter().any(|selected| *selected) {
                for selected in &mut write_tracks {
                    *selected = true;
                }
            }
            selections.ensure_all_matched()?;

            let build_result: Result<(bool, Vec<PathBuf>)> = (|| {
                let mut reader = BufReader::new(File::open(&temp_path)?);
                let mut frame = vec![0_u8; Self::CD_FRAME_BYTES as usize];
                let mut omitted_subcode = false;
                let mut physframeofs = 0_u32;
                let mut produced_outputs = Vec::new();
                let mut gdi_lines = Vec::new();

                for (track_index, track) in layout.tracks.iter().enumerate() {
                    let (track_type, sector_size) = track.mode.gdi_track_descriptor()?;
                    let track_name = &track_names[track_index];
                    let track_selected = write_tracks[track_index];
                    if track_selected {
                        gdi_lines.push(format!(
                            "{} {} {} {} {} 0",
                            track.number, physframeofs, track_type, sector_size, track_name
                        ));
                    }
                    let track_path = request.out_dir.join(track_name);
                    let mut track_writer = if track_selected {
                        produced_outputs.push(track_path.clone());
                        Some(BufWriter::new(File::create(track_path)?))
                    } else {
                        None
                    };
                    let data_frames = track.frames.saturating_sub(track.pad_frames);
                    for _ in 0..data_frames {
                        reader.read_exact(&mut frame)?;
                        let data = &mut frame[..track.mode.data_bytes()];
                        if track_selected && track.has_subcode {
                            omitted_subcode = true;
                        }
                        track.mode.swap_audio_bytes(data);
                        if let Some(writer) = track_writer.as_mut() {
                            writer.write_all(data)?;
                        }
                    }
                    for _ in 0..track.pad_frames {
                        reader.read_exact(&mut frame)?;
                    }
                    if let Some(writer) = track_writer.as_mut() {
                        writer.flush()?;
                    }
                    physframeofs = physframeofs.saturating_add(track.frames);
                }

                if write_gdi {
                    let mut gdi_writer = BufWriter::new(File::create(&gdi_path)?);
                    produced_outputs.push(gdi_path.clone());
                    gdi_writer.write_all(format!("{}\n", gdi_lines.len()).as_bytes())?;
                    for line in &gdi_lines {
                        gdi_writer.write_all(line.as_bytes())?;
                        gdi_writer.write_all(b"\n")?;
                    }
                    gdi_writer.flush()?;
                }

                Ok((omitted_subcode, produced_outputs))
            })();

            let _ = fs::remove_file(&temp_path);
            let (omitted_subcode, produced_outputs) = build_result?;
            if selection_requested && produced_outputs.is_empty() {
                return Err(RomWeaverError::Validation(
                    "requested selections resolved to no extractable gd outputs".into(),
                ));
            }
            let suffix = if omitted_subcode {
                "; subcode data was omitted from gdi output"
            } else {
                ""
            };

            let label = if selection_requested {
                let outputs = produced_outputs
                    .iter()
                    .map(|path| format!("`{}`", path.display()))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "extracted `{}` to selected outputs: {} (gd, {}){}",
                    request.source.display(),
                    outputs,
                    self.header_codec_label(header),
                    suffix
                )
            } else {
                format!(
                    "extracted `{}` to `{}` and per-track gd files (gd, {}){}",
                    request.source.display(),
                    gdi_path.display(),
                    self.header_codec_label(header),
                    suffix
                )
            };

            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "extract",
                label,
                Some(100.0),
                Some(execution),
            ))
        }

        fn create_uncompressed_rust_raw(
            &self,
            input: &Path,
            output: &Path,
            logical_bytes: u64,
            create_kind: &ChdCreateKind,
        ) -> Result<ChdHeader> {
            if matches!(create_kind, ChdCreateKind::Av(_)) {
                return Err(RomWeaverError::Unsupported(
                    "rust chd create currently supports only raw/dvd/hd/disc `store` mode".into(),
                ));
            }

            let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, ChdCodec::NONE);
            let unit_bytes = self.unit_bytes(create_kind);
            if hunk_bytes == 0 || unit_bytes == 0 || hunk_bytes % unit_bytes != 0 {
                return Err(RomWeaverError::Validation(
                    "invalid CHD geometry for rust create".into(),
                ));
            }

            let hunk_count_u64 = logical_bytes.div_ceil(u64::from(hunk_bytes));
            let hunk_count = u32::try_from(hunk_count_u64).map_err(|_| {
                RomWeaverError::Validation(
                    "input is too large for CHD v5 hunk table limits".to_string(),
                )
            })?;
            let map_offset = Self::CHD_V5_HEADER_BYTES;
            let map_bytes = hunk_count_u64
                .checked_mul(4)
                .ok_or_else(|| RomWeaverError::Validation("chd map size overflow".to_string()))?;
            let after_map = map_offset.checked_add(map_bytes).ok_or_else(|| {
                RomWeaverError::Validation("chd file layout overflow".to_string())
            })?;
            let data_offset = if hunk_count == 0 {
                after_map
            } else {
                after_map.div_ceil(u64::from(hunk_bytes)) * u64::from(hunk_bytes)
            };
            let first_hunk_entry = u32::try_from(data_offset / u64::from(hunk_bytes))
                .map_err(|_| RomWeaverError::Validation("chd map entry overflow".to_string()))?;

            let mut output_file = File::options()
                .create(true)
                .write(true)
                .read(true)
                .truncate(true)
                .open(output)
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to create `{}`: {error}",
                        output.display()
                    ))
                })?;

            let header = self.build_chd_v5_header(
                logical_bytes,
                map_offset,
                hunk_bytes,
                unit_bytes,
                [ChdCodec::NONE; CHD_MAX_COMPRESSORS],
            );
            output_file.write_all(&header).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to write CHD header to `{}`: {error}",
                    output.display()
                ))
            })?;

            for hunk_index in 0..hunk_count {
                let entry = first_hunk_entry
                    .checked_add(hunk_index)
                    .ok_or_else(|| RomWeaverError::Validation("chd map entry overflow".into()))?;
                output_file
                    .write_all(&entry.to_be_bytes())
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to write CHD map to `{}`: {error}",
                            output.display()
                        ))
                    })?;
            }

            let mut pad_bytes = data_offset.saturating_sub(after_map);
            if pad_bytes > 0 {
                let padding = [0_u8; 8192];
                while pad_bytes > 0 {
                    let write_len =
                        usize::try_from(pad_bytes.min(padding.len() as u64)).map_err(|_| {
                            RomWeaverError::Validation("chd alignment padding overflow".to_string())
                        })?;
                    output_file
                        .write_all(&padding[..write_len])
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "failed to write CHD alignment padding to `{}`: {error}",
                                output.display()
                            ))
                        })?;
                    pad_bytes -= write_len as u64;
                }
            }

            let mut reader = BufReader::new(File::open(input).map_err(|error| {
                RomWeaverError::Validation(format!("failed to open `{}`: {error}", input.display()))
            })?);
            let mut buffer = vec![0_u8; usize::try_from(hunk_bytes).unwrap_or(4096)];
            let mut remaining = logical_bytes;
            for _ in 0..hunk_count {
                buffer.fill(0);
                let read_len =
                    usize::try_from(remaining.min(u64::from(hunk_bytes))).map_err(|_| {
                        RomWeaverError::Validation(
                            "decoded CHD chunk exceeded addressable memory".to_string(),
                        )
                    })?;
                reader
                    .read_exact(&mut buffer[..read_len])
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to read source `{}`: {error}",
                            input.display()
                        ))
                    })?;
                output_file.write_all(&buffer).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD data to `{}`: {error}",
                        output.display()
                    ))
                })?;
                remaining = remaining.saturating_sub(read_len as u64);
            }
            let metadata_entries = self.rust_metadata_entries(create_kind)?;
            if let Some(meta_offset) =
                self.append_rust_metadata(&mut output_file, output, &metadata_entries)?
            {
                self.patch_chd_header_u64(
                    &mut output_file,
                    output,
                    Self::CHD_V5_HEADER_META_OFFSET,
                    meta_offset,
                    "metadata",
                )?;
            }
            self.patch_chd_header_sha1s(
                &mut output_file,
                output,
                input,
                logical_bytes,
                &metadata_entries,
            )?;
            output_file.flush().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to flush `{}`: {error}",
                    output.display()
                ))
            })?;

            Ok(ChdHeader {
                version: 5,
                logical_bytes,
                hunk_bytes,
                hunk_count,
                unit_bytes,
                unit_count: logical_bytes.div_ceil(u64::from(unit_bytes)),
                compressed: false,
                compression: [ChdCodec::NONE; CHD_MAX_COMPRESSORS],
            })
        }

        fn create_compressed_rust_raw(
            &self,
            input: &Path,
            output: &Path,
            logical_bytes: u64,
            create_kind: &ChdCreateKind,
            codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
            compression_level: i32,
            thread_count: usize,
        ) -> Result<ChdHeader> {
            let mut active_codecs = Vec::new();
            for (index, codec) in codecs.into_iter().enumerate() {
                if codec == ChdCodec::NONE {
                    break;
                }
                if !self.supports_rust_create_codec(create_kind, codec) {
                    return Err(RomWeaverError::Unsupported(format!(
                        "rust chd compressed create does not support codec `{}` for {} media",
                        self.codec_label(codec),
                        self.media_label(self.media_kind_from_create_kind(create_kind))
                    )));
                }
                active_codecs.push((index as u8, codec));
            }
            if active_codecs.is_empty() {
                return Err(RomWeaverError::Validation(
                    "compressed rust CHD create requires at least one codec".to_string(),
                ));
            }
            let primary_codec = active_codecs[0].1;

            let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, primary_codec);
            let unit_bytes = self.unit_bytes(create_kind);
            if hunk_bytes == 0 || unit_bytes == 0 || hunk_bytes % unit_bytes != 0 {
                return Err(RomWeaverError::Validation(
                    "invalid CHD geometry for rust compressed create".into(),
                ));
            }

            let hunk_count_u64 = logical_bytes.div_ceil(u64::from(hunk_bytes));
            let hunk_count = u32::try_from(hunk_count_u64).map_err(|_| {
                RomWeaverError::Validation(
                    "input is too large for CHD v5 hunk table limits".to_string(),
                )
            })?;
            let hunk_count_usize = usize::try_from(hunk_count_u64).map_err(|_| {
                RomWeaverError::Validation("CHD hunk count exceeded addressable memory".to_string())
            })?;
            let hunk_bytes_usize = usize::try_from(hunk_bytes).map_err(|_| {
                RomWeaverError::Validation("CHD hunk size exceeded addressable memory".to_string())
            })?;

            let mut output_file = File::options()
                .create(true)
                .write(true)
                .read(true)
                .truncate(true)
                .open(output)
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to create `{}`: {error}",
                        output.display()
                    ))
                })?;
            let placeholder_header =
                self.build_chd_v5_header(logical_bytes, 0, hunk_bytes, unit_bytes, codecs);
            output_file
                .write_all(&placeholder_header)
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD header to `{}`: {error}",
                        output.display()
                    ))
                })?;

            let mut source = BufReader::new(File::open(input).map_err(|error| {
                RomWeaverError::Validation(format!("failed to open `{}`: {error}", input.display()))
            })?);
            let effective_threads = thread_count.max(1).min(hunk_count_usize.max(1));
            let pool = if effective_threads > 1 {
                Some(
                    rayon::ThreadPoolBuilder::new()
                        .num_threads(effective_threads)
                        .build()
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "failed to build CHD rust create pool (threads={}): {error}",
                                effective_threads
                            ))
                        })?,
                )
            } else {
                None
            };
            let batch_size = effective_threads.saturating_mul(4).max(1);
            let mut entries = Vec::with_capacity(hunk_count_usize);
            let mut remaining = logical_bytes;
            let mut current_offset = Self::CHD_V5_HEADER_BYTES;
            let mut next_hunk = 0usize;
            while next_hunk < hunk_count_usize {
                let this_batch = (hunk_count_usize - next_hunk).min(batch_size);
                let mut raw_hunks = Vec::with_capacity(this_batch);
                for _ in 0..this_batch {
                    let mut hunk = vec![0_u8; hunk_bytes_usize];
                    let read_len =
                        usize::try_from(remaining.min(u64::from(hunk_bytes))).map_err(|_| {
                            RomWeaverError::Validation(
                                "decoded CHD chunk exceeded addressable memory".to_string(),
                            )
                        })?;
                    source.read_exact(&mut hunk[..read_len]).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to read source `{}`: {error}",
                            input.display()
                        ))
                    })?;
                    remaining = remaining.saturating_sub(read_len as u64);
                    raw_hunks.push(hunk);
                }

                let compressed_hunks: Vec<Result<(u8, Vec<u8>, u16)>> = if let Some(pool) = &pool {
                    pool.install(|| {
                        raw_hunks
                            .into_par_iter()
                            .map(|hunk| {
                                let crc = Self::crc16_ibm3740(&hunk);
                                let mut best: Option<(u8, Vec<u8>)> = None;
                                for (codec_slot, codec) in &active_codecs {
                                    let compressed = self.compress_rust_hunk(
                                        create_kind,
                                        *codec,
                                        compression_level,
                                        &hunk,
                                    )?;
                                    if best
                                        .as_ref()
                                        .map(|(_, candidate)| compressed.len() < candidate.len())
                                        .unwrap_or(true)
                                    {
                                        best = Some((*codec_slot, compressed));
                                    }
                                }
                                let (compression_type, payload) = best
                                    .filter(|(_, compressed)| compressed.len() < hunk.len())
                                    .unwrap_or((Self::CHD_V5_MAP_TYPE_UNCOMPRESSED, hunk));
                                Ok((compression_type, payload, crc))
                            })
                            .collect()
                    })
                } else {
                    raw_hunks
                        .into_iter()
                        .map(|hunk| {
                            let crc = Self::crc16_ibm3740(&hunk);
                            let mut best: Option<(u8, Vec<u8>)> = None;
                            for (codec_slot, codec) in &active_codecs {
                                let compressed = self.compress_rust_hunk(
                                    create_kind,
                                    *codec,
                                    compression_level,
                                    &hunk,
                                )?;
                                if best
                                    .as_ref()
                                    .map(|(_, candidate)| compressed.len() < candidate.len())
                                    .unwrap_or(true)
                                {
                                    best = Some((*codec_slot, compressed));
                                }
                            }
                            let (compression_type, payload) = best
                                .filter(|(_, compressed)| compressed.len() < hunk.len())
                                .unwrap_or((Self::CHD_V5_MAP_TYPE_UNCOMPRESSED, hunk));
                            Ok((compression_type, payload, crc))
                        })
                        .collect()
                };

                for result in compressed_hunks {
                    let (compression_type, compressed, crc16) = result?;
                    let length = u32::try_from(compressed.len()).map_err(|_| {
                        RomWeaverError::Validation("compressed CHD chunk exceeded u32 size".into())
                    })?;
                    if length > 0x00FF_FFFF {
                        return Err(RomWeaverError::Validation(format!(
                            "compressed CHD chunk length {length} exceeds v5 map limit"
                        )));
                    }
                    output_file.write_all(&compressed).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to write CHD data to `{}`: {error}",
                            output.display()
                        ))
                    })?;
                    entries.push(RustCompressedHunkEntry {
                        compression_type,
                        offset: current_offset,
                        length,
                        crc16,
                    });
                    current_offset = current_offset.saturating_add(u64::from(length));
                }
                next_hunk += this_batch;
            }

            let map_offset = current_offset;
            let (map_payload, map_crc, length_bits, first_offset) =
                Self::encode_v5_compressed_map(&entries)?;
            let map_bytes = u32::try_from(map_payload.len()).map_err(|_| {
                RomWeaverError::Validation("compressed CHD map exceeded u32 size".to_string())
            })?;
            let mut map_header = [0_u8; 16];
            map_header[..4].copy_from_slice(&map_bytes.to_be_bytes());
            Self::write_u48_be(&mut map_header[4..10], first_offset)?;
            map_header[10..12].copy_from_slice(&map_crc.to_be_bytes());
            map_header[12] = length_bits;
            map_header[13] = 0;
            map_header[14] = 0;
            map_header[15] = 0;
            output_file.write_all(&map_header).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to write CHD map header to `{}`: {error}",
                    output.display()
                ))
            })?;
            output_file.write_all(&map_payload).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to write CHD map payload to `{}`: {error}",
                    output.display()
                ))
            })?;

            self.patch_chd_header_u64(
                &mut output_file,
                output,
                Self::CHD_V5_HEADER_MAP_OFFSET,
                map_offset,
                "map",
            )?;
            let metadata_entries = self.rust_metadata_entries(create_kind)?;
            if let Some(meta_offset) =
                self.append_rust_metadata(&mut output_file, output, &metadata_entries)?
            {
                self.patch_chd_header_u64(
                    &mut output_file,
                    output,
                    Self::CHD_V5_HEADER_META_OFFSET,
                    meta_offset,
                    "metadata",
                )?;
            }
            self.patch_chd_header_sha1s(
                &mut output_file,
                output,
                input,
                logical_bytes,
                &metadata_entries,
            )?;
            output_file.flush().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to flush `{}`: {error}",
                    output.display()
                ))
            })?;

            Ok(ChdHeader {
                version: 5,
                logical_bytes,
                hunk_bytes,
                hunk_count,
                unit_bytes,
                unit_count: logical_bytes.div_ceil(u64::from(unit_bytes)),
                compressed: true,
                compression: codecs,
            })
        }

        fn build_chd_v5_header(
            &self,
            logical_bytes: u64,
            map_offset: u64,
            hunk_bytes: u32,
            unit_bytes: u32,
            codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
        ) -> [u8; Self::CHD_V5_HEADER_BYTES as usize] {
            let mut header = [0_u8; Self::CHD_V5_HEADER_BYTES as usize];
            header[0..8].copy_from_slice(&CHD_SIGNATURE);
            header[8..12].copy_from_slice(&(Self::CHD_V5_HEADER_BYTES as u32).to_be_bytes());
            header[12..16].copy_from_slice(&5_u32.to_be_bytes());
            header[16..20].copy_from_slice(&codecs[0].raw().to_be_bytes());
            header[20..24].copy_from_slice(&codecs[1].raw().to_be_bytes());
            header[24..28].copy_from_slice(&codecs[2].raw().to_be_bytes());
            header[28..32].copy_from_slice(&codecs[3].raw().to_be_bytes());
            header[32..40].copy_from_slice(&logical_bytes.to_be_bytes());
            header[40..48].copy_from_slice(&map_offset.to_be_bytes());
            header[48..56].copy_from_slice(&0_u64.to_be_bytes());
            header[56..60].copy_from_slice(&hunk_bytes.to_be_bytes());
            header[60..64].copy_from_slice(&unit_bytes.to_be_bytes());
            header
        }

        fn compress_rust_hunk(
            &self,
            create_kind: &ChdCreateKind,
            primary_codec: ChdCodec,
            compression_level: i32,
            hunk: &[u8],
        ) -> Result<Vec<u8>> {
            if matches!(create_kind, ChdCreateKind::Disc(_)) {
                return self.compress_rust_cd_hunk(primary_codec, compression_level, hunk);
            }
            match primary_codec {
                ChdCodec::ZSTD => zstd_compress(hunk, compression_level).map_err(|error| {
                    RomWeaverError::Validation(format!("zstd compression failed: {error}"))
                }),
                ChdCodec::ZLIB => {
                    let compression = if compression_level <= 0 {
                        GzipCompression::default()
                    } else {
                        GzipCompression::new(compression_level.clamp(1, 9) as u32)
                    };
                    let mut encoder = DeflateEncoder::new(Vec::new(), compression);
                    encoder.write_all(hunk).map_err(|error| {
                        RomWeaverError::Validation(format!("zlib compression failed: {error}"))
                    })?;
                    encoder.finish().map_err(|error| {
                        RomWeaverError::Validation(format!("zlib compression failed: {error}"))
                    })
                }
                ChdCodec::LZMA => {
                    let lzma_level = if compression_level <= 0 {
                        9
                    } else {
                        compression_level as u32
                    }
                    .min(9);
                    let mut options = LzmaOptions::with_preset(lzma_level);
                    options.lc = 3;
                    options.lp = 0;
                    options.pb = 2;
                    options.dict_size = Self::chd_lzma_dict_size(lzma_level, hunk.len() as u32);
                    let mut compressed = Vec::new();
                    let mut writer = LzmaWriter::new_no_header(&mut compressed, &options, false)
                        .map_err(|error| {
                            RomWeaverError::Validation(format!("lzma compression failed: {error}"))
                        })?;
                    writer.write_all(hunk).map_err(|error| {
                        RomWeaverError::Validation(format!("lzma compression failed: {error}"))
                    })?;
                    writer.finish().map_err(|error| {
                        RomWeaverError::Validation(format!("lzma compression failed: {error}"))
                    })?;
                    Ok(compressed)
                }
                other => Err(RomWeaverError::Unsupported(format!(
                    "rust chd compressed create does not support codec `{}` for this media mode",
                    self.codec_label(other)
                ))),
            }
        }

        fn compress_rust_cd_hunk(
            &self,
            primary_codec: ChdCodec,
            compression_level: i32,
            hunk: &[u8],
        ) -> Result<Vec<u8>> {
            let frame_bytes = usize::try_from(Self::CD_FRAME_BYTES).map_err(|_| {
                RomWeaverError::Validation("invalid CD frame size for rust CHD encoder".to_string())
            })?;
            if frame_bytes != Self::CD_SECTOR_DATA_BYTES + Self::CD_SUBCODE_BYTES {
                return Err(RomWeaverError::Validation(
                    "unexpected CD frame layout for rust CHD encoder".to_string(),
                ));
            }
            if hunk.len() % frame_bytes != 0 {
                return Err(RomWeaverError::Validation(
                    "cd hunk size must be a multiple of frame size".to_string(),
                ));
            }

            let frame_count = hunk.len() / frame_bytes;
            let mut sectors = Vec::with_capacity(frame_count * Self::CD_SECTOR_DATA_BYTES);
            let mut subcode = Vec::with_capacity(frame_count * Self::CD_SUBCODE_BYTES);
            for frame in hunk.chunks_exact(frame_bytes) {
                sectors.extend_from_slice(&frame[..Self::CD_SECTOR_DATA_BYTES]);
                subcode.extend_from_slice(
                    &frame[Self::CD_SECTOR_DATA_BYTES
                        ..Self::CD_SECTOR_DATA_BYTES + Self::CD_SUBCODE_BYTES],
                );
            }

            let sector_stream = match primary_codec {
                ChdCodec::CD_ZSTD => {
                    zstd_compress(&sectors, compression_level).map_err(|error| {
                        RomWeaverError::Validation(format!("cd zstd compression failed: {error}"))
                    })?
                }
                ChdCodec::CD_ZLIB => {
                    let compression = if compression_level <= 0 {
                        GzipCompression::default()
                    } else {
                        GzipCompression::new(compression_level.clamp(1, 9) as u32)
                    };
                    let mut encoder = DeflateEncoder::new(Vec::new(), compression);
                    encoder.write_all(&sectors).map_err(|error| {
                        RomWeaverError::Validation(format!("cd zlib compression failed: {error}"))
                    })?;
                    encoder.finish().map_err(|error| {
                        RomWeaverError::Validation(format!("cd zlib compression failed: {error}"))
                    })?
                }
                ChdCodec::CD_LZMA => {
                    let lzma_level = if compression_level <= 0 {
                        9
                    } else {
                        compression_level as u32
                    }
                    .min(9);
                    let mut options = LzmaOptions::with_preset(lzma_level);
                    options.lc = 3;
                    options.lp = 0;
                    options.pb = 2;
                    options.dict_size = Self::chd_lzma_dict_size(lzma_level, sectors.len() as u32);
                    let mut compressed = Vec::new();
                    let mut writer = LzmaWriter::new_no_header(&mut compressed, &options, false)
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "cd lzma compression failed: {error}"
                            ))
                        })?;
                    writer.write_all(&sectors).map_err(|error| {
                        RomWeaverError::Validation(format!("cd lzma compression failed: {error}"))
                    })?;
                    writer.finish().map_err(|error| {
                        RomWeaverError::Validation(format!("cd lzma compression failed: {error}"))
                    })?;
                    compressed
                }
                other => {
                    return Err(RomWeaverError::Unsupported(format!(
                        "rust chd compressed create does not support codec `{}` for disc media",
                        self.codec_label(other)
                    )));
                }
            };
            let sector_len_u32 = u32::try_from(sector_stream.len()).map_err(|_| {
                RomWeaverError::Validation("cd sector stream size exceeded u32".to_string())
            })?;

            let subcode_stream = match primary_codec {
                ChdCodec::CD_ZSTD => {
                    zstd_compress(&subcode, compression_level).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "cd subcode zstd compression failed: {error}"
                        ))
                    })?
                }
                ChdCodec::CD_ZLIB | ChdCodec::CD_LZMA => {
                    let mut encoder = DeflateEncoder::new(Vec::new(), GzipCompression::default());
                    encoder.write_all(&subcode).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "cd subcode zlib compression failed: {error}"
                        ))
                    })?;
                    encoder.finish().map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "cd subcode zlib compression failed: {error}"
                        ))
                    })?
                }
                _ => Vec::new(),
            };

            let ecc_bytes = frame_count.div_ceil(8);
            let comp_len_bytes = if hunk.len() < 65_536 { 2 } else { 3 };
            let mut output = Vec::with_capacity(
                ecc_bytes + comp_len_bytes + sector_stream.len() + subcode_stream.len(),
            );
            output.resize(ecc_bytes + comp_len_bytes, 0);
            if comp_len_bytes == 2 {
                if sector_len_u32 > 0xFFFF {
                    return Err(RomWeaverError::Validation(
                        "cd sector stream too large for short header length".to_string(),
                    ));
                }
                output[ecc_bytes] = ((sector_len_u32 >> 8) & 0xFF) as u8;
                output[ecc_bytes + 1] = (sector_len_u32 & 0xFF) as u8;
            } else {
                if sector_len_u32 > 0x00FF_FFFF {
                    return Err(RomWeaverError::Validation(
                        "cd sector stream too large for extended header length".to_string(),
                    ));
                }
                output[ecc_bytes] = ((sector_len_u32 >> 16) & 0xFF) as u8;
                output[ecc_bytes + 1] = ((sector_len_u32 >> 8) & 0xFF) as u8;
                output[ecc_bytes + 2] = (sector_len_u32 & 0xFF) as u8;
            }
            output.extend_from_slice(&sector_stream);
            output.extend_from_slice(&subcode_stream);
            Ok(output)
        }

        fn chd_lzma_dict_size(level: u32, reduce_size: u32) -> u32 {
            let mut dict_size = if level <= 5 {
                1 << (level * 2 + 14)
            } else if level <= 7 {
                1 << 25
            } else {
                1 << 26
            };

            if dict_size > reduce_size {
                for i in 11..=30 {
                    if reduce_size <= (2_u32 << i) {
                        dict_size = 2_u32 << i;
                        break;
                    }
                    if reduce_size <= (3_u32 << i) {
                        dict_size = 3_u32 << i;
                        break;
                    }
                }
            }
            dict_size
        }

        fn encode_v5_compressed_map(
            entries: &[RustCompressedHunkEntry],
        ) -> Result<(Vec<u8>, u16, u8, u64)> {
            let mut raw_map = vec![0_u8; entries.len().saturating_mul(12)];
            for (index, entry) in entries.iter().enumerate() {
                let offset = index.saturating_mul(12);
                raw_map[offset] = entry.compression_type;
                Self::write_u24_be(&mut raw_map[offset + 1..offset + 4], entry.length)?;
                Self::write_u48_be(&mut raw_map[offset + 4..offset + 10], entry.offset)?;
                raw_map[offset + 10..offset + 12].copy_from_slice(&entry.crc16.to_be_bytes());
            }
            let map_crc = Self::crc16_ibm3740(&raw_map);
            let length_bits = Self::bits_for_value(
                entries
                    .iter()
                    .map(|entry| entry.length)
                    .max()
                    .unwrap_or_default(),
            );
            let first_offset = entries.first().map(|entry| entry.offset).unwrap_or(0);
            let max_compression_type = entries
                .iter()
                .map(|entry| entry.compression_type)
                .max()
                .unwrap_or(0);
            if max_compression_type > Self::CHD_V5_MAP_TYPE_UNCOMPRESSED {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported compressed CHD map type {} for rust map encoder",
                    max_compression_type
                )));
            }
            let symbol_bit_lengths =
                Self::map_symbol_bit_lengths_for_max_type(max_compression_type)?;
            let symbol_codes = Self::canonical_huffman_codes(&symbol_bit_lengths)?;

            let mut bit_writer = MsbBitWriter::new();
            Self::write_map_symbol_tree_rle(&mut bit_writer, &symbol_bit_lengths)?;

            for entry in entries {
                let (bits, bit_count) = symbol_codes[usize::from(entry.compression_type)]
                    .ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "missing map huffman code for compression type {}",
                            entry.compression_type
                        ))
                    })?;
                bit_writer.write_bits(u64::from(bits), bit_count);
            }

            for entry in entries {
                if entry.compression_type <= Self::CHD_V5_MAP_TYPE_COMPRESSED_MAX {
                    bit_writer.write_bits(u64::from(entry.length), length_bits);
                }
                bit_writer.write_bits(u64::from(entry.crc16), 16);
            }
            Ok((bit_writer.finish(), map_crc, length_bits, first_offset))
        }

        fn map_symbol_bit_lengths_for_max_type(max_type: u8) -> Result<[u8; 16]> {
            let mut lengths = [0_u8; 16];
            match max_type {
                0 => {
                    lengths[0] = 1;
                }
                1 => {
                    lengths[0] = 1;
                    lengths[1] = 1;
                }
                2 => {
                    lengths[0] = 1;
                    lengths[1] = 2;
                    lengths[2] = 2;
                }
                3 => {
                    lengths[0] = 2;
                    lengths[1] = 2;
                    lengths[2] = 2;
                    lengths[3] = 2;
                }
                4 => {
                    lengths[0] = 2;
                    lengths[1] = 2;
                    lengths[2] = 2;
                    lengths[3] = 3;
                    lengths[4] = 3;
                }
                _ => {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported compressed CHD map type {max_type} for rust map encoder"
                    )));
                }
            }
            Ok(lengths)
        }

        fn canonical_huffman_codes(lengths: &[u8; 16]) -> Result<[Option<(u32, u8)>; 16]> {
            let mut histogram = [0_u32; 33];
            for &length in lengths {
                if usize::from(length) >= histogram.len() {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported CHD map huffman bit length {}",
                        length
                    )));
                }
                histogram[length as usize] = histogram[length as usize].saturating_add(1);
            }

            let mut curr_start = 0_u32;
            for code_len in (1..histogram.len()).rev() {
                let next_start = (curr_start + histogram[code_len]) >> 1;
                if code_len != 1 && next_start.saturating_mul(2) != curr_start + histogram[code_len]
                {
                    return Err(RomWeaverError::Validation(
                        "invalid CHD map huffman length distribution".to_string(),
                    ));
                }
                histogram[code_len] = curr_start;
                curr_start = next_start;
            }

            let mut codes = [None; 16];
            for (index, &length) in lengths.iter().enumerate() {
                if length == 0 {
                    continue;
                }
                let start = &mut histogram[length as usize];
                codes[index] = Some((*start, length));
                *start = start.saturating_add(1);
            }
            Ok(codes)
        }

        fn write_map_symbol_tree_rle(
            bit_writer: &mut MsbBitWriter,
            lengths: &[u8; 16],
        ) -> Result<()> {
            let mut index = 0usize;
            while index < lengths.len() {
                let value = lengths[index];
                let mut run_len = 1usize;
                while index + run_len < lengths.len()
                    && lengths[index + run_len] == value
                    && run_len < 18
                {
                    run_len += 1;
                }

                if value != 1 && run_len >= 3 {
                    bit_writer.write_bits(1, 4);
                    bit_writer.write_bits(u64::from(value), 4);
                    bit_writer.write_bits(u64::try_from(run_len - 3).unwrap_or(0), 4);
                    index += run_len;
                    continue;
                }

                for _ in 0..run_len {
                    if value == 1 {
                        bit_writer.write_bits(1, 4);
                        bit_writer.write_bits(1, 4);
                    } else {
                        bit_writer.write_bits(u64::from(value), 4);
                    }
                }
                index += run_len;
            }
            Ok(())
        }

        fn write_u24_be(dst: &mut [u8], value: u32) -> Result<()> {
            if dst.len() < 3 {
                return Err(RomWeaverError::Validation(
                    "internal CHD map write buffer underflow".into(),
                ));
            }
            if value > 0x00FF_FFFF {
                return Err(RomWeaverError::Validation(format!(
                    "value {value} exceeds u24 range"
                )));
            }
            dst[0] = ((value >> 16) & 0xFF) as u8;
            dst[1] = ((value >> 8) & 0xFF) as u8;
            dst[2] = (value & 0xFF) as u8;
            Ok(())
        }

        fn write_u48_be(dst: &mut [u8], value: u64) -> Result<()> {
            if dst.len() < 6 {
                return Err(RomWeaverError::Validation(
                    "internal CHD map write buffer underflow".into(),
                ));
            }
            if value > 0x0000_FFFF_FFFF_FFFF {
                return Err(RomWeaverError::Validation(format!(
                    "value {value} exceeds u48 range"
                )));
            }
            dst[0] = ((value >> 40) & 0xFF) as u8;
            dst[1] = ((value >> 32) & 0xFF) as u8;
            dst[2] = ((value >> 24) & 0xFF) as u8;
            dst[3] = ((value >> 16) & 0xFF) as u8;
            dst[4] = ((value >> 8) & 0xFF) as u8;
            dst[5] = (value & 0xFF) as u8;
            Ok(())
        }

        fn bits_for_value(value: u32) -> u8 {
            if value == 0 {
                0
            } else {
                (u32::BITS - value.leading_zeros()) as u8
            }
        }

        fn crc16_ibm3740(bytes: &[u8]) -> u16 {
            let mut crc = 0xFFFFu16;
            for &byte in bytes {
                crc ^= u16::from(byte) << 8;
                for _ in 0..8 {
                    if (crc & 0x8000) != 0 {
                        crc = (crc << 1) ^ 0x1021;
                    } else {
                        crc <<= 1;
                    }
                }
            }
            crc
        }

        fn rust_metadata_entries(
            &self,
            create_kind: &ChdCreateKind,
        ) -> Result<Vec<RustMetadataEntry>> {
            match create_kind {
                ChdCreateKind::Raw => Ok(Vec::new()),
                ChdCreateKind::Dvd => Ok(vec![RustMetadataEntry {
                    tag: DVD_METADATA_TAG,
                    flags: CHD_METADATA_FLAG_CHECKSUM,
                    data: vec![0],
                }]),
                ChdCreateKind::HardDisk(geometry) => {
                    let mut metadata = format!(
                        "CYLS:{},HEADS:{},SECS:{},BPS:{}",
                        geometry.cylinders,
                        geometry.heads,
                        geometry.sectors,
                        geometry.bytes_per_sector
                    )
                    .into_bytes();
                    metadata.push(0);
                    Ok(vec![RustMetadataEntry {
                        tag: HARD_DISK_METADATA_TAG,
                        flags: CHD_METADATA_FLAG_CHECKSUM,
                        data: metadata,
                    }])
                }
                ChdCreateKind::Disc(layout) => {
                    let mut entries = Vec::with_capacity(layout.tracks.len());
                    for track in &layout.tracks {
                        let pgtype = if track.pregap_has_data {
                            format!("V{}", track.mode.metadata_label())
                        } else {
                            track.mode.metadata_label().to_string()
                        };
                        let mut data = match layout.kind {
                            DiscKind::CdRom => format!(
                                "TRACK:{} TYPE:{} SUBTYPE:NONE FRAMES:{} PREGAP:{} PGTYPE:{} PGSUB:NONE POSTGAP:{}",
                                track.number,
                                track.mode.metadata_label(),
                                track.frames,
                                track.pregap_frames,
                                pgtype,
                                track.postgap_frames
                            ),
                            DiscKind::GdRom => format!(
                                "TRACK:{} TYPE:{} SUBTYPE:NONE FRAMES:{} PAD:{} PREGAP:{} PGTYPE:{} PGSUB:NONE POSTGAP:{}",
                                track.number,
                                track.mode.metadata_label(),
                                track.frames,
                                track.pad_frames,
                                track.pregap_frames,
                                pgtype,
                                track.postgap_frames
                            ),
                        }
                        .into_bytes();
                        data.push(0);
                        entries.push(RustMetadataEntry {
                            tag: layout.kind.metadata_tag(),
                            flags: CHD_METADATA_FLAG_CHECKSUM,
                            data,
                        });
                    }
                    Ok(entries)
                }
                ChdCreateKind::Av(profile) => {
                    let mut metadata = format!(
                        "FPS:{}.{:06} WIDTH:{} HEIGHT:{} INTERLACED:{} CHANNELS:{} SAMPLERATE:{}",
                        profile.fps,
                        profile.fpsfrac,
                        profile.width,
                        profile.height,
                        profile.interlaced,
                        profile.channels,
                        profile.sample_rate
                    )
                    .into_bytes();
                    metadata.push(0);
                    Ok(vec![RustMetadataEntry {
                        tag: AV_METADATA_TAG,
                        flags: CHD_METADATA_FLAG_CHECKSUM,
                        data: metadata,
                    }])
                }
            }
        }

        fn append_rust_metadata(
            &self,
            output_file: &mut File,
            output_path: &Path,
            entries: &[RustMetadataEntry],
        ) -> Result<Option<u64>> {
            if entries.is_empty() {
                return Ok(None);
            }

            let mut entry_offsets = Vec::with_capacity(entries.len());
            for entry in entries {
                if entry.data.is_empty() || entry.data.len() >= 16 * 1024 * 1024 {
                    return Err(RomWeaverError::Validation(
                        "CHD metadata entries must be 1..16MiB".to_string(),
                    ));
                }
                let offset = output_file.stream_position().map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to determine metadata offset in `{}`: {error}",
                        output_path.display()
                    ))
                })?;
                entry_offsets.push(offset);

                let mut header = [0_u8; 16];
                header[..4].copy_from_slice(&entry.tag.to_be_bytes());
                header[4] = entry.flags;
                Self::write_u24_be(
                    &mut header[5..8],
                    u32::try_from(entry.data.len()).map_err(|_| {
                        RomWeaverError::Validation("metadata length overflow".to_string())
                    })?,
                )?;
                output_file.write_all(&header).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD metadata header to `{}`: {error}",
                        output_path.display()
                    ))
                })?;
                output_file.write_all(&entry.data).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD metadata payload to `{}`: {error}",
                        output_path.display()
                    ))
                })?;
            }

            for (index, offset) in entry_offsets.iter().enumerate() {
                let next = entry_offsets.get(index + 1).copied().unwrap_or(0);
                output_file
                    .seek(SeekFrom::Start(offset.saturating_add(8)))
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to seek CHD metadata link in `{}`: {error}",
                            output_path.display()
                        ))
                    })?;
                output_file
                    .write_all(&next.to_be_bytes())
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to write CHD metadata link in `{}`: {error}",
                            output_path.display()
                        ))
                    })?;
            }
            let end = output_file.seek(SeekFrom::End(0)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to restore CHD output offset in `{}`: {error}",
                    output_path.display()
                ))
            })?;
            let first = entry_offsets[0];
            if end < first {
                return Err(RomWeaverError::Validation(
                    "invalid CHD metadata layout".to_string(),
                ));
            }
            Ok(Some(first))
        }

        fn patch_chd_header_sha1s(
            &self,
            output_file: &mut File,
            output_path: &Path,
            source_path: &Path,
            logical_bytes: u64,
            metadata_entries: &[RustMetadataEntry],
        ) -> Result<()> {
            let raw_sha1 = Self::sha1_file_prefix(source_path, logical_bytes)?;
            let overall_sha1 = Self::compute_overall_sha1(&raw_sha1, metadata_entries);
            self.patch_chd_header_bytes(
                output_file,
                output_path,
                Self::CHD_V5_HEADER_RAW_SHA1_OFFSET,
                &raw_sha1,
                "raw sha1",
            )?;
            self.patch_chd_header_bytes(
                output_file,
                output_path,
                Self::CHD_V5_HEADER_SHA1_OFFSET,
                &overall_sha1,
                "sha1",
            )
        }

        fn compute_overall_sha1(
            raw_sha1: &[u8; Self::CHD_SHA1_BYTES],
            metadata_entries: &[RustMetadataEntry],
        ) -> [u8; Self::CHD_SHA1_BYTES] {
            let mut metadata_hashes = metadata_entries
                .iter()
                .filter(|entry| (entry.flags & CHD_METADATA_FLAG_CHECKSUM) != 0)
                .map(|entry| {
                    let mut hash_entry = [0_u8; 4 + Self::CHD_SHA1_BYTES];
                    hash_entry[..4].copy_from_slice(&entry.tag.to_be_bytes());
                    let digest = Sha1::digest(&entry.data);
                    hash_entry[4..].copy_from_slice(&digest);
                    hash_entry
                })
                .collect::<Vec<_>>();
            metadata_hashes.sort_unstable();

            let mut overall_sha1 = Sha1::new();
            overall_sha1.update(raw_sha1);
            for hash_entry in metadata_hashes {
                overall_sha1.update(hash_entry);
            }
            let digest = overall_sha1.finalize();
            let mut out = [0_u8; Self::CHD_SHA1_BYTES];
            out.copy_from_slice(&digest);
            out
        }

        fn sha1_file_prefix(
            source_path: &Path,
            logical_bytes: u64,
        ) -> Result<[u8; Self::CHD_SHA1_BYTES]> {
            let mut reader = BufReader::new(File::open(source_path).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open `{}` for CHD sha1: {error}",
                    source_path.display()
                ))
            })?);
            let mut sha1 = Sha1::new();
            let mut remaining = logical_bytes;
            let mut buffer = [0_u8; 64 * 1024];
            while remaining > 0 {
                let read_len =
                    usize::try_from(remaining.min(buffer.len() as u64)).map_err(|_| {
                        RomWeaverError::Validation("CHD sha1 read length overflow".to_string())
                    })?;
                reader
                    .read_exact(&mut buffer[..read_len])
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to read `{}` for CHD sha1: {error}",
                            source_path.display()
                        ))
                    })?;
                sha1.update(&buffer[..read_len]);
                remaining = remaining.saturating_sub(read_len as u64);
            }

            let digest = sha1.finalize();
            let mut out = [0_u8; Self::CHD_SHA1_BYTES];
            out.copy_from_slice(&digest);
            Ok(out)
        }

        fn patch_chd_header_u64(
            &self,
            output_file: &mut File,
            output_path: &Path,
            header_offset: u64,
            value: u64,
            field_label: &str,
        ) -> Result<()> {
            self.patch_chd_header_bytes(
                output_file,
                output_path,
                header_offset,
                &value.to_be_bytes(),
                field_label,
            )
        }

        fn patch_chd_header_bytes(
            &self,
            output_file: &mut File,
            output_path: &Path,
            header_offset: u64,
            bytes: &[u8],
            field_label: &str,
        ) -> Result<()> {
            let restore_offset = output_file.stream_position().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to capture CHD write offset in `{}`: {error}",
                    output_path.display()
                ))
            })?;
            output_file
                .seek(SeekFrom::Start(header_offset))
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to seek CHD {field_label} pointer in `{}`: {error}",
                        output_path.display()
                    ))
                })?;
            output_file.write_all(bytes).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to finalize CHD {field_label} pointer in `{}`: {error}",
                    output_path.display()
                ))
            })?;
            output_file
                .seek(SeekFrom::Start(restore_offset))
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to restore CHD write offset in `{}`: {error}",
                        output_path.display()
                    ))
                })?;
            Ok(())
        }

        fn infer_create_kind(&self, input: &Path, logical_bytes: u64) -> Result<ChdCreateKind> {
            let extension = input
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase());
            match extension.as_deref() {
                Some("iso") => {
                    self.ensure_multiple_of(logical_bytes, Self::DVD_SECTOR_BYTES, "dvd image")?;
                    Ok(ChdCreateKind::Dvd)
                }
                Some("img") | Some("ima") => Ok(ChdCreateKind::HardDisk(
                    self.infer_hd_geometry(logical_bytes)?,
                )),
                Some("cue") => Ok(ChdCreateKind::Disc(self.parse_cue_file(input)?)),
                Some("gdi") => Ok(ChdCreateKind::Disc(self.parse_gdi_file(input)?)),
                _ => Ok(ChdCreateKind::Raw),
            }
        }

        fn parse_create_mode_override(
            &self,
            format: &str,
        ) -> Result<Option<ChdCreateModeOverride>> {
            let normalized = format.trim().to_ascii_lowercase();
            if normalized == "chd" {
                return Ok(None);
            }

            let Some(mode) = normalized.strip_prefix("chd-") else {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported chd format `{format}`; expected `chd` or `chd-<mode>` where mode is cd|dvd|raw|hd"
                )));
            };

            match mode {
                "cd" => Ok(Some(ChdCreateModeOverride::Cd)),
                "dvd" => Ok(Some(ChdCreateModeOverride::Dvd)),
                "raw" => Ok(Some(ChdCreateModeOverride::Raw)),
                "hd" => Ok(Some(ChdCreateModeOverride::HardDisk)),
                _ => Err(RomWeaverError::Validation(format!(
                    "unsupported chd mode `{mode}` in `{format}`; expected one of: cd, dvd, raw, hd"
                ))),
            }
        }

        fn infer_create_kind_with_override(
            &self,
            input: &Path,
            logical_bytes: u64,
            mode: ChdCreateModeOverride,
        ) -> Result<ChdCreateKind> {
            match mode {
                ChdCreateModeOverride::Cd => {
                    let extension = input
                        .extension()
                        .and_then(|value| value.to_str())
                        .map(|value| value.to_ascii_lowercase());
                    let layout = match extension.as_deref() {
                        Some("cue") => self.parse_cue_file(input)?,
                        Some("gdi") => {
                            return Err(RomWeaverError::Validation(format!(
                                "chd-cd does not accept gdi input `{}`; use `chd` or `chd-raw` for gd media",
                                input.display()
                            )));
                        }
                        _ => {
                            let (mode, sector_bytes) = if logical_bytes
                                % u64::try_from(DiscTrackMode::Mode1Raw.data_bytes())
                                    .unwrap_or(2352)
                                == 0
                            {
                                (
                                    DiscTrackMode::Mode1Raw,
                                    DiscTrackMode::Mode1Raw.data_bytes(),
                                )
                            } else if logical_bytes
                                % u64::try_from(DiscTrackMode::Mode1.data_bytes()).unwrap_or(2048)
                                == 0
                            {
                                (DiscTrackMode::Mode1, DiscTrackMode::Mode1.data_bytes())
                            } else {
                                return Err(RomWeaverError::Validation(format!(
                                    "chd-cd input `{}` size must be a multiple of 2352 or 2048 bytes unless a cue file is provided",
                                    input.display()
                                )));
                            };
                            let frames = logical_bytes / u64::try_from(sector_bytes).unwrap_or(1);
                            let frames = u32::try_from(frames).map_err(|_| {
                                RomWeaverError::Validation(format!(
                                    "chd-cd input `{}` is too large for current track metadata limits",
                                    input.display()
                                ))
                            })?;
                            DiscLayout {
                                kind: DiscKind::CdRom,
                                tracks: vec![DiscTrack {
                                    number: 1,
                                    mode,
                                    file_path: input.to_path_buf(),
                                    file_offset_bytes: 0,
                                    frames,
                                    pregap_frames: 0,
                                    postgap_frames: 0,
                                    pregap_has_data: false,
                                    has_subcode: false,
                                    pad_frames: 0,
                                    swap_audio_on_read: false,
                                }],
                            }
                        }
                    };
                    if layout.kind != DiscKind::CdRom {
                        return Err(RomWeaverError::Validation(format!(
                            "chd-cd input `{}` resolved to non-cd media",
                            input.display()
                        )));
                    }
                    Ok(ChdCreateKind::Disc(layout))
                }
                ChdCreateModeOverride::Dvd => {
                    self.ensure_multiple_of(logical_bytes, Self::DVD_SECTOR_BYTES, "dvd image")?;
                    Ok(ChdCreateKind::Dvd)
                }
                ChdCreateModeOverride::Raw => Ok(ChdCreateKind::Raw),
                ChdCreateModeOverride::HardDisk => Ok(ChdCreateKind::HardDisk(
                    self.infer_hd_geometry(logical_bytes)?,
                )),
            }
        }

        #[cfg(test)]
        pub(super) fn infer_create_kind_label_for_tests(
            &self,
            format: &str,
            input: &Path,
            logical_bytes: u64,
        ) -> Result<&'static str> {
            let mode_override = self.parse_create_mode_override(format)?;
            let create_kind = if let Some(mode) = mode_override {
                self.infer_create_kind_with_override(input, logical_bytes, mode)?
            } else {
                self.infer_create_kind(input, logical_bytes)?
            };
            Ok(match create_kind {
                ChdCreateKind::Raw => "raw",
                ChdCreateKind::HardDisk(_) => "hd",
                ChdCreateKind::Dvd => "dvd",
                ChdCreateKind::Disc(layout) => match layout.kind {
                    DiscKind::CdRom => "cd",
                    DiscKind::GdRom => "gd",
                },
                ChdCreateKind::Av(_) => "av",
            })
        }

        fn unit_bytes(&self, create_kind: &ChdCreateKind) -> u32 {
            match create_kind {
                ChdCreateKind::Raw => 1,
                ChdCreateKind::HardDisk(geometry) => geometry.bytes_per_sector,
                ChdCreateKind::Dvd => Self::DVD_SECTOR_BYTES,
                ChdCreateKind::Disc(_) => Self::CD_FRAME_BYTES,
                ChdCreateKind::Av(_) => 1,
            }
        }

        fn hunk_bytes(
            &self,
            create_kind: &ChdCreateKind,
            logical_bytes: u64,
            codec: ChdCodec,
        ) -> u32 {
            match create_kind {
                ChdCreateKind::Disc(_) if codec != ChdCodec::NONE => {
                    let total_frames = logical_bytes / u64::from(Self::CD_FRAME_BYTES);
                    if total_frames <= 1 {
                        Self::CD_HUNK_BYTES
                    } else {
                        let frames_per_hunk = total_frames.div_ceil(2).min(8);
                        u32::try_from(frames_per_hunk)
                            .unwrap_or(8)
                            .saturating_mul(Self::CD_FRAME_BYTES)
                    }
                }
                ChdCreateKind::Disc(_) => Self::CD_HUNK_BYTES,
                ChdCreateKind::Av(profile) => profile.frame_bytes,
                _ => Self::DEFAULT_HUNK_BYTES,
            }
        }

        fn infer_hd_geometry(&self, logical_bytes: u64) -> Result<HdGeometry> {
            self.ensure_multiple_of(logical_bytes, Self::HD_SECTOR_BYTES, "hard-disk image")?;
            let total_sectors = logical_bytes / u64::from(Self::HD_SECTOR_BYTES);
            const CANDIDATES: &[(u32, u32)] = &[
                (255, 63),
                (240, 63),
                (128, 63),
                (64, 63),
                (32, 63),
                (16, 63),
                (16, 32),
                (16, 16),
                (8, 32),
                (8, 16),
                (4, 16),
                (2, 16),
                (1, 1),
            ];

            for &(heads, sectors) in CANDIDATES {
                let span = u64::from(heads) * u64::from(sectors);
                if span == 0 || total_sectors % span != 0 {
                    continue;
                }

                let cylinders = total_sectors / span;
                if cylinders <= u64::from(u32::MAX) {
                    return Ok(HdGeometry {
                        cylinders: cylinders as u32,
                        heads,
                        sectors,
                        bytes_per_sector: Self::HD_SECTOR_BYTES,
                    });
                }
            }

            Err(RomWeaverError::Validation(format!(
                "hard-disk image `{logical_bytes}` bytes is too large for the current synthetic geometry heuristic"
            )))
        }

        fn infer_av_profile(&self, input: &Path, logical_bytes: u64) -> Result<AvProfile> {
            let mut reader = BufReader::new(File::open(input).map_err(|error| {
                RomWeaverError::Validation(format!("failed to open `{}`: {error}", input.display()))
            })?);
            let mut header = [0_u8; 12];
            reader.read_exact(&mut header).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read A/V header from `{}`: {error}",
                    input.display()
                ))
            })?;
            if &header[..4] != b"chav" {
                return Err(RomWeaverError::Validation(format!(
                    "chd codec `avhuff` requires `chav` frames; `{}` does not start with a `chav` header",
                    input.display()
                )));
            }

            let metadata_bytes = u64::from(header[4]);
            let channels = u64::from(header[5]);
            let samples = u64::from(u16::from_be_bytes([header[6], header[7]]));
            let width = u64::from(u16::from_be_bytes([header[8], header[9]]));
            let height = u64::from(u16::from_be_bytes([header[10], header[11]]));

            let frame_bytes = 12_u64
                .saturating_add(metadata_bytes)
                .saturating_add(channels.saturating_mul(samples).saturating_mul(2))
                .saturating_add(width.saturating_mul(height).saturating_mul(2));
            let frame_bytes_u32 = u32::try_from(frame_bytes).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "A/V frame size `{frame_bytes}` in `{}` exceeds supported limits",
                    input.display()
                ))
            })?;
            if frame_bytes_u32 == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "A/V frame size in `{}` resolved to zero bytes",
                    input.display()
                )));
            }
            self.ensure_multiple_of(logical_bytes, frame_bytes_u32, "av frame stream")?;

            Ok(AvProfile {
                frame_bytes: frame_bytes_u32,
                fps: 1,
                fpsfrac: 0,
                width: width as u32,
                height: height as u32,
                interlaced: 0,
                channels: channels as u32,
                sample_rate: samples as u32,
            })
        }

        fn ensure_multiple_of(
            &self,
            logical_bytes: u64,
            unit_bytes: u32,
            label: &str,
        ) -> Result<()> {
            if logical_bytes % u64::from(unit_bytes) == 0 {
                Ok(())
            } else {
                Err(RomWeaverError::Validation(format!(
                    "{label} size must be a multiple of {unit_bytes} bytes"
                )))
            }
        }
    }

    impl ContainerHandler for ChdContainerHandler {
        fn descriptor(&self) -> &'static FormatDescriptor {
            &CHD
        }

        fn probe(&self, source: &Path) -> ProbeConfidence {
            if file_starts_with(source, &CHD_SIGNATURE) {
                ProbeConfidence::Signature
            } else {
                ProbeConfidence::Extension
            }
        }

        fn inspect(
            &self,
            request: &ContainerInspectRequest,
            context: &OperationContext,
        ) -> Result<OperationReport> {
            let execution = context.plan_threads(ThreadCapability::single_threaded());
            let chd = ChdReadSession::open(&request.source, None)?;
            let header = chd.header();
            let media_kind = chd.media_kind();
            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "inspect",
                format!(
                    "{} chd v{}: {} bytes, {}-byte hunks, codec={}",
                    self.media_label(media_kind),
                    header.version,
                    header.logical_bytes,
                    header.hunk_bytes,
                    self.header_codec_label(header)
                ),
                Some(100.0),
                Some(execution),
            ))
        }

        fn list_entries(
            &self,
            request: &ContainerInspectRequest,
            _context: &OperationContext,
        ) -> Result<Vec<String>> {
            let chd = ChdReadSession::open(&request.source, None)?;
            let media_kind = chd.media_kind();
            let stem = request
                .source
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("output");
            if media_kind == ChdMediaKind::CdRom {
                let layout = self.read_disc_tracks(&chd, DiscKind::CdRom)?;
                let first_data_bytes = layout
                    .tracks
                    .first()
                    .map(|track| track.mode.data_bytes())
                    .unwrap_or(2352);
                let single_bin = layout
                    .tracks
                    .iter()
                    .all(|track| track.mode.data_bytes() == first_data_bytes);
                let mut entries = vec![format!("{stem}.cue")];
                if single_bin {
                    entries.push(format!("{stem}.bin"));
                } else {
                    for track in &layout.tracks {
                        entries.push(self.track_output_name(stem, track.number));
                    }
                }
                return Ok(entries);
            }
            if media_kind == ChdMediaKind::GdRom {
                let layout = self.read_disc_tracks(&chd, DiscKind::GdRom)?;
                let mut entries = vec![format!("{stem}.gdi")];
                for track in &layout.tracks {
                    entries.push(self.track_output_name(stem, track.number));
                }
                return Ok(entries);
            }
            Ok(vec![self.extract_name(&request.source, media_kind)?])
        }

        fn extract(
            &self,
            request: &ContainerExtractRequest,
            context: &OperationContext,
        ) -> Result<OperationReport> {
            if request.parent.is_some() {
                return Err(RomWeaverError::Unsupported(
                    "chd extract with parent is not yet supported by the rust-native path"
                        .to_string(),
                ));
            }
            let execution = context.plan_threads(ThreadCapability::parallel(None));
            let chd = ChdReadSession::open(&request.source, None)?;
            let media_kind = chd.media_kind();
            if request.split_bin && media_kind != ChdMediaKind::CdRom {
                return Err(RomWeaverError::Validation(format!(
                    "chd extract --split-bin is only supported for cd media; `{}` is {}",
                    request.source.display(),
                    self.media_label(media_kind)
                )));
            }
            if media_kind == ChdMediaKind::CdRom {
                return self.extract_cd(chd, request, execution);
            }
            if media_kind == ChdMediaKind::GdRom {
                return self.extract_gd(chd, request, execution);
            }
            fs::create_dir_all(&request.out_dir)?;
            let output_name = self.extract_name(&request.source, media_kind)?;
            let mut selections = SelectionMatcher::new(&request.selections);
            if !selections.matches(&output_name) {
                selections.ensure_all_matched()?;
            }
            selections.ensure_all_matched()?;
            let output_path = request.out_dir.join(&output_name);
            let header = chd.extract_to_file(&output_path, execution.effective_threads)?;
            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "extract",
                format!(
                    "extracted `{}` to `{}` ({} bytes, {}, {})",
                    request.source.display(),
                    output_path.display(),
                    header.logical_bytes,
                    self.media_label(media_kind),
                    self.header_codec_label(header)
                ),
                Some(100.0),
                Some(execution),
            ))
        }

        fn create(
            &self,
            request: &ContainerCreateRequest,
            context: &OperationContext,
        ) -> Result<OperationReport> {
            if request.parent.is_some() {
                return Err(RomWeaverError::Unsupported(
                    "chd create with parent is not yet supported by the rust-native path"
                        .to_string(),
                ));
            }
            if request.inputs.len() != 1 {
                return Err(RomWeaverError::Validation(
                    "chd create currently requires exactly one input file".into(),
                ));
            }

            let execution = context.plan_threads(ThreadCapability::parallel(None));
            let input = &request.inputs[0];
            let input_bytes = fs::metadata(input)?.len();
            let mode_override = self.parse_create_mode_override(&request.format)?;
            let mut create_kind = if let Some(mode) = mode_override {
                self.infer_create_kind_with_override(input, input_bytes, mode)?
            } else {
                self.infer_create_kind(input, input_bytes)?
            };
            let mut compression_plan =
                self.resolve_compression_plan(request.codec.as_deref(), &create_kind)?;
            if compression_plan.primary_codec == ChdCodec::AVHUFF {
                create_kind = match create_kind {
                    ChdCreateKind::Raw => {
                        ChdCreateKind::Av(self.infer_av_profile(input, input_bytes)?)
                    }
                    ChdCreateKind::Av(profile) => ChdCreateKind::Av(profile),
                    _ => {
                        return Err(RomWeaverError::Validation(
                            "chd codec `avhuff` currently supports only raw `chav` frame inputs"
                                .into(),
                        ));
                    }
                };
            }
            compression_plan =
                self.resolve_compression_plan(request.codec.as_deref(), &create_kind)?;
            compression_plan =
                self.normalize_compression_plan_for_create_kind(&create_kind, compression_plan);
            let compression_level =
                self.resolve_compression_level(compression_plan.primary_codec, request.level)?;
            if let Some(parent) = request.output.parent() {
                fs::create_dir_all(parent)?;
            }

            let mut staged_input = None;
            let (source_path, logical_bytes) = match &create_kind {
                ChdCreateKind::Disc(layout) => {
                    let temp_path = self.materialize_disc_image(layout)?;
                    let logical_bytes = fs::metadata(&temp_path)?.len();
                    staged_input = Some(temp_path);
                    (
                        staged_input.as_ref().expect("staged disc input"),
                        logical_bytes,
                    )
                }
                _ => (input, input_bytes),
            };

            let rust_create = || -> Result<(ChdHeader, ChdMediaKind)> {
                let header = if compression_plan.primary_codec == ChdCodec::NONE {
                    self.create_uncompressed_rust_raw(
                        source_path,
                        &request.output,
                        logical_bytes,
                        &create_kind,
                    )?
                } else {
                    self.create_compressed_rust_raw(
                        source_path,
                        &request.output,
                        logical_bytes,
                        &create_kind,
                        compression_plan.codecs,
                        compression_level,
                        execution.effective_threads,
                    )?
                };
                Ok((header, self.media_kind_from_create_kind(&create_kind)))
            };

            let should_attempt_rust = self.should_attempt_rust_create(
                &create_kind,
                compression_plan.codecs,
                compression_plan.primary_codec,
            );
            let create_result = if !should_attempt_rust {
                Err(RomWeaverError::Unsupported(
                    "chd create requires all active compressed codec slots to be rust-encodable: raw/dvd/hd/av use `zstd`, `zlib`, or `lzma`; disc/gd use `cdzs`, `cdzl`, or `cdlz` (aliases `zstd`, `zlib`, and `lzma` normalize to disc codecs)".to_string(),
                ))
            } else {
                rust_create()
            };
            if let Some(path) = staged_input.as_ref() {
                let _ = fs::remove_file(path);
            }
            let (header, media_kind) = create_result?;

            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "create",
                format!(
                    "created {} chd `{}` from `{}` ({} bytes, {})",
                    self.media_label(media_kind),
                    request.output.display(),
                    input.display(),
                    header.logical_bytes,
                    self.header_codec_label(header)
                ),
                Some(100.0),
                Some(execution),
            ))
        }

        fn capabilities(&self) -> ContainerCapabilities {
            ContainerCapabilities {
                inspect: true,
                extract: true,
                create: true,
                extract_threads: ThreadCapability::parallel(None),
                create_threads: ThreadCapability::parallel(None),
            }
        }
    }
}

use chd_native::ChdContainerHandler;

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        io::{Seek, SeekFrom, Write},
        path::{Path, PathBuf},
        sync::Arc,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        CSO_DEFAULT_BLOCK_BYTES, ChdCodec, ContainerCreateRequest, ContainerRegistry,
        SelectionMatcher, Z3dsContainerHandler,
    };
    use ciso::write::write_ciso_image;
    use flate2::{Compression as DeflateCompression, write::DeflateEncoder};
    use nod::{
        common::{Compression as NodCompression, Format as NodFormat},
        read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader},
        write::{
            DiscWriter as NodDiscWriter, FormatOptions as NodFormatOptions,
            ProcessOptions as NodProcessOptions,
        },
    };
    use rom_weaver_core::{
        CancellationToken, ContainerHandler, NoopProgressSink, OperationContext, ThreadBudget,
        ThreadCapability,
    };

    fn temp_file_path_with_extension(label: &str, extension: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        env::temp_dir().join(format!(
            "rom-weaver-containers-probe-{label}-{}-{timestamp}.{extension}",
            std::process::id(),
        ))
    }

    fn temp_dir_path(label: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        env::temp_dir().join(format!(
            "rom-weaver-containers-tests-{label}-{}-{timestamp}",
            std::process::id(),
        ))
    }

    fn test_context(temp_root: &Path, threads: usize) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            temp_root.to_path_buf(),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }

    fn build_test_gamecube_iso(payload_len: usize) -> Vec<u8> {
        let total_len = (0x440 + payload_len).max(0x440);
        let mut bytes = vec![0_u8; total_len];
        bytes[..6].copy_from_slice(b"RWTEST");
        bytes[0x1C..0x20].copy_from_slice(&[0xC2, 0x33, 0x9F, 0x3D]);
        let title = b"rom-weaver-test\0";
        bytes[0x20..0x20 + title.len()].copy_from_slice(title);
        for (index, byte) in bytes[0x440..].iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        bytes
    }

    fn write_test_cso(input: &Path, output: &Path) {
        let mut source = fs::File::open(input).expect("open cso source fixture");
        let mut destination = fs::File::create(output).expect("create cso fixture");
        write_ciso_image(&mut source, &mut destination, |_| {}).expect("write cso fixture");
    }

    fn write_test_wbfs(input: &Path, output: &Path) {
        let disc = NodDiscReader::new(input, &NodDiscOptions::default())
            .expect("open wbfs source fixture");
        let options = NodFormatOptions {
            format: NodFormat::Wbfs,
            compression: NodCompression::None,
            block_size: NodFormat::Wbfs.default_block_size(),
        };
        let writer = NodDiscWriter::new(disc, &options).expect("create wbfs writer");
        let mut destination = fs::File::create(output).expect("create wbfs fixture");
        let finalization = writer
            .process(
                |data, _processed, _total| destination.write_all(data.as_ref()),
                &NodProcessOptions::default(),
            )
            .expect("write wbfs fixture");
        if !finalization.header.is_empty() {
            destination
                .seek(SeekFrom::Start(0))
                .expect("seek wbfs header");
            destination
                .write_all(finalization.header.as_ref())
                .expect("write wbfs header");
        }
        destination.flush().expect("flush wbfs fixture");
    }

    fn write_test_wia(input: &Path, output: &Path) {
        let disc =
            NodDiscReader::new(input, &NodDiscOptions::default()).expect("open wia source fixture");
        let options = NodFormatOptions {
            format: NodFormat::Wia,
            compression: NodCompression::Lzma2(6),
            block_size: NodFormat::Wia.default_block_size(),
        };
        let writer = NodDiscWriter::new(disc, &options).expect("create wia writer");
        let mut destination = fs::File::create(output).expect("create wia fixture");
        let finalization = writer
            .process(
                |data, _processed, _total| destination.write_all(data.as_ref()),
                &NodProcessOptions::default(),
            )
            .expect("write wia fixture");
        if !finalization.header.is_empty() {
            destination
                .seek(SeekFrom::Start(0))
                .expect("seek wia header");
            destination
                .write_all(finalization.header.as_ref())
                .expect("write wia header");
        }
        destination.flush().expect("flush wia fixture");
    }

    const TEST_PBP_SECTOR_BYTES: usize = 0x930;
    const TEST_PBP_BLOCK_BYTES: usize = TEST_PBP_SECTOR_BYTES * 16;
    const TEST_PBP_PSAR_INDEX_OFFSET: usize = 0x4000;
    const TEST_PBP_PSAR_ISO_OFFSET: usize = 0x100000;

    fn encode_bcd(value: u8) -> u8 {
        ((value / 10) << 4) | (value % 10)
    }

    fn frames_to_msf(frames: u32) -> (u8, u8, u8) {
        let minutes = frames / (60 * 75);
        let seconds = (frames / 75) % 60;
        let frame = frames % 75;
        (minutes as u8, seconds as u8, frame as u8)
    }

    fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn build_test_pbp_iso(sector_count: u32, seed: u8) -> Vec<u8> {
        let mut bytes =
            vec![0u8; usize::try_from(sector_count).expect("sector count") * TEST_PBP_SECTOR_BYTES];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = seed.wrapping_add((index % 241) as u8);
        }
        assert!(
            bytes.len() >= TEST_PBP_BLOCK_BYTES * 2 + 108,
            "test iso must be large enough to carry the popstation size descriptor"
        );
        bytes[TEST_PBP_BLOCK_BYTES + 104..TEST_PBP_BLOCK_BYTES + 108]
            .copy_from_slice(&sector_count.to_le_bytes());
        bytes
    }

    fn compress_block_raw_deflate(block: &[u8]) -> Vec<u8> {
        let mut encoder = DeflateEncoder::new(Vec::new(), DeflateCompression::new(6));
        std::io::Write::write_all(&mut encoder, block).expect("deflate encode");
        encoder.finish().expect("deflate finish")
    }

    fn build_test_pbp_disc_psar(
        disc_id: &str,
        iso_data: &[u8],
        compress_alternate_blocks: bool,
    ) -> Vec<u8> {
        assert_eq!(disc_id.len(), 9, "disc id must be 9 chars");
        assert_eq!(
            iso_data.len() % TEST_PBP_SECTOR_BYTES,
            0,
            "iso data must align to 2352-byte sectors"
        );
        let mut padded_iso = iso_data.to_vec();
        if padded_iso.len() % TEST_PBP_BLOCK_BYTES != 0 {
            let padded_len = padded_iso.len().div_ceil(TEST_PBP_BLOCK_BYTES) * TEST_PBP_BLOCK_BYTES;
            padded_iso.resize(padded_len, 0);
        }
        let block_count = padded_iso.len() / TEST_PBP_BLOCK_BYTES;
        let mut psar = vec![0u8; TEST_PBP_PSAR_ISO_OFFSET];
        psar[..12].copy_from_slice(b"PSISOIMG0000");
        write_u32_le(
            &mut psar,
            12,
            u32::try_from(TEST_PBP_PSAR_ISO_OFFSET + padded_iso.len()).expect("disc span"),
        );

        let disc_id_bytes = disc_id.as_bytes();
        psar[0x400] = b'_';
        psar[0x401..0x405].copy_from_slice(&disc_id_bytes[..4]);
        psar[0x405] = b'_';
        psar[0x406..0x40B].copy_from_slice(&disc_id_bytes[4..9]);

        let sector_count = u32::try_from(iso_data.len() / TEST_PBP_SECTOR_BYTES).expect("sectors");
        let leadout_frames = 150u32 + sector_count;
        let (leadout_m, leadout_s, leadout_f) = frames_to_msf(leadout_frames);
        psar[0x800 + 2] = 0xA0;
        psar[0x800 + 7] = encode_bcd(1);
        psar[0x80A + 2] = 0xA1;
        psar[0x80A + 7] = encode_bcd(1);
        psar[0x814 + 2] = 0xA2;
        psar[0x814 + 7] = encode_bcd(leadout_m);
        psar[0x814 + 8] = encode_bcd(leadout_s);
        psar[0x814 + 9] = encode_bcd(leadout_f);
        psar[0x81E] = 0x41;
        psar[0x81E + 2] = encode_bcd(1);
        psar[0x81E + 3] = encode_bcd(0);
        psar[0x81E + 4] = encode_bcd(2);
        psar[0x81E + 5] = encode_bcd(0);

        let mut block_bytes = Vec::new();
        for block_index in 0..block_count {
            let start = block_index * TEST_PBP_BLOCK_BYTES;
            let end = start + TEST_PBP_BLOCK_BYTES;
            let raw_block = &padded_iso[start..end];
            let mut payload = raw_block.to_vec();
            if compress_alternate_blocks && block_index % 2 == 1 {
                let compressed = compress_block_raw_deflate(raw_block);
                if compressed.len() < raw_block.len() {
                    payload = compressed;
                }
            }
            let entry_offset = TEST_PBP_PSAR_INDEX_OFFSET + (block_index * 0x20);
            write_u32_le(
                &mut psar,
                entry_offset,
                u32::try_from(block_bytes.len()).expect("index offset"),
            );
            write_u32_le(
                &mut psar,
                entry_offset + 4,
                u32::try_from(payload.len()).expect("index length"),
            );
            block_bytes.extend_from_slice(&payload);
        }
        psar.extend_from_slice(&block_bytes);
        psar
    }

    fn build_test_pbp_fixture(discs: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
        assert!(!discs.is_empty(), "at least one disc is required");
        let psar_offset = 0x100u32;
        let disc_payloads = discs
            .iter()
            .enumerate()
            .map(|(index, (disc_id, iso))| build_test_pbp_disc_psar(disc_id, iso, index % 2 == 0))
            .collect::<Vec<_>>();

        let psar = if disc_payloads.len() == 1 {
            disc_payloads[0].clone()
        } else {
            let mut data = Vec::new();
            data.extend_from_slice(b"PSTITLEIMG000000");
            data.extend_from_slice(&0u32.to_le_bytes());
            data.extend_from_slice(&0u32.to_le_bytes());
            data.extend_from_slice(&0x2CC9_C5BCu32.to_le_bytes());
            data.extend_from_slice(&0x33B5_A90Fu32.to_le_bytes());
            data.extend_from_slice(&0x06F6_B4B3u32.to_le_bytes());
            data.extend_from_slice(&0xB259_45BAu32.to_le_bytes());
            data.resize(0x200, 0);
            let position_table_offset = data.len();
            data.resize(position_table_offset + (5 * 4), 0);
            let mut cursor = 0x800usize;
            for (index, disc) in disc_payloads.iter().enumerate() {
                if data.len() < cursor {
                    data.resize(cursor, 0);
                }
                let relative = u32::try_from(cursor).expect("disc relative offset");
                write_u32_le(&mut data, position_table_offset + (index * 4), relative);
                data.extend_from_slice(disc);
                cursor = data.len();
            }
            data
        };

        let total_len = usize::try_from(psar_offset).expect("psar offset") + psar.len();
        let mut pbp = vec![0u8; total_len];
        pbp[..4].copy_from_slice(&[0x00, b'P', b'B', b'P']);
        write_u32_le(&mut pbp, 4, 0x0001_0000);
        for section in 0..8 {
            write_u32_le(&mut pbp, 8 + (section * 4), psar_offset);
        }
        let psar_start = usize::try_from(psar_offset).expect("psar offset usize");
        pbp[psar_start..psar_start + psar.len()].copy_from_slice(&psar);
        pbp
    }

    #[test]
    fn registry_contains_planned_formats() {
        let registry = ContainerRegistry::new();
        let names = registry
            .handlers()
            .iter()
            .map(|handler| handler.descriptor().name)
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "zip", "zipx", "7z", "rar", "tar", "tar.gz", "tar.bz2", "tar.xz", "gz", "bz2",
                "xz", "zst", "cso", "pbp", "chd", "gcz", "wia", "tgc", "nfs", "wbfs", "rvz",
                "z3ds", "xiso"
            ]
        );
    }

    #[test]
    fn z3ds_registers_azahar_extensions() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("z3ds").expect("z3ds handler");
        assert_eq!(
            handler.descriptor().extensions,
            [".z3ds", ".zcci", ".zcxi", ".zcia", ".z3dsx"]
        );
    }

    #[test]
    fn z3ds_extract_name_maps_to_matching_uncompressed_extension() {
        let handler = Z3dsContainerHandler;
        assert_eq!(
            handler.extract_name(Path::new("rom.z3ds")),
            "rom.3ds".to_string()
        );
        assert_eq!(
            handler.extract_name(Path::new("rom.zcci")),
            "rom.cci".to_string()
        );
        assert_eq!(
            handler.extract_name(Path::new("rom.zcxi")),
            "rom.cxi".to_string()
        );
        assert_eq!(
            handler.extract_name(Path::new("rom.zcia")),
            "rom.cia".to_string()
        );
        assert_eq!(
            handler.extract_name(Path::new("rom.z3dsx")),
            "rom.3dsx".to_string()
        );
        assert_eq!(
            handler.extract_name(Path::new("ROM.ZCCI")),
            "ROM.cci".to_string()
        );
    }

    #[test]
    fn z3ds_capabilities_report_parallel_create_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("z3ds").expect("z3ds handler");
        let capabilities = handler.capabilities();
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn gcz_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("gcz").expect("gcz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[test]
    fn wbfs_capabilities_support_create_and_extract() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wbfs").expect("wbfs handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn wia_capabilities_support_create_and_extract() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wia").expect("wia handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn tgc_capabilities_support_create_and_extract() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tgc").expect("tgc handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn nfs_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("nfs").expect("nfs handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[test]
    fn cso_capabilities_support_create_and_extract() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn pbp_capabilities_report_parallel_extract_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn rar_capabilities_report_parallel_extract_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("rar").expect("rar handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("chd-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let output_dir = temp_dir.join("out");
        let payload = (0..(512 * 1024))
            .map(|index| (index as u8).wrapping_mul(17))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        let capabilities = handler.capabilities();
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );

        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create chd");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 6);
        assert_eq!(create_execution.effective_threads, 6);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract chd");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 6);
        assert_eq!(extract_execution.effective_threads, 6);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn seven_z_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("7z").expect("7z handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn zip_capabilities_report_parallel_extract_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zip").expect("zip handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn tar_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar").expect("tar handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn tar_xz_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.xz").expect("tar.xz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn tar_gz_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.gz").expect("tar.gz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn tar_bz2_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.bz2").expect("tar.bz2 handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn gz_stream_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("gz").expect("gz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn bz2_stream_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("bz2").expect("bz2 handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn zst_stream_capabilities_report_parallel_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zst").expect("zst handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn xz_stream_capabilities_report_parallel_create_threads() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("xz").expect("xz handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
        assert!(capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::parallel(None)
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::parallel(None)
        );
    }

    #[test]
    fn zip_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("zip-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        for index in 0..8 {
            let path = input_dir.join(format!("file-{index}.bin"));
            let content = (0..32_768)
                .map(|offset| (offset as u8).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            fs::write(path, content).expect("write fixture");
        }
        let archive_path = temp_dir.join("payload.zip");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zip").expect("zip handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "zip".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create zip");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract zip");

        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 8);
        assert!(extract_execution.used_parallelism);

        for index in 0..8 {
            let path = output_dir.join(format!("input/file-{index}.bin"));
            let content = fs::read(path).expect("read extracted file");
            let expected = (0..32_768)
                .map(|offset| (offset as u8).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            assert_eq!(content, expected);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn zip_runtime_threads_fall_back_to_single_thread_for_single_entry() {
        let temp_dir = temp_dir_path("zip-thread-single-entry");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        let input_path = input_dir.join("single.bin");
        let source = (0..65_536)
            .map(|index| (index % 239) as u8)
            .collect::<Vec<_>>();
        fs::write(&input_path, &source).expect("write fixture");
        let archive_path = temp_dir.join("payload.zip");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zip").expect("zip handler");

        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "zip".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create zip");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 1);
        assert!(!create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract zip");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 1);
        assert!(!extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("input/single.bin")).expect("read extracted file");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn tar_gz_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("tar-gz-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        for index in 0..6 {
            let path = input_dir.join(format!("blob-{index}.bin"));
            let content = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(5).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            fs::write(path, content).expect("write fixture");
        }
        let archive_path = temp_dir.join("payload.tar.gz");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.gz").expect("tar.gz handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "tar.gz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create tar.gz");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract tar.gz");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        for index in 0..6 {
            let path = output_dir.join(format!("input/blob-{index}.bin"));
            let content = fs::read(path).expect("read extracted file");
            let expected = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(5).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            assert_eq!(content, expected);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn tar_bz2_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("tar-bz2-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        for index in 0..6 {
            let path = input_dir.join(format!("blob-{index}.bin"));
            let content = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(9).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            fs::write(path, content).expect("write fixture");
        }
        let archive_path = temp_dir.join("payload.tar.bz2");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.bz2").expect("tar.bz2 handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "tar.bz2".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create tar.bz2");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract tar.bz2");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        for index in 0..6 {
            let path = output_dir.join(format!("input/blob-{index}.bin"));
            let content = fs::read(path).expect("read extracted file");
            let expected = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(9).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            assert_eq!(content, expected);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn tar_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("tar-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        for index in 0..8 {
            let path = input_dir.join(format!("blob-{index}.bin"));
            let content = (0..(256 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(7).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            fs::write(path, content).expect("write fixture");
        }
        let archive_path = temp_dir.join("payload.tar");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar").expect("tar handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "tar".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create tar");

        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract tar");

        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 8);
        assert!(extract_execution.used_parallelism);

        for index in 0..8 {
            let path = output_dir.join(format!("input/blob-{index}.bin"));
            let content = fs::read(path).expect("read extracted file");
            let expected = (0..(256 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(7).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            assert_eq!(content, expected);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn tar_xz_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("tar-xz-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_dir = temp_dir.join("input");
        fs::create_dir_all(&input_dir).expect("input dir");
        for index in 0..6 {
            let path = input_dir.join(format!("blob-{index}.bin"));
            let content = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(3).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            fs::write(path, content).expect("write fixture");
        }
        let archive_path = temp_dir.join("payload.tar.xz");
        let output_dir = temp_dir.join("out");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tar.xz").expect("tar.xz handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_dir.clone()],
                    output: archive_path.clone(),
                    format: "tar.xz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create tar.xz");

        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract tar.xz");

        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 8);
        assert!(extract_execution.used_parallelism);

        for index in 0..6 {
            let path = output_dir.join(format!("input/blob-{index}.bin"));
            let content = fs::read(path).expect("read extracted file");
            let expected = (0..(512 * 1024))
                .map(|offset| (offset as u8).wrapping_mul(3).wrapping_add(index as u8))
                .collect::<Vec<_>>();
            assert_eq!(content, expected);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn gz_stream_create_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("gz-stream-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.bin.gz");
        let output_dir = temp_dir.join("out");
        let payload = (0..(1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(31))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("gz").expect("gz handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "gz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create gz");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract gz");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn bz2_stream_create_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("bz2-stream-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.bin.bz2");
        let output_dir = temp_dir.join("out");
        let payload = (0..(3 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(37))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("bz2").expect("bz2 handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "bz2".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create bz2");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract bz2");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn zst_stream_create_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("zst-stream-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.bin.zst");
        let output_dir = temp_dir.join("out");
        let payload = (0..(1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(13))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zst").expect("zst handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "zst".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create zst");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract zst");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.effective_threads > 1);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn zst_stream_inspect_reports_uncompressed_bytes() {
        let temp_dir = temp_dir_path("zst-stream-inspect");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.bin.zst");
        let payload = (0..(512 * 1024))
            .map(|index| (index as u8).wrapping_mul(7))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("zst").expect("zst handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "zst".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create zst");

        let report = handler
            .inspect(
                &rom_weaver_core::ContainerInspectRequest {
                    source: archive_path,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("inspect zst");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(
            report
                .label
                .contains(&format!("{} bytes uncompressed", payload.len())),
            "inspect label mismatch: {}",
            report.label
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn xz_stream_create_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("xz-stream-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.bin.xz");
        let output_dir = temp_dir.join("out");
        let payload = (0..(3 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(11))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("xz").expect("xz handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "xz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create xz");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract xz");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 8);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cso_extract_round_trips_to_iso_output() {
        let temp_dir = temp_dir_path("cso-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let compressed_cso = temp_dir.join("disc.cso");
        let output_dir = temp_dir.join("out");

        let source = (0..(CSO_DEFAULT_BLOCK_BYTES * 4))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let mut source = source;
        if let Some(last) = source.last_mut() {
            *last = 0;
        }
        fs::write(&input_iso, &source).expect("write source fixture");
        write_test_cso(&input_iso, &compressed_cso);

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: compressed_cso,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect("extract cso");

        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn wbfs_extract_round_trips_to_iso_output() {
        let temp_dir = temp_dir_path("wbfs-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let compressed_wbfs = temp_dir.join("disc.wbfs");
        let output_dir = temp_dir.join("out");

        let source = build_test_gamecube_iso(0x8000);
        fs::write(&input_iso, &source).expect("write source fixture");
        write_test_wbfs(&input_iso, &compressed_wbfs);

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wbfs").expect("wbfs handler");
        let report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: compressed_wbfs,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract wbfs");

        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn wbfs_create_and_extract_round_trip() {
        let temp_dir = temp_dir_path("wbfs-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_wbfs = temp_dir.join("disc.wbfs");
        let output_dir = temp_dir.join("out");

        let source = build_test_gamecube_iso(0xA000);
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wbfs").expect("wbfs handler");
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso.clone()],
                    output: output_wbfs.clone(),
                    format: "wbfs".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create wbfs");
        assert_eq!(
            create_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        assert!(output_wbfs.exists());

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: output_wbfs,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract wbfs");
        assert_eq!(
            extract_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn wbfs_create_rejects_compressed_codec() {
        let temp_dir = temp_dir_path("wbfs-create-error");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_wbfs = temp_dir.join("disc.wbfs");
        let source = build_test_gamecube_iso(0x3000);
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wbfs").expect("wbfs handler");
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso],
                    output: output_wbfs,
                    format: "wbfs".to_string(),
                    codec: Some("zstd".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("wbfs create should reject compressed codec");
        assert!(
            error.to_string().contains("unsupported wbfs codec `zstd`"),
            "unexpected error message: {error}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn wia_extract_round_trips_to_iso_output() {
        let temp_dir = temp_dir_path("wia-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let compressed_wia = temp_dir.join("disc.wia");
        let output_dir = temp_dir.join("out");

        let source = build_test_gamecube_iso(0x7000);
        fs::write(&input_iso, &source).expect("write source fixture");
        write_test_wia(&input_iso, &compressed_wia);

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wia").expect("wia handler");
        let report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: compressed_wia,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract wia");

        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn wia_create_and_extract_round_trip() {
        let temp_dir = temp_dir_path("wia-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_wia = temp_dir.join("disc.wia");
        let output_dir = temp_dir.join("out");

        let source = build_test_gamecube_iso(0xA000);
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("wia").expect("wia handler");
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso.clone()],
                    output: output_wia.clone(),
                    format: "wia".to_string(),
                    codec: Some("lzma2".to_string()),
                    level: Some(6),
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create wia");
        assert_eq!(
            create_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        assert!(output_wia.exists());

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: output_wia,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract wia");
        assert_eq!(
            extract_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn nfs_create_returns_clear_error() {
        let temp_dir = temp_dir_path("nfs-create-error");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_nfs = temp_dir.join("disc.nfs");
        let source = build_test_gamecube_iso(0x3000);
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("nfs").expect("nfs handler");
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso],
                    output: output_nfs,
                    format: "nfs".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("nfs create should error");
        assert!(
            error
                .to_string()
                .contains("nfs compression is not supported"),
            "unexpected error message: {error}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn tgc_create_rejects_compressed_codec() {
        let temp_dir = temp_dir_path("tgc-create-error");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_tgc = temp_dir.join("disc.tgc");
        let source = build_test_gamecube_iso(0x3000);
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("tgc").expect("tgc handler");
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso],
                    output: output_tgc,
                    format: "tgc".to_string(),
                    codec: Some("zstd".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("tgc create should reject compressed codec");
        assert!(
            error.to_string().contains("unsupported tgc codec `zstd`"),
            "unexpected error message: {error}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cso_create_and_extract_round_trip() {
        let temp_dir = temp_dir_path("cso-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let output_cso = temp_dir.join("disc.cso");
        let output_dir = temp_dir.join("out");
        let mut source = (0..(CSO_DEFAULT_BLOCK_BYTES * 4))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        if let Some(last) = source.last_mut() {
            *last = 0;
        }
        fs::write(&input_iso, &source).expect("write source fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso.clone()],
                    output: output_cso.clone(),
                    format: "cso".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create cso");
        assert_eq!(
            create_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        assert!(output_cso.exists());

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: output_cso,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect("extract cso");
        assert_eq!(
            extract_report.status,
            rom_weaver_core::OperationStatus::Succeeded
        );
        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cso_create_rejects_compressed_codec() {
        let temp_dir = temp_dir_path("cso-create-error");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("input.iso");
        let output_cso = temp_dir.join("output.cso");
        fs::write(&input_iso, vec![0_u8; CSO_DEFAULT_BLOCK_BYTES]).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_iso],
                    output: output_cso,
                    format: "cso".to_string(),
                    codec: Some("zstd".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("cso create should reject compressed codec");
        assert!(
            error.to_string().contains("unsupported cso codec `zstd`"),
            "unexpected error message: {error}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_lists_and_extracts_single_disc_outputs() {
        let temp_dir = temp_dir_path("pbp-single");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_iso = build_test_pbp_iso(64, 7);
        let pbp_bytes = build_test_pbp_fixture(vec![("SLUS00001", source_iso.clone())]);
        let source_path = temp_dir.join("game.pbp");
        fs::write(&source_path, pbp_bytes).expect("pbp fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let context = test_context(&temp_dir, 1);

        let inspect = handler
            .inspect(
                &rom_weaver_core::ContainerInspectRequest {
                    source: source_path.clone(),
                },
                &context,
            )
            .expect("inspect pbp");
        assert_eq!(inspect.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(inspect.label.contains("pbp: 1 disc(s)"));
        assert!(inspect.label.contains("SLUS00001"));

        let entries = handler
            .list_entries(
                &rom_weaver_core::ContainerInspectRequest {
                    source: source_path.clone(),
                },
                &context,
            )
            .expect("list entries");
        assert_eq!(
            entries,
            vec!["game.cue".to_string(), "game.bin".to_string()]
        );

        let out_dir = temp_dir.join("out");
        let extract = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: source_path,
                    out_dir: out_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &context,
            )
            .expect("extract pbp");
        assert_eq!(extract.status, rom_weaver_core::OperationStatus::Succeeded);
        assert_eq!(fs::read(out_dir.join("game.bin")).expect("bin"), source_iso);
        let cue_text = fs::read_to_string(out_dir.join("game.cue")).expect("cue text");
        assert!(cue_text.contains("TRACK 01 MODE2/2352"));
        assert!(cue_text.contains("INDEX 01 00:02:00"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_multi_disc_selection_supports_exact_glob_and_cue_fanout() {
        let temp_dir = temp_dir_path("pbp-multi");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let disc1_iso = build_test_pbp_iso(72, 11);
        let disc2_iso = build_test_pbp_iso(80, 29);
        let pbp_bytes = build_test_pbp_fixture(vec![
            ("SLUS00001", disc1_iso.clone()),
            ("SLUS00002", disc2_iso.clone()),
        ]);
        let source_path = temp_dir.join("multi.pbp");
        fs::write(&source_path, pbp_bytes).expect("pbp fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let context = test_context(&temp_dir, 1);

        let entries = handler
            .list_entries(
                &rom_weaver_core::ContainerInspectRequest {
                    source: source_path.clone(),
                },
                &context,
            )
            .expect("list entries");
        assert_eq!(
            entries,
            vec![
                "multi.disc01.cue".to_string(),
                "multi.disc01.bin".to_string(),
                "multi.disc02.cue".to_string(),
                "multi.disc02.bin".to_string(),
            ]
        );

        let selected_cue_dir = temp_dir.join("selected-cue");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: source_path.clone(),
                    out_dir: selected_cue_dir.clone(),
                    selections: vec!["multi.disc02.cue".to_string()],
                    split_bin: false,
                    parent: None,
                },
                &context,
            )
            .expect("extract selected cue");
        assert!(selected_cue_dir.join("multi.disc02.cue").exists());
        assert!(selected_cue_dir.join("multi.disc02.bin").exists());
        assert!(!selected_cue_dir.join("multi.disc01.cue").exists());
        assert!(!selected_cue_dir.join("multi.disc01.bin").exists());
        assert_eq!(
            fs::read(selected_cue_dir.join("multi.disc02.bin")).expect("disc2 bin"),
            disc2_iso
        );

        let selected_glob_dir = temp_dir.join("selected-glob");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: source_path,
                    out_dir: selected_glob_dir.clone(),
                    selections: vec!["multi.disc0?.bin".to_string()],
                    split_bin: false,
                    parent: None,
                },
                &context,
            )
            .expect("extract glob");
        assert!(selected_glob_dir.join("multi.disc01.bin").exists());
        assert!(selected_glob_dir.join("multi.disc02.bin").exists());
        assert!(!selected_glob_dir.join("multi.disc01.cue").exists());
        assert!(!selected_glob_dir.join("multi.disc02.cue").exists());
        assert_eq!(
            fs::read(selected_glob_dir.join("multi.disc01.bin")).expect("disc1 bin"),
            disc1_iso
        );
        assert_eq!(
            fs::read(selected_glob_dir.join("multi.disc02.bin")).expect("disc2 bin"),
            disc2_iso
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_extract_reports_missing_selection() {
        let temp_dir = temp_dir_path("pbp-missing-select");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let pbp_bytes = build_test_pbp_fixture(vec![("SLUS00001", build_test_pbp_iso(64, 5))]);
        let source_path = temp_dir.join("single.pbp");
        fs::write(&source_path, pbp_bytes).expect("pbp fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let error = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: source_path,
                    out_dir: temp_dir.join("out"),
                    selections: vec!["single.missing.cue".to_string()],
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("missing selection should fail");
        assert!(
            error
                .to_string()
                .contains("requested selections were not found")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_rejects_invalid_magic_and_payload_headers() {
        let temp_dir = temp_dir_path("pbp-invalid");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");

        let bad_magic_path = temp_dir.join("bad-magic.pbp");
        let mut bad_magic_header = vec![0u8; 0x28];
        bad_magic_header[..4].copy_from_slice(b"bad!");
        fs::write(&bad_magic_path, bad_magic_header).expect("bad magic fixture");
        let bad_magic_error = handler
            .inspect(
                &rom_weaver_core::ContainerInspectRequest {
                    source: bad_magic_path,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("inspect should fail for bad magic");
        assert!(bad_magic_error.to_string().contains("missing \\0PBP magic"));

        let mut bad_payload =
            build_test_pbp_fixture(vec![("SLUS00001", build_test_pbp_iso(64, 19))]);
        let psar_offset = u32::from_le_bytes([
            bad_payload[0x24],
            bad_payload[0x25],
            bad_payload[0x26],
            bad_payload[0x27],
        ]) as usize;
        bad_payload[psar_offset..psar_offset + 16].copy_from_slice(b"NOT-A-PSAR-SIGN!");
        let bad_payload_path = temp_dir.join("bad-payload.pbp");
        fs::write(&bad_payload_path, bad_payload).expect("bad payload fixture");

        let bad_payload_error = handler
            .inspect(
                &rom_weaver_core::ContainerInspectRequest {
                    source: bad_payload_path,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("inspect should fail for bad payload");
        assert!(
            bad_payload_error
                .to_string()
                .contains("supported PS1 DATA.PSAR signature")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn xiso_capabilities_disable_container_create() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("xiso").expect("xiso handler");
        let capabilities = handler.capabilities();
        assert!(!capabilities.inspect);
        assert!(!capabilities.extract);
        assert!(!capabilities.create);
        assert_eq!(
            capabilities.extract_threads,
            ThreadCapability::single_threaded()
        );
        assert_eq!(
            capabilities.create_threads,
            ThreadCapability::single_threaded()
        );
    }

    #[test]
    fn cso_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("cso-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("disc.iso");
        let output_path = temp_dir.join("disc.cso");
        let output_dir = temp_dir.join("out");
        let mut source = (0..(12 * 1024 * 1024))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        if let Some(last) = source.last_mut() {
            *last = 0;
        }
        fs::write(&input_path, &source).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let capabilities = handler.capabilities();

        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path.clone()],
                    output: output_path.clone(),
                    format: "cso".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create cso");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert!(create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: output_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract cso");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert!(extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("disc.iso")).expect("read extracted output");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn pbp_extract_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("pbp-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_iso = build_test_pbp_iso(4096, 23);
        let pbp_bytes = build_test_pbp_fixture(vec![("SLUS00001", source_iso.clone())]);
        let source_path = temp_dir.join("game.pbp");
        let out_dir = temp_dir.join("out");
        fs::write(&source_path, pbp_bytes).expect("pbp fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("pbp").expect("pbp handler");
        let capabilities = handler.capabilities();
        let report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: source_path,
                    out_dir: out_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract pbp");

        let execution = report.thread_execution.expect("thread execution");
        assert!(capabilities.extract_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(out_dir.join("game.bin")).expect("bin"), source_iso);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn rvz_create_runtime_threads_match_capability() {
        let temp_dir = temp_dir_path("rvz-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("disc.iso");
        let output_path = temp_dir.join("disc.rvz");
        fs::write(&input_path, build_test_gamecube_iso(0xA000)).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("rvz").expect("rvz handler");
        let capabilities = handler.capabilities();
        let report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path.clone()],
                    output: output_path.clone(),
                    format: "rvz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("rvz create");

        let execution = report.thread_execution.expect("thread execution");
        assert!(capabilities.create_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert!(execution.used_parallelism);
        assert!(output_path.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_create_runtime_threads_match_capability_with_single_chunk_input() {
        let temp_dir = temp_dir_path("z3ds-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("disc.3ds");
        let output_path = temp_dir.join("disc.z3ds");
        let source = (0..65_536)
            .map(|index| (index % 223) as u8)
            .collect::<Vec<_>>();
        fs::write(&input_path, source).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("z3ds").expect("z3ds handler");
        let capabilities = handler.capabilities();
        let report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path],
                    output: output_path.clone(),
                    format: "z3ds".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("z3ds create");

        let execution = report.thread_execution.expect("thread execution");
        assert!(capabilities.create_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);
        assert!(output_path.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn z3ds_extract_runtime_threads_match_capability_with_single_chunk_input() {
        let temp_dir = temp_dir_path("z3ds-extract-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("disc.3ds");
        let archive_path = temp_dir.join("disc.z3ds");
        let output_dir = temp_dir.join("out");
        let source = (0..65_536)
            .map(|index| (index % 223) as u8)
            .collect::<Vec<_>>();
        fs::write(&input_path, &source).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("z3ds").expect("z3ds handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path.clone()],
                    output: archive_path.clone(),
                    format: "z3ds".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("z3ds create");
        let create_execution = create_report.thread_execution.expect("thread execution");
        assert_eq!(create_execution.effective_threads, 1);
        assert!(!create_execution.used_parallelism);

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("z3ds extract");
        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 1);
        assert!(!extract_execution.used_parallelism);

        let extracted = fs::read(output_dir.join("disc.3ds")).expect("read extracted file");
        assert_eq!(extracted, source);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn seven_z_runtime_threads_match_capabilities_for_create_and_extract() {
        let temp_dir = temp_dir_path("seven-z-thread-parity");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_path = temp_dir.join("payload.bin");
        let archive_path = temp_dir.join("payload.7z");
        let output_dir = temp_dir.join("out");
        let source_bytes = (0..(64 * 1024))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        fs::write(&input_path, &source_bytes).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("7z").expect("7z handler");
        let capabilities = handler.capabilities();
        let create_report = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![input_path.clone()],
                    output: archive_path.clone(),
                    format: "7z".to_string(),
                    codec: Some("lzma2".to_string()),
                    level: Some(6),
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("create seven-z");

        let create_execution = create_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .create_threads
                .supports_execution(&create_execution)
        );
        assert_eq!(create_execution.requested_threads, 8);
        assert_eq!(create_execution.effective_threads, 8);
        assert!(create_execution.used_parallelism);
        assert!(archive_path.exists());

        let extract_report = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path.clone(),
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 8),
            )
            .expect("extract seven-z");

        let extract_execution = extract_report.thread_execution.expect("thread execution");
        assert!(
            capabilities
                .extract_threads
                .supports_execution(&extract_execution)
        );
        assert_eq!(extract_execution.requested_threads, 8);
        assert_eq!(extract_execution.effective_threads, 8);
        assert!(extract_execution.used_parallelism);

        let extracted_bytes =
            fs::read(output_dir.join("payload.bin")).expect("read extracted file");
        assert_eq!(extracted_bytes, source_bytes);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn probe_prefers_signature_over_mismatched_extension() {
        let path = temp_file_path_with_extension("seven-z-signature", "zip");
        fs::write(&path, [b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C]).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.probe(&path).expect("7z probe");
        assert_eq!(handler.descriptor().name, "7z");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_unknown_extension_with_chd_signature_to_chd_handler() {
        let path = temp_file_path_with_extension("chd-signature", "bin");
        fs::write(&path, b"MComprHD\0\0\0\0").expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.probe(&path).expect("chd probe");
        assert_eq!(handler.descriptor().name, "chd");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_routes_pbp_signature_even_with_wrong_extension() {
        let path = temp_file_path_with_extension("pbp-signature", "bin");
        let pbp_bytes = build_test_pbp_fixture(vec![("SLUS00001", build_test_pbp_iso(64, 17))]);
        fs::write(&path, pbp_bytes).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.probe(&path).expect("pbp probe");
        assert_eq!(handler.descriptor().name, "pbp");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn recommend_compress_format_returns_rvz_for_gamecube_wii_discs() {
        let path = temp_file_path_with_extension("recommend-rvz", "iso");
        fs::write(&path, build_test_gamecube_iso(64 * 1024)).expect("fixture");

        let registry = ContainerRegistry::new();
        let recommendation = registry.recommend_compress_format(&path);
        assert_eq!(recommendation.format_name, "rvz");
        assert_eq!(recommendation.reason, "wii-gc-disc");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn recommend_compress_format_returns_rvz_for_wbfs_inputs() {
        let temp_dir = temp_dir_path("recommend-rvz-wbfs");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let input_wbfs = temp_dir.join("disc.wbfs");
        fs::write(&input_iso, build_test_gamecube_iso(64 * 1024)).expect("fixture");
        write_test_wbfs(&input_iso, &input_wbfs);

        let registry = ContainerRegistry::new();
        let recommendation = registry.recommend_compress_format(&input_wbfs);
        assert_eq!(recommendation.format_name, "rvz");
        assert_eq!(recommendation.reason, "wii-gc-disc");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn recommend_compress_format_returns_rvz_for_wia_inputs() {
        let temp_dir = temp_dir_path("recommend-rvz-wia");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let input_iso = temp_dir.join("disc.iso");
        let input_wia = temp_dir.join("disc.wia");
        fs::write(&input_iso, build_test_gamecube_iso(64 * 1024)).expect("fixture");
        write_test_wia(&input_iso, &input_wia);

        let registry = ContainerRegistry::new();
        let recommendation = registry.recommend_compress_format(&input_wia);
        assert_eq!(recommendation.format_name, "rvz");
        assert_eq!(recommendation.reason, "wii-gc-disc");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn recommend_compress_format_returns_chd_for_unrecognized_inputs() {
        let path = temp_file_path_with_extension("recommend-chd", "bin");
        fs::write(&path, b"not-a-disc").expect("fixture");

        let registry = ContainerRegistry::new();
        let recommendation = registry.recommend_compress_format(&path);
        assert_eq!(recommendation.format_name, "chd");
        assert_eq!(recommendation.reason, "not-wii-gc-or-unrecognized");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn chd_mode_aliases_route_to_chd_handler() {
        let registry = ContainerRegistry::new();
        for alias in ["chd", "chd-cd", "chd-dvd", "chd-raw", "chd-hd"] {
            let handler = registry
                .find_by_name(alias)
                .expect("chd alias should resolve");
            assert_eq!(handler.descriptor().name, "chd");
        }
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_create_mode_overrides_adjust_inferred_kind() {
        let handler = super::ChdContainerHandler;
        let input = Path::new("disc.iso");
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd", input, 2048 * 8)
                .expect("auto kind"),
            "dvd"
        );
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd-cd", input, 2048 * 8)
                .expect("cd override"),
            "cd"
        );
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd-raw", input, 2048 * 8)
                .expect("raw override"),
            "raw"
        );
        assert_eq!(
            handler
                .infer_create_kind_label_for_tests("chd-hd", input, 512 * 8)
                .expect("hd override"),
            "hd"
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_cd_override_rejects_invalid_raw_sector_size() {
        let handler = super::ChdContainerHandler;
        let error = handler
            .infer_create_kind_label_for_tests("chd-cd", Path::new("disc.bin"), 12345)
            .expect_err("invalid sector size should fail");
        assert!(
            error
                .to_string()
                .contains("size must be a multiple of 2352 or 2048 bytes")
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_default_codecs_for_cd_inputs_match_rust_native_policy() {
        let handler = super::ChdContainerHandler;
        let (codecs, primary_codec) = handler
            .default_cd_compression_plan_for_tests()
            .expect("default cd plan");
        assert_eq!(
            codecs,
            [
                ChdCodec::CD_ZSTD,
                ChdCodec::CD_ZLIB,
                ChdCodec::CD_LZMA,
                ChdCodec::NONE,
            ]
        );
        assert_eq!(primary_codec, ChdCodec::CD_ZSTD);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_default_codecs_for_dvd_inputs_match_rust_native_policy() {
        let handler = super::ChdContainerHandler;
        let (codecs, primary_codec) = handler
            .default_dvd_compression_plan_for_tests()
            .expect("default dvd plan");
        assert_eq!(
            codecs,
            [
                ChdCodec::ZSTD,
                ChdCodec::ZLIB,
                ChdCodec::LZMA,
                ChdCodec::NONE,
            ]
        );
        assert_eq!(primary_codec, ChdCodec::ZSTD);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_explicit_codec_lists_support_multiple_codecs() {
        let handler = super::ChdContainerHandler;
        let (codecs, primary_codec) = handler
            .explicit_compression_plan_for_tests("cdzs,cdzl+cdfl")
            .expect("explicit codec list");
        assert_eq!(
            codecs,
            [
                ChdCodec::CD_ZSTD,
                ChdCodec::CD_ZLIB,
                ChdCodec::CD_FLAC,
                ChdCodec::NONE,
            ]
        );
        assert_eq!(primary_codec, ChdCodec::CD_ZSTD);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_explicit_codec_lists_reject_too_many_entries() {
        let handler = super::ChdContainerHandler;
        let error = handler
            .explicit_compression_plan_for_tests("cdzs,cdzl,cdfl,zstd,zlib")
            .expect_err("too many codecs should fail");
        assert!(error.to_string().contains("chd supports at most 4 codecs"));
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_backend_store_attempt_policy_matches_supported_codecs() {
        let handler = super::ChdContainerHandler;
        assert!(
            handler
                .rust_backend_can_create_with_codec_list_for_tests("store")
                .expect("store plan should use rust backend")
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_backend_create_attempt_requires_single_codec_plan() {
        let handler = super::ChdContainerHandler;
        assert!(
            handler
                .rust_backend_can_create_with_codec_list_for_tests("zstd")
                .expect("single codec should use rust backend")
        );
        assert!(
            handler
                .rust_backend_can_create_with_codec_list_for_tests("zstd,zlib")
                .expect("supported multi codec plan should use rust backend")
        );
        assert!(
            !handler
                .rust_backend_can_create_with_codec_list_for_tests("zstd,zlib,huffman")
                .expect("mixed codec plan with unsupported codecs should not use rust backend")
        );
        assert!(
            !handler
                .rust_backend_can_create_with_codec_list_for_tests("huffman")
                .expect("unsupported-only plan should fail rust backend support")
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_rejects_unsupported_codec_slots() {
        let temp_dir = temp_dir_path("chd-rust-unsupported-codec-slots");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let payload = (0..(512 * 1024))
            .map(|index| (index as u8).wrapping_mul(61))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        let error = handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path],
                    output: archive_path,
                    format: "chd".to_string(),
                    codec: Some("zstd,huffman".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect_err("mixed unsupported codec slots should fail in rust backend");
        assert!(
            error
                .to_string()
                .contains("requires all active compressed codec slots to be rust-encodable")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(all(not(target_family = "wasm"), any(unix, windows)))]
    #[test]
    fn chd_rust_backend_parallel_extract_matches_source_payload() {
        let temp_dir = temp_dir_path("chd-rust-parallel-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let extracted_single = temp_dir.join("single.bin");
        let extracted_parallel = temp_dir.join("parallel.bin");
        let payload = (0..(1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(29))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let handler = super::ChdContainerHandler;
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create chd fixture");

        handler
            .extract_raw_with_rust_backend_for_tests(&archive_path, &extracted_single, 1)
            .expect("single-thread rust extract");
        handler
            .extract_raw_with_rust_backend_for_tests(&archive_path, &extracted_parallel, 6)
            .expect("parallel rust extract");

        let single = fs::read(&extracted_single).expect("read single-thread output");
        let parallel = fs::read(&extracted_parallel).expect("read parallel output");
        assert_eq!(single, payload);
        assert_eq!(parallel, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_store_create_round_trip_matches_source_payload() {
        let temp_dir = temp_dir_path("chd-rust-store-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let extracted_path = temp_dir.join("extracted.bin");
        let payload = (0..(768 * 1024))
            .map(|index| (index as u8).wrapping_mul(37))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let handler = super::ChdContainerHandler;
        handler
            .create_raw_store_with_rust_backend_for_tests(&source_path, &archive_path)
            .expect("create rust store chd");
        handler
            .extract_raw_with_rust_backend_for_tests(&archive_path, &extracted_path, 1)
            .expect("extract rust store chd");

        let extracted = fs::read(&extracted_path).expect("read extracted output");
        assert_eq!(extracted, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_extract_with_parent_option_is_unsupported() {
        let temp_dir = temp_dir_path("chd-parent-option-extract");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let payload = (0..(320 * 1024))
            .map(|index| (index as u8).wrapping_mul(17))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 4),
            )
            .expect("create chd fixture");

        let error = handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path.clone(),
                    out_dir: temp_dir.join("out"),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: Some(archive_path),
                },
                &test_context(&temp_dir, 4),
            )
            .expect_err("extract with parent should be unsupported");
        assert!(error.to_string().contains("not yet supported"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_compressed_create_round_trip_matches_source_payload() {
        let temp_dir = temp_dir_path("chd-rust-compressed-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let payload = (0..(896 * 1024))
            .map(|index| (index as u8).wrapping_mul(41))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let handler = super::ChdContainerHandler;
        for (codec, codec_label) in [
            (ChdCodec::ZSTD, "zstd"),
            (ChdCodec::ZLIB, "zlib"),
            (ChdCodec::LZMA, "lzma"),
        ] {
            let archive_path = temp_dir.join(format!("source-{codec_label}.chd"));
            let extracted_path = temp_dir.join(format!("extracted-{codec_label}.bin"));
            handler
                .create_raw_with_rust_backend_codec_for_tests(
                    &source_path,
                    &archive_path,
                    codec,
                    0,
                    6,
                )
                .expect("create rust compressed chd");
            handler
                .extract_raw_with_rust_backend_for_tests(&archive_path, &extracted_path, 6)
                .expect("extract rust compressed chd");
            let extracted = fs::read(&extracted_path).expect("read extracted output");
            assert_eq!(extracted, payload);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_multi_codec_raw_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-multi-codec-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_path = temp_dir.join("source.bin");
        let archive_path = temp_dir.join("source.chd");
        let output_dir = temp_dir.join("out");
        let payload = (0..(1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(7))
            .collect::<Vec<_>>();
        fs::write(&source_path, &payload).expect("write fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_path.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: Some("zstd,zlib".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create rust-only multi codec chd");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only multi codec chd");

        let extracted = fs::read(output_dir.join("source.bin")).expect("read extracted payload");
        assert_eq!(extracted, payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_dvd_and_hd_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-nondisc-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let dvd_input = temp_dir.join("movie.iso");
        let hd_input = temp_dir.join("disk.img");
        let dvd_payload = (0..(2048 * 96))
            .map(|index| (index as u8).wrapping_mul(13))
            .collect::<Vec<_>>();
        let hd_payload = (0..(512 * 640))
            .map(|index| (index as u8).wrapping_mul(17))
            .collect::<Vec<_>>();
        fs::write(&dvd_input, &dvd_payload).expect("write dvd fixture");
        fs::write(&hd_input, &hd_payload).expect("write hd fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");

        for (input, codec, expected_ext, expected_payload, label) in [
            (&dvd_input, "zstd", ".iso", &dvd_payload, "dvd"),
            (&hd_input, "zlib", ".img", &hd_payload, "hd"),
        ] {
            let archive_path = temp_dir.join(format!("{label}.chd"));
            let output_dir = temp_dir.join(format!("out-{label}"));
            handler
                .create(
                    &ContainerCreateRequest {
                        inputs: vec![input.clone()],
                        output: archive_path.clone(),
                        format: "chd".to_string(),
                        codec: Some(codec.to_string()),
                        level: None,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("create rust-only chd");
            handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path.clone(),
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        split_bin: false,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("extract rust-only chd");

            let stem = archive_path
                .file_stem()
                .and_then(|value| value.to_str())
                .expect("archive stem");
            let extracted_path = output_dir.join(format!("{stem}{expected_ext}"));
            let extracted = fs::read(extracted_path).expect("read extracted payload");
            assert_eq!(extracted, *expected_payload);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_cd_store_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-cd-store-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_bin = temp_dir.join("disc.bin");
        let source_cue = temp_dir.join("disc.cue");
        let archive_path = temp_dir.join("disc.chd");
        let output_dir = temp_dir.join("out");

        let source_payload = (0..(2352 * 128))
            .map(|index| (index as u8).wrapping_mul(19))
            .collect::<Vec<_>>();
        fs::write(&source_bin, &source_payload).expect("write bin fixture");
        fs::write(
            &source_cue,
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("write cue fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_cue.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: Some("store".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create rust-only cd chd");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only cd chd");

        let extracted_bin = fs::read(output_dir.join("disc.bin")).expect("read extracted bin");
        let extracted_cue = fs::read_to_string(output_dir.join("disc.cue")).expect("read cue");
        assert_eq!(extracted_bin, source_payload);
        assert!(extracted_cue.contains("TRACK 01 MODE1/2352"));
        assert!(extracted_cue.contains("INDEX 01 00:00:00"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_cd_compressed_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-cd-compressed-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_bin = temp_dir.join("disc.bin");
        let source_cue = temp_dir.join("disc.cue");
        let source_payload = (0..(2352 * 192))
            .map(|index| (index as u8).wrapping_mul(23))
            .collect::<Vec<_>>();
        fs::write(&source_bin, &source_payload).expect("write bin fixture");
        fs::write(
            &source_cue,
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("write cue fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        for (codec, label) in [("cdzs", "cdzs"), ("cdzl", "cdzl"), ("cdlz", "cdlz")] {
            let archive_path = temp_dir.join(format!("disc-{label}.chd"));
            let output_dir = temp_dir.join(format!("out-{label}"));
            handler
                .create(
                    &ContainerCreateRequest {
                        inputs: vec![source_cue.clone()],
                        output: archive_path.clone(),
                        format: "chd".to_string(),
                        codec: Some(codec.to_string()),
                        level: None,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("create rust-only compressed cd chd");
            handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path,
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        split_bin: false,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("extract rust-only compressed cd chd");
            let extracted_bin =
                fs::read(output_dir.join(format!("disc-{label}.bin"))).expect("read extracted bin");
            assert_eq!(extracted_bin, source_payload);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_dvd_default_codec_plan_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-dvd-default-codec-plan");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_iso = temp_dir.join("movie.iso");
        let archive_path = temp_dir.join("movie.chd");
        let output_dir = temp_dir.join("out");
        let source_payload = (0..(2048 * 160))
            .map(|index| (index as u8).wrapping_mul(43))
            .collect::<Vec<_>>();
        fs::write(&source_iso, &source_payload).expect("write iso fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_iso.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create rust-only dvd chd with default codec plan");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only dvd chd");
        let extracted = fs::read(output_dir.join("movie.iso")).expect("read extracted payload");
        assert_eq!(extracted, source_payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_cd_default_codec_plan_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-cd-default-codec-plan");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_bin = temp_dir.join("disc.bin");
        let source_cue = temp_dir.join("disc.cue");
        let archive_path = temp_dir.join("disc.chd");
        let output_dir = temp_dir.join("out");
        let source_payload = (0..(2352 * 208))
            .map(|index| (index as u8).wrapping_mul(47))
            .collect::<Vec<_>>();
        fs::write(&source_bin, &source_payload).expect("write bin fixture");
        fs::write(
            &source_cue,
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("write cue fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_cue.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create rust-only cd chd with default codec plan");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only cd chd");

        let extracted = fs::read(output_dir.join("disc.bin")).expect("read extracted payload");
        assert_eq!(extracted, source_payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_cd_multi_codec_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-cd-multi-codec-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_bin = temp_dir.join("disc.bin");
        let source_cue = temp_dir.join("disc.cue");
        let archive_path = temp_dir.join("disc.chd");
        let output_dir = temp_dir.join("out");
        let source_payload = (0..(2352 * 224))
            .map(|index| (index as u8).wrapping_mul(31))
            .collect::<Vec<_>>();
        fs::write(&source_bin, &source_payload).expect("write bin fixture");
        fs::write(
            &source_cue,
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("write cue fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source_cue.clone()],
                    output: archive_path.clone(),
                    format: "chd".to_string(),
                    codec: Some("cdzs,cdzl".to_string()),
                    level: None,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("create rust-only multi codec cd chd");
        handler
            .extract(
                &rom_weaver_core::ContainerExtractRequest {
                    source: archive_path,
                    out_dir: output_dir.clone(),
                    selections: Vec::new(),
                    split_bin: false,
                    parent: None,
                },
                &test_context(&temp_dir, 6),
            )
            .expect("extract rust-only multi codec cd chd");

        let extracted = fs::read(output_dir.join("disc.bin")).expect("read extracted payload");
        assert_eq!(extracted, source_payload);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn chd_rust_only_create_supports_cd_codec_aliases_round_trip() {
        let temp_dir = temp_dir_path("chd-rust-cd-alias-codec-create");
        fs::create_dir_all(&temp_dir).expect("temp dir");
        let source_bin = temp_dir.join("disc.bin");
        let source_cue = temp_dir.join("disc.cue");
        let source_payload = (0..(2352 * 200))
            .map(|index| (index as u8).wrapping_mul(53))
            .collect::<Vec<_>>();
        fs::write(&source_bin, &source_payload).expect("write bin fixture");
        fs::write(
            &source_cue,
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("write cue fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("chd").expect("chd handler");
        for codec in ["zstd", "zlib", "lzma"] {
            let archive_path = temp_dir.join(format!("disc-{codec}.chd"));
            let output_dir = temp_dir.join(format!("out-{codec}"));
            handler
                .create(
                    &ContainerCreateRequest {
                        inputs: vec![source_cue.clone()],
                        output: archive_path.clone(),
                        format: "chd".to_string(),
                        codec: Some(codec.to_string()),
                        level: None,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("create rust-only cd alias codec chd");
            handler
                .extract(
                    &rom_weaver_core::ContainerExtractRequest {
                        source: archive_path,
                        out_dir: output_dir.clone(),
                        selections: Vec::new(),
                        split_bin: false,
                        parent: None,
                    },
                    &test_context(&temp_dir, 6),
                )
                .expect("extract rust-only cd alias codec chd");
            let extracted = fs::read(output_dir.join(format!("disc-{codec}.bin")))
                .expect("read extracted payload");
            assert_eq!(extracted, source_payload);
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn selection_matcher_preserves_exact_and_prefix_matches() {
        let mut selections =
            SelectionMatcher::new(&["content".to_string(), "disc.iso".to_string()]);
        assert!(selections.matches("content/track01.bin"));
        assert!(selections.matches("disc.iso"));
        assert!(selections.ensure_all_matched().is_ok());
    }

    #[test]
    fn selection_matcher_supports_glob_patterns() {
        let mut selections =
            SelectionMatcher::new(&["content/**/*.bin".to_string(), "cover.???".to_string()]);
        assert!(selections.matches("content/disc.bin"));
        assert!(selections.matches("content/tracks/track01.bin"));
        assert!(selections.matches("cover.png"));
        assert!(selections.ensure_all_matched().is_ok());
    }

    #[test]
    fn selection_matcher_reports_missing_glob_matches() {
        let mut selections = SelectionMatcher::new(&["*.cue".to_string()]);
        assert!(!selections.matches("disc.bin"));
        let error = selections
            .ensure_all_matched()
            .expect_err("missing selection");
        assert!(
            error
                .to_string()
                .contains("requested selections were not found: *.cue")
        );
    }
}
