struct CliApp {
    reporter: Arc<dyn ProgressSink>,
    emit_progress_events: bool,
    interactive_selection_enabled: bool,
    containers: ContainerRegistry,
    patches: PatchRegistry,
    checksum: NativeChecksumEngine,
}

const MAX_NESTED_EXTRACT_DEPTH: usize = 8;
const MAX_NESTED_EXTRACT_ARCHIVES: usize = 256;
const ROM_HEADER_BYTES: usize = 512;
const ROM_HEADER_SCAN_BYTES: usize = 0x8000;
const A78_HEADER_MAGIC: [u8; 9] = *b"ATARI7800";
const LNX_HEADER_MAGIC: [u8; 4] = *b"LYNX";
const INES_HEADER_MAGIC: [u8; 4] = *b"NES\x1A";
const FDS_HEADER_MAGIC: [u8; 3] = *b"FDS";
const SMS_TMR_SEGA_MAGIC: [u8; 8] = *b"TMR SEGA";
const NGP_COPYRIGHT_MAGIC: [u8; 16] = *b"COPYRIGHT BY SNK";
const GBA_HEADER_MAGIC: [u8; 4] = [0x24, 0xFF, 0xAE, 0x51];
const N64_BIG_ENDIAN_MAGIC: [u8; 4] = [0x80, 0x37, 0x12, 0x40];
const N64_LITTLE_ENDIAN_MAGIC: [u8; 4] = [0x40, 0x12, 0x37, 0x80];
const N64_BYTE_SWAPPED_MAGIC: [u8; 4] = [0x37, 0x80, 0x40, 0x12];
const SNES_COPIER_HEADER_MODULUS: u64 = 1024;
const PCE_COPIER_HEADER_MODULUS: u64 = 8192;
const SMC_GAME_DOCTOR_1_MAGIC: [u8; 16] = [
    0x00, 0x01, 0x4D, 0x45, 0x20, 0x44, 0x4F, 0x43, 0x54, 0x4F, 0x52, 0x20, 0x53, 0x46, 0x20, 0x33,
];
const SMC_GAME_DOCTOR_2_MAGIC: [u8; 16] = *b"GAME DOCTOR SF 3";
const NDS_HEADER_TOTAL_BYTES: usize = 0x1000;
const NDS_HEADER_UNIT_CODE_OFFSET: usize = 0x12;
const NDS_HEADER_NTR_ROM_SIZE_OFFSET: usize = 0x80;
const NDS_HEADER_HEADER_SIZE_OFFSET: usize = 0x84;
const NDS_HEADER_LOGO_OFFSET: usize = 0x0C0;
const NDS_HEADER_LOGO_LENGTH: usize = 156;
const NDS_HEADER_LOGO_CRC_OFFSET: usize = 0x15C;
const NDS_HEADER_CRC_OFFSET: usize = 0x15E;
const NDS_HEADER_NTR_TWL_ROM_SIZE_OFFSET: usize = 0x210;
const NDS_DOWNLOAD_PLAY_CERT_MAGIC: [u8; 2] = [0x61, 0x63];
const NDS_DOWNLOAD_PLAY_CERT_SIZE_BYTES: u64 = 0x88;
const TRIM_BINARY_SCAN_CHUNK_BYTES: usize = 128 * 1024;
const XISO_TRIM_TEMP_SUFFIX: &str = "rom-weaver-trim-xiso.tmp";
const RVZ_TRIM_TEMP_SUFFIX: &str = "rom-weaver-trim-rvz.tmp";
const CHECKSUM_IGNORE_SIDECAR_EXTENSIONS: &[&str] = &[
    ".txt", ".nfo", ".diz", ".sfv", ".md5", ".sha1", ".sha256", ".sha512", ".crc", ".log", ".json",
];
const EMITTED_ARCHIVE_EXTENSIONS: &[&str] = &[
    ".7z", ".zip", ".zipx", ".tar", ".tgz", ".tar.gz", ".tbz2", ".tar.bz2", ".txz", ".tar.xz",
    ".zst", ".zstd", ".gz", ".bz2", ".xz", ".chd", ".rvz", ".gcz", ".wbfs", ".wia", ".cso",
    ".ciso", ".rar", ".pbp", ".z3d", ".z3ds",
];
const EMITTED_ROM_EXTENSIONS: &[&str] = &[
    ".iso", ".img", ".bin", ".gdi", ".nds", ".dsi", ".srl", ".gba", ".3ds", ".n64", ".z64", ".v64",
    ".nes", ".fds", ".sfc", ".smc", ".gen", ".md", ".gb", ".gbc", ".pce", ".a78", ".lnx", ".msx",
];
const HEADER_FIXER_SUPPORTED_EXTENSIONS: &[&str] = &[
    "a78", "lnx", "nes", "fds", "smc", "sfc", "gb", "gbc", "gba", "gen", "md", "sms", "gg", "bin",
    "z64", "n64", "v64", "nds", "dsi", "srl", "pce", "tg16", "vb", "vboy", "ngp", "ngc", "mx1",
    "mx2", "j64", "jag", "col", "cv", "sv", "int",
];
const BATCH_HEADER_FIX_SYSTEM_PROFILES: [&str; 19] = [
    "snes",
    "nes",
    "fds",
    "game-boy",
    "gba",
    "sega-genesis",
    "sms-gg",
    "n64",
    "atari-7800",
    "atari-lynx",
    "pce-tg16",
    "virtual-boy",
    "neo-geo-pocket",
    "msx",
    "nds",
    "atari-jaguar",
    "colecovision",
    "watara-supervision",
    "intellivision",
];
const GAME_BOY_NINTENDO_LOGO: [u8; 48] = [
    0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00, 0x0D,
    0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E, 0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD, 0xD9, 0x99,
    0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC, 0xDD, 0xDC, 0x99, 0x9F, 0xBB, 0xB9, 0x33, 0x3E,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum KnownRomHeader {
    A78,
    Lnx,
    Nes,
    Fds,
    SnesCopier,
    PceCopier,
    SmcZero,
    SmcGameDoctor1,
    SmcGameDoctor2,
    GameBoy,
    Gba,
    MegaDrive,
    SmsTmr,
    N64,
    Nds,
    NeoGeoPocket,
    Msx,
}

impl KnownRomHeader {
    const ALL: [Self; 17] = [
        Self::A78,
        Self::Lnx,
        Self::Nes,
        Self::Fds,
        Self::SnesCopier,
        Self::PceCopier,
        Self::SmcZero,
        Self::SmcGameDoctor1,
        Self::SmcGameDoctor2,
        Self::GameBoy,
        Self::Gba,
        Self::MegaDrive,
        Self::SmsTmr,
        Self::N64,
        Self::Nds,
        Self::NeoGeoPocket,
        Self::Msx,
    ];

    const fn profile_name(self) -> &'static str {
        match self {
            Self::A78 => "No-Intro_A7800.xml",
            Self::Lnx => "No-Intro_LNX.xml",
            Self::Nes => "No-Intro_NES.xml",
            Self::Fds => "No-Intro_FDS.xml",
            Self::SnesCopier => "SNES_COPIER_HEADER",
            Self::PceCopier => "PCE_COPIER_HEADER",
            Self::SmcZero => "SMC",
            Self::SmcGameDoctor1 => "SMC_GAME_DOCTOR_1",
            Self::SmcGameDoctor2 => "SMC_GAME_DOCTOR_2",
            Self::GameBoy => "Game Boy",
            Self::Gba => "Game Boy Advance",
            Self::MegaDrive => "Sega Mega Drive / Genesis",
            Self::SmsTmr => "SMS/GG_TMR_SEGA",
            Self::N64 => "Nintendo 64",
            Self::Nds => "Nintendo DS",
            Self::NeoGeoPocket => "Neo Geo Pocket",
            Self::Msx => "MSX AB",
        }
    }

    const fn headered_extension(self) -> &'static str {
        match self {
            Self::A78 => ".a78",
            Self::Lnx => ".lnx",
            Self::Nes => ".nes",
            Self::Fds => ".fds",
            Self::SnesCopier => ".smc",
            Self::PceCopier => ".pce",
            Self::SmcZero | Self::SmcGameDoctor1 | Self::SmcGameDoctor2 => ".smc",
            Self::GameBoy => ".gb",
            Self::Gba => ".gba",
            Self::MegaDrive => ".md",
            Self::SmsTmr => ".sms",
            Self::N64 => ".z64",
            Self::Nds => ".nds",
            Self::NeoGeoPocket => ".ngp",
            Self::Msx => ".mx1",
        }
    }

    const fn headerless_extension(self) -> &'static str {
        match self {
            Self::Lnx => ".lyx",
            Self::SmcZero | Self::SmcGameDoctor1 | Self::SmcGameDoctor2 => ".sfc",
            Self::A78 | Self::Nes | Self::Fds => self.headered_extension(),
            Self::SnesCopier => ".sfc",
            Self::PceCopier => ".tg16",
            Self::GameBoy => ".gbc",
            Self::Gba => self.headered_extension(),
            Self::MegaDrive => ".gen",
            Self::SmsTmr => ".gg",
            Self::N64 => ".n64",
            Self::Nds => ".dsi",
            Self::NeoGeoPocket => ".ngc",
            Self::Msx => ".mx2",
        }
    }

    const fn data_offset_bytes(self) -> Option<usize> {
        match self {
            Self::A78 => Some(128),
            Self::Lnx => Some(64),
            Self::Nes => Some(16),
            Self::Fds => Some(16),
            Self::SnesCopier
            | Self::PceCopier
            | Self::SmcZero
            | Self::SmcGameDoctor1
            | Self::SmcGameDoctor2 => Some(ROM_HEADER_BYTES),
            Self::GameBoy
            | Self::Gba
            | Self::MegaDrive
            | Self::SmsTmr
            | Self::N64
            | Self::Nds
            | Self::NeoGeoPocket
            | Self::Msx => None,
        }
    }

    const fn scan_bytes_required(self) -> usize {
        match self {
            Self::A78 => 1 + A78_HEADER_MAGIC.len(),
            Self::Lnx => LNX_HEADER_MAGIC.len(),
            Self::Nes => INES_HEADER_MAGIC.len(),
            Self::Fds => FDS_HEADER_MAGIC.len(),
            Self::SnesCopier | Self::PceCopier => 0,
            Self::SmcZero => ROM_HEADER_BYTES,
            Self::SmcGameDoctor1 => SMC_GAME_DOCTOR_1_MAGIC.len(),
            Self::SmcGameDoctor2 => SMC_GAME_DOCTOR_2_MAGIC.len(),
            Self::GameBoy => 0x134,
            Self::Gba => 0x08,
            Self::MegaDrive => 0x105,
            Self::SmsTmr => 0x7FF8,
            Self::N64 => N64_BIG_ENDIAN_MAGIC.len(),
            Self::Nds => 0xC4,
            Self::NeoGeoPocket => NGP_COPYRIGHT_MAGIC.len(),
            Self::Msx => 2,
        }
    }

    fn matches_extension(self, extension_with_dot: &str) -> bool {
        if self
            .headered_extension()
            .eq_ignore_ascii_case(extension_with_dot)
            || self
                .headerless_extension()
                .eq_ignore_ascii_case(extension_with_dot)
        {
            return true;
        }
        match self {
            Self::N64 => ".v64".eq_ignore_ascii_case(extension_with_dot),
            Self::Nds => ".srl".eq_ignore_ascii_case(extension_with_dot),
            _ => false,
        }
    }

    fn signature_matches(self, bytes: &[u8]) -> bool {
        if bytes.len() < self.scan_bytes_required() {
            return false;
        }
        match self {
            Self::A78 => bytes[1..1 + A78_HEADER_MAGIC.len()] == A78_HEADER_MAGIC,
            Self::Lnx => bytes[..LNX_HEADER_MAGIC.len()] == LNX_HEADER_MAGIC,
            Self::Nes => bytes[..INES_HEADER_MAGIC.len()] == INES_HEADER_MAGIC,
            Self::Fds => bytes[..FDS_HEADER_MAGIC.len()] == FDS_HEADER_MAGIC,
            Self::SnesCopier | Self::PceCopier => false,
            Self::SmcZero => bytes[3..ROM_HEADER_BYTES].iter().all(|value| *value == 0),
            Self::SmcGameDoctor1 => {
                bytes[..SMC_GAME_DOCTOR_1_MAGIC.len()] == SMC_GAME_DOCTOR_1_MAGIC
            }
            Self::SmcGameDoctor2 => {
                bytes[..SMC_GAME_DOCTOR_2_MAGIC.len()] == SMC_GAME_DOCTOR_2_MAGIC
            }
            Self::GameBoy => bytes[0x104..0x134] == GAME_BOY_NINTENDO_LOGO,
            Self::Gba => bytes[0x04..0x08] == GBA_HEADER_MAGIC,
            Self::MegaDrive => bytes[0x100..0x104] == *b"SEGA" || bytes[0x101..0x105] == *b"SEGA",
            Self::SmsTmr => [0x7FF0usize, 0x3FF0, 0x1FF0].iter().any(|offset| {
                bytes.get(*offset..offset.saturating_add(SMS_TMR_SEGA_MAGIC.len()))
                    == Some(SMS_TMR_SEGA_MAGIC.as_slice())
            }),
            Self::N64 => {
                bytes[..N64_BIG_ENDIAN_MAGIC.len()] == N64_BIG_ENDIAN_MAGIC
                    || bytes[..N64_LITTLE_ENDIAN_MAGIC.len()] == N64_LITTLE_ENDIAN_MAGIC
                    || bytes[..N64_BYTE_SWAPPED_MAGIC.len()] == N64_BYTE_SWAPPED_MAGIC
            }
            Self::Nds => bytes[0xC0..0xC4] == GBA_HEADER_MAGIC,
            Self::NeoGeoPocket => bytes[..NGP_COPYRIGHT_MAGIC.len()] == NGP_COPYRIGHT_MAGIC,
            Self::Msx => bytes[..2] == *b"AB",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct KnownRomHeaderMatch {
    header: KnownRomHeader,
    stripped_bytes: Option<usize>,
}

impl KnownRomHeaderMatch {
    const fn profile_name(self) -> &'static str {
        self.header.profile_name()
    }

    const fn stripped_bytes(self) -> Option<usize> {
        self.stripped_bytes
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StripHeaderResult {
    header_bytes: Vec<u8>,
    matched_header: Option<KnownRomHeaderMatch>,
}

type XisoTrimSourceDevice = XdvdfsOffsetWrapper<BufReader<File>, io::Error>;
type XisoTrimSourceFilesystem = XdvdfsFilesystem<io::Error, XisoTrimSourceDevice>;

struct NdsTrimPlan {
    trimmed_size: u64,
    dsi_mode: bool,
    preserved_download_play_cert: bool,
}

struct ChecksumTrimPlan {
    trimmed_size: u64,
    mode: &'static str,
    preserved_download_play_cert: bool,
}

struct NdsTrimOutcome {
    original_size: u64,
    result_size: u64,
    output_path: PathBuf,
    mode: &'static str,
    preserved_download_play_cert: bool,
    already_target_size: bool,
    revert_supported: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TrimSource {
    path: PathBuf,
    kind: TrimInputKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct BatchHeaderFixOutcome {
    repaired_profiles: Vec<&'static str>,
    matched_without_changes: Vec<&'static str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TrimOperation {
    Trim,
    Revert,
}

impl TrimOperation {
    const fn stage(self) -> &'static str {
        "trim"
    }

    const fn running_label(self, dry_run: bool) -> &'static str {
        match (self, dry_run) {
            (Self::Trim, false) => "trimming",
            (Self::Trim, true) => "simulating trim for",
            (Self::Revert, false) => "reverting trim for",
            (Self::Revert, true) => "simulating trim revert for",
        }
    }

    const fn summary_label(self, dry_run: bool) -> &'static str {
        match (self, dry_run) {
            (Self::Trim, false) => "trim complete",
            (Self::Trim, true) => "trim simulation complete",
            (Self::Revert, false) => "trim revert complete",
            (Self::Revert, true) => "trim revert simulation complete",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TrimInputKind {
    NdsFamily,
    Gba,
    ThreeDs,
    Xiso,
    RvzScrub,
}

impl TrimInputKind {
    fn from_path(path: &Path) -> Option<Self> {
        let file_name = path.file_name()?.to_str()?.to_ascii_lowercase();
        if file_name.ends_with(".xiso") || file_name.ends_with(".xiso.iso") {
            return Some(Self::Xiso);
        }

        let extension = path.extension()?.to_str()?;
        if extension.eq_ignore_ascii_case("nds")
            || extension.eq_ignore_ascii_case("dsi")
            || extension.eq_ignore_ascii_case("srl")
        {
            return Some(Self::NdsFamily);
        }
        if extension.eq_ignore_ascii_case("gba") {
            return Some(Self::Gba);
        }
        if extension.eq_ignore_ascii_case("3ds") {
            return Some(Self::ThreeDs);
        }
        None
    }

    const fn mode_label(self) -> &'static str {
        match self {
            Self::NdsFamily => "nds",
            Self::Gba => "gba",
            Self::ThreeDs => "3ds",
            Self::Xiso => "xiso",
            Self::RvzScrub => "rvz-scrub",
        }
    }

    const fn default_padding_byte(self) -> u8 {
        match self {
            Self::ThreeDs => 0xFF,
            Self::NdsFamily | Self::Gba | Self::Xiso | Self::RvzScrub => 0x00,
        }
    }
}

#[derive(Debug)]
struct ResolvedChecksumSource {
    source: PathBuf,
    extracted_archives: usize,
    cleanup_paths: Vec<PathBuf>,
}

#[derive(Clone, Copy, Debug)]
struct AutoExtractResolutionLabels<'a> {
    command: &'a str,
    family: OperationFamily,
    format: Option<&'a str>,
    source_label: &'a str,
    temp_prefix: &'a str,
}

#[derive(Clone, Debug)]
struct ChecksumExtractCandidate {
    source: PathBuf,
    display_name: String,
    ignored: bool,
}

#[derive(Clone, Debug)]
struct SelectionPromptCandidate {
    value: String,
    label: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileSnapshot {
    size_bytes: u64,
    modified_unix_nanos: Option<u128>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ParsedSelectionInput {
    Cancelled,
    Selected(usize),
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProfileCodecKind {
    Standard,
    Zstd,
    NoLevel,
}

#[derive(Clone, Debug)]
struct PatchApplyCompressionOptions {
    enabled: bool,
    auto_mode: bool,
    requested_format: Option<String>,
    codec: Option<String>,
    level: Option<i32>,
    profile: CompressionLevelProfile,
}

#[derive(Clone, Debug)]
struct PatchApplyCompressionPlan {
    format: String,
    codec: Option<String>,
    level: Option<i32>,
    output_path: PathBuf,
    extension_appended: bool,
    auto_note: String,
}

struct PatchApplyFinalizeResult {
    repaired_profiles: Vec<&'static str>,
    repair_warning: Option<String>,
}

struct HeaderRepairOutcome {
    repaired_profiles: Vec<&'static str>,
    matched_without_changes: Vec<&'static str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HeaderRepairStatus {
    NotMatched,
    MatchedNoChange,
    Repaired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum N64ByteOrder {
    BigEndian,
    LittleEndian,
    ByteSwapped,
}


include!("commands_and_selection.rs");
include!("compress_trim_batch.rs");
include!("patch_commands.rs");
include!("compression_planning.rs");
include!("trim_and_inspect_details.rs");
include!("header_detection_and_finalize.rs");
include!("header_repair.rs");
include!("nested_extract.rs");
