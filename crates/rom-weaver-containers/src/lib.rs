use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use bzip2::{Compression as Bzip2Compression, read::BzDecoder as Bzip2Decoder, write::BzEncoder};
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
use rom_weaver_chd_sys::{
    CD_FRAME_SIZE, CDROM_TRACK_METADATA2_TAG, CHD_MAX_COMPRESSORS, CHD_METADATA_FLAG_CHECKSUM,
    ChdCodec, ChdFile, ChdMediaKind, CreateOptions, DVD_METADATA_TAG, GDROM_TRACK_METADATA_TAG,
    HARD_DISK_METADATA_TAG, build_info, make_tag,
};
use rom_weaver_codecs::{
    CanonicalCodec, RequestedCodec, normalize_codec_label, parse_requested_codec,
};
use rom_weaver_core::{
    ContainerCapabilities, ContainerCreateRequest, ContainerExtractRequest, ContainerHandler,
    ContainerInspectRequest, FormatDescriptor, OperationContext, OperationFamily, OperationReport,
    ProbeConfidence, Result, RomWeaverError, ThreadCapability,
};
use sevenz_rust::{
    Password as SevenZPassword, SevenZArchiveEntry, SevenZMethod, SevenZMethodConfiguration,
    SevenZReader, SevenZWriter,
};
use tar::{Archive as TarArchive, Builder as TarBuilder};
use unrar_ng::Archive as RarArchive;
use zip::{
    CompressionMethod as ZipCompressionMethod, ZipArchive as ZipFileArchive,
    ZipWriter as ZipFileWriter, write::FileOptions as ZipFileOptions,
};
use zstd::bulk::compress as zstd_compress;
use zstd::stream::{Decoder as ZstdDecoder, Encoder as ZstdEncoder};
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
const CHD: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "chd",
    aliases: &[],
    extensions: &[".chd"],
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
    extensions: &[".z3ds"],
};

pub struct ContainerRegistry {
    handlers: Vec<Arc<dyn ContainerHandler>>,
}

impl Default for ContainerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ContainerRegistry {
    pub fn new() -> Self {
        Self {
            handlers: vec![
                Arc::new(ZipContainerHandler::new(&ZIP, ZipContainerFlavor::Zip)),
                Arc::new(ZipContainerHandler::new(&ZIPX, ZipContainerFlavor::Zipx)),
                Arc::new(SevenZContainerHandler::new(&SEVEN_Z)),
                Arc::new(RarContainerHandler::new(&RAR)),
                Arc::new(TarContainerHandler::new(&TAR, TarCompression::None)),
                Arc::new(TarContainerHandler::new(&TAR_GZ, TarCompression::Gzip)),
                Arc::new(TarContainerHandler::new(&TAR_BZ2, TarCompression::Bzip2)),
                Arc::new(TarContainerHandler::new(&TAR_XZ, TarCompression::Xz)),
                Arc::new(StreamContainerHandler::new(&GZ, StreamCompression::Gzip)),
                Arc::new(StreamContainerHandler::new(&BZ2, StreamCompression::Bzip2)),
                Arc::new(StreamContainerHandler::new(&XZ, StreamCompression::Xz)),
                Arc::new(StreamContainerHandler::new(&ZST, StreamCompression::Zstd)),
                Arc::new(ChdContainerHandler),
                Arc::new(RvzContainerHandler),
                Arc::new(Z3dsContainerHandler),
            ],
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
        extension_match
    }

    pub fn find_by_name(&self, name: &str) -> Option<Arc<dyn ContainerHandler>> {
        self.handlers
            .iter()
            .find(|handler| handler.descriptor().matches_name(name))
            .cloned()
    }
}

const SEVEN_Z_SIGNATURE: [u8; 6] = [b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C];
const RAR4_SIGNATURE: [u8; 7] = [b'R', b'a', b'r', b'!', 0x1A, 0x07, 0x00];
const RAR5_SIGNATURE: [u8; 8] = [b'R', b'a', b'r', b'!', 0x1A, 0x07, 0x01, 0x00];

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
            .compression_level(level)
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
}

impl ContainerHandler for TarContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
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

    fn open_reader(&self, source: &Path) -> Result<Box<dyn Read>> {
        let file = File::open(source)?;
        let reader: Box<dyn Read> = match self.compression {
            StreamCompression::Gzip => Box::new(GzDecoder::new(BufReader::new(file))),
            StreamCompression::Bzip2 => Box::new(Bzip2Decoder::new(BufReader::new(file))),
            StreamCompression::Xz => Box::new(XzDecoder::new(BufReader::new(file))),
            StreamCompression::Zstd => Box::new(ZstdDecoder::new(BufReader::new(file))?),
        };
        Ok(reader)
    }
}

impl ContainerHandler for StreamContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let compressed_bytes = fs::metadata(&request.source)?.len();
        let mut reader = self.open_reader(&request.source)?;
        let logical_bytes = io::copy(&mut reader, &mut io::sink())?;

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
        let mut reader = self.open_reader(&request.source)?;
        let mut output = BufWriter::new(File::create(&output_path)?);
        let written = io::copy(&mut reader, &mut output)?;
        output.flush()?;
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

        let mut source = BufReader::new(File::open(input)?);
        match self.compression {
            StreamCompression::Gzip => {
                let output = BufWriter::new(File::create(&request.output)?);
                let mut encoder = GzEncoder::new(output, GzipCompression::new(level as u32));
                io::copy(&mut source, &mut encoder)?;
                let mut output = encoder.finish()?;
                output.flush()?;
            }
            StreamCompression::Bzip2 => {
                let output = BufWriter::new(File::create(&request.output)?);
                let mut encoder = BzEncoder::new(output, Bzip2Compression::new(level as u32));
                io::copy(&mut source, &mut encoder)?;
                let mut output = encoder.finish()?;
                output.flush()?;
            }
            StreamCompression::Xz => {
                let output = BufWriter::new(File::create(&request.output)?);
                let mut encoder = XzEncoder::new(output, level as u32);
                io::copy(&mut source, &mut encoder)?;
                let mut output = encoder.finish()?;
                output.flush()?;
            }
            StreamCompression::Zstd => {
                let output = BufWriter::new(File::create(&request.output)?);
                let mut encoder = ZstdEncoder::new(output, level)?;
                io::copy(&mut source, &mut encoder)?;
                let mut output = encoder.finish()?;
                output.flush()?;
            }
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

struct RarContainerHandler {
    descriptor: &'static FormatDescriptor,
}

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

struct RvzContainerHandler;

impl RvzContainerHandler {
    fn open_disc(&self, source: &Path) -> Result<NodDiscReader> {
        NodDiscReader::new(source, &NodDiscOptions::default()).map_err(|error| {
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

    fn probe(&self, _source: &Path) -> ProbeConfidence {
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
        if !request.selections.is_empty() {
            return Err(RomWeaverError::Validation(
                "rvz extract does not support --select yet".into(),
            ));
        }

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let mut disc = self.open_disc(&request.source)?;
        let meta = self.validate_rvz_meta(&request.source, &disc)?;
        let disc_size = meta.disc_size.unwrap_or_else(|| disc.disc_size());
        let compression_label = normalize_codec_label(&meta.compression.to_string());

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(self.extract_name(&request.source));
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

        let execution = context.plan_threads(ThreadCapability::single_threaded());
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

        let input_disc =
            NodDiscReader::new(input, &NodDiscOptions::default()).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open input `{}` for rvz create: {error}",
                    input.display()
                ))
            })?;
        let writer = NodDiscWriter::new(input_disc, &options).map_err(|error| {
            RomWeaverError::Validation(format!("failed to initialize rvz writer: {error}"))
        })?;

        let mut output = File::create(&request.output)?;
        let finalization = writer
            .process(
                |data, _processed, _total| output.write_all(data.as_ref()),
                &NodProcessOptions::default(),
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

    fn extract_name(&self, source: &Path) -> String {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        format!("{stem}.3ds")
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
        if !request.selections.is_empty() {
            return Err(RomWeaverError::Validation(
                "z3ds extract does not support --select yet".into(),
            ));
        }

        let mut file = File::open(&request.source)?;
        let header = self.read_header(&request.source, &mut file)?;
        let payload_start = header.payload_offset();
        let tasks = self.build_extract_tasks(header.uncompressed_size, context)?;
        let (execution, pool) =
            context.build_pool(ThreadCapability::parallel(Some(tasks.len().max(1))))?;

        fs::create_dir_all(&request.out_dir)?;
        let output_path = request.out_dir.join(self.extract_name(&request.source));

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
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

struct ChdContainerHandler;

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

const CDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'C', b'D');
const CDROM_TRACK_METADATA_TAG: u32 = make_tag(b'C', b'H', b'T', b'R');
const GDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'G', b'T');
const AV_METADATA_TAG: u32 = make_tag(b'A', b'V', b'A', b'V');
const AV_LD_METADATA_TAG: u32 = make_tag(b'A', b'V', b'L', b'D');

enum ChdReadBackend {
    Native(ChdFile),
    Rust {
        metadata_by_tag_and_index: BTreeMap<(u32, u32), Vec<u8>>,
    },
}

struct ChdReadSession {
    source: PathBuf,
    header: rom_weaver_chd_sys::ChdHeader,
    media_kind: ChdMediaKind,
    backend: ChdReadBackend,
}

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

impl ContainerHandler for ChdContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &CHD
    }

    fn probe(&self, _source: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
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
    use super::ContainerRegistry;

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
                "xz", "zst", "chd", "rvz", "z3ds"
            ]
        );
    }
}
