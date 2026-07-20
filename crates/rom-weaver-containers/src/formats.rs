use std::{fs::File, path::Path, sync::Arc};

use crate::nod::read::{DiscOptions as NodDiscOptions, DiscReader as NodDiscReader};
use rom_weaver_core::{
    ContainerCapabilities, ContainerHandler, ContainerHandlerOperations,
    ContainerHandlerRegistration, CreateSupport, FormatDescriptor, OperationFamily,
    ProbeConfidence, Result, RomWeaverError, ThreadCapability, UnsupportedOp,
};

use crate::{
    CsoContainerHandler, GczContainerHandler, NfsContainerHandler, PbpContainerHandler,
    RarContainerHandler, RvzContainerHandler, SevenZContainerHandler, StreamCompression,
    StreamContainerHandler, TarContainerHandler, TgcContainerHandler, WbfsContainerHandler,
    WiaContainerHandler, XisoContainerHandler, Z3dsContainerHandler, ZipContainerFlavor,
    ZipContainerHandler,
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
    /// File magic prefix for rom-specific single-payload codec containers (CHD /
    /// RVZ / Z3DS), empty for archives whose detection goes through libarchive.
    /// Canonical source for the web UI's synchronous magic probe (via typegen).
    pub magic: &'static [u8],
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
    Tar,
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

    /// File magic prefix for rom-specific single-payload codec containers, sourced
    /// from each handler's canonical magic constant. Archives return an empty slice
    /// (their detection runs through libarchive, not a fixed prefix).
    fn magic_signature(self) -> &'static [u8] {
        match self {
            Self::Chd => &rom_weaver_chd::CHD_SIGNATURE,
            Self::Rvz => &crate::rvz::RVZ_MAGIC,
            Self::Z3ds => &crate::z3ds::Z3DS_MAGIC,
            _ => &[],
        }
    }

    fn build(self, descriptor: &'static FormatDescriptor) -> Arc<dyn ContainerHandlerOperations> {
        match self {
            Self::Zip(flavor) => Arc::new(ZipContainerHandler::new(descriptor, flavor)),
            Self::SevenZ => Arc::new(SevenZContainerHandler::new(descriptor)),
            Self::Rar => Arc::new(RarContainerHandler::new(descriptor)),
            Self::Tar => Arc::new(TarContainerHandler::new(descriptor)),
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
        let capabilities = self.capabilities.into_container_capabilities();
        let create_support = if capabilities.create {
            CreateSupport::Supported
        } else {
            CreateSupport::ExtractOnly {
                supported_create_formats: supported_create_formats_text(),
            }
        };
        rom_weaver_core::traced_container_handler(
            self.handler.build(self.descriptor),
            ContainerHandlerRegistration {
                descriptor: self.descriptor,
                capabilities,
                is_single_payload_disc_image: self.handler.is_single_payload_disc_image(),
                create_support,
            },
        )
    }

    fn metadata(&self) -> ContainerFormatMetadata {
        ContainerFormatMetadata {
            name: self.descriptor.name,
            aliases: self.descriptor.aliases,
            extensions: self.descriptor.extensions,
            capabilities: self.capabilities.metadata(),
            default_output: self.default_output,
            magic: self.handler.magic_signature(),
        }
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
        handler: ContainerHandlerKind::Tar,
    },
    ContainerFormatRegistration {
        descriptor: &TAR_GZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Tar,
    },
    ContainerFormatRegistration {
        descriptor: &TAR_BZ2,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Tar,
    },
    ContainerFormatRegistration {
        descriptor: &TAR_XZ,
        capabilities: EXTRACT_ONLY_PARALLEL,
        default_output: None,
        handler: ContainerHandlerKind::Tar,
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

/// Extensions that are ambiguous between a CD/DVD disc image and a bare console ROM
/// dump. A `.bin` whose size is not a whole number of CD/DVD sectors is treated as a
/// plain ROM rather than auto-resolved to a disc container.
const AMBIGUOUS_DISC_IMAGE_EXTENSIONS: &[&str] = &["bin"];

/// Heuristics the web UI uses to disambiguate disc images from plain ROM dumps
/// without decoding the file. Canonical source surfaced via typegen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DiscImagePolicyMetadata {
    /// Valid CD/DVD logical sector sizes; a disc image's length is a multiple of one.
    pub cd_sector_sizes: &'static [u32],
    /// Extensions shared by disc images and bare ROM dumps (see size heuristic).
    pub ambiguous_disc_image_extensions: &'static [&'static str],
}

pub fn disc_image_policy_metadata() -> DiscImagePolicyMetadata {
    DiscImagePolicyMetadata {
        cd_sector_sizes: &rom_weaver_chd::CD_SECTOR_SIZES,
        ambiguous_disc_image_extensions: AMBIGUOUS_DISC_IMAGE_EXTENSIONS,
    }
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

    /// Resolve a handler by name that can create archives, bundling the
    /// "not registered" and "extract-only" guards the compress flows repeated.
    /// Returns the registered, create-capable handler or a
    /// [`RomWeaverError::Validation`] whose message matches what those flows
    /// produced inline: "requested output format is not registered" when no
    /// handler matches or the match exposes no real capabilities, and the
    /// [`extract_only_create_validation_message`] when the handler exists but
    /// cannot create.
    pub fn find_creatable_by_name(&self, name: &str) -> Result<Arc<dyn ContainerHandler>> {
        let Some(handler) = self.find_by_name(name) else {
            return Err(RomWeaverError::Validation(
                "requested output format is not registered".to_string(),
            ));
        };
        let capabilities = handler.capabilities();
        if !capabilities.probe_details && !capabilities.extract && !capabilities.create {
            return Err(RomWeaverError::Validation(
                "requested output format is not registered".to_string(),
            ));
        }
        if !capabilities.create {
            return Err(RomWeaverError::Validation(
                extract_only_create_validation_message(handler.descriptor().name),
            ));
        }
        Ok(handler)
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
        let identity = rom_weaver_checksum::rom_identity::detect_rom_identity_for_path(path);
        let recommendation = recommend_container_for_identity(
            identity.platform,
            identity.disc_format.map(|medium| medium.label()),
        );
        if recommendation.format_name != SEVEN_Z.name {
            return recommendation;
        }
        // GameCube/Wii container formats (wbfs/wia/gcz) hide the raw disc magic behind their own
        // header, so prefix-based identity detection above sees no console. Fall back to nod, which
        // decodes the container and reads the disc header - this recovers the RVZ recommendation for
        // an already-compressed GC/Wii image the webapp would otherwise get from the decoded leaf.
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
        recommendation
    }
}

/// Map a detected ROM identity (the `platform` label and optical-medium `disc_format`
/// label emitted by `rom_weaver_checksum::rom_identity`) to the best rom-specific
/// compression container. GameCube/Wii → RVZ, 3DS → z3ds, any optical disc → CHD,
/// otherwise the 7z fallback.
///
/// GameCube/Wii are matched before the disc rule because those discs also report a DVD
/// medium - keying CHD off `disc_format` alone would mis-route a GameCube ISO to CHD.
/// This is the single source of truth shared by the probe recommendation and the ingest
/// per-asset `recommended_format`.
pub fn recommend_container_for_identity(
    platform: Option<&str>,
    disc_format: Option<&str>,
) -> CompressFormatRecommendation {
    use rom_weaver_checksum::platform_detection::platform as plat;
    match platform {
        Some(plat::GAMECUBE | plat::WII) => CompressFormatRecommendation {
            format_name: RVZ.name,
            reason: "wii-gc-disc",
        },
        Some(plat::N3DS) => CompressFormatRecommendation {
            format_name: Z3DS.name,
            reason: "n3ds",
        },
        _ if disc_format.is_some() => CompressFormatRecommendation {
            format_name: rom_weaver_chd::CHD.name,
            reason: "disc-chd",
        },
        _ => CompressFormatRecommendation {
            format_name: SEVEN_Z.name,
            reason: "fallback-7z-lzma2",
        },
    }
}

/// Whether an extension is one of the disc-image/ROM ambiguous extensions (currently `.bin`). The
/// extension is matched bare (no leading dot), case-insensitively.
pub fn is_ambiguous_disc_image_extension(extension: &str) -> bool {
    let normalized = extension.trim_start_matches('.').to_ascii_lowercase();
    AMBIGUOUS_DISC_IMAGE_EXTENSIONS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(&normalized))
}

/// Whether `size` is a whole number of CD/DVD logical sectors. An unknown size (`None`) keeps the
/// extension-based resolution by returning `true`.
pub fn is_likely_disc_image_size(size: Option<u64>) -> bool {
    let Some(size) = size.filter(|value| *value > 0) else {
        return true;
    };
    rom_weaver_chd::CD_SECTOR_SIZES
        .iter()
        .any(|sector_size| size % u64::from(*sector_size) == 0)
}

/// Whether a source with the given `extension` and optional `size` is a disc image rather than a
/// bare console ROM dump. Non-ambiguous extensions are always disc images; an ambiguous extension is
/// a disc image only when its size is sector-aligned (or unknown). This is the size-aware half of
/// the disc-image policy the webapp's output-format auto-resolution applies (the policy data is the
/// same one surfaced to TS via [`disc_image_policy_metadata`]).
pub fn is_likely_disc_image_source(extension: &str, size: Option<u64>) -> bool {
    if !is_ambiguous_disc_image_extension(extension) {
        return true;
    }
    is_likely_disc_image_size(size)
}
