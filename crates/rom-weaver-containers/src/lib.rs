use std::collections::BTreeMap;
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
        mpsc,
    },
    thread,
};

mod constants;

use ciso::{read::CSOReader as CsoReader, split::SplitFileReader};
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
use rom_weaver_checksum::StreamingChecksum;
use rom_weaver_codecs::{
    CanonicalCodec, RequestedCodec, decode_deflate_into_buffer, normalize_codec_label,
    parse_requested_codec,
};
use rom_weaver_core::{
    ArchiveEntryKindFilter, ContainerByteProgress, ContainerCapabilities, ContainerCreateRequest,
    ContainerExtractRequest, ContainerHandler, ContainerHandlerOperations, ContainerListEntry,
    ContainerProbeRequest, FormatDescriptor, OperationContext, OperationFamily, OperationReport,
    OperationStatus, OrderedChunkWriter, OrderedStreamingMessages, ProbeConfidence, ProgressEvent,
    Result, RomWeaverError, SelectionMatcher, SharedThreadPool, ThreadCapability, ThreadExecution,
    bounded_items_for_threads, create_extract_output_file, emit_container_running_progress,
    file_starts_with, maybe_emit_container_byte_progress, normalize_archive_name,
    ordered_streaming_compress, should_ignore_common_container_file,
};
use rom_weaver_libarchive::{
    EntryFileType, EntrySpec, ReadArchive, ReadFilter as LibarchiveReadFilter,
    RegularArchiveProbeFormat as LibarchiveProbeFormat, SelectedRegularArchiveEntry, WriteArchive,
    WriteFilter as LibarchiveCreateFilter, WriteFormat as LibarchiveCreateFormat,
    ZeroWriteBehavior, list_regular_archive_entries,
    probe_regular_archive as probe_regular_archive_with_libarchive_impl,
    probe_regular_archive_format, visit_selected_regular_archive_entries,
};
use serde_json::{Map, Value, json};
use tracing::trace;
use xdvdfs::{
    blockdev::OffsetWrapper as XdvdfsOffsetWrapper, write::fs::XDVDFSFilesystem as XdvdfsFilesystem,
};
use zeekstd::{DecodeOptions as ZeekstdDecodeOptions, SeekTable as ZeekstdSeekTable};
use zstd::bulk::Compressor as ZstdCompressor;

use constants::{
    LIBARCHIVE_CREATE_IO_BUFFER_BYTES, LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES,
    LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES, PARALLEL_COORDINATOR_STACK_SIZE_BYTES,
    Z3DS_DECODE_BUFFER_BYTES, Z3DS_DEFAULT_COMPRESSION_LEVEL, Z3DS_DEFAULT_FRAME_SIZE_BYTES,
    Z3DS_EXTRACT_MAX_CHUNK_BYTES, Z3DS_EXTRACT_TASKS_PER_THREAD, Z3DS_MAX_COMPRESSION_LEVEL,
    Z3DS_MIN_COMPRESSION_LEVEL, copy_progress_buffer_size,
};

fn ensure_extract_output_available(output_path: &Path, overwrite: bool) -> Result<()> {
    if overwrite || !output_path.exists() {
        return Ok(());
    }
    Err(RomWeaverError::Validation(format!(
        "refusing to overwrite existing output `{}` (rerun without --no-overwrite to replace it)",
        output_path.display()
    )))
}

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegisteredThreadCapability {
    SingleThreaded,
    Parallel { max_threads: Option<usize> },
}

impl RegisteredThreadCapability {
    fn into_thread_capability(self) -> ThreadCapability {
        match self {
            Self::SingleThreaded => ThreadCapability::single_threaded(),
            Self::Parallel { max_threads } => ThreadCapability::parallel(max_threads),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RegisteredContainerCapabilities {
    probe_details: bool,
    extract: bool,
    create: bool,
    extract_threads: RegisteredThreadCapability,
    create_threads: RegisteredThreadCapability,
}

impl RegisteredContainerCapabilities {
    fn into_container_capabilities(self) -> ContainerCapabilities {
        ContainerCapabilities {
            probe_details: self.probe_details,
            extract: self.extract,
            create: self.create,
            extract_threads: self.extract_threads.into_thread_capability(),
            create_threads: self.create_threads.into_thread_capability(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum ContainerHandlerKind {
    Zip(ZipContainerFlavor),
    SevenZ,
    Rar,
    Tar(TarCompression),
    Stream(StreamCompression),
    Cso,
    Pbp,
    Chd,
    Gcz,
    Wia,
    Tgc,
    Nfs,
    Wbfs,
    Rvz,
    Z3ds,
    Xiso,
}

impl ContainerHandlerKind {
    fn build(self, descriptor: &'static FormatDescriptor) -> Arc<dyn ContainerHandlerOperations> {
        match self {
            Self::Zip(flavor) => Arc::new(ZipContainerHandler::new(descriptor, flavor)),
            Self::SevenZ => Arc::new(SevenZContainerHandler::new(descriptor)),
            Self::Rar => Arc::new(RarContainerHandler::new(descriptor)),
            Self::Tar(compression) => Arc::new(TarContainerHandler::new(descriptor, compression)),
            Self::Stream(compression) => {
                Arc::new(StreamContainerHandler::new(descriptor, compression))
            }
            Self::Cso => Arc::new(CsoContainerHandler::new(descriptor)),
            Self::Pbp => Arc::new(PbpContainerHandler),
            Self::Chd => Arc::new(ChdContainerHandler),
            Self::Gcz => Arc::new(GczContainerHandler),
            Self::Wia => Arc::new(WiaContainerHandler),
            Self::Tgc => Arc::new(TgcContainerHandler),
            Self::Nfs => Arc::new(NfsContainerHandler),
            Self::Wbfs => Arc::new(WbfsContainerHandler),
            Self::Rvz => Arc::new(RvzContainerHandler),
            Self::Z3ds => Arc::new(Z3dsContainerHandler),
            Self::Xiso => Arc::new(XisoContainerHandler),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ContainerFormatRegistration {
    descriptor: &'static FormatDescriptor,
    capabilities: RegisteredContainerCapabilities,
    handler: ContainerHandlerKind,
}

impl ContainerFormatRegistration {
    fn build_handler(&'static self) -> Arc<dyn ContainerHandler> {
        Arc::new(RegisteredContainerHandler {
            registration: self,
            inner: self.handler.build(self.descriptor),
        })
    }
}

struct RegisteredContainerHandler {
    registration: &'static ContainerFormatRegistration,
    inner: Arc<dyn ContainerHandlerOperations>,
}

impl ContainerHandlerOperations for RegisteredContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.registration.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        self.inner.probe(source)
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.inner.probe_details(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<Vec<String>> {
        self.inner.list_entries(request, context)
    }

    fn list_entry_records(
        &self,
        request: &ContainerProbeRequest,
        context: &OperationContext,
    ) -> Result<Vec<ContainerListEntry>> {
        self.inner.list_entry_records(request, context)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.inner.extract(request, context)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if !self.registration.capabilities.create {
            return Err(RomWeaverError::Unsupported(format!(
                "{} is extract-only; supported create formats are 7z, zip, chd, rvz, and z3ds",
                request.format
            )));
        }
        self.inner.create(request, context)
    }

    fn create_dry_run_size(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<u64> {
        if !self.registration.capabilities.create {
            return Err(RomWeaverError::Unsupported(format!(
                "{} is extract-only; supported create formats are 7z, zip, chd, rvz, and z3ds",
                request.format
            )));
        }
        self.inner.create_dry_run_size(request, context)
    }
}

impl ContainerHandler for RegisteredContainerHandler {
    fn capabilities(&self) -> ContainerCapabilities {
        self.registration.capabilities.into_container_capabilities()
    }
}

const SINGLE_THREADED: RegisteredThreadCapability = RegisteredThreadCapability::SingleThreaded;
const PARALLEL_THREADS: RegisteredThreadCapability =
    RegisteredThreadCapability::Parallel { max_threads: None };

const CREATE_AND_EXTRACT_PARALLEL: RegisteredContainerCapabilities =
    RegisteredContainerCapabilities {
        probe_details: true,
        extract: true,
        create: true,
        extract_threads: PARALLEL_THREADS,
        create_threads: PARALLEL_THREADS,
    };

const EXTRACT_ONLY_PARALLEL: RegisteredContainerCapabilities = RegisteredContainerCapabilities {
    probe_details: true,
    extract: true,
    create: false,
    extract_threads: PARALLEL_THREADS,
    create_threads: SINGLE_THREADED,
};

static CONTAINER_FORMAT_REGISTRY: &[ContainerFormatRegistration] = &[
    ContainerFormatRegistration {
        descriptor: &ZIP,
        capabilities: CREATE_AND_EXTRACT_PARALLEL,
        handler: ContainerHandlerKind::Zip(ZipContainerFlavor::Zip),
    },
    ContainerFormatRegistration {
        descriptor: &ZIPX,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Zip(ZipContainerFlavor::Zipx),
    },
    ContainerFormatRegistration {
        descriptor: &SEVEN_Z,
        capabilities: CREATE_AND_EXTRACT_PARALLEL,
        handler: ContainerHandlerKind::SevenZ,
    },
    ContainerFormatRegistration {
        descriptor: &RAR,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Rar,
    },
    ContainerFormatRegistration {
        descriptor: &TAR,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Tar(TarCompression::None),
    },
    ContainerFormatRegistration {
        descriptor: &TAR_GZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Tar(TarCompression::Gzip),
    },
    ContainerFormatRegistration {
        descriptor: &TAR_BZ2,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Tar(TarCompression::Bzip2),
    },
    ContainerFormatRegistration {
        descriptor: &TAR_XZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Tar(TarCompression::Xz),
    },
    ContainerFormatRegistration {
        descriptor: &GZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Stream(StreamCompression::Gzip),
    },
    ContainerFormatRegistration {
        descriptor: &BZ2,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Stream(StreamCompression::Bzip2),
    },
    ContainerFormatRegistration {
        descriptor: &XZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Stream(StreamCompression::Xz),
    },
    ContainerFormatRegistration {
        descriptor: &ZST,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Stream(StreamCompression::Zstd),
    },
    ContainerFormatRegistration {
        descriptor: &CSO,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Cso,
    },
    ContainerFormatRegistration {
        descriptor: &PBP,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Pbp,
    },
    ContainerFormatRegistration {
        descriptor: &rom_weaver_chd::CHD,
        capabilities: CREATE_AND_EXTRACT_PARALLEL,
        handler: ContainerHandlerKind::Chd,
    },
    ContainerFormatRegistration {
        descriptor: &GCZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Gcz,
    },
    ContainerFormatRegistration {
        descriptor: &WIA,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Wia,
    },
    ContainerFormatRegistration {
        descriptor: &TGC,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Tgc,
    },
    ContainerFormatRegistration {
        descriptor: &NFS,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Nfs,
    },
    ContainerFormatRegistration {
        descriptor: &WBFS,
        capabilities: EXTRACT_ONLY_PARALLEL,
        handler: ContainerHandlerKind::Wbfs,
    },
    ContainerFormatRegistration {
        descriptor: &RVZ,
        capabilities: CREATE_AND_EXTRACT_PARALLEL,
        handler: ContainerHandlerKind::Rvz,
    },
    ContainerFormatRegistration {
        descriptor: &Z3DS,
        capabilities: CREATE_AND_EXTRACT_PARALLEL,
        handler: ContainerHandlerKind::Z3ds,
    },
    ContainerFormatRegistration {
        descriptor: &XISO,
        capabilities: RegisteredContainerCapabilities {
            probe_details: false,
            extract: true,
            create: false,
            extract_threads: SINGLE_THREADED,
            create_threads: SINGLE_THREADED,
        },
        handler: ContainerHandlerKind::Xiso,
    },
];

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
        Self {
            handlers: CONTAINER_FORMAT_REGISTRY
                .iter()
                .map(ContainerFormatRegistration::build_handler)
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

    /// Resolve a handler purely from an output path's extension, without opening the file.
    ///
    /// Unlike [`Self::probe`], this never reads the file (the output usually does not exist yet
    /// when a format is being chosen). Returns the first registered handler whose descriptor
    /// extensions match `path`; capability checks (create vs extract-only) are left to the caller
    /// so it can surface the right error.
    pub fn find_by_output_extension(&self, path: &Path) -> Option<Arc<dyn ContainerHandler>> {
        self.handlers
            .iter()
            .find(|handler| handler.descriptor().matches_path(path))
            .cloned()
    }

    pub fn recommend_compress_format(&self, path: &Path) -> CompressFormatRecommendation {
        let options = NodDiscOptions {
            preloader_threads: 0,
            ..Default::default()
        };
        if let Ok(file) = File::open(path)
            && let Ok(disc) = NodDiscReader::new_from_non_cloneable_read(file, &options)
        {
            let header = disc.header();
            if header.is_wii() || header.is_gamecube() {
                return CompressFormatRecommendation {
                    format_name: RVZ.name,
                    reason: "wii-gc-disc",
                };
            }
        }
        CompressFormatRecommendation {
            format_name: SEVEN_Z.name,
            reason: "fallback-7z-lzma2",
        }
    }
}

const GZIP_SIGNATURE: [u8; 2] = [0x1F, 0x8B];
const BZIP2_SIGNATURE: [u8; 3] = [b'B', b'Z', b'h'];
const XZ_SIGNATURE: [u8; 6] = [0xFD, b'7', b'z', b'X', b'Z', 0x00];
const ZSTD_SIGNATURE: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
const CSO_SIGNATURE: [u8; 4] = [b'C', b'I', b'S', b'O'];
const PBP_SIGNATURE: [u8; 4] = [0x00, b'P', b'B', b'P'];

#[derive(Clone, Debug)]
struct ArchiveInputEntry {
    source: PathBuf,
    archive_name: String,
    is_dir: bool,
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
    on_codec_bytes_processed: Option<Box<dyn FnMut(u64)>>,
    on_compressed_bytes_written: Option<Box<dyn FnMut(u64)>>,
) -> Result<WriteArchive> {
    let mut archive = WriteArchive::new(&format!("{} create failed", config.format_name))?;
    let setup_result = (|| -> Result<()> {
        archive.set_format(
            config.format,
            &format!(
                "{} create failed while selecting {} format",
                config.format_name, config.format_name
            ),
        )?;

        if let Some(on_codec_bytes_processed) = on_codec_bytes_processed
            && let LibarchiveCreateFormat::SevenZ = config.format
        {
            archive.set_7zip_progress_callback(
                on_codec_bytes_processed,
                &format!(
                    "{} create failed while setting 7z progress callback",
                    config.format_name
                ),
            )?;
        }

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

        if let Some(level) = config.compression_level
            && config.format_compression.is_some()
        {
            archive.set_format_option(
                None,
                "compression-level",
                &level.to_string(),
                &format!(
                    "{} create failed while setting format option `compression-level`",
                    config.format_name
                ),
            )?;
        }

        if let Some(threads) = config.format_threads
            && threads > 1
            && config.format_compression.is_some()
        {
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

        if let Some(threads) = config.filter_threads
            && threads > 1
            && let Some(module) = config.filter.module_name()
        {
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

        let open_context = format!(
            "{} create failed while opening output `{}`",
            config.format_name,
            output.display()
        );
        if let Some(on_compressed_bytes_written) = on_compressed_bytes_written {
            archive.open_file_with_write_callback(
                output,
                on_compressed_bytes_written,
                &open_context,
            )?;
        } else {
            archive.open_filename(output, "container output", &open_context)?;
        }
        Ok(())
    })();

    setup_result?;

    Ok(archive)
}

fn libarchive_write_archive_entry<F>(
    archive: &mut WriteArchive,
    format_name: &str,
    entry: &ArchiveInputEntry,
    entry_size_bytes: u64,
    io_buffer_bytes: usize,
    progress_on_source_read: bool,
    mut on_source_bytes: F,
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
            if progress_on_source_read {
                on_source_bytes(read as u64);
            }
            archive.write_data_all(
                &buffer[..read],
                &format!("{format_name} create failed while writing payload"),
                ZeroWriteBehavior::Error,
            )?;
            logical_bytes = logical_bytes.saturating_add(read as u64);
            if !progress_on_source_read {
                on_source_bytes(read as u64);
            }
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

    let compressed_bytes_written = Arc::new(AtomicU64::new(0));
    let emitted_compressed_progress_bucket = Arc::new(AtomicU64::new(0));
    let emitted_codec_progress_bucket = Arc::new(AtomicU8::new(0));
    let codec_progress_context = context.clone();
    let codec_progress_bucket = Arc::clone(&emitted_codec_progress_bucket);
    let codec_progress_execution = execution.clone();
    let codec_progress_format = config.format_name;
    let on_codec_bytes_processed: Option<Box<dyn FnMut(u64)>> =
        if matches!(config.format, LibarchiveCreateFormat::SevenZ) && total_input_bytes > 0 {
            Some(Box::new(move |processed_bytes| {
                let running_processed = processed_bytes.min(total_input_bytes.saturating_sub(1));
                if running_processed == 0 {
                    return;
                }
                let percent_bucket = running_processed
                    .saturating_mul(100)
                    .checked_div(total_input_bytes)
                    .unwrap_or(100)
                    .min(99) as u8;
                if percent_bucket == 0 {
                    return;
                }
                loop {
                    let previous_bucket = codec_progress_bucket.load(Ordering::Relaxed);
                    if percent_bucket <= previous_bucket {
                        return;
                    }
                    if codec_progress_bucket
                        .compare_exchange(
                            previous_bucket,
                            percent_bucket,
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                        )
                        .is_ok()
                    {
                        break;
                    }
                }
                emit_container_running_progress(
                    &codec_progress_context,
                    "compress",
                    codec_progress_format,
                    "create",
                    format!("compressing `{codec_progress_format}`"),
                    percent_bucket as f32,
                    Some(&codec_progress_execution),
                );
            }))
        } else {
            None
        };
    let compressed_progress_bytes = Arc::clone(&compressed_bytes_written);
    let compressed_progress_bucket = Arc::clone(&emitted_compressed_progress_bucket);
    let compressed_progress_execution = execution.clone();
    let compressed_progress_format = config.format_name;
    let compressed_progress_output = request.output.clone();
    let on_compressed_bytes_written = move |delta: u64| {
        let total = compressed_progress_bytes
            .fetch_add(delta, Ordering::Relaxed)
            .saturating_add(delta);
        let bucket = (total / (1024 * 1024)).max(1);
        let previous = compressed_progress_bucket.load(Ordering::Relaxed);
        if bucket <= previous {
            return;
        }
        if compressed_progress_bucket
            .compare_exchange(previous, bucket, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return;
        }
        trace!(
            command = "compress",
            family = ?OperationFamily::Container,
            format = compressed_progress_format,
            stage = "write",
            compressed_bytes_written = total,
            output = %compressed_progress_output.display(),
            requested_threads = compressed_progress_execution.requested_threads,
            effective_threads = compressed_progress_execution.effective_threads,
            thread_mode = ?compressed_progress_execution.thread_mode,
            used_parallelism = compressed_progress_execution.used_parallelism,
            thread_fallback = compressed_progress_execution.thread_fallback,
            thread_fallback_reason = ?compressed_progress_execution.thread_fallback_reason,
            "wrote compressed archive bytes"
        );
    };

    let mut archive = libarchive_open_create_archive(
        &request.output,
        config,
        on_codec_bytes_processed,
        Some(Box::new(on_compressed_bytes_written)),
    )?;
    let input_progress_enabled =
        total_input_bytes > 0 && !matches!(config.format, LibarchiveCreateFormat::SevenZ);
    let observed_input_progress = false;
    let input_progress_label = format!("creating `{}`", config.format_name);
    let input_progress_bytes = Arc::new(AtomicU64::new(0));
    let emitted_input_progress_bucket = Arc::new(AtomicU8::new(0));
    let input_progress_context = context.clone();
    let input_progress_execution = execution.clone();
    let input_progress_format = config.format_name;
    let result = (|| -> Result<u64> {
        let total_entries = entries.len();
        let mut logical_bytes = 0u64;
        for (entry_index, (entry, entry_size_bytes)) in
            entries.iter().zip(entry_sizes.iter().copied()).enumerate()
        {
            logical_bytes = logical_bytes.saturating_add(libarchive_write_archive_entry(
                &mut archive,
                config.format_name,
                entry,
                entry_size_bytes,
                config.io_buffer_bytes,
                observed_input_progress,
                |delta| {
                    if !input_progress_enabled {
                        return;
                    }
                    let accepted = input_progress_bytes
                        .fetch_add(delta, Ordering::Relaxed)
                        .saturating_add(delta)
                        .min(total_input_bytes);
                    if accepted >= total_input_bytes {
                        return;
                    }
                    if observed_input_progress {
                        let percent_bucket = accepted
                            .saturating_mul(100)
                            .checked_div(total_input_bytes)
                            .unwrap_or(100)
                            .min(99) as u8;
                        if percent_bucket == 0 {
                            return;
                        }
                        loop {
                            let previous_bucket =
                                emitted_input_progress_bucket.load(Ordering::Relaxed);
                            if percent_bucket <= previous_bucket {
                                return;
                            }
                            if emitted_input_progress_bucket
                                .compare_exchange(
                                    previous_bucket,
                                    percent_bucket,
                                    Ordering::Relaxed,
                                    Ordering::Relaxed,
                                )
                                .is_ok()
                            {
                                break;
                            }
                        }
                        emit_container_running_progress(
                            &input_progress_context,
                            "compress",
                            input_progress_format,
                            "create",
                            input_progress_label.clone(),
                            percent_bucket as f32,
                            Some(&input_progress_execution),
                        );
                        return;
                    }
                    maybe_emit_container_byte_progress(
                        &input_progress_context,
                        accepted,
                        total_input_bytes,
                        ContainerByteProgress {
                            command: "compress",
                            format: input_progress_format,
                            stage: "create",
                            label: &input_progress_label,
                            thread_execution: Some(&input_progress_execution),
                            emitted_progress_bucket: emitted_input_progress_bucket.as_ref(),
                        },
                    );
                },
            )?);
            if total_input_bytes == 0 {
                emit_container_step_progress(
                    &ContainerProgressContext {
                        context,
                        command: "compress",
                        format: config.format_name,
                        stage: "create",
                        thread_execution: Some(execution),
                    },
                    entry_index.saturating_add(1),
                    total_entries,
                    format!(
                        "creating `{}` ({}/{})",
                        config.format_name,
                        entry_index.saturating_add(1),
                        total_entries
                    ),
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
    let mut archive = ReadArchive::new(&format!("{format_name} probe failed"))?;
    let setup_result = (|| -> Result<()> {
        archive.support_raw_format(&format!(
            "{format_name} probe failed while enabling raw format"
        ))?;
        archive.support_filter(
            filter,
            &format!(
                "{format_name} probe failed while enabling {} filter",
                libarchive_read_filter_name(filter)
            ),
        )?;
        archive.open_filename(
            source,
            "container source",
            LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES,
            &format!(
                "{format_name} probe failed while opening input `{}`",
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
        &format!("{format_name} probe failed while closing reader"),
        &format!("{format_name} probe failed while releasing reader"),
    )
}

fn probe_stream_with_libarchive(
    source: &Path,
    format_name: &str,
    filter: LibarchiveReadFilter,
) -> Result<u64> {
    let mut archive = libarchive_open_read_stream(source, format_name, filter)?;
    let result = (|| -> Result<u64> {
        if !archive.next_header(&format!("{format_name} probe failed while reading header"))? {
            return Err(RomWeaverError::Validation(format!(
                "{format_name} probe found no compressed payload entries"
            )));
        }

        let mut total = 0_u64;
        let mut buffer = vec![0_u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
        loop {
            let bytes = archive.read_data(
                &mut buffer,
                &format!("{format_name} probe failed while reading payload"),
            )?;
            if bytes == 0 {
                break;
            }
            let bytes_u64 = u64::try_from(bytes).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "{format_name} probe failed: decoded size exceeded u64 range"
                ))
            })?;
            total = total.checked_add(bytes_u64).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "{format_name} probe failed: uncompressed size overflowed u64"
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

fn emit_container_indeterminate_progress(
    context: &OperationContext,
    command: &str,
    format: &str,
    stage: &str,
    label: impl Into<String>,
    thread_execution: Option<&ThreadExecution>,
) {
    context.emit(ProgressEvent {
        command: command.to_string(),
        family: OperationFamily::Container,
        format: Some(format.to_string()),
        stage: stage.to_string(),
        label: label.into(),
        details: None,
        percent: None,
        requested_threads: thread_execution.map(|value| value.requested_threads),
        effective_threads: thread_execution.map(|value| value.effective_threads),
        thread_mode: thread_execution.map(|value| value.thread_mode),
        used_parallelism: thread_execution.map(|value| value.used_parallelism),
        thread_fallback: thread_execution.map(|value| value.thread_fallback),
        thread_fallback_reason: thread_execution
            .and_then(|value| value.thread_fallback_reason.clone()),
        elapsed_ms: None,
        status: OperationStatus::Running,
    });
}

/// The stable descriptor of a container progress stream — everything that stays constant across
/// the per-step/per-byte progress calls of a single create/extract operation. Groups the values
/// that otherwise thread individually through every progress helper.
#[derive(Clone, Copy)]
struct ContainerProgressContext<'a> {
    context: &'a OperationContext,
    command: &'a str,
    format: &'a str,
    stage: &'a str,
    thread_execution: Option<&'a ThreadExecution>,
}

fn emit_container_step_progress(
    progress: &ContainerProgressContext,
    completed_steps: usize,
    total_steps: usize,
    label: impl Into<String>,
) {
    if total_steps == 0 {
        return;
    }
    let completed = completed_steps.min(total_steps);
    let percent = (completed as f32 / total_steps as f32) * 100.0;
    let ContainerProgressContext {
        context,
        command,
        format,
        stage,
        thread_execution,
    } = *progress;
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

fn copy_reader_with_progress<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total_bytes: u64,
    progress: &ContainerProgressContext,
    label: &str,
) -> Result<u64> {
    let ContainerProgressContext {
        context,
        command,
        format,
        stage,
        thread_execution,
    } = *progress;
    let buffer_size = copy_progress_buffer_size(total_bytes);
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
                bytes_written.min(total_bytes),
                total_bytes,
                ContainerByteProgress {
                    command,
                    format,
                    stage,
                    label,
                    thread_execution,
                    emitted_progress_bucket: &emitted_progress_bucket,
                },
            );
        }
    }

    Ok(bytes_written)
}

#[derive(Clone, Debug)]
struct ExtractedFileChecksum {
    path: PathBuf,
    values: BTreeMap<String, String>,
}

fn create_extract_checksum(context: &OperationContext) -> Result<Option<StreamingChecksum>> {
    StreamingChecksum::new_with_context(context.extract_checksum_algorithms(), context)
}

fn attach_extract_checksum_details(
    mut report: OperationReport,
    checksums: Vec<ExtractedFileChecksum>,
) -> OperationReport {
    if checksums.is_empty() || report.status != OperationStatus::Succeeded {
        return report;
    }

    let mut details = match report.details.take() {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let emitted = checksums
        .into_iter()
        .filter_map(|entry| build_extract_checksum_emitted_file_detail(&entry.path, entry.values))
        .collect::<Vec<_>>();
    if !emitted.is_empty() {
        details.insert("emitted_files".to_string(), Value::Array(emitted));
    }
    report.details = Some(Value::Object(details));
    report
}

fn build_extract_checksum_emitted_file_detail(
    path: &Path,
    checksums: BTreeMap<String, String>,
) -> Option<Value> {
    if checksums.is_empty() {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let file_name = canonical.file_name()?.to_string_lossy().into_owned();
    let mut entry = Map::new();
    entry.insert(
        "path".to_string(),
        json!(canonical.to_string_lossy().replace('\\', "/")),
    );
    entry.insert("file_name".to_string(), json!(file_name));
    entry.insert("size_bytes".to_string(), json!(metadata.len()));
    entry.insert("checksums".to_string(), json!(checksums));
    Some(Value::Object(entry))
}

#[derive(Clone, Debug)]
struct LibarchiveExtractTask {
    index: usize,
    archive_name: String,
    output_path: PathBuf,
    is_dir: bool,
    logical_bytes: Option<u64>,
}

#[derive(Debug)]
enum LibarchiveExtractOutput {
    Directory {
        output_path: PathBuf,
    },
    FileStart {
        index: usize,
        archive_name: String,
        output_path: PathBuf,
    },
    FileData {
        index: usize,
        archive_name: String,
        bytes: Vec<u8>,
    },
    FileEnd {
        index: usize,
        archive_name: String,
    },
}

struct LibarchiveOpenExtractOutput {
    archive_name: String,
    checksum: Option<StreamingChecksum>,
    output_path: PathBuf,
    writer: BufWriter<File>,
}

type LibarchiveProbeSummary = rom_weaver_libarchive::RegularArchiveProbeSummary;

fn probe_regular_archive_with_libarchive(
    source: &Path,
    format_name: &str,
    expected: LibarchiveProbeFormat,
) -> ProbeConfidence {
    match probe_regular_archive_format(source, format_name, expected) {
        Ok(true) => ProbeConfidence::Signature,
        _ => ProbeConfidence::Extension,
    }
}

fn probe_regular_archive_details_with_libarchive(
    source: &Path,
    format_name: &str,
) -> Result<LibarchiveProbeSummary> {
    probe_regular_archive_with_libarchive_impl(source, format_name)
}

fn list_regular_archive_entries_with_libarchive(
    source: &Path,
    format_name: &str,
) -> Result<Vec<String>> {
    Ok(list_regular_archive_entries(source, format_name)?
        .into_iter()
        .map(|entry| normalize_archive_name(&entry.path))
        .filter(|entry| !entry.is_empty())
        .collect())
}

fn list_regular_archive_entry_records_with_libarchive(
    source: &Path,
    format_name: &str,
) -> Result<Vec<ContainerListEntry>> {
    Ok(list_regular_archive_entries(source, format_name)?
        .into_iter()
        .filter_map(|entry| {
            let path = normalize_archive_name(&entry.path);
            if path.is_empty() {
                return None;
            }
            Some(ContainerListEntry {
                path,
                size: if entry.is_dir { None } else { entry.size },
            })
        })
        .collect())
}

fn build_libarchive_extract_tasks(
    source: &Path,
    out_dir: &Path,
    selections: &[String],
    kind_filter: ArchiveEntryKindFilter,
    ignore_common_files: bool,
    format_name: &str,
) -> Result<Vec<LibarchiveExtractTask>> {
    let mut matcher = SelectionMatcher::new(selections);
    let should_filter_common = ignore_common_files && selections.is_empty();
    let mut ignored_count = 0usize;
    let mut kind_filtered_count = 0usize;
    let mut tasks = Vec::new();
    let mut payload_kind_tasks = Vec::new();
    let mut container_fallback_tasks = Vec::new();

    for entry in list_regular_archive_entries(source, format_name)? {
        let entry_path = entry.path;
        let archive_name = normalize_archive_name(&entry_path);
        if archive_name.is_empty() || !matcher.matches(&archive_name) {
            continue;
        }
        if should_filter_common && should_ignore_common_container_file(&archive_name) {
            ignored_count = ignored_count.saturating_add(1);
            continue;
        }
        let relative = sanitize_archive_relative_path_from_str(&entry_path)?;
        let is_dir = entry.is_dir;
        let task = LibarchiveExtractTask {
            index: entry.index,
            archive_name: archive_name.clone(),
            output_path: out_dir.join(relative),
            is_dir,
            logical_bytes: if is_dir { Some(0) } else { entry.size },
        };
        if kind_filter.enabled() {
            if kind_filter.matches_payload_name(&archive_name) {
                payload_kind_tasks.push(task);
            } else if kind_filter.matches_container_fallback_name(&archive_name) {
                container_fallback_tasks.push(task);
            } else {
                kind_filtered_count = kind_filtered_count.saturating_add(1);
            }
        } else {
            tasks.push(task);
        }
    }

    matcher.ensure_all_matched()?;
    if kind_filter.enabled() {
        tasks = if payload_kind_tasks.iter().any(|task| !task.is_dir) {
            payload_kind_tasks
        } else {
            container_fallback_tasks
        };
    }
    if should_filter_common && ignored_count > 0 && !tasks.iter().any(|task| !task.is_dir) {
        return Err(RomWeaverError::Validation(format!(
            "all extract entries from `{}` were ignored by default filters; rerun with --no-ignore or pass --select <pattern>",
            source.display()
        )));
    }
    if kind_filter.enabled() && kind_filtered_count > 0 && !tasks.iter().any(|task| !task.is_dir) {
        return Err(RomWeaverError::Validation(format!(
            "no extract entries from `{}` matched {}",
            source.display(),
            kind_filter.flag_label()
        )));
    }
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
    context: &OperationContext,
    overwrite: bool,
    mut on_bytes_written: F,
    mut on_task_complete: G,
) -> Result<(u64, Vec<ExtractedFileChecksum>)>
where
    F: FnMut(u64),
    G: FnMut(),
{
    if chunk.is_empty() {
        return Ok((0, Vec::new()));
    }

    let mut tasks_by_index = BTreeMap::new();
    for task in chunk {
        tasks_by_index.insert(task.index, task);
    }
    let selected_indices = tasks_by_index.keys().copied().collect::<BTreeSet<_>>();
    let mut written_bytes = 0u64;
    let mut output_checksums = Vec::new();
    let matched_tasks = visit_selected_regular_archive_entries(
        source,
        format_name,
        &selected_indices,
        |selected_entry| -> Result<()> {
            match selected_entry {
                SelectedRegularArchiveEntry::Directory { entry } => {
                    let task = tasks_by_index.get(&entry.index).copied().ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "{format_name} extract failed while resolving selected directory index {}",
                            entry.index
                        ))
                    })?;
                    fs::create_dir_all(&task.output_path)?;
                }
                SelectedRegularArchiveEntry::File { entry, reader } => {
                    let task = tasks_by_index.get(&entry.index).copied().ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "{format_name} extract failed while resolving selected file index {}",
                            entry.index
                        ))
                    })?;
                    if task.is_dir {
                        fs::create_dir_all(&task.output_path)?;
                    } else {
                        if let Some(parent) = task.output_path.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        let mut output = BufWriter::new(create_extract_output_file(
                            &task.output_path,
                            overwrite,
                        )?);
                        let mut checksum = create_extract_checksum(context)?;
                        let mut copied = 0u64;
                        if checksum.is_some() {
                            loop {
                                let mut buffer = vec![0u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
                                let read = reader.read(&mut buffer).map_err(|error| {
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
                                buffer.truncate(read);
                                if let Some(checksum) = checksum.as_mut() {
                                    checksum.update_owned(buffer)?;
                                }
                                let read_u64 = read as u64;
                                copied = copied.saturating_add(read_u64);
                                on_bytes_written(read_u64);
                            }
                        } else {
                            let mut buffer = vec![0u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
                            loop {
                                let read = reader.read(&mut buffer).map_err(|error| {
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
                        }
                        output.flush()?;
                        written_bytes = written_bytes.saturating_add(copied);
                        if let Some(checksum) = checksum {
                            output_checksums.push(ExtractedFileChecksum {
                                path: task.output_path.clone(),
                                values: checksum.finalize()?,
                            });
                        }
                    }
                }
            }
            on_task_complete();
            Ok(())
        },
    )?;

    if matched_tasks != tasks_by_index.len() {
        return Err(RomWeaverError::Validation(format!(
            "{format_name} extract failed because selected entries changed while processing"
        )));
    }

    Ok((written_bytes, output_checksums))
}

fn send_libarchive_extract_output(
    sender: &mpsc::SyncSender<LibarchiveExtractOutput>,
    output: LibarchiveExtractOutput,
    format_name: &str,
) -> Result<()> {
    sender.send(output).map_err(|_| {
        RomWeaverError::Validation(format!("{format_name} extract output receiver closed"))
    })
}

fn extract_libarchive_task_chunk_to_sender(
    source: &Path,
    chunk: &[LibarchiveExtractTask],
    format_name: &str,
    sender: &mpsc::SyncSender<LibarchiveExtractOutput>,
) -> Result<()> {
    if chunk.is_empty() {
        return Ok(());
    }

    let mut tasks_by_index = BTreeMap::new();
    for task in chunk {
        tasks_by_index.insert(task.index, task);
    }
    let selected_indices = tasks_by_index.keys().copied().collect::<BTreeSet<_>>();
    let matched_tasks = visit_selected_regular_archive_entries(
        source,
        format_name,
        &selected_indices,
        |selected_entry| -> Result<()> {
            match selected_entry {
                SelectedRegularArchiveEntry::Directory { entry } => {
                    let task = tasks_by_index.get(&entry.index).copied().ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "{format_name} extract failed while resolving selected directory index {}",
                            entry.index
                        ))
                    })?;
                    send_libarchive_extract_output(
                        sender,
                        LibarchiveExtractOutput::Directory {
                            output_path: task.output_path.clone(),
                        },
                        format_name,
                    )?;
                }
                SelectedRegularArchiveEntry::File { entry, reader } => {
                    let task = tasks_by_index.get(&entry.index).copied().ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "{format_name} extract failed while resolving selected file index {}",
                            entry.index
                        ))
                    })?;
                    if task.is_dir {
                        send_libarchive_extract_output(
                            sender,
                            LibarchiveExtractOutput::Directory {
                                output_path: task.output_path.clone(),
                            },
                            format_name,
                        )?;
                    } else {
                        send_libarchive_extract_output(
                            sender,
                            LibarchiveExtractOutput::FileStart {
                                index: task.index,
                                archive_name: task.archive_name.clone(),
                                output_path: task.output_path.clone(),
                            },
                            format_name,
                        )?;
                        let mut buffer = vec![0u8; LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES];
                        loop {
                            let read = reader.read(&mut buffer).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract failed while reading entry {} (`{}`): {error}",
                                    task.index, task.archive_name
                                ))
                            })?;
                            if read == 0 {
                                break;
                            }
                            send_libarchive_extract_output(
                                sender,
                                LibarchiveExtractOutput::FileData {
                                    index: task.index,
                                    archive_name: task.archive_name.clone(),
                                    bytes: buffer[..read].to_vec(),
                                },
                                format_name,
                            )?;
                        }
                        send_libarchive_extract_output(
                            sender,
                            LibarchiveExtractOutput::FileEnd {
                                index: task.index,
                                archive_name: task.archive_name.clone(),
                            },
                            format_name,
                        )?;
                    }
                }
            }
            Ok(())
        },
    )?;

    if matched_tasks != tasks_by_index.len() {
        return Err(RomWeaverError::Validation(format!(
            "{format_name} extract failed because selected entries changed while processing"
        )));
    }

    Ok(())
}

fn extract_regular_archive_with_libarchive(
    request: &ContainerExtractRequest,
    context: &OperationContext,
    format_name: &'static str,
) -> Result<OperationReport> {
    fs::create_dir_all(&request.out_dir)?;
    let tasks = build_libarchive_extract_tasks(
        &request.source,
        &request.out_dir,
        &request.selections,
        request.kind_filter,
        request.ignore_common_files,
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
        ensure_extract_output_available(&task.output_path, request.overwrite)?;
        duplicate_output_paths |= !output_paths.insert(task.output_path.clone());
    }

    let (execution, written_bytes, output_checksums) = if tasks.is_empty() || duplicate_output_paths
    {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let emitted_progress_bucket = AtomicU8::new(0);
        let mut copied_bytes = 0u64;
        let mut completed = 0usize;
        let (written, output_checksums) = extract_libarchive_task_chunk(
            &request.source,
            &tasks,
            format_name,
            context,
            request.overwrite,
            |delta| {
                if let Some(total_bytes) = total_file_bytes {
                    copied_bytes = copied_bytes.saturating_add(delta).min(total_bytes);
                    maybe_emit_container_byte_progress(
                        context,
                        copied_bytes,
                        total_bytes,
                        ContainerByteProgress {
                            command: "extract",
                            format: format_name,
                            stage: "extract",
                            label: &format!("extracting `{format_name}`"),
                            thread_execution: Some(&execution),
                            emitted_progress_bucket: &emitted_progress_bucket,
                        },
                    );
                }
            },
            || {
                if total_file_bytes.is_none() {
                    completed = completed.saturating_add(1);
                    emit_container_step_progress(
                        &ContainerProgressContext {
                            context,
                            command: "extract",
                            format: format_name,
                            stage: "extract",
                            thread_execution: Some(&execution),
                        },
                        completed,
                        total_tasks,
                        format!("extracting `{format_name}` ({completed}/{total_tasks})"),
                    );
                }
            },
        )?;
        (execution, written, output_checksums)
    } else {
        let file_task_count = tasks.iter().filter(|task| !task.is_dir).count().max(1);
        let capability = ThreadCapability::parallel(Some(file_task_count));
        let (execution, pool) = context.build_pool(capability)?;
        let source = request.source.clone();
        let progress_context = context.clone();
        let progress_execution = execution.clone();

        let mut output_checksums = Vec::new();
        let written_bytes = if execution.used_parallelism {
            let worker_count = execution.effective_threads.max(1);
            let chunk_size = tasks.len().div_ceil(worker_count).max(1);
            let (sender, receiver) = mpsc::sync_channel::<LibarchiveExtractOutput>(
                bounded_items_for_threads(execution.effective_threads),
            );
            let emitted_progress_bucket = AtomicU8::new(0);
            let mut copied_bytes = 0u64;
            let mut completed = 0usize;
            let mut written_bytes = 0u64;
            let mut open_outputs = BTreeMap::<usize, LibarchiveOpenExtractOutput>::new();
            let mut write_result = Ok(());

            thread::scope(|scope| -> Result<u64> {
                let producer = thread::Builder::new()
                    .name("rom-weaver-libarchive-extract".to_string())
                    .stack_size(PARALLEL_COORDINATOR_STACK_SIZE_BYTES)
                    .spawn_scoped(scope, || {
                        pool.install(|| {
                            tasks.par_chunks(chunk_size).try_for_each_with(
                                sender,
                                |sender, chunk| {
                                    extract_libarchive_task_chunk_to_sender(
                                        &source,
                                        chunk,
                                        format_name,
                                        sender,
                                    )
                                },
                            )
                        })
                    })
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to start parallel {format_name} extract coordinator: {error}"
                        ))
                    })?;

                let mut receiver = Some(receiver);
                while let Some(active_receiver) = receiver.as_ref() {
                    let item = match active_receiver.recv() {
                        Ok(item) => item,
                        Err(_) => break,
                    };
                    let item_result = match item {
                        LibarchiveExtractOutput::Directory { output_path } => {
                            fs::create_dir_all(output_path)?;
                            if total_file_bytes.is_none() {
                                completed = completed.saturating_add(1);
                                emit_container_step_progress(
                                    &ContainerProgressContext {
                                        context: &progress_context,
                                        command: "extract",
                                        format: format_name,
                                        stage: "extract",
                                        thread_execution: Some(&progress_execution),
                                    },
                                    completed,
                                    total_tasks,
                                    format!(
                                        "extracting `{format_name}` ({completed}/{total_tasks})"
                                    ),
                                );
                            }
                            Ok(())
                        }
                        LibarchiveExtractOutput::FileStart {
                            index,
                            archive_name,
                            output_path,
                        } => {
                            if let Some(parent) = output_path.parent() {
                                fs::create_dir_all(parent)?;
                            }
                            if let std::collections::btree_map::Entry::Vacant(e) =
                                open_outputs.entry(index)
                            {
                                let writer = BufWriter::new(create_extract_output_file(
                                    &output_path,
                                    request.overwrite,
                                )?);
                                e.insert(LibarchiveOpenExtractOutput {
                                    archive_name,
                                    checksum: create_extract_checksum(context)?,
                                    output_path,
                                    writer,
                                });
                                Ok(())
                            } else {
                                Err(RomWeaverError::Validation(format!(
                                    "{format_name} extract received duplicate start for entry {index} (`{archive_name}`)"
                                )))
                            }
                        }
                        LibarchiveExtractOutput::FileData {
                            index,
                            archive_name,
                            bytes,
                        } => {
                            let output = open_outputs.get_mut(&index).ok_or_else(|| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract received data before start for entry {index} (`{archive_name}`)"
                                ))
                            })?;
                            output.writer.write_all(&bytes).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract failed while writing entry {index} (`{archive_name}`): {error}"
                                ))
                            })?;
                            let delta = bytes.len() as u64;
                            if let Some(checksum) = output.checksum.as_mut() {
                                checksum.update_owned(bytes)?;
                            }
                            written_bytes = written_bytes.saturating_add(delta);
                            if let Some(total_bytes) = total_file_bytes {
                                copied_bytes = copied_bytes.saturating_add(delta).min(total_bytes);
                                maybe_emit_container_byte_progress(
                                    &progress_context,
                                    copied_bytes,
                                    total_bytes,
                                    ContainerByteProgress {
                                        command: "extract",
                                        format: format_name,
                                        stage: "extract",
                                        label: &format!("extracting `{format_name}`"),
                                        thread_execution: Some(&progress_execution),
                                        emitted_progress_bucket: &emitted_progress_bucket,
                                    },
                                );
                            }
                            Ok(())
                        }
                        LibarchiveExtractOutput::FileEnd {
                            index,
                            archive_name,
                        } => {
                            let mut output = open_outputs.remove(&index).ok_or_else(|| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract received end before start for entry {index} (`{archive_name}`)"
                                ))
                            })?;
                            output.writer.flush().map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{format_name} extract failed while flushing entry {index} (`{}`): {error}",
                                    output.archive_name
                                ))
                            })?;
                            if let Some(checksum) = output.checksum {
                                output_checksums.push(ExtractedFileChecksum {
                                    path: output.output_path,
                                    values: checksum.finalize()?,
                                });
                            }
                            if total_file_bytes.is_none() {
                                completed = completed.saturating_add(1);
                                emit_container_step_progress(
                                    &ContainerProgressContext {
                                        context: &progress_context,
                                        command: "extract",
                                        format: format_name,
                                        stage: "extract",
                                        thread_execution: Some(&progress_execution),
                                    },
                                    completed,
                                    total_tasks,
                                    format!(
                                        "extracting `{format_name}` ({completed}/{total_tasks})"
                                    ),
                                );
                            }
                            Ok(())
                        }
                    };
                    if let Err(error) = item_result {
                        write_result = Err(error);
                        drop(receiver.take());
                        break;
                    }
                }

                let producer_result = producer.join().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "parallel {format_name} extract coordinator panicked"
                    ))
                })?;
                write_result?;
                producer_result?;
                if let Some((index, output)) = open_outputs.into_iter().next() {
                    return Err(RomWeaverError::Validation(format!(
                        "{format_name} extract finished with unclosed entry {index} (`{}`)",
                        output.archive_name
                    )));
                }
                Ok(written_bytes)
            })?
        } else {
            let emitted_progress_bucket = AtomicU8::new(0);
            let mut copied_bytes = 0u64;
            let mut completed = 0usize;
            let (written_bytes, checksums) = extract_libarchive_task_chunk(
                &source,
                &tasks,
                format_name,
                context,
                request.overwrite,
                |delta| {
                    if let Some(total_bytes) = total_file_bytes {
                        copied_bytes = copied_bytes.saturating_add(delta).min(total_bytes);
                        maybe_emit_container_byte_progress(
                            &progress_context,
                            copied_bytes,
                            total_bytes,
                            ContainerByteProgress {
                                command: "extract",
                                format: format_name,
                                stage: "extract",
                                label: &format!("extracting `{format_name}`"),
                                thread_execution: Some(&progress_execution),
                                emitted_progress_bucket: &emitted_progress_bucket,
                            },
                        );
                    }
                },
                || {
                    if total_file_bytes.is_none() {
                        completed = completed.saturating_add(1);
                        emit_container_step_progress(
                            &ContainerProgressContext {
                                context: &progress_context,
                                command: "extract",
                                format: format_name,
                                stage: "extract",
                                thread_execution: Some(&progress_execution),
                            },
                            completed,
                            total_tasks,
                            format!("extracting `{format_name}` ({completed}/{total_tasks})"),
                        );
                    }
                },
            )?;
            output_checksums = checksums;
            written_bytes
        };
        (execution, written_bytes, output_checksums)
    };

    let report = OperationReport::succeeded(
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
    );
    Ok(attach_extract_checksum_details(report, output_checksums))
}

fn write_decoded_chunks_from_workers<TTask, TChunk, Decode, WriteChunk>(
    pool: &SharedThreadPool,
    tasks: &[TTask],
    max_in_flight_items: usize,
    receiver_closed_message: &'static str,
    decode: Decode,
    mut write_chunk: WriteChunk,
) -> Result<()>
where
    TTask: Sync,
    TChunk: Send,
    Decode: Fn(&TTask) -> Result<TChunk> + Send + Sync,
    WriteChunk: FnMut(TChunk) -> Result<()>,
{
    let (sender, receiver) = mpsc::sync_channel::<TChunk>(max_in_flight_items.max(1));
    let mut write_result = Ok(());

    thread::scope(|scope| -> Result<()> {
        let producer = thread::Builder::new()
            .name("rom-weaver-decode".to_string())
            .stack_size(PARALLEL_COORDINATOR_STACK_SIZE_BYTES)
            .spawn_scoped(scope, || {
                pool.install(|| {
                    tasks.par_iter().try_for_each_with(sender, |sender, task| {
                        let chunk = decode(task)?;
                        sender.send(chunk).map_err(|_| {
                            RomWeaverError::Validation(receiver_closed_message.to_string())
                        })
                    })
                })
            })
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to start parallel decode coordinator: {error}"
                ))
            })?;

        let mut receiver = Some(receiver);
        while let Some(active_receiver) = receiver.as_ref() {
            match active_receiver.recv() {
                Ok(chunk) => {
                    if let Err(error) = write_chunk(chunk) {
                        write_result = Err(error);
                        drop(receiver.take());
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        let producer_result = producer.join().map_err(|_| {
            RomWeaverError::Validation("parallel decode coordinator panicked".into())
        })?;
        write_result?;
        producer_result
    })
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
        children.sort_by_key(|left| left.path());
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

include!("handlers/nod_shared.rs");

include!("handlers/gcz.rs");

include!("handlers/wia.rs");

include!("handlers/tgc.rs");

include!("handlers/nfs.rs");

include!("handlers/wbfs.rs");

include!("handlers/rvz.rs");

include!("handlers/z3ds.rs");

include!("../tests/unit/handlers.rs");
