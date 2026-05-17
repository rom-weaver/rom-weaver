use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use bzip2::{Compression as Bzip2Compression, read::BzDecoder as Bzip2Decoder, write::BzEncoder};
use ciso::{read::CSOReader as CsoReader, split::SplitFileReader};
use flate2::{Compression as GzipCompression, read::GzDecoder, write::GzEncoder};
use liblzma::{read::XzDecoder, write::XzEncoder};
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
#[cfg(not(target_family = "wasm"))]
use rom_weaver_chd_sys::{
    CD_FRAME_SIZE, CDROM_TRACK_METADATA2_TAG, CHD_MAX_COMPRESSORS, CHD_METADATA_FLAG_CHECKSUM,
    ChdCodec, ChdFile, ChdMediaKind, CreateOptions, DVD_METADATA_TAG, GDROM_TRACK_METADATA_TAG,
    HARD_DISK_METADATA_TAG, build_info, make_tag,
};
use rom_weaver_codecs::{
    CanonicalCodec, CodecRegistry, RequestedCodec, normalize_codec_label, parse_requested_codec,
};
use rom_weaver_core::{
    CodecBackend, CodecOperationRequest, ContainerCapabilities, ContainerCreateRequest,
    ContainerExtractRequest, ContainerHandler, ContainerInspectRequest, FormatDescriptor,
    OperationContext, OperationFamily, OperationReport, OperationStatus, ProbeConfidence, Result,
    RomWeaverError, ThreadCapability,
};
use sevenz_rust::{
    Password as SevenZPassword, SevenZArchiveEntry, SevenZMethod, SevenZMethodConfiguration,
    SevenZReader, SevenZWriter,
};
use sha2::{Digest as Sha2Digest, Sha256};
use tar::{Archive as TarArchive, Builder as TarBuilder};
#[cfg(not(target_family = "wasm"))]
use unrar_ng::Archive as RarArchive;
use xdvdfs::{
    blockdev::OffsetWrapper as XdvdfsOffsetWrapper,
    write::{fs::XDVDFSFilesystem as XdvdfsFilesystem, img::create_xdvdfs_image},
};
use zip::{
    CompressionMethod as ZipCompressionMethod, ZipArchive as ZipFileArchive,
    ZipWriter as ZipFileWriter, write::SimpleFileOptions as ZipFileOptions,
};
use zstd::bulk::compress as zstd_compress;
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
const CHD: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "chd",
    aliases: &[],
    extensions: &[".chd"],
};
const GCZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "gcz",
    aliases: &[],
    extensions: &[".gcz"],
};
const RVZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "rvz",
    aliases: &[],
    extensions: &[".rvz"],
};
#[cfg(not(target_family = "wasm"))]
const Z3DS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "z3ds",
    aliases: &["3ds"],
    extensions: &[".z3ds", ".zcci", ".zcxi", ".zcia", ".z3dsx"],
};
const WUA: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "wua",
    aliases: &["zar", "zarchive"],
    extensions: &[".wua", ".zar"],
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
        #[cfg(not(target_family = "wasm"))]
        {
            handlers.push(Arc::new(RarContainerHandler::new(&RAR)));
        }
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
        #[cfg(not(target_family = "wasm"))]
        {
            handlers.push(Arc::new(ChdContainerHandler));
        }
        handlers.push(Arc::new(WuaContainerHandler));
        handlers.push(Arc::new(GczContainerHandler));
        handlers.push(Arc::new(RvzContainerHandler));
        #[cfg(not(target_family = "wasm"))]
        {
            handlers.push(Arc::new(Z3dsContainerHandler));
        }
        handlers.push(Arc::new(XisoContainerHandler));
        Self { handlers }
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
        #[cfg(target_family = "wasm")]
        {
            return CompressFormatRecommendation {
                format_name: ZST.name,
                reason: "not-wii-gc-or-unrecognized-chd-unavailable-on-wasm",
            };
        }
        #[cfg(not(target_family = "wasm"))]
        CompressFormatRecommendation {
            format_name: CHD.name,
            reason: "not-wii-gc-or-unrecognized",
        }
    }
}

const SEVEN_Z_SIGNATURE: [u8; 6] = [b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C];
#[cfg(not(target_family = "wasm"))]
const RAR4_SIGNATURE: [u8; 7] = [b'R', b'a', b'r', b'!', 0x1A, 0x07, 0x00];
#[cfg(not(target_family = "wasm"))]
const RAR5_SIGNATURE: [u8; 8] = [b'R', b'a', b'r', b'!', 0x1A, 0x07, 0x01, 0x00];
const GZIP_SIGNATURE: [u8; 2] = [0x1F, 0x8B];
const BZIP2_SIGNATURE: [u8; 3] = [b'B', b'Z', b'h'];
const XZ_SIGNATURE: [u8; 6] = [0xFD, b'7', b'z', b'X', b'Z', 0x00];
const ZSTD_SIGNATURE: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
const CSO_SIGNATURE: [u8; 4] = [b'C', b'I', b'S', b'O'];
#[cfg(not(target_family = "wasm"))]
const CHD_SIGNATURE: [u8; 8] = *b"MComprHD";

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

#[derive(Debug, Default)]
struct SelectionMatcher {
    requested: BTreeSet<String>,
    matched: BTreeSet<String>,
}

impl SelectionMatcher {
    fn new(requested: &[String]) -> Self {
        let requested = requested
            .iter()
            .map(|value| normalize_archive_name(value))
            .filter(|value| !value.is_empty())
            .collect();
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
            if entry_name == *requested || entry_name.starts_with(&format!("{requested}/")) {
                self.matched.insert(requested.clone());
                return true;
            }
        }
        false
    }

    fn ensure_all_matched(&self) -> Result<()> {
        let missing = self
            .requested
            .difference(&self.matched)
            .cloned()
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        fs::create_dir_all(&request.out_dir)?;

        let mut archive = self.open_archive(&request.source)?;
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut extracted_files = 0usize;
        let mut written_bytes = 0u64;

        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| {
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

            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut output = BufWriter::new(File::create(&output_path)?);
            let copied = io::copy(&mut entry, &mut output)?;
            written_bytes = written_bytes.saturating_add(copied);
            extracted_files += 1;
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let (method, level) = self.parse_codec(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = File::create(&request.output)?;
        let writer = BufWriter::new(file);
        let mut archive = ZipFileWriter::new(writer);
        let mut logical_bytes = 0u64;

        for entry in &entries {
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

            archive
                .start_file(
                    entry.archive_name.clone(),
                    self.build_options(method, level),
                )
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "{} create failed for `{}`: {error}",
                        self.descriptor.name, entry.archive_name
                    ))
                })?;
            let mut source = BufReader::new(File::open(&entry.source)?);
            let copied = io::copy(&mut source, &mut archive)?;
            logical_bytes = logical_bytes.saturating_add(copied);
        }

        archive.finish().map_err(|error| {
            RomWeaverError::Validation(format!(
                "{} create failed while finalizing archive: {error}",
                self.descriptor.name
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
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
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

impl TarContainerHandler {
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
    ) -> Result<u64> {
        let mut logical_bytes = 0u64;
        for entry in entries {
            if entry.is_dir {
                builder.append_dir(&entry.archive_name, &entry.source)?;
            } else {
                builder.append_path_with_name(&entry.source, &entry.archive_name)?;
                logical_bytes = logical_bytes.saturating_add(fs::metadata(&entry.source)?.len());
            }
        }
        Ok(logical_bytes)
    }

    fn open_reader(&self, source: &Path) -> Result<Box<dyn Read>> {
        let file = File::open(source)?;
        let reader: Box<dyn Read> = match self.compression {
            TarCompression::None => Box::new(BufReader::new(file)),
            TarCompression::Gzip => Box::new(GzDecoder::new(BufReader::new(file))),
            TarCompression::Bzip2 => Box::new(Bzip2Decoder::new(BufReader::new(file))),
            TarCompression::Xz => Box::new(XzDecoder::new(BufReader::new(file))),
        };
        Ok(reader)
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        fs::create_dir_all(&request.out_dir)?;

        let reader = self.open_reader(&request.source)?;
        let mut archive = TarArchive::new(reader);
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut extracted_files = 0usize;
        let mut written_bytes = 0u64;

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
            let copied = io::copy(&mut entry, &mut output)?;
            extracted_files += 1;
            written_bytes = written_bytes.saturating_add(copied);
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let level = self.parse_codec_and_level(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let logical_bytes = match self.compression {
            TarCompression::None => {
                let output = BufWriter::new(File::create(&request.output)?);
                let mut builder = TarBuilder::new(output);
                let bytes = self.append_entries(&mut builder, &entries)?;
                builder.finish()?;
                bytes
            }
            TarCompression::Gzip => {
                let output = BufWriter::new(File::create(&request.output)?);
                let encoder = GzEncoder::new(output, GzipCompression::new(level));
                let mut builder = TarBuilder::new(encoder);
                let bytes = self.append_entries(&mut builder, &entries)?;
                let encoder = builder.into_inner()?;
                let mut output = encoder.finish()?;
                output.flush()?;
                bytes
            }
            TarCompression::Bzip2 => {
                let output = BufWriter::new(File::create(&request.output)?);
                let encoder = BzEncoder::new(output, Bzip2Compression::new(level));
                let mut builder = TarBuilder::new(encoder);
                let bytes = self.append_entries(&mut builder, &entries)?;
                let mut output = builder.into_inner()?.finish()?;
                output.flush()?;
                bytes
            }
            TarCompression::Xz => {
                let output = BufWriter::new(File::create(&request.output)?);
                let encoder = XzEncoder::new(output, level);
                let mut builder = TarBuilder::new(encoder);
                let bytes = self.append_entries(&mut builder, &entries)?;
                let mut output = builder.into_inner()?.finish()?;
                output.flush()?;
                bytes
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
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
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

    fn codec_backend(&self) -> Result<Arc<dyn CodecBackend>> {
        let codec = self.backend_codec_name();
        CodecRegistry::new().find_by_name(codec).ok_or_else(|| {
            RomWeaverError::Unsupported(format!(
                "codec backend `{codec}` is not registered for {}",
                self.descriptor.name
            ))
        })
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
        let backend = self.codec_backend()?;
        let decoded = context
            .temp_paths()
            .next_path(&format!("{}-inspect", self.descriptor.name), Some("bin"));
        let decode_report = backend.decode(
            &CodecOperationRequest {
                input: request.source.clone(),
                output: decoded.clone(),
                level: None,
            },
            context,
        )?;
        if decode_report.status != OperationStatus::Succeeded {
            return Err(RomWeaverError::Unsupported(decode_report.label));
        }
        let logical_bytes = fs::metadata(&decoded)?.len();
        let _ = fs::remove_file(&decoded);

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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
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

        let execution = context.plan_threads(ThreadCapability::single_threaded());
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
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

const CSO_DEFAULT_BLOCK_BYTES: usize = 2 * 1024;

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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        fs::create_dir_all(&request.out_dir)?;

        let output_name = self.output_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }
        selections.ensure_all_matched()?;

        let output_path = request.out_dir.join(&output_name);
        let mut output = BufWriter::new(File::create(&output_path)?);
        let mut reader = self.open_reader(&request.source)?;
        let logical_bytes = reader.file_size();
        let mut cursor = 0u64;
        let mut buffer = vec![0_u8; CSO_DEFAULT_BLOCK_BYTES];

        while cursor < logical_bytes {
            let remaining = logical_bytes - cursor;
            let chunk_len = remaining.min(buffer.len() as u64) as usize;
            reader
                .read_offset(cursor, &mut buffer[..chunk_len])
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "cso extract failed while reading `{}`: {error}",
                        request.source.display()
                    ))
                })?;
            output.write_all(&buffer[..chunk_len])?;
            cursor += chunk_len as u64;
        }
        output.flush()?;

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
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "cso compression is not supported; cso can only be decompressed with `extract`".into(),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: false,
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

struct SevenZContainerHandler {
    descriptor: &'static FormatDescriptor,
}

impl SevenZContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn open_reader(&self, source: &Path) -> Result<SevenZReader<File>> {
        let file = File::open(source)?;
        let len = file.metadata()?.len();
        SevenZReader::new(file, len, SevenZPassword::empty())
            .map_err(|error| RomWeaverError::Validation(format!("7z archive is invalid: {error}")))
    }

    fn parse_codec(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<SevenZMethodConfiguration> {
        if level.is_some() {
            return Err(RomWeaverError::Validation(
                "7z compression level tuning is not implemented yet; omit --level".into(),
            ));
        }
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Lzma2) => {
                Ok(SevenZMethodConfiguration::new(SevenZMethod::LZMA2))
            }
            RequestedCodec::Known(CanonicalCodec::Lzma) => {
                Ok(SevenZMethodConfiguration::new(SevenZMethod::LZMA))
            }
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported 7z codec `{}`; supported codecs are lzma2 and lzma",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported 7z codec `{name}`; supported codecs are lzma2 and lzma"
            ))),
        }
    }

    fn method_name(method: &SevenZMethodConfiguration) -> &'static str {
        match method.method {
            SevenZMethod::LZMA2 => "lzma2",
            SevenZMethod::LZMA => "lzma",
            _ => "unknown",
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        fs::create_dir_all(&request.out_dir)?;

        let mut reader = self.open_reader(&request.source)?;
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut extracted_files = 0usize;
        let mut written_bytes = 0u64;

        reader
            .for_each_entries(|entry, source| {
                let entry_name = normalize_archive_name(entry.name());
                if entry_name.is_empty() || !selections.matches(&entry_name) {
                    if entry.size() > 0 {
                        io::copy(source, &mut io::sink()).map_err(sevenz_rust::Error::io)?;
                    }
                    return Ok(true);
                }

                let relative = sanitize_archive_relative_path_from_str(entry.name())
                    .map_err(|error| sevenz_rust::Error::other(error.to_string()))?;
                let output_path = request.out_dir.join(relative);

                if entry.is_directory() {
                    fs::create_dir_all(&output_path).map_err(sevenz_rust::Error::io)?;
                    return Ok(true);
                }

                if let Some(parent) = output_path.parent() {
                    fs::create_dir_all(parent).map_err(sevenz_rust::Error::io)?;
                }
                let mut output =
                    BufWriter::new(File::create(&output_path).map_err(sevenz_rust::Error::io)?);
                let copied = io::copy(source, &mut output).map_err(sevenz_rust::Error::io)?;
                extracted_files += 1;
                written_bytes = written_bytes.saturating_add(copied);
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let method = self.parse_codec(request.codec.as_deref(), request.level)?;
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
        for entry in &entries {
            let archive_entry =
                SevenZArchiveEntry::from_path(&entry.source, entry.archive_name.clone());
            if entry.is_dir {
                writer
                    .push_archive_entry::<&[u8]>(archive_entry, None)
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "7z create failed for `{}`: {error}",
                            entry.archive_name
                        ))
                    })?;
                continue;
            }

            let source = File::open(&entry.source)?;
            writer
                .push_archive_entry(archive_entry, Some(source))
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "7z create failed for `{}`: {error}",
                        entry.archive_name
                    ))
                })?;
            logical_bytes = logical_bytes.saturating_add(fs::metadata(&entry.source)?.len());
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
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

#[cfg(not(target_family = "wasm"))]
struct RarContainerHandler {
    descriptor: &'static FormatDescriptor,
}

#[cfg(not(target_family = "wasm"))]
impl RarContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn open_for_listing(
        &self,
        source: &Path,
    ) -> Result<unrar_ng::OpenArchive<unrar_ng::List, unrar_ng::CursorBeforeHeader>> {
        RarArchive::new(source)
            .open_for_listing()
            .map_err(|error| RomWeaverError::Validation(format!("rar archive is invalid: {error}")))
    }

    fn open_for_processing(
        &self,
        source: &Path,
    ) -> Result<unrar_ng::OpenArchive<unrar_ng::Process, unrar_ng::CursorBeforeHeader>> {
        RarArchive::new(source)
            .open_for_processing()
            .map_err(|error| RomWeaverError::Validation(format!("rar archive is invalid: {error}")))
    }
}

#[cfg(not(target_family = "wasm"))]
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
        let mut archive = self.open_for_listing(&request.source)?;
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut logical_bytes = 0u64;
        let mut entries_total = 0usize;

        while let Some(entry) = archive.read_header().map_err(|error| {
            RomWeaverError::Validation(format!("rar inspect failed while reading header: {error}"))
        })? {
            let header = entry.entry();
            entries_total = entries_total.saturating_add(1);
            if header.is_directory() {
                directories = directories.saturating_add(1);
            } else {
                files = files.saturating_add(1);
                logical_bytes = logical_bytes.saturating_add(header.unpacked_size);
            }
            let entry_name = normalize_archive_name(&header.filename.to_string_lossy());
            archive = entry.skip().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "rar inspect failed while skipping entry `{entry_name}`: {error}"
                ))
            })?;
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
        let mut archive = self.open_for_listing(&request.source)?;
        let mut entries = Vec::new();
        while let Some(entry) = archive.read_header().map_err(|error| {
            RomWeaverError::Validation(format!("rar list failed while reading header: {error}"))
        })? {
            let entry_name = normalize_archive_name(&entry.entry().filename.to_string_lossy());
            if !entry_name.is_empty() {
                entries.push(entry_name.clone());
            }
            archive = entry.skip().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "rar list failed while skipping entry `{entry_name}`: {error}"
                ))
            })?;
        }
        Ok(entries)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        fs::create_dir_all(&request.out_dir)?;

        let mut archive = self.open_for_processing(&request.source)?;
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut extracted_files = 0usize;
        let mut written_bytes = 0u64;

        while let Some(entry) = archive.read_header().map_err(|error| {
            RomWeaverError::Validation(format!("rar extract failed while reading header: {error}"))
        })? {
            let entry_name = normalize_archive_name(&entry.entry().filename.to_string_lossy());
            if entry_name.is_empty() || !selections.matches(&entry_name) {
                archive = entry.skip().map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "rar extract failed while skipping entry `{entry_name}`: {error}"
                    ))
                })?;
                continue;
            }

            let relative =
                sanitize_archive_relative_path_from_str(&entry.entry().filename.to_string_lossy())?;
            let output_path = request.out_dir.join(relative);

            if entry.entry().is_directory() {
                fs::create_dir_all(&output_path)?;
                archive = entry.skip().map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "rar extract failed while skipping directory `{entry_name}`: {error}"
                    ))
                })?;
                continue;
            }

            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)?;
            }
            archive = entry.extract_to(&output_path).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "rar extract failed for `{entry_name}`: {error}"
                ))
            })?;
            extracted_files = extracted_files.saturating_add(1);
            written_bytes = written_bytes.saturating_add(fs::metadata(&output_path)?.len());
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
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

const WUA_BLOCK_SIZE: usize = 64 * 1024;
const WUA_ENTRIES_PER_OFFSET_RECORD: usize = 16;
const WUA_OFFSET_RECORD_SIZE: usize = 8 + (2 * WUA_ENTRIES_PER_OFFSET_RECORD);
const WUA_TREE_ENTRY_SIZE: usize = 16;
const WUA_FOOTER_SIZE: usize = 144;
const WUA_FOOTER_MAGIC: u32 = 0x169F_52D6;
const WUA_FOOTER_VERSION: u32 = 0x61BF_3A01;
const WUA_INVALID_NAME_OFFSET: u32 = 0x7FFF_FFFF;
const WUA_CREATE_DEFAULT_LEVEL: i32 = 6;
const WUA_MAX_FILE_OFFSET_OR_SIZE: u64 = (1u64 << 48) - 1;

#[derive(Clone, Copy, Debug)]
struct WuaSectionRange {
    offset: u64,
    size: u64,
}

impl WuaSectionRange {
    fn is_within_file(&self, file_size: u64) -> bool {
        self.offset
            .checked_add(self.size)
            .is_some_and(|end| end <= file_size)
    }
}

#[derive(Clone, Debug)]
struct WuaFooter {
    section_compressed_data: WuaSectionRange,
    section_offset_records: WuaSectionRange,
    section_names: WuaSectionRange,
    section_file_tree: WuaSectionRange,
    section_meta_directory: WuaSectionRange,
    section_meta_data: WuaSectionRange,
    integrity_hash: [u8; 32],
    total_size: u64,
    version: u32,
    magic: u32,
}

impl WuaFooter {
    fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != WUA_FOOTER_SIZE {
            return Err(RomWeaverError::Validation(
                "wua footer has unexpected size".into(),
            ));
        }

        let mut cursor = 0usize;
        let section_compressed_data = Self::decode_section(bytes, &mut cursor)?;
        let section_offset_records = Self::decode_section(bytes, &mut cursor)?;
        let section_names = Self::decode_section(bytes, &mut cursor)?;
        let section_file_tree = Self::decode_section(bytes, &mut cursor)?;
        let section_meta_directory = Self::decode_section(bytes, &mut cursor)?;
        let section_meta_data = Self::decode_section(bytes, &mut cursor)?;

        let mut integrity_hash = [0u8; 32];
        integrity_hash.copy_from_slice(&bytes[cursor..cursor + 32]);
        cursor += 32;
        let total_size = Self::read_u64(bytes, &mut cursor)?;
        let version = Self::read_u32(bytes, &mut cursor)?;
        let magic = Self::read_u32(bytes, &mut cursor)?;

        Ok(Self {
            section_compressed_data,
            section_offset_records,
            section_names,
            section_file_tree,
            section_meta_directory,
            section_meta_data,
            integrity_hash,
            total_size,
            version,
            magic,
        })
    }

    fn decode_section(bytes: &[u8], cursor: &mut usize) -> Result<WuaSectionRange> {
        let offset = Self::read_u64(bytes, cursor)?;
        let size = Self::read_u64(bytes, cursor)?;
        Ok(WuaSectionRange { offset, size })
    }

    fn read_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32> {
        let end = cursor.saturating_add(4);
        let chunk = bytes
            .get(*cursor..end)
            .ok_or_else(|| RomWeaverError::Validation("wua footer is truncated".into()))?;
        *cursor = end;
        let mut raw = [0u8; 4];
        raw.copy_from_slice(chunk);
        Ok(u32::from_be_bytes(raw))
    }

    fn read_u64(bytes: &[u8], cursor: &mut usize) -> Result<u64> {
        let end = cursor.saturating_add(8);
        let chunk = bytes
            .get(*cursor..end)
            .ok_or_else(|| RomWeaverError::Validation("wua footer is truncated".into()))?;
        *cursor = end;
        let mut raw = [0u8; 8];
        raw.copy_from_slice(chunk);
        Ok(u64::from_be_bytes(raw))
    }

    fn validate(&self, file_size: u64) -> Result<()> {
        if self.magic != WUA_FOOTER_MAGIC {
            return Err(RomWeaverError::Validation(
                "wua footer magic does not match".into(),
            ));
        }
        if self.version != WUA_FOOTER_VERSION {
            return Err(RomWeaverError::Validation(format!(
                "wua footer version `{:#X}` is unsupported",
                self.version
            )));
        }
        if self.total_size != file_size {
            return Err(RomWeaverError::Validation(format!(
                "wua footer size mismatch: footer reports {}, file size is {}",
                self.total_size, file_size
            )));
        }
        let ranges = [
            self.section_compressed_data,
            self.section_offset_records,
            self.section_names,
            self.section_file_tree,
            self.section_meta_directory,
            self.section_meta_data,
        ];
        if ranges.iter().any(|range| !range.is_within_file(file_size)) {
            return Err(RomWeaverError::Validation(
                "wua footer contains out-of-range section offsets".into(),
            ));
        }
        if self.section_offset_records.size % (WUA_OFFSET_RECORD_SIZE as u64) != 0 {
            return Err(RomWeaverError::Validation(
                "wua offset record table is misaligned".into(),
            ));
        }
        if self.section_file_tree.size % (WUA_TREE_ENTRY_SIZE as u64) != 0 {
            return Err(RomWeaverError::Validation(
                "wua file tree table is misaligned".into(),
            ));
        }
        Ok(())
    }

    fn encode_with_hash(&self, integrity_hash: [u8; 32]) -> [u8; WUA_FOOTER_SIZE] {
        let mut out = [0u8; WUA_FOOTER_SIZE];
        let mut cursor = 0usize;

        Self::write_section(&mut out, &mut cursor, self.section_compressed_data);
        Self::write_section(&mut out, &mut cursor, self.section_offset_records);
        Self::write_section(&mut out, &mut cursor, self.section_names);
        Self::write_section(&mut out, &mut cursor, self.section_file_tree);
        Self::write_section(&mut out, &mut cursor, self.section_meta_directory);
        Self::write_section(&mut out, &mut cursor, self.section_meta_data);
        out[cursor..cursor + 32].copy_from_slice(&integrity_hash);
        cursor += 32;
        Self::write_u64(&mut out, &mut cursor, self.total_size);
        Self::write_u32(&mut out, &mut cursor, self.version);
        Self::write_u32(&mut out, &mut cursor, self.magic);
        out
    }

    fn write_section(out: &mut [u8], cursor: &mut usize, section: WuaSectionRange) {
        Self::write_u64(out, cursor, section.offset);
        Self::write_u64(out, cursor, section.size);
    }

    fn write_u32(out: &mut [u8], cursor: &mut usize, value: u32) {
        let end = *cursor + 4;
        out[*cursor..end].copy_from_slice(&value.to_be_bytes());
        *cursor = end;
    }

    fn write_u64(out: &mut [u8], cursor: &mut usize, value: u64) {
        let end = *cursor + 8;
        out[*cursor..end].copy_from_slice(&value.to_be_bytes());
        *cursor = end;
    }
}

#[derive(Clone, Copy, Debug)]
struct WuaCompressionOffsetRecord {
    base_offset: u64,
    size: [u16; WUA_ENTRIES_PER_OFFSET_RECORD],
}

impl WuaCompressionOffsetRecord {
    fn decode_many(bytes: &[u8]) -> Result<Vec<Self>> {
        if bytes.is_empty() || bytes.len() % WUA_OFFSET_RECORD_SIZE != 0 {
            return Err(RomWeaverError::Validation(
                "wua offset records are malformed".into(),
            ));
        }
        let mut records = Vec::with_capacity(bytes.len() / WUA_OFFSET_RECORD_SIZE);
        for chunk in bytes.chunks_exact(WUA_OFFSET_RECORD_SIZE) {
            let mut base_raw = [0u8; 8];
            base_raw.copy_from_slice(&chunk[..8]);
            let mut size = [0u16; WUA_ENTRIES_PER_OFFSET_RECORD];
            for (index, value) in size.iter_mut().enumerate() {
                let offset = 8 + (index * 2);
                let mut raw = [0u8; 2];
                raw.copy_from_slice(&chunk[offset..offset + 2]);
                *value = u16::from_be_bytes(raw);
            }
            records.push(Self {
                base_offset: u64::from_be_bytes(base_raw),
                size,
            });
        }
        Ok(records)
    }

    fn encode_many(records: &[Self]) -> Vec<u8> {
        let mut out = Vec::with_capacity(records.len() * WUA_OFFSET_RECORD_SIZE);
        for record in records {
            out.extend_from_slice(&record.base_offset.to_be_bytes());
            for size in &record.size {
                out.extend_from_slice(&size.to_be_bytes());
            }
        }
        out
    }
}

#[derive(Clone, Copy, Debug)]
struct WuaFileTreeEntry {
    name_offset_and_type: u32,
    value_a: u32,
    value_b: u32,
    value_c: u32,
}

impl WuaFileTreeEntry {
    fn decode_many(bytes: &[u8]) -> Result<Vec<Self>> {
        if bytes.is_empty() || bytes.len() % WUA_TREE_ENTRY_SIZE != 0 {
            return Err(RomWeaverError::Validation(
                "wua file tree is malformed".into(),
            ));
        }
        let mut entries = Vec::with_capacity(bytes.len() / WUA_TREE_ENTRY_SIZE);
        for chunk in bytes.chunks_exact(WUA_TREE_ENTRY_SIZE) {
            let mut raw = [0u8; 4];
            raw.copy_from_slice(&chunk[0..4]);
            let name_offset_and_type = u32::from_be_bytes(raw);
            raw.copy_from_slice(&chunk[4..8]);
            let value_a = u32::from_be_bytes(raw);
            raw.copy_from_slice(&chunk[8..12]);
            let value_b = u32::from_be_bytes(raw);
            raw.copy_from_slice(&chunk[12..16]);
            let value_c = u32::from_be_bytes(raw);
            entries.push(Self {
                name_offset_and_type,
                value_a,
                value_b,
                value_c,
            });
        }
        Ok(entries)
    }

    fn encode_many(entries: &[Self]) -> Vec<u8> {
        let mut out = Vec::with_capacity(entries.len() * WUA_TREE_ENTRY_SIZE);
        for entry in entries {
            out.extend_from_slice(&entry.name_offset_and_type.to_be_bytes());
            out.extend_from_slice(&entry.value_a.to_be_bytes());
            out.extend_from_slice(&entry.value_b.to_be_bytes());
            out.extend_from_slice(&entry.value_c.to_be_bytes());
        }
        out
    }

    fn is_file(&self) -> bool {
        (self.name_offset_and_type & 0x8000_0000) != 0
    }

    fn name_offset(&self) -> u32 {
        self.name_offset_and_type & 0x7FFF_FFFF
    }

    fn file_offset(&self) -> u64 {
        u64::from(self.value_a) | (u64::from(self.value_c & 0x0000_FFFF) << 32)
    }

    fn file_size(&self) -> u64 {
        u64::from(self.value_b) | (u64::from(self.value_c & 0xFFFF_0000) << 16)
    }

    fn directory_start(&self) -> usize {
        self.value_a as usize
    }

    fn directory_count(&self) -> usize {
        self.value_b as usize
    }
}

#[derive(Clone, Debug)]
enum WuaEntryKind {
    File { file_offset: u64, file_size: u64 },
    Directory,
}

#[derive(Clone, Debug)]
struct WuaArchiveEntry {
    path: String,
    kind: WuaEntryKind,
}

struct WuaArchive {
    file: File,
    compressed_data_offset: u64,
    compressed_data_size: u64,
    offset_records: Vec<WuaCompressionOffsetRecord>,
    names: Vec<u8>,
    tree: Vec<WuaFileTreeEntry>,
    cached_block_index: Option<u64>,
    cached_block_data: Vec<u8>,
    compressed_block_data: Vec<u8>,
}

impl WuaArchive {
    fn open(source: &Path) -> Result<Self> {
        let mut file = File::open(source)?;
        let file_size = file.metadata()?.len();
        if file_size <= WUA_FOOTER_SIZE as u64 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` is too small to be a wua archive",
                source.display()
            )));
        }

        let mut footer_raw = [0u8; WUA_FOOTER_SIZE];
        file.seek(SeekFrom::End(-(WUA_FOOTER_SIZE as i64)))?;
        file.read_exact(&mut footer_raw)?;
        let footer = WuaFooter::decode(&footer_raw)?;
        footer.validate(file_size)?;

        let offset_records_bytes = Self::read_section(&mut file, footer.section_offset_records)?;
        let offset_records = WuaCompressionOffsetRecord::decode_many(&offset_records_bytes)?;
        let names = Self::read_section(&mut file, footer.section_names)?;
        let file_tree_bytes = Self::read_section(&mut file, footer.section_file_tree)?;
        let tree = WuaFileTreeEntry::decode_many(&file_tree_bytes)?;
        if tree.is_empty() {
            return Err(RomWeaverError::Validation(
                "wua archive has an empty file tree".into(),
            ));
        }
        if tree[0].is_file() {
            return Err(RomWeaverError::Validation(
                "wua archive root node is not a directory".into(),
            ));
        }

        let archive = Self {
            file,
            compressed_data_offset: footer.section_compressed_data.offset,
            compressed_data_size: footer.section_compressed_data.size,
            offset_records,
            names,
            tree,
            cached_block_index: None,
            cached_block_data: vec![0u8; WUA_BLOCK_SIZE],
            compressed_block_data: Vec::new(),
        };

        let root_name = archive.decode_name(archive.tree[0].name_offset())?;
        if !root_name.is_empty() {
            return Err(RomWeaverError::Validation(
                "wua archive root node must not have a name".into(),
            ));
        }

        Ok(archive)
    }

    fn read_section(file: &mut File, section: WuaSectionRange) -> Result<Vec<u8>> {
        let size = usize::try_from(section.size)
            .map_err(|_| RomWeaverError::Validation("wua section is too large to read".into()))?;
        let mut data = vec![0u8; size];
        file.seek(SeekFrom::Start(section.offset))?;
        file.read_exact(&mut data)?;
        Ok(data)
    }

    fn decode_name(&self, name_offset: u32) -> Result<String> {
        if name_offset == WUA_INVALID_NAME_OFFSET {
            return Ok(String::new());
        }
        let offset = usize::try_from(name_offset).map_err(|_| {
            RomWeaverError::Validation("wua name offset exceeds supported range".into())
        })?;
        if offset >= self.names.len() {
            return Err(RomWeaverError::Validation(format!(
                "wua name offset `{name_offset}` is out of range"
            )));
        }

        let mut cursor = offset;
        let first = self.names[cursor];
        let mut name_len = usize::from(first & 0x7F);
        cursor += 1;
        if (first & 0x80) != 0 {
            if cursor >= self.names.len() {
                return Err(RomWeaverError::Validation(
                    "wua name table is truncated".into(),
                ));
            }
            name_len |= usize::from(self.names[cursor]) << 7;
            cursor += 1;
        }

        let end = cursor
            .checked_add(name_len)
            .ok_or_else(|| RomWeaverError::Validation("wua name length overflowed".into()))?;
        if end > self.names.len() {
            return Err(RomWeaverError::Validation(
                "wua name table entry extends past table bounds".into(),
            ));
        }

        Ok(String::from_utf8_lossy(&self.names[cursor..end]).into_owned())
    }

    fn collect_entries(&self) -> Result<Vec<WuaArchiveEntry>> {
        let mut entries = Vec::new();
        self.collect_entries_from_directory(0, "", &mut entries)?;
        Ok(entries)
    }

    fn collect_entries_from_directory(
        &self,
        directory_index: usize,
        prefix: &str,
        entries: &mut Vec<WuaArchiveEntry>,
    ) -> Result<()> {
        let directory = self.tree.get(directory_index).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "wua directory index `{directory_index}` is out of range"
            ))
        })?;
        if directory.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "wua tree index `{directory_index}` is unexpectedly a file"
            )));
        }

        let start = directory.directory_start();
        let end = start
            .checked_add(directory.directory_count())
            .ok_or_else(|| {
                RomWeaverError::Validation("wua directory entry range overflowed".into())
            })?;
        if end > self.tree.len() {
            return Err(RomWeaverError::Validation(format!(
                "wua directory range `{start}..{end}` is out of bounds"
            )));
        }

        for index in start..end {
            let child = &self.tree[index];
            let name = self.decode_name(child.name_offset())?;
            if name.is_empty() {
                return Err(RomWeaverError::Validation(
                    "wua entry contains an empty name".into(),
                ));
            }
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };

            if child.is_file() {
                entries.push(WuaArchiveEntry {
                    path,
                    kind: WuaEntryKind::File {
                        file_offset: child.file_offset(),
                        file_size: child.file_size(),
                    },
                });
            } else {
                entries.push(WuaArchiveEntry {
                    path: path.clone(),
                    kind: WuaEntryKind::Directory,
                });
                self.collect_entries_from_directory(index, &path, entries)?;
            }
        }

        Ok(())
    }

    fn block_count(&self) -> u64 {
        (self.offset_records.len() as u64) * (WUA_ENTRIES_PER_OFFSET_RECORD as u64)
    }

    fn read_block(&mut self, block_index: u64) -> Result<()> {
        if self.cached_block_index == Some(block_index) {
            return Ok(());
        }
        if block_index >= self.block_count() {
            return Err(RomWeaverError::Validation(format!(
                "wua block index `{block_index}` is out of range"
            )));
        }

        let record_index = usize::try_from(block_index / (WUA_ENTRIES_PER_OFFSET_RECORD as u64))
            .map_err(|_| RomWeaverError::Validation("wua record index overflowed".into()))?;
        let record_sub_index = usize::try_from(
            block_index % (WUA_ENTRIES_PER_OFFSET_RECORD as u64),
        )
        .map_err(|_| RomWeaverError::Validation("wua record sub-index overflowed".into()))?;
        let record = self.offset_records.get(record_index).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "wua offset record `{record_index}` is out of range"
            ))
        })?;

        let mut compressed_offset = record.base_offset;
        for size in &record.size[..record_sub_index] {
            compressed_offset = compressed_offset
                .checked_add(u64::from(*size) + 1)
                .ok_or_else(|| {
                    RomWeaverError::Validation("wua compressed offset overflowed".into())
                })?;
        }
        let compressed_size = usize::from(record.size[record_sub_index]) + 1;
        let compressed_size_u64 = u64::try_from(compressed_size).map_err(|_| {
            RomWeaverError::Validation("wua compressed block size overflowed".into())
        })?;
        if compressed_offset
            .checked_add(compressed_size_u64)
            .is_none_or(|end| end > self.compressed_data_size)
        {
            return Err(RomWeaverError::Validation(format!(
                "wua block `{block_index}` exceeds compressed data bounds"
            )));
        }

        self.file.seek(SeekFrom::Start(
            self.compressed_data_offset + compressed_offset,
        ))?;
        if compressed_size == WUA_BLOCK_SIZE {
            self.file.read_exact(&mut self.cached_block_data)?;
        } else {
            self.compressed_block_data.resize(compressed_size, 0);
            self.file.read_exact(&mut self.compressed_block_data)?;
            let decompressed = zstd::bulk::decompress(&self.compressed_block_data, WUA_BLOCK_SIZE)
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "wua block `{block_index}` failed to decompress: {error}"
                    ))
                })?;
            if decompressed.len() != WUA_BLOCK_SIZE {
                return Err(RomWeaverError::Validation(format!(
                    "wua block `{block_index}` decompressed to {} bytes, expected {}",
                    decompressed.len(),
                    WUA_BLOCK_SIZE
                )));
            }
            self.cached_block_data.copy_from_slice(&decompressed);
        }

        self.cached_block_index = Some(block_index);
        Ok(())
    }

    fn read_file_into_writer<W: Write>(
        &mut self,
        file_offset: u64,
        file_size: u64,
        writer: &mut W,
    ) -> Result<u64> {
        let mut written = 0u64;
        let mut source_offset = file_offset;
        let mut remaining = file_size;
        while remaining > 0 {
            let block_index = source_offset / (WUA_BLOCK_SIZE as u64);
            let block_offset = usize::try_from(source_offset % (WUA_BLOCK_SIZE as u64))
                .map_err(|_| RomWeaverError::Validation("wua block offset overflowed".into()))?;
            self.read_block(block_index)?;

            let chunk = remaining.min((WUA_BLOCK_SIZE - block_offset) as u64) as usize;
            writer.write_all(&self.cached_block_data[block_offset..block_offset + chunk])?;
            source_offset = source_offset
                .checked_add(chunk as u64)
                .ok_or_else(|| RomWeaverError::Validation("wua source offset overflowed".into()))?;
            remaining -= chunk as u64;
            written += chunk as u64;
        }
        Ok(written)
    }
}

#[derive(Clone, Debug)]
struct WuaWriteNode {
    is_file: bool,
    name_index: Option<u32>,
    children: Vec<usize>,
    file_offset: u64,
    file_size: u64,
    node_start_index: u32,
}

impl WuaWriteNode {
    fn new_root() -> Self {
        Self {
            is_file: false,
            name_index: None,
            children: Vec::new(),
            file_offset: 0,
            file_size: 0,
            node_start_index: 0,
        }
    }

    fn new_directory(name_index: u32) -> Self {
        Self {
            is_file: false,
            name_index: Some(name_index),
            children: Vec::new(),
            file_offset: 0,
            file_size: 0,
            node_start_index: 0,
        }
    }

    fn new_file(name_index: u32, file_offset: u64, file_size: u64) -> Self {
        Self {
            is_file: true,
            name_index: Some(name_index),
            children: Vec::new(),
            file_offset,
            file_size,
            node_start_index: 0,
        }
    }
}

struct WuaContainerHandler;

impl WuaContainerHandler {
    fn parse_codec_and_level(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<Option<i32>> {
        match parse_requested_codec(codec) {
            RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Zstd) => {
                let level = level.unwrap_or(WUA_CREATE_DEFAULT_LEVEL);
                if !(-7..=22).contains(&level) {
                    return Err(RomWeaverError::Validation(format!(
                        "wua zstd level `{level}` is out of range (-7..=22)"
                    )));
                }
                Ok(Some(level))
            }
            RequestedCodec::Known(CanonicalCodec::Store) => {
                if level.is_some() {
                    return Err(RomWeaverError::Validation(
                        "wua codec `store` does not accept --level".into(),
                    ));
                }
                Ok(None)
            }
            RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                "unsupported wua codec `{}`; supported codecs are zstd and store",
                codec.name()
            ))),
            RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                "unsupported wua codec `{name}`; supported codecs are zstd and store"
            ))),
        }
    }

    fn probe_signature(&self, source: &Path) -> bool {
        let mut file = match File::open(source) {
            Ok(file) => file,
            Err(_) => return false,
        };
        let file_size = match file.metadata() {
            Ok(metadata) => metadata.len(),
            Err(_) => return false,
        };
        if file_size <= WUA_FOOTER_SIZE as u64 {
            return false;
        }
        if file.seek(SeekFrom::End(-(WUA_FOOTER_SIZE as i64))).is_err() {
            return false;
        }
        let mut footer_raw = [0u8; WUA_FOOTER_SIZE];
        if file.read_exact(&mut footer_raw).is_err() {
            return false;
        }
        let Ok(footer) = WuaFooter::decode(&footer_raw) else {
            return false;
        };
        footer.magic == WUA_FOOTER_MAGIC
            && footer.version == WUA_FOOTER_VERSION
            && footer.total_size == file_size
    }
}

impl ContainerHandler for WuaContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &WUA
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.probe_signature(source) {
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
        let archive = WuaArchive::open(&request.source)?;
        let entries = archive.collect_entries()?;
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut logical_bytes = 0u64;
        for entry in &entries {
            match entry.kind {
                WuaEntryKind::Directory => directories += 1,
                WuaEntryKind::File { file_size, .. } => {
                    files += 1;
                    logical_bytes = logical_bytes.saturating_add(file_size);
                }
            }
        }
        let compressed_bytes = fs::metadata(&request.source)?.len();

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WUA.name.to_string()),
            "inspect",
            format!(
                "wua: {} entries ({} files, {} directories), {} bytes compressed, {} bytes uncompressed",
                entries.len(),
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
        let archive = WuaArchive::open(&request.source)?;
        Ok(archive
            .collect_entries()?
            .into_iter()
            .map(|entry| entry.path)
            .collect())
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        fs::create_dir_all(&request.out_dir)?;

        let mut archive = WuaArchive::open(&request.source)?;
        let entries = archive.collect_entries()?;
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut extracted_files = 0usize;
        let mut written_bytes = 0u64;

        for entry in entries {
            if !selections.matches(&entry.path) {
                continue;
            }
            let relative = sanitize_archive_relative_path_from_str(&entry.path)?;
            let output_path = request.out_dir.join(relative);
            match entry.kind {
                WuaEntryKind::Directory => {
                    fs::create_dir_all(&output_path)?;
                }
                WuaEntryKind::File {
                    file_offset,
                    file_size,
                } => {
                    if let Some(parent) = output_path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    let mut output = BufWriter::new(File::create(&output_path)?);
                    let copied =
                        archive.read_file_into_writer(file_offset, file_size, &mut output)?;
                    output.flush()?;
                    extracted_files += 1;
                    written_bytes = written_bytes.saturating_add(copied);
                }
            }
        }

        selections.ensure_all_matched()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WUA.name.to_string()),
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let compression_level =
            self.parse_codec_and_level(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;
        let logical_bytes = entries
            .iter()
            .filter(|entry| !entry.is_dir)
            .map(|entry| fs::metadata(&entry.source).map(|metadata| metadata.len()))
            .collect::<io::Result<Vec<_>>>()?
            .into_iter()
            .sum::<u64>();

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut output = BufWriter::new(File::create(&request.output)?);
        let mut hasher = Sha256::new();
        let mut bytes_written = 0u64;

        let mut nodes = vec![WuaWriteNode::new_root()];
        let mut names = Vec::<String>::new();
        let mut name_lookup = BTreeMap::<String, u32>::new();

        let mut current_input_offset = 0u64;
        for entry in &entries {
            let components = entry
                .archive_name
                .split('/')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            if components.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "wua cannot represent empty path `{}`",
                    entry.archive_name
                )));
            }

            let mut current = 0usize;
            let terminal = if entry.is_dir {
                components.len()
            } else {
                components.len().saturating_sub(1)
            };
            for name in &components[..terminal] {
                let existing = nodes[current].children.iter().copied().find(|index| {
                    nodes[*index]
                        .name_index
                        .and_then(|name_index| names.get(name_index as usize))
                        .is_some_and(|existing_name| existing_name.eq_ignore_ascii_case(name))
                });
                if let Some(index) = existing {
                    if nodes[index].is_file {
                        return Err(RomWeaverError::Validation(format!(
                            "wua create path collision at `{}`",
                            entry.archive_name
                        )));
                    }
                    current = index;
                } else {
                    let name_index = wua_create_name_entry(name, &mut names, &mut name_lookup)?;
                    let index = nodes.len();
                    nodes.push(WuaWriteNode::new_directory(name_index));
                    nodes[current].children.push(index);
                    current = index;
                }
            }

            let name = *components.last().expect("components non-empty");
            let existing = nodes[current].children.iter().copied().find(|index| {
                nodes[*index]
                    .name_index
                    .and_then(|name_index| names.get(name_index as usize))
                    .is_some_and(|existing_name| existing_name.eq_ignore_ascii_case(name))
            });
            if entry.is_dir {
                if let Some(index) = existing {
                    if nodes[index].is_file {
                        return Err(RomWeaverError::Validation(format!(
                            "wua create path collision at `{}`",
                            entry.archive_name
                        )));
                    }
                } else {
                    let name_index = wua_create_name_entry(name, &mut names, &mut name_lookup)?;
                    let index = nodes.len();
                    nodes.push(WuaWriteNode::new_directory(name_index));
                    nodes[current].children.push(index);
                }
                continue;
            }

            if existing.is_some() {
                return Err(RomWeaverError::Validation(format!(
                    "wua create path collision at `{}`",
                    entry.archive_name
                )));
            }

            let file_size = fs::metadata(&entry.source)?.len();
            if file_size > WUA_MAX_FILE_OFFSET_OR_SIZE {
                return Err(RomWeaverError::Validation(format!(
                    "wua cannot store `{}` because it exceeds the per-file 48-bit size limit",
                    entry.source.display()
                )));
            }
            if current_input_offset > WUA_MAX_FILE_OFFSET_OR_SIZE {
                return Err(RomWeaverError::Validation(
                    "wua combined input stream exceeded the 48-bit offset limit".into(),
                ));
            }
            let name_index = wua_create_name_entry(name, &mut names, &mut name_lookup)?;
            let index = nodes.len();
            nodes.push(WuaWriteNode::new_file(
                name_index,
                current_input_offset,
                file_size,
            ));
            nodes[current].children.push(index);
            current_input_offset = current_input_offset
                .checked_add(file_size)
                .ok_or_else(|| RomWeaverError::Validation("wua input offset overflowed".into()))?;
            if current_input_offset > (WUA_MAX_FILE_OFFSET_OR_SIZE + 1) {
                return Err(RomWeaverError::Validation(
                    "wua combined input stream exceeded the 48-bit offset limit".into(),
                ));
            }
        }

        for index in 0..nodes.len() {
            let mut children = nodes[index].children.clone();
            children.sort_by(|left, right| {
                let left_name = nodes[*left]
                    .name_index
                    .and_then(|name_index| names.get(name_index as usize))
                    .map(String::as_str)
                    .unwrap_or("");
                let right_name = nodes[*right]
                    .name_index
                    .and_then(|name_index| names.get(name_index as usize))
                    .map(String::as_str)
                    .unwrap_or("");
                compare_archive_name_case_insensitive(left_name, right_name)
            });
            nodes[index].children = children;
        }

        let mut pending_block = Vec::<u8>::new();
        let mut offset_records = Vec::<WuaCompressionOffsetRecord>::new();
        let mut blocks_written = 0usize;
        let mut compressed_data_bytes = 0u64;

        let write_bytes = |buffer: &[u8],
                           output: &mut BufWriter<File>,
                           hasher: &mut Sha256,
                           bytes_written: &mut u64|
         -> Result<()> {
            output.write_all(buffer)?;
            hasher.update(buffer);
            *bytes_written = bytes_written
                .checked_add(buffer.len() as u64)
                .ok_or_else(|| RomWeaverError::Validation("wua output size overflowed".into()))?;
            Ok(())
        };

        let flush_block = |block: &[u8],
                           level: Option<i32>,
                           output: &mut BufWriter<File>,
                           hasher: &mut Sha256,
                           bytes_written: &mut u64,
                           compressed_data_bytes: &mut u64,
                           offset_records: &mut Vec<WuaCompressionOffsetRecord>,
                           blocks_written: &mut usize|
         -> Result<()> {
            let compressed = if let Some(level) = level {
                zstd::bulk::compress(block, level).map_err(|error| {
                    RomWeaverError::Validation(format!("wua block compression failed: {error}"))
                })?
            } else {
                Vec::new()
            };

            let chosen = if compression_level.is_some() && compressed.len() < block.len() {
                compressed.as_slice()
            } else {
                block
            };

            if chosen.len() > usize::from(u16::MAX) + 1 {
                return Err(RomWeaverError::Validation(
                    "wua block exceeded supported compressed size".into(),
                ));
            }

            if (*blocks_written % WUA_ENTRIES_PER_OFFSET_RECORD) == 0 {
                offset_records.push(WuaCompressionOffsetRecord {
                    base_offset: *compressed_data_bytes,
                    size: [0u16; WUA_ENTRIES_PER_OFFSET_RECORD],
                });
            }

            let record_index = *blocks_written / WUA_ENTRIES_PER_OFFSET_RECORD;
            let record_sub_index = *blocks_written % WUA_ENTRIES_PER_OFFSET_RECORD;
            offset_records[record_index].size[record_sub_index] = u16::try_from(chosen.len() - 1)
                .map_err(|_| {
                RomWeaverError::Validation(
                    "wua block size exceeded supported offset record range".into(),
                )
            })?;

            write_bytes(chosen, output, hasher, bytes_written)?;
            *compressed_data_bytes = compressed_data_bytes
                .checked_add(chosen.len() as u64)
                .ok_or_else(|| {
                    RomWeaverError::Validation("wua compressed size overflowed".into())
                })?;
            *blocks_written += 1;
            Ok(())
        };

        let mut buffer = vec![0u8; WUA_BLOCK_SIZE];
        for entry in entries.iter().filter(|entry| !entry.is_dir) {
            let mut input = BufReader::new(File::open(&entry.source)?);
            loop {
                let read = input.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                pending_block.extend_from_slice(&buffer[..read]);
                while pending_block.len() >= WUA_BLOCK_SIZE {
                    flush_block(
                        &pending_block[..WUA_BLOCK_SIZE],
                        compression_level,
                        &mut output,
                        &mut hasher,
                        &mut bytes_written,
                        &mut compressed_data_bytes,
                        &mut offset_records,
                        &mut blocks_written,
                    )?;
                    pending_block.drain(..WUA_BLOCK_SIZE);
                }
            }
        }

        if !pending_block.is_empty() {
            pending_block.resize(WUA_BLOCK_SIZE, 0);
            flush_block(
                &pending_block,
                compression_level,
                &mut output,
                &mut hasher,
                &mut bytes_written,
                &mut compressed_data_bytes,
                &mut offset_records,
                &mut blocks_written,
            )?;
            pending_block.clear();
        }

        while (bytes_written % 8) != 0 {
            write_bytes(&[0u8], &mut output, &mut hasher, &mut bytes_written)?;
        }

        let section_compressed_data = WuaSectionRange {
            offset: 0,
            size: compressed_data_bytes,
        };

        let section_offset_records = WuaSectionRange {
            offset: bytes_written,
            size: 0,
        };
        let offset_records_bytes = WuaCompressionOffsetRecord::encode_many(&offset_records);
        write_bytes(
            &offset_records_bytes,
            &mut output,
            &mut hasher,
            &mut bytes_written,
        )?;
        let section_offset_records = WuaSectionRange {
            offset: section_offset_records.offset,
            size: bytes_written - section_offset_records.offset,
        };

        let section_names = WuaSectionRange {
            offset: bytes_written,
            size: 0,
        };
        let mut name_offsets = vec![0u32; names.len()];
        let mut name_table = Vec::<u8>::new();
        for (index, name) in names.iter().enumerate() {
            let offset = u32::try_from(name_table.len()).map_err(|_| {
                RomWeaverError::Validation("wua name table exceeded supported size".into())
            })?;
            name_offsets[index] = offset;
            let mut name_bytes = name.as_bytes();
            if name_bytes.len() > 0x7FFF {
                name_bytes = &name_bytes[..0x7FFF];
            }
            if name_bytes.len() >= 0x80 {
                name_table.push((name_bytes.len() as u8 & 0x7F) | 0x80);
                name_table.push((name_bytes.len() >> 7) as u8);
            } else {
                name_table.push(name_bytes.len() as u8);
            }
            name_table.extend_from_slice(name_bytes);
        }
        write_bytes(&name_table, &mut output, &mut hasher, &mut bytes_written)?;
        let section_names = WuaSectionRange {
            offset: section_names.offset,
            size: bytes_written - section_names.offset,
        };

        let mut bfs_nodes = Vec::<usize>::new();
        let mut queue = vec![0usize];
        let mut cursor = 0usize;
        while cursor < queue.len() {
            let node_index = queue[cursor];
            cursor += 1;
            bfs_nodes.push(node_index);
            for &child in &nodes[node_index].children {
                queue.push(child);
            }
        }

        let mut next_child_index = 1u32;
        for &node_index in &bfs_nodes {
            if nodes[node_index].is_file {
                nodes[node_index].node_start_index = u32::MAX;
                continue;
            }
            nodes[node_index].node_start_index = next_child_index;
            next_child_index = next_child_index
                .checked_add(
                    u32::try_from(nodes[node_index].children.len()).map_err(|_| {
                        RomWeaverError::Validation("wua directory child count overflowed".into())
                    })?,
                )
                .ok_or_else(|| {
                    RomWeaverError::Validation("wua file tree index overflowed".into())
                })?;
        }

        let section_file_tree = WuaSectionRange {
            offset: bytes_written,
            size: 0,
        };
        let mut file_tree = Vec::<WuaFileTreeEntry>::with_capacity(bfs_nodes.len());
        for &node_index in &bfs_nodes {
            let node = &nodes[node_index];
            let name_offset = match node.name_index {
                Some(name_index) => {
                    name_offsets
                        .get(name_index as usize)
                        .copied()
                        .ok_or_else(|| {
                            RomWeaverError::Validation("wua name offset table is invalid".into())
                        })?
                }
                None => WUA_INVALID_NAME_OFFSET,
            };
            let name_offset_and_type = if node.is_file {
                name_offset | 0x8000_0000
            } else {
                name_offset & 0x7FFF_FFFF
            };

            let entry = if node.is_file {
                let file_offset = node.file_offset;
                let file_size = node.file_size;
                WuaFileTreeEntry {
                    name_offset_and_type,
                    value_a: file_offset as u32,
                    value_b: file_size as u32,
                    value_c: ((file_size >> 16) as u32 & 0xFFFF_0000)
                        | ((file_offset >> 32) as u32 & 0x0000_FFFF),
                }
            } else {
                WuaFileTreeEntry {
                    name_offset_and_type,
                    value_a: node.node_start_index,
                    value_b: u32::try_from(node.children.len()).map_err(|_| {
                        RomWeaverError::Validation("wua directory child count overflowed".into())
                    })?,
                    value_c: 0,
                }
            };
            file_tree.push(entry);
        }
        let file_tree_bytes = WuaFileTreeEntry::encode_many(&file_tree);
        write_bytes(
            &file_tree_bytes,
            &mut output,
            &mut hasher,
            &mut bytes_written,
        )?;
        let section_file_tree = WuaSectionRange {
            offset: section_file_tree.offset,
            size: bytes_written - section_file_tree.offset,
        };

        let section_meta_directory = WuaSectionRange {
            offset: bytes_written,
            size: 0,
        };
        let section_meta_data = WuaSectionRange {
            offset: bytes_written,
            size: 0,
        };

        let mut footer = WuaFooter {
            section_compressed_data,
            section_offset_records,
            section_names,
            section_file_tree,
            section_meta_directory,
            section_meta_data,
            integrity_hash: [0u8; 32],
            total_size: bytes_written + (WUA_FOOTER_SIZE as u64),
            version: WUA_FOOTER_VERSION,
            magic: WUA_FOOTER_MAGIC,
        };
        let footer_zero = footer.encode_with_hash([0u8; 32]);
        hasher.update(footer_zero);
        let digest = hasher.finalize();
        footer.integrity_hash.copy_from_slice(&digest[..32]);
        let footer_bytes = footer.encode_with_hash(footer.integrity_hash);
        output.write_all(&footer_bytes)?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(WUA.name.to_string()),
            "create",
            format!(
                "created wua `{}` from {} input(s) (codec={}, {} bytes)",
                request.output.display(),
                request.inputs.len(),
                compression_level
                    .map(|level| format!("zstd:{level}"))
                    .unwrap_or_else(|| "store".to_string()),
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
            extract_threads: ThreadCapability::single_threaded(),
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
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(
                "xiso create currently requires exactly one input file".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let input = &request.inputs[0];
        let input_metadata = fs::metadata(input)?;
        if !input_metadata.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "xiso create input must be a file: `{}`",
                input.display()
            )));
        }

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut source_fs = self.open_source_filesystem(input)?;
        let output_file = File::create(&request.output)?;
        let mut output = BufWriter::new(output_file);
        create_xdvdfs_image(&mut source_fs, &mut output, |_| {}).map_err(|error| {
            RomWeaverError::Validation(format!(
                "xiso create failed while rebuilding `{}`: {error}",
                input.display()
            ))
        })?;
        output.flush()?;

        let output_bytes = fs::metadata(&request.output)?.len();
        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(XISO.name.to_string()),
            "create",
            format!(
                "created xiso `{}` from `{}` ({} bytes)",
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
            inspect: false,
            extract: false,
            create: true,
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

fn compare_archive_name_case_insensitive(left: &str, right: &str) -> Ordering {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();
    let min_len = left_bytes.len().min(right_bytes.len());
    for index in 0..min_len {
        let left_byte = left_bytes[index].to_ascii_lowercase();
        let right_byte = right_bytes[index].to_ascii_lowercase();
        if left_byte != right_byte {
            return left_byte.cmp(&right_byte);
        }
    }
    left_bytes.len().cmp(&right_bytes.len())
}

fn wua_create_name_entry(
    name: &str,
    names: &mut Vec<String>,
    name_lookup: &mut BTreeMap<String, u32>,
) -> Result<u32> {
    if let Some(index) = name_lookup.get(name) {
        return Ok(*index);
    }
    let index = u32::try_from(names.len()).map_err(|_| {
        RomWeaverError::Validation("wua contains too many unique path segments".into())
    })?;
    names.push(name.to_string());
    name_lookup.insert(name.to_string(), index);
    Ok(index)
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
        if !request.selections.is_empty() {
            return Err(RomWeaverError::Validation(
                "gcz extract does not support --select yet".into(),
            ));
        }

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
        let output_path = request.out_dir.join(self.extract_name(&request.source));
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

#[cfg(not(target_family = "wasm"))]
struct Z3dsContainerHandler;

#[cfg(not(target_family = "wasm"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Z3dsFileHeader {
    underlying_magic: [u8; 4],
    metadata_size: u32,
    compressed_size: u64,
    uncompressed_size: u64,
}

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
#[derive(Debug, Default)]
struct Z3dsMetadata {
    version: Option<u8>,
    item_names: Vec<String>,
}

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
struct Z3dsPayloadReader<R> {
    inner: R,
    start: u64,
    len: u64,
    pos: u64,
}

#[cfg(not(target_family = "wasm"))]
#[derive(Clone, Debug)]
struct Z3dsExtractTask {
    index: usize,
    offset: u64,
    len: u64,
    temp_path: PathBuf,
}

#[cfg(not(target_family = "wasm"))]
#[derive(Clone, Debug)]
struct Z3dsCreateTask {
    index: usize,
    offset: u64,
    len: u64,
    temp_path: PathBuf,
}

#[cfg(not(target_family = "wasm"))]
#[derive(Clone, Debug)]
struct Z3dsCompressedFrame {
    index: usize,
    decompressed_size: u32,
    compressed_size: u32,
    temp_path: PathBuf,
}

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
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
        let decode_result = pool.install(|| {
            tasks
                .par_iter()
                .map(|task| {
                    self.extract_chunk_task(&source, payload_start, header.compressed_size, task)
                })
                .collect::<Result<Vec<_>>>()
        });
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
        let compress_result = pool.install(|| {
            create_tasks
                .par_iter()
                .map(|task| self.compress_create_task(&source, level, task))
                .collect::<Result<Vec<_>>>()
        });
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

#[cfg(not(target_family = "wasm"))]
struct ChdContainerHandler;

#[cfg(not(target_family = "wasm"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HdGeometry {
    cylinders: u32,
    heads: u32,
    sectors: u32,
    bytes_per_sector: u32,
}

#[cfg(not(target_family = "wasm"))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct DiscLayout {
    kind: DiscKind,
    tracks: Vec<DiscTrack>,
}

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiscKind {
    CdRom,
    GdRom,
}

#[cfg(not(target_family = "wasm"))]
impl DiscKind {
    fn metadata_tag(self) -> u32 {
        match self {
            Self::CdRom => CDROM_TRACK_METADATA2_TAG,
            Self::GdRom => GDROM_TRACK_METADATA_TAG,
        }
    }
}

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum ChdCreateKind {
    Raw,
    HardDisk(HdGeometry),
    Dvd,
    Disc(DiscLayout),
    Av(AvProfile),
}

#[cfg(not(target_family = "wasm"))]
const CDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'C', b'D');
#[cfg(not(target_family = "wasm"))]
const CDROM_TRACK_METADATA_TAG: u32 = make_tag(b'C', b'H', b'T', b'R');
#[cfg(not(target_family = "wasm"))]
const GDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'G', b'T');
#[cfg(not(target_family = "wasm"))]
const AV_METADATA_TAG: u32 = make_tag(b'A', b'V', b'A', b'V');
#[cfg(not(target_family = "wasm"))]
const AV_LD_METADATA_TAG: u32 = make_tag(b'A', b'V', b'L', b'D');

#[cfg(not(target_family = "wasm"))]
enum ChdReadBackend {
    Native(ChdFile),
    Rust {
        metadata_by_tag_and_index: BTreeMap<(u32, u32), Vec<u8>>,
    },
}

#[cfg(not(target_family = "wasm"))]
struct ChdReadSession {
    source: PathBuf,
    header: rom_weaver_chd_sys::ChdHeader,
    media_kind: ChdMediaKind,
    backend: ChdReadBackend,
}

#[cfg(not(target_family = "wasm"))]
impl ChdReadSession {
    fn open(source: &Path) -> Result<Self> {
        match ChdFile::open(source, None) {
            Ok(chd) => {
                let media_kind = chd
                    .media_kind()
                    .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
                Ok(Self {
                    source: source.to_path_buf(),
                    header: chd.header(),
                    media_kind,
                    backend: ChdReadBackend::Native(chd),
                })
            }
            Err(native_error) => Self::open_rust(source).map_err(|fallback_error| {
                RomWeaverError::Validation(format!(
                    "failed to open chd `{}` with native backend ({native_error}); fallback decoder failed ({fallback_error})",
                    source.display()
                ))
            }),
        }
    }

    fn open_rust(source: &Path) -> std::result::Result<Self, String> {
        let file = File::open(source)
            .map_err(|error| format!("failed to open `{}`: {error}", source.display()))?;
        let mut reader = BufReader::new(file);
        let mut chd = chd::Chd::open(&mut reader, None)
            .map_err(|error| format!("failed to parse `{}`: {error}", source.display()))?;

        let header = Self::convert_header(chd.header());
        let mut metadata_by_tag_and_index = BTreeMap::new();
        let metadatas: Vec<chd::metadata::Metadata> = chd
            .metadata_refs()
            .try_into()
            .map_err(|error| format!("failed to read CHD metadata: {error}"))?;
        for metadata in metadatas {
            metadata_by_tag_and_index.insert((metadata.metatag, metadata.index), metadata.value);
        }
        let media_kind = Self::detect_media_kind(&metadata_by_tag_and_index);

        Ok(Self {
            source: source.to_path_buf(),
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

    fn convert_header(header: &chd::header::Header) -> rom_weaver_chd_sys::ChdHeader {
        let compression = match header {
            chd::header::Header::V1Header(value) | chd::header::Header::V2Header(value) => {
                [value.compression, 0, 0, 0]
            }
            chd::header::Header::V3Header(value) => [value.compression, 0, 0, 0],
            chd::header::Header::V4Header(value) => [value.compression, 0, 0, 0],
            chd::header::Header::V5Header(value) => value.compression,
        };
        rom_weaver_chd_sys::ChdHeader {
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

    fn header(&self) -> rom_weaver_chd_sys::ChdHeader {
        self.header
    }

    fn media_kind(&self) -> ChdMediaKind {
        self.media_kind
    }

    fn read_metadata(&self, tag: u32, index: u32) -> Result<Option<Vec<u8>>> {
        match &self.backend {
            ChdReadBackend::Native(chd) => chd
                .read_metadata(tag, index)
                .map_err(|error| RomWeaverError::Validation(error.to_string())),
            ChdReadBackend::Rust {
                metadata_by_tag_and_index,
            } => Ok(metadata_by_tag_and_index.get(&(tag, index)).cloned()),
        }
    }

    fn extract_to_file(&self, output_path: &Path) -> Result<rom_weaver_chd_sys::ChdHeader> {
        match &self.backend {
            ChdReadBackend::Native(_) => match ChdFile::extract_to_file(&self.source, None, output_path)
                .map_err(|error| RomWeaverError::Validation(error.to_string()))
            {
                Ok(header) => Ok(header),
                Err(native_error) => Self::extract_to_file_with_rust(
                    &self.source,
                    self.header.logical_bytes,
                    output_path,
                )
                .map_err(|fallback_error| {
                    RomWeaverError::Validation(format!(
                        "failed to extract chd `{}` with native backend ({native_error}); fallback decoder failed ({fallback_error})",
                        self.source.display()
                    ))
                })
                .map(|_| self.header),
            },
            ChdReadBackend::Rust { .. } => {
                Self::extract_to_file_with_rust(&self.source, self.header.logical_bytes, output_path)
                    .map_err(RomWeaverError::Validation)
                    .map(|_| self.header)
            }
        }
    }

    fn extract_to_file_with_rust(
        source: &Path,
        logical_bytes: u64,
        output_path: &Path,
    ) -> std::result::Result<(), String> {
        let file = File::open(source)
            .map_err(|error| format!("failed to open `{}`: {error}", source.display()))?;
        let mut reader = BufReader::new(file);
        let mut chd = chd::Chd::open(&mut reader, None)
            .map_err(|error| format!("failed to decode `{}`: {error}", source.display()))?;

        let mut output = File::create(output_path)
            .map_err(|error| format!("failed to create `{}`: {error}", output_path.display()))?;
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
                .map_err(|error| format!("failed to write `{}`: {error}", output_path.display()))?;
            remaining -= write_len as u64;
        }

        Ok(())
    }
}

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
impl ChdContainerHandler {
    const DEFAULT_HUNK_BYTES: u32 = 4096;
    const DVD_SECTOR_BYTES: u32 = 2048;
    const HD_SECTOR_BYTES: u32 = 512;
    const CD_FRAME_BYTES: u32 = CD_FRAME_SIZE;
    const CD_HUNK_BYTES: u32 = CD_FRAME_SIZE * 8;
    const ZLIB_LEVEL_MIN: i32 = 1;
    const ZLIB_LEVEL_MAX: i32 = 9;
    const ZSTD_LEVEL_MIN: i32 = -7;
    const LZMA_LEVEL_MIN: i32 = 0;
    const LZMA_LEVEL_MAX: i32 = 9;

    fn ensure_backend(&self) -> Result<()> {
        let info = build_info();
        if info.backend_available {
            Ok(())
        } else {
            Err(RomWeaverError::Unsupported(format!(
                "chd backend unavailable: {}",
                info.backend_name
            )))
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

    fn resolve_codec(&self, codec: Option<&str>, _create_kind: &ChdCreateKind) -> Result<ChdCodec> {
        self.map_codec(codec)
    }

    fn map_codec(&self, codec: Option<&str>) -> Result<ChdCodec> {
        let normalized = codec
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase());
        if let Some(value) = normalized.as_deref() {
            match value {
                "flac" => return Ok(ChdCodec::FLAC),
                "cdzl" => return Ok(ChdCodec::CD_ZLIB),
                "cdzs" => return Ok(ChdCodec::CD_ZSTD),
                "cdlz" => return Ok(ChdCodec::CD_LZMA),
                "cdfl" => return Ok(ChdCodec::CD_FLAC),
                "avhu" | "avhuff" => return Ok(ChdCodec::AVHUFF),
                _ => {}
            }
        }

        match parse_requested_codec(codec) {
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

    fn header_codec_label(&self, header: rom_weaver_chd_sys::ChdHeader) -> String {
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
                "REM" | "TITLE" | "PERFORMER" | "SONGWRITER" | "FLAGS" | "CATALOG" | "ISRC" => {}
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
                        "00" => tracks[track_index].index00_frames = Some(self.parse_msf(time)?),
                        "01" => tracks[track_index].index01_frames = Some(self.parse_msf(time)?),
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
                let candidate_start_frame = candidate.index00_frames.unwrap_or(candidate_index01);
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
        std::env::temp_dir().join(format!(
            "rom-weaver-{stem}-{}-{timestamp}{extension}",
            std::process::id()
        ))
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

    fn write_disc_metadata(&self, chd: &ChdFile, layout: &DiscLayout) -> Result<()> {
        for (index, track) in layout.tracks.iter().enumerate() {
            let pgtype = if track.pregap_has_data {
                format!("V{}", track.mode.metadata_label())
            } else {
                track.mode.metadata_label().to_string()
            };
            let mut metadata = match layout.kind {
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
            metadata.push(0);
            chd.write_metadata(rom_weaver_chd_sys::Metadata {
                tag: layout.kind.metadata_tag(),
                index: index as u32,
                flags: CHD_METADATA_FLAG_CHECKSUM,
                data: &metadata,
            })
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
        }
        Ok(())
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
        let extract_result = chd.extract_to_file(&temp_path);
        if extract_result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        let _ = extract_result?;

        let first_data_bytes = layout
            .tracks
            .first()
            .map(|track| track.mode.data_bytes())
            .unwrap_or(2352);
        let single_bin = layout
            .tracks
            .iter()
            .all(|track| track.mode.data_bytes() == first_data_bytes);
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
                    writer.write_all(format!("FILE \"{single_bin_name}\" BINARY\n").as_bytes())?;
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
                                format!("    INDEX 00 {}\n", self.format_msf(output_frame_offset))
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
                                format!("    PREGAP {}\n", self.format_msf(track.pregap_frames))
                                    .as_bytes(),
                            )?;
                            writer.write_all(
                                format!("    INDEX 01 {}\n", self.format_msf(output_frame_offset))
                                    .as_bytes(),
                            )?;
                        } else {
                            writer.write_all(
                                format!("    INDEX 01 {}\n", self.format_msf(output_frame_offset))
                                    .as_bytes(),
                            )?;
                        }
                        if track.postgap_frames > 0 {
                            writer.write_all(
                                format!("    POSTGAP {}\n", self.format_msf(track.postgap_frames))
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
                            writer
                                .write_all(format!("FILE \"{track_name}\" BINARY\n").as_bytes())?;
                            writer.write_all(
                                format!("  TRACK {:02} {}\n", track.number, track.mode.cue_label())
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

        let label = if !selection_requested && wrote_single_bin_output {
            let bin_path = request.out_dir.join(&single_bin_name);
            format!(
                "extracted `{}` to `{}` and `{}` (cd, {}){}",
                request.source.display(),
                cue_path.display(),
                bin_path.display(),
                self.header_codec_label(header),
                suffix
            )
        } else if !selection_requested {
            format!(
                "extracted `{}` to `{}` and per-track bin files (cd, {}){}",
                request.source.display(),
                cue_path.display(),
                self.header_codec_label(header),
                suffix
            )
        } else {
            let outputs = produced_outputs
                .iter()
                .map(|path| format!("`{}`", path.display()))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "extracted `{}` to selected outputs: {} (cd, {}){}",
                request.source.display(),
                outputs,
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
        let extract_result = chd.extract_to_file(&temp_path);
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

    fn create_uncompressed(
        &self,
        input: &Path,
        output: &Path,
        logical_bytes: u64,
        create_kind: &ChdCreateKind,
        compression_level: i32,
    ) -> Result<rom_weaver_chd_sys::ChdHeader> {
        let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, ChdCodec::NONE);
        let mut chd = ChdFile::create(
            output,
            None,
            &CreateOptions {
                logical_bytes,
                hunk_bytes,
                unit_bytes: self.unit_bytes(create_kind),
                compression: [ChdCodec::NONE; CHD_MAX_COMPRESSORS],
                compression_level,
            },
        )
        .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
        let mut reader = BufReader::new(File::open(input)?);
        let mut buffer = vec![0_u8; usize::try_from(chd.header().hunk_bytes).unwrap_or(4096)];

        for hunk_index in 0..chd.header().hunk_count {
            buffer.fill(0);
            let mut filled = 0;
            while filled < buffer.len() {
                let read = reader.read(&mut buffer[filled..])?;
                if read == 0 {
                    break;
                }
                filled += read;
            }
            chd.write_hunk(hunk_index, &buffer)
                .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
            if filled < buffer.len() {
                break;
            }
        }

        self.write_create_metadata(&chd, create_kind)?;
        chd.refresh_header()
            .map_err(|error| RomWeaverError::Validation(error.to_string()))
    }

    fn create_compressed(
        &self,
        input: &Path,
        output: &Path,
        logical_bytes: u64,
        create_kind: &ChdCreateKind,
        codec: ChdCodec,
        compression_level: i32,
    ) -> Result<rom_weaver_chd_sys::ChdHeader> {
        let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, codec);
        ChdFile::compress_file(
            input,
            output,
            None,
            &CreateOptions {
                logical_bytes,
                hunk_bytes,
                unit_bytes: self.unit_bytes(create_kind),
                compression: [codec, ChdCodec::NONE, ChdCodec::NONE, ChdCodec::NONE],
                compression_level,
            },
        )
        .map_err(|error| RomWeaverError::Validation(error.to_string()))?;

        let mut chd = ChdFile::open_writable(output, None)
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
        self.write_create_metadata(&chd, create_kind)?;
        chd.refresh_header()
            .map_err(|error| RomWeaverError::Validation(error.to_string()))
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

    fn unit_bytes(&self, create_kind: &ChdCreateKind) -> u32 {
        match create_kind {
            ChdCreateKind::Raw => 1,
            ChdCreateKind::HardDisk(geometry) => geometry.bytes_per_sector,
            ChdCreateKind::Dvd => Self::DVD_SECTOR_BYTES,
            ChdCreateKind::Disc(_) => Self::CD_FRAME_BYTES,
            ChdCreateKind::Av(_) => 1,
        }
    }

    fn hunk_bytes(&self, create_kind: &ChdCreateKind, logical_bytes: u64, codec: ChdCodec) -> u32 {
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

    fn ensure_multiple_of(&self, logical_bytes: u64, unit_bytes: u32, label: &str) -> Result<()> {
        if logical_bytes % u64::from(unit_bytes) == 0 {
            Ok(())
        } else {
            Err(RomWeaverError::Validation(format!(
                "{label} size must be a multiple of {unit_bytes} bytes"
            )))
        }
    }

    fn write_create_metadata(&self, chd: &ChdFile, create_kind: &ChdCreateKind) -> Result<()> {
        match create_kind {
            ChdCreateKind::Raw => Ok(()),
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
                chd.write_metadata(rom_weaver_chd_sys::Metadata {
                    tag: AV_METADATA_TAG,
                    index: 0,
                    flags: CHD_METADATA_FLAG_CHECKSUM,
                    data: &metadata,
                })
                .map_err(|error| RomWeaverError::Validation(error.to_string()))
            }
            ChdCreateKind::Dvd => chd
                .write_metadata(rom_weaver_chd_sys::Metadata {
                    tag: DVD_METADATA_TAG,
                    index: 0,
                    flags: CHD_METADATA_FLAG_CHECKSUM,
                    data: b"\0",
                })
                .map_err(|error| RomWeaverError::Validation(error.to_string())),
            ChdCreateKind::HardDisk(geometry) => {
                let mut metadata = format!(
                    "CYLS:{},HEADS:{},SECS:{},BPS:{}",
                    geometry.cylinders, geometry.heads, geometry.sectors, geometry.bytes_per_sector
                )
                .into_bytes();
                metadata.push(0);
                chd.write_metadata(rom_weaver_chd_sys::Metadata {
                    tag: HARD_DISK_METADATA_TAG,
                    index: 0,
                    flags: CHD_METADATA_FLAG_CHECKSUM,
                    data: &metadata,
                })
                .map_err(|error| RomWeaverError::Validation(error.to_string()))
            }
            ChdCreateKind::Disc(layout) => self.write_disc_metadata(chd, layout),
        }
    }
}

#[cfg(not(target_family = "wasm"))]
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
        let chd = ChdReadSession::open(&request.source)?;
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
        let chd = ChdReadSession::open(&request.source)?;
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let chd = ChdReadSession::open(&request.source)?;
        let media_kind = chd.media_kind();
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
        let header = chd.extract_to_file(&output_path)?;
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
        self.ensure_backend()?;
        if request.inputs.len() != 1 {
            return Err(RomWeaverError::Validation(
                "chd create currently requires exactly one input file".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let input = &request.inputs[0];
        let input_bytes = fs::metadata(input)?.len();
        let mut create_kind = self.infer_create_kind(input, input_bytes)?;
        let codec = self.resolve_codec(request.codec.as_deref(), &create_kind)?;
        if codec == ChdCodec::AVHUFF {
            create_kind = match create_kind {
                ChdCreateKind::Raw => ChdCreateKind::Av(self.infer_av_profile(input, input_bytes)?),
                ChdCreateKind::Av(profile) => ChdCreateKind::Av(profile),
                _ => {
                    return Err(RomWeaverError::Validation(
                        "chd codec `avhuff` currently supports only raw `chav` frame inputs".into(),
                    ));
                }
            };
        }
        let compression_level = self.resolve_compression_level(codec, request.level)?;
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

        let create_result = if codec == ChdCodec::NONE {
            self.create_uncompressed(
                source_path,
                &request.output,
                logical_bytes,
                &create_kind,
                compression_level,
            )
        } else {
            self.create_compressed(
                source_path,
                &request.output,
                logical_bytes,
                &create_kind,
                codec,
                compression_level,
            )
        };
        if let Some(path) = staged_input.as_ref() {
            let _ = fs::remove_file(path);
        }
        let header = create_result?;
        let created_chd = ChdFile::open(&request.output, None)
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;
        let media_kind = created_chd
            .media_kind()
            .map_err(|error| RomWeaverError::Validation(error.to_string()))?;

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
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::{Path, PathBuf},
        sync::Arc,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        CSO_DEFAULT_BLOCK_BYTES, ContainerCreateRequest, ContainerRegistry, WUA_FOOTER_MAGIC,
        WUA_FOOTER_SIZE, WUA_FOOTER_VERSION, Z3dsContainerHandler,
    };
    use ciso::write::write_ciso_image;
    use rom_weaver_core::{
        CancellationToken, NoopProgressSink, OperationContext, ThreadBudget, ThreadCapability,
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
                "zip", "7z", "zipx", "rar", "tar", "tar.gz", "tar.bz2", "tar.xz", "gz", "bz2",
                "xz", "zst", "cso", "chd", "wua", "gcz", "rvz", "z3ds", "xiso"
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
    fn cso_capabilities_are_extract_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("cso").expect("cso handler");
        let capabilities = handler.capabilities();
        assert!(capabilities.inspect);
        assert!(capabilities.extract);
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
    fn cso_create_returns_clear_error() {
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
                    codec: None,
                    level: None,
                },
                &test_context(&temp_dir, 1),
            )
            .expect_err("cso create should error");

        assert!(
            error
                .to_string()
                .contains("cso compression is not supported"),
            "unexpected error message: {error}"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn xiso_capabilities_are_create_only() {
        let registry = ContainerRegistry::new();
        let handler = registry.find_by_name("xiso").expect("xiso handler");
        let capabilities = handler.capabilities();
        assert!(!capabilities.inspect);
        assert!(!capabilities.extract);
        assert!(capabilities.create);
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
    fn probe_routes_wua_signature_even_with_wrong_extension() {
        let path = temp_file_path_with_extension("wua-signature", "zip");
        let mut bytes = vec![0u8; 64];
        let mut footer = [0u8; WUA_FOOTER_SIZE];
        let total_size = u64::try_from(bytes.len() + footer.len()).expect("size");
        footer[128..136].copy_from_slice(&total_size.to_be_bytes());
        footer[136..140].copy_from_slice(&WUA_FOOTER_VERSION.to_be_bytes());
        footer[140..144].copy_from_slice(&WUA_FOOTER_MAGIC.to_be_bytes());
        bytes.extend_from_slice(&footer);
        fs::write(&path, bytes).expect("fixture");

        let registry = ContainerRegistry::new();
        let handler = registry.probe(&path).expect("wua probe");
        assert_eq!(handler.descriptor().name, "wua");

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
    fn recommend_compress_format_returns_chd_for_unrecognized_inputs() {
        let path = temp_file_path_with_extension("recommend-chd", "bin");
        fs::write(&path, b"not-a-disc").expect("fixture");

        let registry = ContainerRegistry::new();
        let recommendation = registry.recommend_compress_format(&path);
        assert_eq!(recommendation.format_name, "chd");
        assert_eq!(recommendation.reason, "not-wii-gc-or-unrecognized");

        let _ = fs::remove_file(path);
    }
}
