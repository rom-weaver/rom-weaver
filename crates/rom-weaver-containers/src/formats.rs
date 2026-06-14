use std::{fs::File, path::Path, sync::Arc};

use nod::read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader};
use rom_weaver_core::{
    ContainerCapabilities, ContainerCreateRequest, ContainerExtractRequest, ContainerHandler,
    ContainerHandlerOperations, ContainerListEntry, ContainerProbeRequest, FormatDescriptor,
    OperationFamily, OperationReport, ProbeConfidence, Result, RomWeaverError, ThreadCapability,
    UnsupportedOp,
};

use crate::{
    CsoContainerHandler, GczContainerHandler, NfsContainerHandler, PbpContainerHandler,
    RarContainerHandler, RvzContainerHandler, SevenZContainerHandler, StreamCompression,
    StreamContainerHandler, TarCompression, TarContainerHandler, TgcContainerHandler,
    WbfsContainerHandler, WiaContainerHandler, XisoContainerHandler, Z3dsContainerHandler,
    ZipContainerFlavor, ZipContainerHandler,
};

pub(crate) const ZIP: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "zip",
    aliases: &[],
    extensions: &[".zip"],
};
pub(crate) const ZIPX: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "zipx",
    aliases: &[],
    extensions: &[".zipx"],
};
pub(crate) const SEVEN_Z: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "7z",
    aliases: &["7zip"],
    extensions: &[".7z"],
};
pub(crate) const RAR: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "rar",
    aliases: &[],
    extensions: &[".rar"],
};
pub(crate) const TAR: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar",
    aliases: &[],
    extensions: &[".tar"],
};
pub(crate) const TAR_GZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar.gz",
    aliases: &["tgz"],
    extensions: &[".tar.gz", ".tgz"],
};
pub(crate) const TAR_BZ2: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar.bz2",
    aliases: &["tbz2"],
    extensions: &[".tar.bz2", ".tbz2"],
};
pub(crate) const TAR_XZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tar.xz",
    aliases: &["txz"],
    extensions: &[".tar.xz", ".txz"],
};
pub(crate) const GZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "gz",
    aliases: &["gzip"],
    extensions: &[".gz"],
};
pub(crate) const BZ2: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "bz2",
    aliases: &["bzip2"],
    extensions: &[".bz2"],
};
pub(crate) const XZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "xz",
    aliases: &["lzma", "lzma2"],
    extensions: &[".xz"],
};
pub(crate) const ZST: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "zst",
    aliases: &["zstd", "zstandard"],
    extensions: &[".zst"],
};
pub(crate) const CSO: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "cso",
    aliases: &["ciso"],
    extensions: &[".cso", ".ciso"],
};
pub(crate) const PBP: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "pbp",
    aliases: &[],
    extensions: &[".pbp"],
};
pub(crate) const GCZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "gcz",
    aliases: &[],
    extensions: &[".gcz"],
};
pub(crate) const WBFS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "wbfs",
    aliases: &[],
    extensions: &[".wbfs"],
};
pub(crate) const WIA: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "wia",
    aliases: &[],
    extensions: &[".wia"],
};
pub(crate) const TGC: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "tgc",
    aliases: &[],
    extensions: &[".tgc"],
};
pub(crate) const NFS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "nfs",
    aliases: &[],
    extensions: &[".nfs"],
};
pub(crate) const RVZ: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "rvz",
    aliases: &[],
    extensions: &[".rvz"],
};
pub(crate) const Z3DS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "z3ds",
    aliases: &["3ds"],
    extensions: &[".z3ds", ".zcci", ".zcxi", ".zcia", ".z3dsx"],
};
pub(crate) const XISO: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "xiso",
    aliases: &[],
    extensions: &[".xiso", ".xiso.iso"],
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContainerOutputExtensionStrategy {
    Append,
    Replace,
    Z3dsSubtype,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContainerDefaultOutputMetadata {
    pub format: &'static str,
    pub label: &'static str,
    pub output_extension: &'static str,
    pub output_extension_strategy: ContainerOutputExtensionStrategy,
    pub automatic_parent_kinds: &'static [&'static str],
    pub automatic_source_extensions: &'static [&'static str],
    pub compression_input_extensions: &'static [&'static str],
    pub decompression_input_extensions: &'static [&'static str],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContainerThreadCapabilityMetadata {
    pub parallel: bool,
    pub max_threads: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContainerCapabilitiesMetadata {
    pub probe_details: bool,
    pub extract: bool,
    pub create: bool,
    pub extract_threads: ContainerThreadCapabilityMetadata,
    pub create_threads: ContainerThreadCapabilityMetadata,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContainerFormatMetadata {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub extensions: &'static [&'static str],
    pub capabilities: ContainerCapabilitiesMetadata,
    pub default_output: Option<ContainerDefaultOutputMetadata>,
}

const SEVEN_Z_DEFAULT_OUTPUT: ContainerDefaultOutputMetadata = ContainerDefaultOutputMetadata {
    format: "7z",
    label: "7z",
    output_extension: "7z",
    output_extension_strategy: ContainerOutputExtensionStrategy::Append,
    automatic_parent_kinds: &["7z"],
    automatic_source_extensions: &["7z"],
    compression_input_extensions: &[],
    decompression_input_extensions: &["7z"],
};

const ZIP_DEFAULT_OUTPUT: ContainerDefaultOutputMetadata = ContainerDefaultOutputMetadata {
    format: "zip",
    label: "ZIP",
    output_extension: "zip",
    output_extension_strategy: ContainerOutputExtensionStrategy::Append,
    automatic_parent_kinds: &["zip"],
    automatic_source_extensions: &["zip", "zipx"],
    compression_input_extensions: &[],
    decompression_input_extensions: &["zip", "zipx"],
};

const CHD_DEFAULT_OUTPUT: ContainerDefaultOutputMetadata = ContainerDefaultOutputMetadata {
    format: "chd",
    label: "CHD",
    output_extension: "chd",
    output_extension_strategy: ContainerOutputExtensionStrategy::Replace,
    automatic_parent_kinds: &["chd"],
    automatic_source_extensions: &["bin", "cue", "gdi", "chd"],
    compression_input_extensions: &["bin", "cue", "gdi", "iso"],
    decompression_input_extensions: &["chd"],
};

const RVZ_DEFAULT_OUTPUT: ContainerDefaultOutputMetadata = ContainerDefaultOutputMetadata {
    format: "rvz",
    label: "RVZ",
    output_extension: "rvz",
    output_extension_strategy: ContainerOutputExtensionStrategy::Replace,
    automatic_parent_kinds: &["rvz"],
    automatic_source_extensions: &["gcm", "wbfs", "gcz", "rvz", "wia"],
    compression_input_extensions: &["gcm", "iso", "wbfs"],
    decompression_input_extensions: &["gcz", "rvz", "wia"],
};

const Z3DS_DEFAULT_OUTPUT: ContainerDefaultOutputMetadata = ContainerDefaultOutputMetadata {
    format: "z3ds",
    label: "Z3DS",
    output_extension: "z3ds",
    output_extension_strategy: ContainerOutputExtensionStrategy::Z3dsSubtype,
    automatic_parent_kinds: &["z3ds"],
    automatic_source_extensions: &[
        "3ds", "3dsx", "app", "cci", "cia", "cxi", "z3ds", "z3dsx", "zcci", "zcia", "zcxi",
    ],
    compression_input_extensions: &["3ds", "3dsx", "app", "cci", "cia", "cxi"],
    decompression_input_extensions: &["z3ds", "z3dsx", "zcci", "zcia", "zcxi"],
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegisteredThreadCapability {
    SingleThreaded,
    Parallel { max_threads: Option<usize> },
}

impl RegisteredThreadCapability {
    fn metadata(self) -> ContainerThreadCapabilityMetadata {
        match self {
            Self::SingleThreaded => ContainerThreadCapabilityMetadata {
                parallel: false,
                max_threads: Some(1),
            },
            Self::Parallel { max_threads } => ContainerThreadCapabilityMetadata {
                parallel: true,
                max_threads,
            },
        }
    }

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
    fn metadata(self) -> ContainerCapabilitiesMetadata {
        ContainerCapabilitiesMetadata {
            probe_details: self.probe_details,
            extract: self.extract,
            create: self.create,
            extract_threads: self.extract_threads.metadata(),
            create_threads: self.create_threads.metadata(),
        }
    }

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
    /// Disc/ROM image codec containers. Probe reports these directly instead of
    /// decompressing to the inner payload. Generic archives (zip/7z/rar/tar) and
    /// stream codecs (gz/bz2/xz/zst) are excluded so probe still drills into them.
    fn is_single_payload_disc_image(self) -> bool {
        matches!(
            self,
            Self::Cso
                | Self::Pbp
                | Self::Chd
                | Self::Gcz
                | Self::Wia
                | Self::Tgc
                | Self::Nfs
                | Self::Wbfs
                | Self::Rvz
                | Self::Z3ds
                | Self::Xiso
        )
    }

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
            Self::Chd => Arc::new(rom_weaver_chd::ChdContainerHandler),
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
    default_output: Option<ContainerDefaultOutputMetadata>,
    handler: ContainerHandlerKind,
}

impl ContainerFormatRegistration {
    fn build_handler(&'static self) -> Arc<dyn ContainerHandler> {
        Arc::new(RegisteredContainerHandler {
            registration: self,
            inner: self.handler.build(self.descriptor),
        })
    }

    fn metadata(&self) -> ContainerFormatMetadata {
        ContainerFormatMetadata {
            name: self.descriptor.name,
            aliases: self.descriptor.aliases,
            extensions: self.descriptor.extensions,
            capabilities: self.capabilities.metadata(),
            default_output: self.default_output,
        }
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
        context: &rom_weaver_core::OperationContext,
    ) -> Result<OperationReport> {
        self.inner.probe_details(request, context)
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        context: &rom_weaver_core::OperationContext,
    ) -> Result<Vec<String>> {
        self.inner.list_entries(request, context)
    }

    fn list_entry_records(
        &self,
        request: &ContainerProbeRequest,
        context: &rom_weaver_core::OperationContext,
    ) -> Result<Vec<ContainerListEntry>> {
        self.inner.list_entry_records(request, context)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &rom_weaver_core::OperationContext,
    ) -> Result<OperationReport> {
        self.inner.extract(request, context)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &rom_weaver_core::OperationContext,
    ) -> Result<OperationReport> {
        if !self.registration.capabilities.create {
            return Err(extract_only_create_error(&request.format));
        }
        self.inner.create(request, context)
    }

    fn create_with_input_overrides(
        &self,
        request: &ContainerCreateRequest,
        overrides: &[rom_weaver_core::CreateInputOverride],
        context: &rom_weaver_core::OperationContext,
    ) -> Result<OperationReport> {
        if !self.registration.capabilities.create {
            return Err(extract_only_create_error(&request.format));
        }
        self.inner
            .create_with_input_overrides(request, overrides, context)
    }

    fn create_dry_run_size(
        &self,
        request: &ContainerCreateRequest,
        context: &rom_weaver_core::OperationContext,
    ) -> Result<u64> {
        if !self.registration.capabilities.create {
            return Err(extract_only_create_error(&request.format));
        }
        self.inner.create_dry_run_size(request, context)
    }
}

impl ContainerHandler for RegisteredContainerHandler {
    fn capabilities(&self) -> ContainerCapabilities {
        self.registration.capabilities.into_container_capabilities()
    }

    fn is_single_payload_disc_image(&self) -> bool {
        self.registration.handler.is_single_payload_disc_image()
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
        default_output: Some(ZIP_DEFAULT_OUTPUT),
        handler: ContainerHandlerKind::Zip(ZipContainerFlavor::Zip),
    },
    ContainerFormatRegistration {
        descriptor: &ZIPX,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Zip(ZipContainerFlavor::Zipx),
    },
    ContainerFormatRegistration {
        descriptor: &SEVEN_Z,
        capabilities: CREATE_AND_EXTRACT_PARALLEL,
        default_output: Some(SEVEN_Z_DEFAULT_OUTPUT),
        handler: ContainerHandlerKind::SevenZ,
    },
    ContainerFormatRegistration {
        descriptor: &RAR,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Rar,
    },
    ContainerFormatRegistration {
        descriptor: &TAR,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Tar(TarCompression::None),
    },
    ContainerFormatRegistration {
        descriptor: &TAR_GZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Tar(TarCompression::Gzip),
    },
    ContainerFormatRegistration {
        descriptor: &TAR_BZ2,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Tar(TarCompression::Bzip2),
    },
    ContainerFormatRegistration {
        descriptor: &TAR_XZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Tar(TarCompression::Xz),
    },
    ContainerFormatRegistration {
        descriptor: &GZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Stream(StreamCompression::Gzip),
    },
    ContainerFormatRegistration {
        descriptor: &BZ2,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Stream(StreamCompression::Bzip2),
    },
    ContainerFormatRegistration {
        descriptor: &XZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Stream(StreamCompression::Xz),
    },
    ContainerFormatRegistration {
        descriptor: &ZST,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Stream(StreamCompression::Zstd),
    },
    ContainerFormatRegistration {
        descriptor: &CSO,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Cso,
    },
    ContainerFormatRegistration {
        descriptor: &PBP,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Pbp,
    },
    ContainerFormatRegistration {
        descriptor: &rom_weaver_chd::CHD,
        capabilities: CREATE_AND_EXTRACT_PARALLEL,
        default_output: Some(CHD_DEFAULT_OUTPUT),
        handler: ContainerHandlerKind::Chd,
    },
    ContainerFormatRegistration {
        descriptor: &GCZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Gcz,
    },
    ContainerFormatRegistration {
        descriptor: &WIA,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Wia,
    },
    ContainerFormatRegistration {
        descriptor: &TGC,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Tgc,
    },
    ContainerFormatRegistration {
        descriptor: &NFS,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Nfs,
    },
    ContainerFormatRegistration {
        descriptor: &WBFS,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Wbfs,
    },
    ContainerFormatRegistration {
        descriptor: &RVZ,
        capabilities: CREATE_AND_EXTRACT_PARALLEL,
        default_output: Some(RVZ_DEFAULT_OUTPUT),
        handler: ContainerHandlerKind::Rvz,
    },
    ContainerFormatRegistration {
        descriptor: &Z3DS,
        capabilities: CREATE_AND_EXTRACT_PARALLEL,
        default_output: Some(Z3DS_DEFAULT_OUTPUT),
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
        default_output: None,
        handler: ContainerHandlerKind::Xiso,
    },
];

pub fn container_format_metadata() -> Vec<ContainerFormatMetadata> {
    CONTAINER_FORMAT_REGISTRY
        .iter()
        .map(ContainerFormatRegistration::metadata)
        .collect()
}

pub fn supported_create_format_names() -> Vec<&'static str> {
    CONTAINER_FORMAT_REGISTRY
        .iter()
        .filter(|registration| registration.capabilities.create)
        .map(|registration| registration.descriptor.name)
        .collect()
}

pub fn supported_create_formats_text() -> String {
    supported_create_format_names().join(", ")
}

pub fn extract_only_create_validation_message(format_name: &str) -> String {
    format!(
        "{format_name} is extract-only; supported create formats are {}",
        supported_create_formats_text()
    )
}

pub fn extract_only_create_error(format_name: &str) -> RomWeaverError {
    RomWeaverError::Unsupported(UnsupportedOp::ExtractOnlyCreate {
        format: format_name.to_string(),
        supported_create_formats: supported_create_formats_text(),
    })
}

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
