use std::collections::BTreeMap;
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, AtomicU64, AtomicUsize, Ordering},
    },
};

use akv::reader::ArchiveReader as LibarchiveReadArchive;
use ciso::{read::CSOReader as CsoReader, split::SplitFileReader};
use lz4_flex::frame::{
    BlockMode as Lz4BlockMode, BlockSize as Lz4BlockSize, FrameEncoder as Lz4FrameEncoder,
    FrameInfo as Lz4FrameInfo,
};
use nod::{
    common::{Compression as NodCompression, Format as NodFormat},
    read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader},
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
    CanonicalCodec, RequestedCodec, decode_deflate_into_buffer, normalize_codec_label,
    parse_requested_codec,
};
use rom_weaver_core::{
    ContainerCapabilities, ContainerCreateRequest, ContainerExtractRequest, ContainerHandler,
    ContainerInspectRequest, FormatDescriptor, OperationContext, OperationFamily, OperationReport,
    OperationStatus, OrderedChunkWriter, ProbeConfidence, ProgressEvent, Result, RomWeaverError,
    ThreadCapability, ThreadExecution, bounded_items_for_threads,
};
use rom_weaver_libarchive::{
    EntryFileType, EntrySpec, ReadArchive, ReadFilter as LibarchiveReadFilter, WriteArchive,
    WriteFilter as LibarchiveCreateFilter, WriteFormat as LibarchiveCreateFormat,
    ZeroWriteBehavior,
    sys::{
        ARCHIVE_FORMAT_7ZIP, ARCHIVE_FORMAT_BASE_MASK, ARCHIVE_FORMAT_RAR, ARCHIVE_FORMAT_RAR_V5,
        ARCHIVE_FORMAT_TAR, ARCHIVE_FORMAT_ZIP,
    },
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

    if negated {
        !matched
    } else {
        matched
    }
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
const LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES: usize = 128 * 1024;

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
) -> Result<WriteArchive> {
    let mut archive = WriteArchive::new(&format!("{} create failed", config.format_name))?;
    let setup_result = (|| -> Result<()> {
        archive.set_format(
            config.format,
            &format!(
                "{} create failed while selecting {} format",
                config.format_name,
                libarchive_create_format_name(config.format)
            ),
        )?;

        archive.add_filter(
            config.filter,
            &format!(
                "{} create failed while enabling {} filter",
                config.format_name,
                config.filter.module_name().unwrap_or("no-op")
            ),
        )?;

        if let Some(compression) = config.format_compression {
            archive.set_format_option(
                None,
                "compression",
                compression,
                &format!(
                    "{} create failed while setting format option `compression`",
                    config.format_name
                ),
            )?;
        }

        if let Some(level) = config.compression_level {
            if config.format_compression.is_some() {
                archive.set_format_option(
                    None,
                    "compression-level",
                    &level.to_string(),
                    &format!(
                        "{} create failed while setting format option `compression-level`",
                        config.format_name
                    ),
                )?;
            } else {
                match config.filter {
                    LibarchiveCreateFilter::Gzip
                    | LibarchiveCreateFilter::Bzip2
                    | LibarchiveCreateFilter::Xz
                    | LibarchiveCreateFilter::Zstd => {
                        let module = config.filter.module_name().ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "{} create failed: no filter module for compression level",
                                config.format_name
                            ))
                        })?;
                        archive.set_filter_option(
                            module,
                            "compression-level",
                            &level.to_string(),
                            &format!(
                                "{} create failed while setting {module}:compression-level={level}",
                                config.format_name
                            ),
                        )?;
                    }
                    LibarchiveCreateFilter::None => {}
                }
            }
        }

        if let Some(threads) = config.format_threads {
            if config.format_compression.is_some() {
                archive.try_set_format_option(
                    None,
                    "threads",
                    &threads.to_string(),
                    &format!(
                        "{} create failed while setting format option `threads`",
                        config.format_name
                    ),
                )?;
            }
        }

        if let Some(threads) = config.filter_threads {
            if let Some(module) = config.filter.module_name() {
                archive.try_set_filter_option(
                    module,
                    "threads",
                    &threads.to_string(),
                    &format!(
                        "{} create failed while setting {module}:threads={threads}",
                        config.format_name
                    ),
                )?;
            }
        }

        archive.open_filename(
            output,
            "container output",
            &format!(
                "{} create failed while opening output `{}`",
                config.format_name,
                output.display()
            ),
        )?;
        Ok(())
    })();

    setup_result?;

    Ok(archive)
}

fn libarchive_create_format_name(format: LibarchiveCreateFormat) -> &'static str {
    match format {
        LibarchiveCreateFormat::Zip => "zip",
        LibarchiveCreateFormat::SevenZ => "7z",
        LibarchiveCreateFormat::TarPax => "tar",
        LibarchiveCreateFormat::Raw => "raw",
    }
}

fn libarchive_write_archive_entry<F>(
    archive: &mut WriteArchive,
    format_name: &str,
    entry: &ArchiveInputEntry,
    entry_size_bytes: u64,
    io_buffer_bytes: usize,
    mut on_bytes_written: F,
) -> Result<u64>
where
    F: FnMut(u64),
{
    let path_name = if entry.is_dir && !entry.archive_name.ends_with('/') {
        format!("{}/", entry.archive_name)
    } else {
        entry.archive_name.clone()
    };

    archive.start_entry(
        EntrySpec {
            pathname: &path_name,
            file_type: if entry.is_dir {
                EntryFileType::Directory
            } else {
                EntryFileType::Regular
            },
            perm: if entry.is_dir { 0o755 } else { 0o644 },
            size: entry_size_bytes,
        },
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
            archive.write_data_all(
                &buffer[..read],
                &format!("{format_name} create failed while writing payload"),
                ZeroWriteBehavior::Error,
            )?;
            logical_bytes = logical_bytes.saturating_add(read as u64);
            on_bytes_written(read as u64);
        }
    }

    archive.finish_entry(&format!(
        "{format_name} create failed while finalizing entry `{}`",
        entry.archive_name
    ))?;
    Ok(logical_bytes)
}

fn libarchive_close_create_archive(archive: WriteArchive, format_name: &str) -> Result<()> {
    archive.close(
        &format!("{format_name} create failed while closing output"),
        &format!("{format_name} create failed while releasing writer"),
    )
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

    let mut entry_sizes = Vec::with_capacity(entries.len());
    let mut total_input_bytes = 0u64;
    for entry in entries {
        let size = if entry.is_dir {
            0u64
        } else {
            fs::metadata(&entry.source)?.len()
        };
        total_input_bytes = total_input_bytes.saturating_add(size);
        entry_sizes.push(size);
    }

    let mut archive = libarchive_open_create_archive(&request.output, config)?;
    let result = (|| -> Result<u64> {
        let total_entries = entries.len();
        let mut logical_bytes = 0u64;
        let mut copied_bytes = 0u64;
        let emitted_progress_bucket = AtomicU8::new(0);
        for (entry_index, (entry, entry_size_bytes)) in
            entries.iter().zip(entry_sizes.iter().copied()).enumerate()
        {
            logical_bytes = logical_bytes.saturating_add(libarchive_write_archive_entry(
                &mut archive,
                config.format_name,
                entry,
                entry_size_bytes,
                config.io_buffer_bytes,
                |delta| {
                    copied_bytes = copied_bytes.saturating_add(delta).min(total_input_bytes);
                    maybe_emit_container_byte_progress(
                        context,
                        "compress",
                        config.format_name,
                        "create",
                        copied_bytes,
                        total_input_bytes,
                        &format!("creating `{}`", config.format_name),
                        Some(execution),
                        &emitted_progress_bucket,
                    );
                },
            )?);
            if total_input_bytes == 0 {
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
        }
        Ok(logical_bytes)
    })();

    match (
        result,
        libarchive_close_create_archive(archive, config.format_name),
    ) {
        (Ok(bytes), Ok(())) => Ok(bytes),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn libarchive_open_read_stream(
    source: &Path,
    format_name: &str,
    filter: LibarchiveReadFilter,
) -> Result<ReadArchive> {
    let mut archive = ReadArchive::new(&format!("{format_name} inspect failed"))?;
    let setup_result = (|| -> Result<()> {
        archive.support_raw_format(&format!(
            "{format_name} inspect failed while enabling raw format"
        ))?;
        archive.support_filter(
            filter,
            &format!(
                "{format_name} inspect failed while enabling {} filter",
                libarchive_read_filter_name(filter)
            ),
        )?;
        archive.open_filename(
            source,
            "container source",
            LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES,
            &format!(
                "{format_name} inspect failed while opening input `{}`",
                source.display()
            ),
        )?;
        Ok(())
    })();

    setup_result?;
    Ok(archive)
}

fn libarchive_read_filter_name(filter: LibarchiveReadFilter) -> &'static str {
    match filter {
        LibarchiveReadFilter::Gzip => "gzip",
        LibarchiveReadFilter::Bzip2 => "bzip2",
        LibarchiveReadFilter::Xz => "xz",
        LibarchiveReadFilter::Zstd => "zstd",
    }
}

fn libarchive_close_read_stream(archive: ReadArchive, format_name: &str) -> Result<()> {
    archive.close(
        &format!("{format_name} inspect failed while closing reader"),
        &format!("{format_name} inspect failed while releasing reader"),
    )
}

fn inspect_stream_with_libarchive(
    source: &Path,
    format_name: &str,
    filter: LibarchiveReadFilter,
) -> Result<u64> {
    let mut archive = libarchive_open_read_stream(source, format_name, filter)?;
    let result = (|| -> Result<u64> {
        if !archive.next_header(&format!(
            "{format_name} inspect failed while reading header"
        ))? {
            return Err(RomWeaverError::Validation(format!(
                "{format_name} inspect found no compressed payload entries"
            )));
        }

        let mut total = 0_u64;
        let mut buffer = vec![0_u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
        loop {
            let bytes = archive.read_data(
                &mut buffer,
                &format!("{format_name} inspect failed while reading payload"),
            )?;
            if bytes == 0 {
                break;
            }
            let bytes_u64 = u64::try_from(bytes).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "{format_name} inspect failed: decoded size exceeded u64 range"
                ))
            })?;
            total = total.checked_add(bytes_u64).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "{format_name} inspect failed: uncompressed size overflowed u64"
                ))
            })?;
        }
        Ok(total)
    })();

    match (result, libarchive_close_read_stream(archive, format_name)) {
        (Ok(bytes), Ok(())) => Ok(bytes),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
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

fn maybe_emit_container_byte_progress(
    context: &OperationContext,
    command: &str,
    format: &str,
    stage: &str,
    completed_bytes: u64,
    total_bytes: u64,
    label: &str,
    thread_execution: Option<&ThreadExecution>,
    emitted_progress_bucket: &AtomicU8,
) {
    if total_bytes == 0 || completed_bytes == 0 {
        return;
    }
    let completed = completed_bytes.min(total_bytes);
    let percent_bucket = completed
        .saturating_mul(100)
        .checked_div(total_bytes)
        .unwrap_or(100)
        .min(100) as u8;
    if percent_bucket == 0 {
        return;
    }

    let (start_bucket, end_bucket) = loop {
        let previous_bucket = emitted_progress_bucket.load(Ordering::Relaxed);
        if percent_bucket <= previous_bucket {
            return;
        }
        match emitted_progress_bucket.compare_exchange(
            previous_bucket,
            percent_bucket,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => break (previous_bucket.saturating_add(1), percent_bucket),
            Err(_) => continue,
        }
    };

    for bucket in start_bucket..=end_bucket {
        emit_container_running_progress(
            context,
            command,
            format,
            stage,
            label.to_string(),
            bucket as f32,
            thread_execution,
        );
    }
}

fn copy_reader_with_progress<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total_bytes: u64,
    context: &OperationContext,
    command: &str,
    format: &str,
    stage: &str,
    label: &str,
    thread_execution: Option<&ThreadExecution>,
) -> Result<u64> {
    let buffer_size = if total_bytes == 0 {
        64 * 1024
    } else {
        ((total_bytes / 100).max(16 * 1024).min(1024 * 1024)) as usize
    };
    let mut buffer = vec![0_u8; buffer_size];
    let mut bytes_written = 0_u64;
    let emitted_progress_bucket = AtomicU8::new(0);

    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        writer.write_all(&buffer[..bytes_read])?;
        bytes_written = bytes_written.saturating_add(bytes_read as u64);
        if total_bytes > 0 {
            maybe_emit_container_byte_progress(
                context,
                command,
                format,
                stage,
                bytes_written.min(total_bytes),
                total_bytes,
                label,
                thread_execution,
                &emitted_progress_bucket,
            );
        }
    }

    Ok(bytes_written)
}

#[derive(Clone, Debug)]
struct LibarchiveExtractTask {
    index: usize,
    archive_name: String,
    output_path: PathBuf,
    is_dir: bool,
    logical_bytes: Option<u64>,
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
        let is_dir = entry.is_dir() || entry_path.ends_with('/') || entry_path.ends_with('\\');
        tasks.push(LibarchiveExtractTask {
            index,
            archive_name,
            output_path: out_dir.join(relative),
            is_dir,
            logical_bytes: if is_dir { Some(0) } else { entry.size() },
        });
        index = index.saturating_add(1);
    }

    matcher.ensure_all_matched()?;
    Ok(tasks)
}

fn libarchive_extract_total_file_bytes(tasks: &[LibarchiveExtractTask]) -> Option<u64> {
    let mut total = 0u64;
    for task in tasks {
        if task.is_dir {
            continue;
        }
        total = total.saturating_add(task.logical_bytes?);
    }
    Some(total)
}

fn extract_libarchive_task_chunk<F, G>(
    source: &Path,
    chunk: &[LibarchiveExtractTask],
    format_name: &str,
    mut on_bytes_written: F,
    mut on_task_complete: G,
) -> Result<u64>
where
    F: FnMut(u64),
    G: FnMut(),
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
            let mut copied = 0u64;
            let mut buffer = vec![0u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
            loop {
                let read = input.read(&mut buffer).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "{format_name} extract failed while reading entry {} (`{}`): {error}",
                        task.index, task.archive_name
                    ))
                })?;
                if read == 0 {
                    break;
                }
                output.write_all(&buffer[..read]).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "{format_name} extract failed while writing entry {} (`{}`): {error}",
                        task.index, task.archive_name
                    ))
                })?;
                let read_u64 = read as u64;
                copied = copied.saturating_add(read_u64);
                on_bytes_written(read_u64);
            }
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
    let total_file_bytes = libarchive_extract_total_file_bytes(&tasks).filter(|total| *total > 0);

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
        let emitted_progress_bucket = AtomicU8::new(0);
        let mut copied_bytes = 0u64;
        let mut completed = 0usize;
        let written = extract_libarchive_task_chunk(
            &request.source,
            &tasks,
            format_name,
            |delta| {
                if let Some(total_bytes) = total_file_bytes {
                    copied_bytes = copied_bytes.saturating_add(delta).min(total_bytes);
                    maybe_emit_container_byte_progress(
                        context,
                        "extract",
                        format_name,
                        "extract",
                        copied_bytes,
                        total_bytes,
                        &format!("extracting `{format_name}`"),
                        Some(&execution),
                        &emitted_progress_bucket,
                    );
                }
            },
            || {
                if total_file_bytes.is_none() {
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
                }
            },
        )?;
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
        let copied_bytes = Arc::new(AtomicU64::new(0));
        let emitted_progress_bucket = Arc::new(AtomicU8::new(0));
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
                        let copied_bytes = Arc::clone(&copied_bytes);
                        let emitted_progress_bucket = Arc::clone(&emitted_progress_bucket);
                        let progress_context = progress_context.clone();
                        let progress_execution = progress_execution.clone();
                        extract_libarchive_task_chunk(
                            &source,
                            chunk,
                            format_name,
                            |delta| {
                                if let Some(total_bytes) = total_file_bytes {
                                    let completed_bytes = copied_bytes
                                        .fetch_add(delta, Ordering::Relaxed)
                                        .saturating_add(delta)
                                        .min(total_bytes);
                                    maybe_emit_container_byte_progress(
                                        &progress_context,
                                        "extract",
                                        format_name,
                                        "extract",
                                        completed_bytes,
                                        total_bytes,
                                        &format!("extracting `{format_name}`"),
                                        Some(&progress_execution),
                                        emitted_progress_bucket.as_ref(),
                                    );
                                }
                            },
                            || {
                                if total_file_bytes.is_none() {
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
                                        format!(
                                            "extracting `{format_name}` ({completed}/{total_tasks})"
                                        ),
                                        Some(&progress_execution),
                                    );
                                }
                            },
                        )
                    })
                    .collect::<Result<Vec<_>>>()
            })?;
            chunk_results
                .into_iter()
                .fold(0u64, |acc, value| acc.saturating_add(value))
        } else {
            let emitted_progress_bucket = AtomicU8::new(0);
            let mut copied_bytes = 0u64;
            let mut completed = 0usize;
            extract_libarchive_task_chunk(
                &source,
                &tasks,
                format_name,
                |delta| {
                    if let Some(total_bytes) = total_file_bytes {
                        copied_bytes = copied_bytes.saturating_add(delta).min(total_bytes);
                        maybe_emit_container_byte_progress(
                            &progress_context,
                            "extract",
                            format_name,
                            "extract",
                            copied_bytes,
                            total_bytes,
                            &format!("extracting `{format_name}`"),
                            Some(&progress_execution),
                            &emitted_progress_bucket,
                        );
                    }
                },
                || {
                    if total_file_bytes.is_none() {
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
                    }
                },
            )?
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
