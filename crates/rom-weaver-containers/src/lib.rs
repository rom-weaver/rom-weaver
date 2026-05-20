use std::collections::BTreeMap;
#[cfg(target_family = "wasm")]
use std::io::Cursor;
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};

use bzip2::read::MultiBzDecoder as Bzip2Decoder;
use ciso::{read::CSOReader as CsoReader, split::SplitFileReader};
use flacenc::{component::BitRepr as _, error::Verify as _};
use flate2::{Compression as GzipCompression, read::MultiGzDecoder, write::DeflateEncoder};
use lz4_flex::frame::{
    BlockMode as Lz4BlockMode, BlockSize as Lz4BlockSize, FrameEncoder as Lz4FrameEncoder,
    FrameInfo as Lz4FrameInfo,
};
use lzma_rust2::{LzmaOptions, LzmaWriter, XzReader};
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
    CanonicalCodec, CodecRegistry, RequestedCodec, decode_deflate_into_buffer,
    normalize_codec_label, parse_requested_codec,
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
    encoder_options::{
        BrotliOptions as SevenZBrotliOptions, Bzip2Options as SevenZBzip2Options,
        DeflateOptions as SevenZDeflateOptions, EncoderOptions as SevenZEncoderOptions,
        Lz4Options as SevenZLz4Options, Lzma2Options as SevenZLzma2Options,
        LzmaOptions as SevenZLzmaOptions, PpmdOptions as SevenZPpmdOptions,
        ZstandardOptions as SevenZZstdOptions,
    },
};
use sha1::{Digest, Sha1};
use tar::{Archive as TarArchive, Builder as TarBuilder};
use xdvdfs::{
    blockdev::OffsetWrapper as XdvdfsOffsetWrapper, write::fs::XDVDFSFilesystem as XdvdfsFilesystem,
};
use zeekstd::{Decoder as ZeekstdDecoder, SeekTable as ZeekstdSeekTable};
use zip::{
    CompressionMethod as ZipCompressionMethod, ZipArchive as ZipFileArchive,
    ZipWriter as ZipFileWriter, write::SimpleFileOptions as ZipFileOptions,
};
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

include!("handlers/chd.rs");

include!("../tests/unit/handlers.rs");
