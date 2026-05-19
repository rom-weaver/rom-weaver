use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs,
    fs::File,
    io::{self, BufReader, BufWriter, IsTerminal, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::{Arc, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use clap::{ArgAction, Args, Parser, Subcommand, ValueEnum};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use rom_weaver_checksum::{
    NativeChecksumEngine, checksum_file_values, seed_checksum_file_cache, supported_algorithms,
};
use rom_weaver_codecs::{CanonicalCodec, RequestedCodec, parse_requested_codec};
use rom_weaver_containers::{CompressFormatRecommendation, ContainerRegistry};
use rom_weaver_core::{
    CancellationToken, ChecksumEngine, ChecksumRequest, ContainerCreateRequest,
    ContainerExtractRequest, ContainerHandler, ContainerInspectRequest, OperationContext,
    OperationFamily, OperationReport, OperationStatus, PatchApplyRequest, PatchChecksumValidation,
    PatchCreateRequest, ProbeConfidence, ProgressEvent, ProgressSink, Result, RomWeaverError,
    ThreadBudget, ThreadCapability, ThreadExecution,
};
use rom_weaver_patches::PatchRegistry;
use tracing::trace;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};
use xdvdfs::{
    blockdev::OffsetWrapper as XdvdfsOffsetWrapper,
    write::{fs::XDVDFSFilesystem as XdvdfsFilesystem, img::create_xdvdfs_image},
};

#[derive(Debug, Parser)]
#[command(
    name = "rom-weaver",
    version,
    about = "Native CLI groundwork for ROM inspection, extraction, checksums, compression, trimming, and patching."
)]
struct Cli {
    #[arg(
        long,
        global = true,
        help = "Emit progress and terminal status as JSON lines"
    )]
    json: bool,
    #[arg(
        long,
        global = true,
        help = "Enable trace logs (also enabled by ROM_WEAVER_LOG or RUST_LOG)"
    )]
    trace: bool,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Inspect(InspectCommand),
    Extract(ExtractCommand),
    Checksum(ChecksumCommand),
    Compress(CompressCommand),
    Trim(TrimCommand),
    PatchApply(PatchApplyCommand),
    PatchCreate(PatchCreateCommand),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum CompressionLevelProfile {
    Min,
    #[value(name = "very-low")]
    VeryLow,
    Low,
    Medium,
    High,
    #[value(name = "very-high")]
    VeryHigh,
    Max,
}

impl CompressionLevelProfile {
    const fn standard_level(self) -> i32 {
        match self {
            Self::Min => 0,
            Self::VeryLow => 2,
            Self::Low => 3,
            Self::Medium => 5,
            Self::High => 7,
            Self::VeryHigh => 8,
            Self::Max => 9,
        }
    }

    const fn zstd_level(self) -> i32 {
        match self {
            Self::Min => 0,
            Self::VeryLow => 3,
            Self::Low => 5,
            Self::Medium => 12,
            Self::High => 19,
            Self::VeryHigh => 21,
            Self::Max => 22,
        }
    }
}

#[derive(Debug, Args)]
struct InspectCommand {
    source: PathBuf,
    #[arg(
        long,
        help = "List selectable archive entries in the inspect label when supported"
    )]
    list: bool,
}

#[derive(Debug, Args)]
struct ExtractCommand {
    source: PathBuf,
    #[arg(
        long = "select",
        help = "Select extracted entries by exact name, prefix, or glob (repeatable). Examples: --select game.disc02.cue --select 'game.disc0?.bin'"
    )]
    select: Vec<String>,
    #[arg(long)]
    out_dir: PathBuf,
    #[arg(
        long,
        help = "For CHD CD extraction, force split CUE + per-track BIN output (`*.trackNN.bin`) instead of a single BIN when possible"
    )]
    split_bin: bool,
    #[arg(long, default_value = "auto")]
    threads: ThreadBudget,
}

#[derive(Debug, Args)]
struct ChecksumCommand {
    source: PathBuf,
    #[arg(long = "algo", required = true)]
    algo: Vec<String>,
    #[arg(long = "select")]
    select: Vec<String>,
    #[arg(
        long,
        help = "Disable container auto-extract and checksum the source bytes directly"
    )]
    no_extract: bool,
    #[arg(
        long,
        help = "Disable default ignore filtering during checksum container payload resolution"
    )]
    no_ignore: bool,
    #[arg(
        long,
        help = "Remove a detected ROM header before checksum (A78/LNX/NES/FDS/SMC signatures; SNES/PCE copier-size rules)"
    )]
    strip_header: bool,
    #[arg(
        long,
        help = "Disable automatic trim-boundary checksum fixes for trim-eligible ROMs"
    )]
    no_trim_fix: bool,
    #[arg(long)]
    start: Option<u64>,
    #[arg(long)]
    length: Option<u64>,
    #[arg(long, default_value = "auto")]
    threads: ThreadBudget,
}

#[derive(Debug, Args)]
struct CompressCommand {
    #[arg(required = true)]
    input: Vec<PathBuf>,
    #[arg(long)]
    format: Option<String>,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    codec: Option<String>,
    #[arg(
        long,
        value_enum,
        default_value_t = CompressionLevelProfile::Max,
        help = "Global compression level profile used when --codec does not include an explicit numeric level"
    )]
    level: CompressionLevelProfile,
    #[arg(long, default_value = "auto")]
    threads: ThreadBudget,
}

#[derive(Debug, Args)]
struct TrimCommand {
    #[arg(required = true)]
    source: Vec<PathBuf>,
    #[arg(
        long,
        conflicts_with = "in_place",
        help = "Destination file for trimmed output (single trim-eligible source only)"
    )]
    output: Option<PathBuf>,
    #[arg(
        short = 'e',
        long,
        help = "Output extension for side-by-side output (supports `{ext}` placeholder, for example `trim.{ext}`)"
    )]
    extension: Option<String>,
    #[arg(
        short = 'i',
        long = "in-place",
        alias = "inplace",
        help = "Trim the source file in place instead of writing a new file"
    )]
    in_place: bool,
    #[arg(
        short = 's',
        long = "simulate",
        alias = "dry-run",
        help = "Simulate trim operations without writing output files"
    )]
    dry_run: bool,
    #[arg(
        long,
        alias = "untrim",
        alias = "restore",
        help = "Revert trimmed files by padding back to the nearest power-of-two size (not supported for xiso)"
    )]
    revert: bool,
    #[arg(
        long = "no-recursive",
        action = ArgAction::SetFalse,
        default_value_t = true,
        help = "Do not recursively scan subdirectories when input sources include folders"
    )]
    recursive: bool,
    #[arg(long, default_value = "auto")]
    threads: ThreadBudget,
}

#[derive(Debug, Args)]
struct PatchApplyCommand {
    #[arg(long)]
    input: PathBuf,
    #[arg(long = "select")]
    select: Vec<String>,
    #[arg(
        long,
        help = "Disable container auto-extract and patch the source bytes directly"
    )]
    no_extract: bool,
    #[arg(
        long,
        help = "Disable default ignore filtering during patch-apply container payload resolution"
    )]
    no_ignore: bool,
    #[arg(
        long = "patch",
        required = true,
        help = "Patch file(s) to apply in order; repeat --patch for each step"
    )]
    patches: Vec<PathBuf>,
    #[arg(long)]
    output: PathBuf,
    #[arg(
        long,
        help = "Write raw patched bytes without the default patch-output compression step"
    )]
    no_compress: bool,
    #[arg(
        long = "compress-format",
        help = "Patch-output compression container format (default: auto). Use `auto` to force auto selection."
    )]
    compress_format: Option<String>,
    #[arg(
        long = "compress-codec",
        help = "Patch-output compression codec[:level] override (for example: --compress-codec zstd:9)"
    )]
    compress_codec: Option<String>,
    #[arg(
        long = "compress-level",
        value_enum,
        default_value_t = CompressionLevelProfile::Max,
        help = "Global patch-output compression level profile used when --compress-codec omits an explicit numeric level"
    )]
    compress_level: CompressionLevelProfile,
    #[arg(
        long = "checksum-cache",
        value_name = "ALGO=HEX",
        help = "Seed effective patch input checksum cache before apply; repeat for multiple algorithms (for example: --checksum-cache crc32=1234abcd)"
    )]
    checksum_cache: Vec<String>,
    #[arg(
        long = "validate-with-checksum",
        value_name = "ALGO=HEX",
        help = "Validate effective patch input checksum before apply; repeat for multiple algorithms (for example: --validate-with-checksum crc32=1234abcd)"
    )]
    validate_with_checksums: Vec<String>,
    #[arg(
        long,
        help = "Remove a detected ROM header before patch apply (A78/LNX/NES/FDS/SMC signatures; SNES/PCE copier-size rules)"
    )]
    strip_header: bool,
    #[arg(
        long,
        help = "Add header bytes after patch apply (reuses stripped header bytes when available; defaults to 512-byte copier header)"
    )]
    add_header: bool,
    #[arg(
        long,
        help = "Repair supported ROM headers/checksums after patch apply (SNES/NES/GB/GBA/MD/SMS/N64/NDS and related profiles; auto-detect)"
    )]
    repair_checksum: bool,
    #[arg(
        long,
        help = "Skip patch-provided checksum validation during patch apply (source, target, and patch-level checks when supported)"
    )]
    ignore_checksum_validation: bool,
    #[arg(long, default_value = "auto")]
    threads: ThreadBudget,
}

#[derive(Debug, Args)]
struct PatchCreateCommand {
    #[arg(long)]
    original: PathBuf,
    #[arg(long)]
    modified: PathBuf,
    #[arg(long)]
    format: String,
    #[arg(long)]
    output: PathBuf,
    #[arg(long, default_value = "auto")]
    threads: ThreadBudget,
}

pub fn main_entry() -> ExitCode {
    let cli = Cli::parse();
    init_trace_logging(cli.trace, cli.json);
    trace!(
        json = cli.json,
        trace_requested = cli.trace,
        command = ?cli.command,
        "parsed command-line arguments"
    );
    let reporter: Arc<dyn ProgressSink> = if cli.json {
        Arc::new(StdoutReporter::json())
    } else {
        Arc::new(StdoutReporter::text())
    };
    let interactive_selection_enabled =
        !cli.json && io::stdin().is_terminal() && io::stderr().is_terminal();
    let app = CliApp::new(reporter, cli.json, interactive_selection_enabled);
    app.run(cli.command)
}

fn init_trace_logging(trace_flag: bool, json_mode: bool) {
    static TRACE_LOGGING_INIT: OnceLock<()> = OnceLock::new();
    TRACE_LOGGING_INIT.get_or_init(|| {
        let filter_spec = std::env::var("ROM_WEAVER_LOG")
            .ok()
            .and_then(trim_non_empty)
            .or_else(|| std::env::var("RUST_LOG").ok().and_then(trim_non_empty))
            .or_else(|| {
                if trace_flag {
                    Some(
                        "rom_weaver_cli=trace,rom_weaver_core=trace,rom_weaver_containers=trace,rom_weaver_patches=trace,rom_weaver_checksum=trace,rom_weaver_codecs=trace"
                            .to_string(),
                    )
                } else {
                    None
                }
            });

        let Some(filter_spec) = filter_spec else {
            return;
        };

        let env_filter = match EnvFilter::try_new(filter_spec.clone()) {
            Ok(filter) => filter,
            Err(error) => {
                eprintln!(
                    "warning: invalid trace filter `{filter_spec}` ({error}); using `off`"
                );
                EnvFilter::new("off")
            }
        };

        if json_mode {
            let _ = tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt::layer().json().with_ansi(false).with_writer(io::stderr))
                .try_init();
        } else {
            let _ = tracing_subscriber::registry()
                .with(env_filter)
                .with(
                    fmt::layer()
                        .with_ansi(false)
                        .with_writer(io::stderr)
                        .compact(),
                )
                .try_init();
        }
    });
}

fn trim_non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

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
const CHECKSUM_IGNORE_SIDECAR_EXTENSIONS: &[&str] = &[
    ".txt", ".nfo", ".diz", ".sfv", ".md5", ".sha1", ".sha256", ".sha512", ".crc", ".log", ".json",
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
        }
    }

    const fn default_padding_byte(self) -> u8 {
        match self {
            Self::ThreeDs => 0xFF,
            Self::NdsFamily | Self::Gba | Self::Xiso => 0x00,
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

impl CliApp {
    fn new(
        reporter: Arc<dyn ProgressSink>,
        emit_progress_events: bool,
        interactive_selection_enabled: bool,
    ) -> Self {
        Self {
            reporter,
            emit_progress_events,
            interactive_selection_enabled,
            containers: ContainerRegistry::new(),
            patches: PatchRegistry::new(),
            checksum: NativeChecksumEngine,
        }
    }

    fn run(&self, command: Commands) -> ExitCode {
        let command_name = Self::command_name(&command);
        trace!(command = command_name, "dispatching CLI command");
        match command {
            Commands::Inspect(args) => self.run_inspect(args),
            Commands::Extract(args) => self.run_extract(args),
            Commands::Checksum(args) => self.run_checksum(args),
            Commands::Compress(args) => self.run_compress(args),
            Commands::Trim(args) => self.run_trim(args),
            Commands::PatchApply(args) => self.run_patch_apply(args),
            Commands::PatchCreate(args) => self.run_patch_create(args),
        }
    }

    fn command_name(command: &Commands) -> &'static str {
        match command {
            Commands::Inspect(_) => "inspect",
            Commands::Extract(_) => "extract",
            Commands::Checksum(_) => "checksum",
            Commands::Compress(_) => "compress",
            Commands::Trim(_) => "trim",
            Commands::PatchApply(_) => "patch-apply",
            Commands::PatchCreate(_) => "patch-create",
        }
    }

    fn run_inspect(&self, args: InspectCommand) -> ExitCode {
        trace!(source = %args.source.display(), list = args.list, "starting inspect command");
        let context = self.context(ThreadBudget::Fixed(1));
        let source = args.source.clone();
        if let Some(report) =
            self.require_existing_path("inspect", OperationFamily::Command, None, &source, None)
        {
            return self.finish("inspect", report);
        }
        let inspect_recommendation = self.inspect_compress_recommendation(&source);

        self.emit_running(
            "inspect",
            OperationFamily::Command,
            None,
            "probe",
            format!("probing handlers for `{}`", source.display()),
            Some(0.0),
            None,
        );

        if let Some(handler) = self.containers.probe(&source) {
            self.emit_running(
                "inspect",
                OperationFamily::Container,
                Some(handler.descriptor().name),
                "inspect",
                format!("inspecting `{}`", source.display()),
                Some(0.0),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            let request = ContainerInspectRequest {
                source: source.clone(),
            };
            let mut report = handler.inspect(&request, &context).unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    "inspect",
                    error.to_string(),
                    None,
                )
            });
            if report.status == OperationStatus::Succeeded && args.list {
                self.emit_running(
                    "inspect",
                    OperationFamily::Container,
                    Some(handler.descriptor().name),
                    "list",
                    format!("listing entries for `{}`", source.display()),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                let listed = handler.list_entries(&request, &context).map_err(|error| {
                    OperationReport::failed(
                        OperationFamily::Container,
                        Some(handler.descriptor().name.to_string()),
                        "list",
                        error.to_string(),
                        None,
                    )
                });
                match listed {
                    Ok(entries) => {
                        report.label = Self::append_entry_list_label(&report.label, &entries);
                    }
                    Err(list_error) => {
                        report = list_error;
                    }
                }
            }
            report =
                Self::append_recommended_compress_label(report, inspect_recommendation.as_ref());
            return self.finish("inspect", report);
        }

        if let Some(handler) = self.patches.probe(&source) {
            self.emit_running(
                "inspect",
                OperationFamily::Patch,
                Some(handler.descriptor().name),
                "inspect",
                format!("parsing `{}`", source.display()),
                Some(0.0),
                None,
            );
            if args.list {
                let report = OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "list",
                    "inspect --list is only supported for container formats",
                    None,
                );
                return self.finish(
                    "inspect",
                    Self::append_recommended_compress_label(
                        report,
                        inspect_recommendation.as_ref(),
                    ),
                );
            }
            let report = handler.parse(&source, &context).unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "inspect",
                    error.to_string(),
                    None,
                )
            });
            let report =
                Self::append_recommended_compress_label(report, inspect_recommendation.as_ref());
            return self.finish("inspect", report);
        }

        if let Ok(Some(header_match)) = Self::detect_known_rom_header(&source) {
            if args.list {
                let report = OperationReport::failed(
                    OperationFamily::Command,
                    Some("rom-header".to_string()),
                    "list",
                    "inspect --list is only supported for container formats",
                    None,
                );
                return self.finish(
                    "inspect",
                    Self::append_recommended_compress_label(
                        report,
                        inspect_recommendation.as_ref(),
                    ),
                );
            }
            let report = OperationReport::succeeded(
                OperationFamily::Command,
                Some("rom-header".to_string()),
                "inspect",
                format!(
                    "detected ROM header {}; stripped_bytes={}; headered_extension={}; headerless_extension={}",
                    header_match.profile_name(),
                    header_match
                        .stripped_bytes()
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "n/a".to_string()),
                    header_match.header.headered_extension(),
                    header_match.header.headerless_extension()
                ),
                Some(100.0),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            return self.finish(
                "inspect",
                Self::append_recommended_compress_label(report, inspect_recommendation.as_ref()),
            );
        }

        let report = OperationReport::failed(
            OperationFamily::Command,
            None,
            "probe",
            format!("no registered handler matched `{}`", source.display()),
            None,
        );
        self.finish(
            "inspect",
            Self::append_recommended_compress_label(report, inspect_recommendation.as_ref()),
        )
    }

    fn run_extract(&self, args: ExtractCommand) -> ExitCode {
        trace!(
            source = %args.source.display(),
            selections = args.select.len(),
            out_dir = %args.out_dir.display(),
            split_bin = args.split_bin,
            threads = %args.threads,
            "starting extract command"
        );
        let ExtractCommand {
            source,
            select: selections,
            out_dir,
            split_bin,
            threads,
        } = args;
        let context = self.context(threads);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        if let Some(report) = self.require_existing_path(
            "extract",
            OperationFamily::Container,
            None,
            &source,
            probe_threads.clone(),
        ) {
            return self.finish("extract", report);
        }

        let Some(handler) = self.containers.probe(&source) else {
            return self.finish(
                "extract",
                OperationReport::failed(
                    OperationFamily::Container,
                    None,
                    "probe",
                    format!("no registered container matched `{}`", source.display()),
                    probe_threads,
                ),
            );
        };

        let (extract_split_bin, split_bin_warning) =
            if split_bin && !handler.descriptor().matches_name("chd") {
                (
                    false,
                    Some(format!(
                        "ignored --split-bin for non-CHD input; matched `{}`",
                        handler.descriptor().name
                    )),
                )
            } else {
                (split_bin, None)
            };

        let extract_threads = Some(context.plan_threads(handler.capabilities().extract_threads));
        self.emit_running(
            "extract",
            OperationFamily::Container,
            Some(handler.descriptor().name),
            "extract",
            format!("extracting `{}`", source.display()),
            Some(0.0),
            extract_threads.clone(),
        );
        let mut report = self
            .extract_with_selection_fallback(
                handler.as_ref(),
                &source,
                &out_dir,
                &selections,
                extract_split_bin,
                "extract input",
                &context,
            )
            .unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    "extract",
                    error.to_string(),
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                )
            });
        if let Some(split_bin_warning) = split_bin_warning {
            report.label = format!("{}; warning={split_bin_warning}", report.label);
        }
        if report.status == OperationStatus::Succeeded {
            self.emit_running(
                "extract",
                OperationFamily::Container,
                Some(handler.descriptor().name),
                "nested-extract",
                format!("checking nested archives under `{}`", out_dir.display()),
                None,
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            match self.extract_nested_archives(&source, &out_dir, &context) {
                Ok(0) => {}
                Ok(nested_count) => {
                    report.label = format!(
                        "{}; recursively extracted {nested_count} nested container(s)",
                        report.label
                    );
                }
                Err(error) => {
                    report = OperationReport::failed(
                        OperationFamily::Container,
                        Some(handler.descriptor().name.to_string()),
                        "extract",
                        error.to_string(),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                }
            }
        }
        self.finish("extract", report)
    }

    fn run_checksum(&self, args: ChecksumCommand) -> ExitCode {
        trace!(
            source = %args.source.display(),
            algorithm_count = args.algo.len(),
            selections = args.select.len(),
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            strip_header = args.strip_header,
            no_trim_fix = args.no_trim_fix,
            start = ?args.start,
            length = ?args.length,
            threads = %args.threads,
            "starting checksum command"
        );
        let ChecksumCommand {
            source,
            algo,
            select,
            no_extract,
            no_ignore,
            strip_header,
            no_trim_fix,
            start,
            length,
            threads,
        } = args;
        let context = self.context(threads);
        let thread_execution =
            Some(context.plan_threads(ThreadCapability::parallel(Some(algo.len().max(1)))));
        if let Some(report) = self.require_existing_path(
            "checksum",
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            &source,
            thread_execution.clone(),
        ) {
            return self.finish("checksum", report);
        }

        let invalid = algo.iter().find(|algo| {
            !supported_algorithms()
                .iter()
                .any(|supported| supported.eq_ignore_ascii_case(algo))
        });
        if let Some(invalid) = invalid {
            return self.finish(
                "checksum",
                OperationReport::failed(
                    OperationFamily::Checksum,
                    Some(self.checksum.name().to_string()),
                    "validate",
                    format!("unsupported checksum algorithm `{invalid}`"),
                    thread_execution,
                ),
            );
        }

        let resolved = match self.resolve_source_with_auto_extract(
            &source,
            &select,
            no_extract,
            no_ignore,
            &context,
            AutoExtractResolutionLabels {
                command: "checksum",
                family: OperationFamily::Checksum,
                format: Some(self.checksum.name()),
                source_label: "checksum",
                temp_prefix: "checksum-extract",
            },
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish(
                    "checksum",
                    OperationReport::failed(
                        OperationFamily::Checksum,
                        Some(self.checksum.name().to_string()),
                        "prepare",
                        error.to_string(),
                        thread_execution,
                    ),
                );
            }
        };
        let ResolvedChecksumSource {
            source: resolved_source,
            extracted_archives,
            mut cleanup_paths,
        } = resolved;

        self.emit_running(
            "checksum",
            OperationFamily::Checksum,
            Some(self.checksum.name()),
            "checksum",
            format!("computing {} checksum algorithm(s)", algo.len()),
            Some(0.0),
            thread_execution.clone(),
        );

        let mut temp_paths = Vec::new();
        let mut stripped_header_match = None;
        let checksum_source = if strip_header {
            self.emit_running(
                "checksum",
                OperationFamily::Checksum,
                Some(self.checksum.name()),
                "prepare",
                "stripping ROM header before checksum",
                None,
                thread_execution.clone(),
            );
            let stripped_extension = resolved_source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("bin");
            let stripped_path = context
                .temp_paths()
                .next_path("checksum-input-noheader", Some(stripped_extension));
            match Self::strip_header_to_temp(&resolved_source, &stripped_path) {
                Ok(result) => {
                    stripped_header_match = result.matched_header;
                    temp_paths.push(stripped_path.clone());
                    stripped_path
                }
                Err(error) => {
                    return self.finish(
                        "checksum",
                        OperationReport::failed(
                            OperationFamily::Checksum,
                            Some(self.checksum.name().to_string()),
                            "validate",
                            error.to_string(),
                            thread_execution,
                        ),
                    );
                }
            }
        } else {
            resolved_source.clone()
        };
        let mut trimmed_plan = None;
        let mut start = start;
        let mut length = length;
        let should_auto_trim_fix = !no_trim_fix && start.is_none() && length.is_none();
        if should_auto_trim_fix {
            self.emit_running(
                "checksum",
                OperationFamily::Checksum,
                Some(self.checksum.name()),
                "prepare",
                "resolving trim boundary before checksum",
                None,
                thread_execution.clone(),
            );
            if let Ok(plan) = self.read_checksum_trim_plan(&checksum_source) {
                start = Some(0);
                length = Some(plan.trimmed_size);
                trimmed_plan = Some(plan);
            }
        }
        temp_paths.append(&mut cleanup_paths);
        let request = ChecksumRequest {
            source: checksum_source,
            algorithms: algo
                .into_iter()
                .map(|algorithm| algorithm.to_ascii_lowercase())
                .collect(),
            start,
            length,
        };
        let mut report = if request.start.is_some() || request.length.is_some() {
            self.checksum.checksum_range(&request, &context)
        } else {
            self.checksum.checksum_file(&request, &context)
        }
        .unwrap_or_else(|error| {
            OperationReport::failed(
                OperationFamily::Checksum,
                Some(self.checksum.name().to_string()),
                "checksum",
                error.to_string(),
                Some(
                    context
                        .plan_threads(ThreadCapability::parallel(Some(request.algorithms.len()))),
                ),
            )
        });
        if report.status == OperationStatus::Succeeded {
            if strip_header {
                if let Some(header_match) = stripped_header_match {
                    report.label = format!(
                        "{}; input header stripped ({} bytes, {})",
                        report.label,
                        header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES),
                        header_match.profile_name()
                    );
                } else {
                    report.label = format!(
                        "{}; input header stripped ({} bytes)",
                        report.label, ROM_HEADER_BYTES
                    );
                }
            }
            if let Some(plan) = trimmed_plan {
                report.label = format!(
                    "{}; trimmed_input_bytes={} mode={} preserved_download_play_cert={}",
                    report.label, plan.trimmed_size, plan.mode, plan.preserved_download_play_cert
                );
            }
            if extracted_archives > 0 {
                report.label = format!(
                    "{}; checksum source resolved via {extracted_archives} container extract step(s)",
                    report.label
                );
            }
        }
        Self::cleanup_temp_paths(temp_paths);
        self.finish("checksum", report)
    }

    fn resolve_source_with_auto_extract(
        &self,
        source: &Path,
        select: &[String],
        no_extract: bool,
        no_ignore: bool,
        context: &OperationContext,
        labels: AutoExtractResolutionLabels<'_>,
    ) -> Result<ResolvedChecksumSource> {
        trace!(
            source = %source.display(),
            selections = select.len(),
            no_extract,
            no_ignore,
            command = labels.command,
            family = ?labels.family,
            format = ?labels.format,
            source_label = labels.source_label,
            "starting auto-extract source resolution"
        );
        if no_extract {
            trace!(
                source = %source.display(),
                "auto-extract source resolution disabled by flag"
            );
            return Ok(ResolvedChecksumSource {
                source: source.to_path_buf(),
                extracted_archives: 0,
                cleanup_paths: Vec::new(),
            });
        }

        let mut current_source = source.to_path_buf();
        let mut extracted_archives = 0usize;
        let mut depth = 0usize;
        let mut cleanup_paths = Vec::new();

        loop {
            trace!(
                current_source = %current_source.display(),
                depth,
                extracted_archives,
                "auto-extract iteration"
            );
            let Some(handler) = self.containers.probe(&current_source) else {
                trace!(
                    current_source = %current_source.display(),
                    "auto-extract stopped: no container handler matched source"
                );
                break;
            };
            let is_xiso = handler.descriptor().matches_name("xiso");
            let can_extract = handler.capabilities().extract;
            if is_xiso || !can_extract {
                trace!(
                    current_source = %current_source.display(),
                    format = handler.descriptor().name,
                    is_xiso,
                    can_extract,
                    "auto-extract stopped: matched handler is not eligible for extract"
                );
                break;
            }

            let inspect_request = ContainerInspectRequest {
                source: current_source.clone(),
            };
            if let Err(error) = handler.inspect(&inspect_request, context) {
                trace!(
                    current_source = %current_source.display(),
                    format = handler.descriptor().name,
                    error = %error,
                    "auto-extract stopped: handler inspect failed"
                );
                break;
            }

            let next_depth = depth + 1;
            if next_depth > MAX_NESTED_EXTRACT_DEPTH {
                trace!(
                    current_source = %current_source.display(),
                    next_depth,
                    max_depth = MAX_NESTED_EXTRACT_DEPTH,
                    "auto-extract failed: exceeded max recursion depth"
                );
                return Err(RomWeaverError::Validation(format!(
                    "{} extract exceeded max depth of {MAX_NESTED_EXTRACT_DEPTH} at `{}`",
                    labels.source_label,
                    current_source.display()
                )));
            }
            if extracted_archives >= MAX_NESTED_EXTRACT_ARCHIVES {
                trace!(
                    source = %source.display(),
                    extracted_archives,
                    max_archives = MAX_NESTED_EXTRACT_ARCHIVES,
                    "auto-extract failed: exceeded max archive count"
                );
                return Err(RomWeaverError::Validation(format!(
                    "{} extract exceeded max archive count of {MAX_NESTED_EXTRACT_ARCHIVES}",
                    labels.source_label
                )));
            }

            self.emit_running(
                labels.command,
                labels.family,
                labels.format,
                "prepare",
                format!(
                    "extracting {} payload from `{}`",
                    labels.source_label,
                    current_source.display()
                ),
                None,
                Some(context.plan_threads(handler.capabilities().extract_threads)),
            );

            let out_dir = context.temp_paths().next_path(labels.temp_prefix, None);
            fs::create_dir_all(&out_dir)?;
            self.extract_with_selection_fallback(
                handler.as_ref(),
                &current_source,
                &out_dir,
                select,
                false,
                labels.source_label,
                context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} payload extraction failed for `{}` ({}): {error}",
                    labels.source_label,
                    current_source.display(),
                    handler.descriptor().name
                ))
            })?;
            cleanup_paths.push(out_dir.clone());
            extracted_archives = extracted_archives.saturating_add(1);
            depth = next_depth;
            trace!(
                source = %current_source.display(),
                format = handler.descriptor().name,
                out_dir = %out_dir.display(),
                extracted_archives,
                depth,
                "auto-extract archive extraction completed"
            );

            let all_candidates = self.collect_checksum_extract_candidates(&out_dir)?;
            trace!(
                source = %current_source.display(),
                candidate_count = all_candidates.len(),
                "auto-extract collected extracted candidates"
            );
            if all_candidates.is_empty() {
                trace!(
                    source = %current_source.display(),
                    "auto-extract failed: extracted archive produced no candidates"
                );
                return Err(RomWeaverError::Validation(format!(
                    "{} payload extraction produced no files for `{}`",
                    labels.source_label,
                    current_source.display()
                )));
            }

            let candidates = if no_ignore {
                all_candidates.clone()
            } else {
                let non_ignored = all_candidates
                    .iter()
                    .filter(|candidate| !candidate.ignored)
                    .cloned()
                    .collect::<Vec<_>>();
                trace!(
                    source = %current_source.display(),
                    candidate_count = all_candidates.len(),
                    non_ignored_count = non_ignored.len(),
                    "auto-extract applied candidate ignore filters"
                );
                if non_ignored.is_empty() {
                    if self.interactive_selection_enabled {
                        if let Some(selected) = self.prompt_for_checksum_candidate(
                            &current_source,
                            &all_candidates,
                            labels.source_label,
                            true,
                        )? {
                            trace!(
                                source = %current_source.display(),
                                selected = %selected.display_name,
                                selected_path = %selected.source.display(),
                                "auto-extract continued with interactively selected ignored candidate"
                            );
                            current_source = selected.source;
                            continue;
                        }
                        trace!(
                            source = %current_source.display(),
                            "auto-extract failed: interactive selection cancelled while all candidates were ignored"
                        );
                        return Err(RomWeaverError::Validation(format!(
                            "interactive selection was cancelled for `{}`",
                            current_source.display()
                        )));
                    }
                    trace!(
                        source = %current_source.display(),
                        "auto-extract failed: all candidates ignored and no interactive selection"
                    );
                    return Err(RomWeaverError::Validation(format!(
                        "all extracted {} candidates from `{}` were ignored by default filters; rerun with --no-ignore or pass --select <pattern>",
                        labels.source_label,
                        current_source.display()
                    )));
                }
                non_ignored
            };
            if candidates.len() > 1 {
                if self.interactive_selection_enabled {
                    if let Some(selected) = self.prompt_for_checksum_candidate(
                        &current_source,
                        &candidates,
                        labels.source_label,
                        false,
                    )? {
                        trace!(
                            source = %current_source.display(),
                            selected = %selected.display_name,
                            selected_path = %selected.source.display(),
                            "auto-extract continued with interactively selected candidate"
                        );
                        current_source = selected.source;
                        continue;
                    }
                    trace!(
                        source = %current_source.display(),
                        candidate_count = candidates.len(),
                        "auto-extract failed: interactive ambiguous candidate selection cancelled"
                    );
                    return Err(RomWeaverError::Validation(format!(
                        "interactive selection was cancelled for `{}`",
                        current_source.display()
                    )));
                }
                let choices = candidates
                    .iter()
                    .map(|candidate| format!("`{}`", candidate.display_name))
                    .collect::<Vec<_>>()
                    .join(", ");
                trace!(
                    source = %current_source.display(),
                    candidate_count = candidates.len(),
                    candidates = %choices,
                    "auto-extract failed: ambiguous candidates without interactive selection"
                );
                return Err(RomWeaverError::Validation(format!(
                    "{} payload resolution is ambiguous for `{}`; candidates: {choices}. Pass --select <pattern> to choose one payload",
                    labels.source_label,
                    current_source.display()
                )));
            }

            let selected_candidate = candidates
                .into_iter()
                .next()
                .expect("checked candidate count");
            trace!(
                source = %current_source.display(),
                selected = %selected_candidate.display_name,
                selected_path = %selected_candidate.source.display(),
                "auto-extract selected single candidate"
            );
            current_source = selected_candidate.source;
        }

        trace!(
            source = %source.display(),
            resolved_source = %current_source.display(),
            extracted_archives,
            cleanup_paths = cleanup_paths.len(),
            "completed auto-extract source resolution"
        );
        Ok(ResolvedChecksumSource {
            source: current_source,
            extracted_archives,
            cleanup_paths,
        })
    }

    fn extract_with_selection_fallback(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        out_dir: &Path,
        selections: &[String],
        split_bin: bool,
        source_label: &str,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let request = ContainerExtractRequest {
            source: source.to_path_buf(),
            selections: selections.to_vec(),
            out_dir: out_dir.to_path_buf(),
            split_bin,
        };
        match handler.extract(&request, context) {
            Ok(report) => Ok(report),
            Err(error) => {
                if !self.interactive_selection_enabled
                    || !Self::is_selection_resolution_error(&error.to_string())
                {
                    return Err(error);
                }

                let Some(selected_entry) =
                    self.prompt_for_container_selection(handler, source, source_label, context)?
                else {
                    return Err(RomWeaverError::Validation(format!(
                        "interactive selection was cancelled for `{}`",
                        source.display()
                    )));
                };

                let retry_request = ContainerExtractRequest {
                    source: source.to_path_buf(),
                    selections: vec![selected_entry],
                    out_dir: out_dir.to_path_buf(),
                    split_bin,
                };
                handler.extract(&retry_request, context)
            }
        }
    }

    fn is_selection_resolution_error(label: &str) -> bool {
        let lower = label.to_ascii_lowercase();
        lower.contains("requested selections were not found")
            || lower.contains("requested selections resolved to no extractable")
            || lower.contains("does not support --select")
    }

    fn prompt_for_container_selection(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        source_label: &str,
        context: &OperationContext,
    ) -> Result<Option<String>> {
        let entries = handler
            .list_entries(
                &ContainerInspectRequest {
                    source: source.to_path_buf(),
                },
                context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "interactive selection could not list entries for `{}` ({}): {error}",
                    source.display(),
                    handler.descriptor().name
                ))
            })?;

        let mut unique_entries = Vec::new();
        let mut seen = HashSet::new();
        for entry in entries {
            let normalized = Self::normalize_selection_entry_name(&entry);
            if normalized.is_empty() || !seen.insert(normalized.clone()) {
                continue;
            }
            unique_entries.push(normalized);
        }
        if unique_entries.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "interactive selection could not list selectable entries for `{}` ({})",
                source.display(),
                handler.descriptor().name
            )));
        }

        let prompt_candidates = unique_entries
            .iter()
            .map(|entry| SelectionPromptCandidate {
                value: entry.clone(),
                label: entry.clone(),
            })
            .collect::<Vec<_>>();
        let heading = format!(
            "{source_label} selection for `{}` did not resolve. Choose one entry:",
            source.display()
        );
        let selected_index = self.prompt_for_selection(&heading, &prompt_candidates)?;
        Ok(selected_index.map(|index| prompt_candidates[index].value.clone()))
    }

    fn prompt_for_checksum_candidate(
        &self,
        source: &Path,
        candidates: &[ChecksumExtractCandidate],
        source_label: &str,
        ignored_only: bool,
    ) -> Result<Option<ChecksumExtractCandidate>> {
        if candidates.is_empty() {
            return Ok(None);
        }
        let heading = if ignored_only {
            format!(
                "{source_label} payload candidates for `{}` were ignored by default filters. Choose one entry to continue:",
                source.display()
            )
        } else {
            format!(
                "{source_label} payload selection for `{}` is ambiguous. Choose one entry:",
                source.display()
            )
        };
        let prompt_candidates = candidates
            .iter()
            .map(|candidate| SelectionPromptCandidate {
                value: candidate.display_name.clone(),
                label: if ignored_only && candidate.ignored {
                    format!("{} [ignored by default]", candidate.display_name)
                } else {
                    candidate.display_name.clone()
                },
            })
            .collect::<Vec<_>>();
        let selected_index = self.prompt_for_selection(&heading, &prompt_candidates)?;
        Ok(selected_index.map(|index| candidates[index].clone()))
    }

    fn normalize_selection_entry_name(name: &str) -> String {
        name.trim()
            .replace('\\', "/")
            .trim_start_matches("./")
            .trim_matches('/')
            .to_string()
    }

    fn parse_selection_input(input: &str, candidate_count: usize) -> ParsedSelectionInput {
        let trimmed = input.trim();
        if trimmed.eq_ignore_ascii_case("q")
            || trimmed.eq_ignore_ascii_case("quit")
            || trimmed.eq_ignore_ascii_case("exit")
        {
            return ParsedSelectionInput::Cancelled;
        }
        if let Ok(parsed) = trimmed.parse::<usize>()
            && (1..=candidate_count).contains(&parsed)
        {
            return ParsedSelectionInput::Selected(parsed - 1);
        }
        ParsedSelectionInput::Invalid
    }

    fn prompt_for_selection(
        &self,
        heading: &str,
        candidates: &[SelectionPromptCandidate],
    ) -> Result<Option<usize>> {
        if !self.interactive_selection_enabled || candidates.is_empty() {
            return Ok(None);
        }
        eprintln!("{heading}");
        for (index, candidate) in candidates.iter().enumerate() {
            eprintln!("  {}. {}", index + 1, candidate.label);
        }
        eprintln!(
            "Enter a number between 1 and {}, or `q` to cancel.",
            candidates.len()
        );

        loop {
            eprint!("selection> ");
            io::stderr().flush()?;
            let mut input = String::new();
            let bytes_read = io::stdin().read_line(&mut input)?;
            if bytes_read == 0 {
                return Ok(None);
            }
            let trimmed = input.trim();
            match Self::parse_selection_input(trimmed, candidates.len()) {
                ParsedSelectionInput::Cancelled => return Ok(None),
                ParsedSelectionInput::Selected(index) => return Ok(Some(index)),
                ParsedSelectionInput::Invalid => {}
            }
            eprintln!(
                "invalid selection `{trimmed}`. Enter 1..{} or `q`.",
                candidates.len()
            );
        }
    }

    fn cleanup_temp_paths(temp_paths: Vec<PathBuf>) {
        for temp_path in temp_paths {
            match fs::metadata(&temp_path) {
                Ok(metadata) if metadata.is_dir() => {
                    let _ = fs::remove_dir_all(temp_path);
                }
                Ok(_) => {
                    let _ = fs::remove_file(temp_path);
                }
                Err(_) => {}
            }
        }
    }

    fn collect_checksum_extract_candidates(
        &self,
        root: &Path,
    ) -> Result<Vec<ChecksumExtractCandidate>> {
        let mut directories = vec![root.to_path_buf()];
        let mut candidates = Vec::new();
        while let Some(directory) = directories.pop() {
            let mut entries =
                fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path());

            for entry in entries {
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_dir() {
                    directories.push(path);
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }

                let relative = path.strip_prefix(root).map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "failed to derive checksum candidate path from `{}`",
                        path.display()
                    ))
                })?;
                let display_name = Self::normalize_checksum_candidate_name(relative);
                if display_name.is_empty() {
                    continue;
                }
                let ignored = Self::should_ignore_checksum_candidate(&display_name);
                candidates.push(ChecksumExtractCandidate {
                    source: path,
                    display_name,
                    ignored,
                });
            }
        }

        candidates.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        Ok(candidates)
    }

    fn normalize_checksum_candidate_name(path: &Path) -> String {
        path.to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches("./")
            .trim_matches('/')
            .to_string()
    }

    fn should_ignore_checksum_candidate(candidate_name: &str) -> bool {
        let lower = candidate_name.to_ascii_lowercase();
        if lower.contains("maxcso") {
            return true;
        }
        Self::checksum_ignore_globs().is_match(candidate_name)
    }

    fn checksum_ignore_globs() -> &'static GlobSet {
        static IGNORE_GLOBS: OnceLock<GlobSet> = OnceLock::new();
        IGNORE_GLOBS.get_or_init(|| {
            let mut patterns = vec![
                "__MACOSX".to_string(),
                "__MACOSX/**".to_string(),
                "**/__MACOSX".to_string(),
                "**/__MACOSX/**".to_string(),
                ".DS_Store".to_string(),
                "**/.DS_Store".to_string(),
                "Thumbs.db".to_string(),
                "**/Thumbs.db".to_string(),
                "desktop.ini".to_string(),
                "**/desktop.ini".to_string(),
            ];
            for extension in CHECKSUM_IGNORE_SIDECAR_EXTENSIONS {
                patterns.push(format!("*{extension}"));
                patterns.push(format!("**/*{extension}"));
            }

            let mut builder = GlobSetBuilder::new();
            for pattern in patterns {
                let glob = GlobBuilder::new(&pattern)
                    .case_insensitive(true)
                    .literal_separator(true)
                    .build()
                    .expect("checksum ignore glob pattern must be valid");
                builder.add(glob);
            }
            builder.build().expect("checksum ignore globset must build")
        })
    }

    fn run_compress(&self, args: CompressCommand) -> ExitCode {
        trace!(
            input_count = args.input.len(),
            output = %args.output.display(),
            requested_format = ?args.format,
            codec = ?args.codec,
            level = ?args.level,
            threads = %args.threads,
            "starting compress command"
        );
        let CompressCommand {
            input,
            format,
            output,
            codec,
            level: level_profile,
            threads,
        } = args;
        let requested_format = match format {
            Some(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return self.finish(
                        "compress",
                        OperationReport::failed(
                            OperationFamily::Container,
                            None,
                            "validate",
                            "--format cannot be empty",
                            None,
                        ),
                    );
                }
                Some(trimmed.to_string())
            }
            None => None,
        };
        let requested_or_auto_format = requested_format
            .clone()
            .unwrap_or_else(|| "auto".to_string());
        let auto_mode = requested_format
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("auto"))
            .unwrap_or(true);

        let context = self.context(threads);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        for input in &input {
            if let Some(report) = self.require_existing_path(
                "compress",
                OperationFamily::Container,
                Some(requested_or_auto_format.clone()),
                input,
                probe_threads.clone(),
            ) {
                return self.finish("compress", report);
            }
        }
        if auto_mode && input.len() != 1 {
            return self.finish(
                "compress",
                OperationReport::failed(
                    OperationFamily::Container,
                    Some("auto".to_string()),
                    "validate",
                    "auto format selection requires exactly one input file; pass --format <name> when compressing multiple inputs",
                    probe_threads,
                ),
            );
        }
        let (resolved_format, auto_label_suffix) = if auto_mode {
            let recommendation = self.containers.recommend_compress_format(&input[0]);
            (
                recommendation.format_name.to_string(),
                Some(format!(
                    "auto format={} reason={}",
                    recommendation.format_name, recommendation.reason
                )),
            )
        } else {
            (
                requested_format
                    .clone()
                    .expect("non-auto mode should keep an explicit format"),
                None,
            )
        };
        let (codec, explicit_level) = match Self::resolve_codec_level(codec, "--codec") {
            Ok(value) => value,
            Err(error) => {
                return self.finish(
                    "compress",
                    OperationReport::failed(
                        OperationFamily::Container,
                        Some(resolved_format.clone()),
                        "validate",
                        error.to_string(),
                        probe_threads,
                    ),
                );
            }
        };
        let (codec, explicit_level) = if auto_mode {
            (None, None)
        } else {
            (codec, explicit_level)
        };
        let level = Self::resolve_compression_level_for_profile(
            &resolved_format,
            codec.as_deref(),
            explicit_level,
            level_profile,
        );

        let Some(handler) = self.containers.find_by_name(&resolved_format) else {
            return self.finish(
                "compress",
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(resolved_format),
                    "probe",
                    "requested output format is not registered",
                    probe_threads,
                ),
            );
        };
        let capabilities = handler.capabilities();
        if !capabilities.inspect && !capabilities.extract && !capabilities.create {
            return self.finish(
                "compress",
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(resolved_format),
                    "probe",
                    "requested output format is not registered",
                    probe_threads,
                ),
            );
        }

        self.emit_running(
            "compress",
            OperationFamily::Container,
            Some(handler.descriptor().name),
            "create",
            format!(
                "creating {} archive from {} input(s)",
                handler.descriptor().name,
                input.len()
            ),
            Some(0.0),
            Some(context.plan_threads(capabilities.create_threads)),
        );

        let request = ContainerCreateRequest {
            inputs: input,
            output,
            format: handler.descriptor().name.to_string(),
            codec,
            level,
        };
        let mut report = handler.create(&request, &context).unwrap_or_else(|error| {
            OperationReport::failed(
                OperationFamily::Container,
                Some(handler.descriptor().name.to_string()),
                "create",
                error.to_string(),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            )
        });
        if report.status == OperationStatus::Succeeded
            && let Some(auto_label_suffix) = auto_label_suffix
        {
            report.label = format!("{}; {auto_label_suffix}", report.label);
        }
        self.finish("compress", report)
    }

    fn run_trim(&self, args: TrimCommand) -> ExitCode {
        trace!(
            source_count = args.source.len(),
            output = ?args.output.as_ref().map(|path| path.display().to_string()),
            extension = ?args.extension,
            in_place = args.in_place,
            dry_run = args.dry_run,
            revert = args.revert,
            recursive = args.recursive,
            threads = %args.threads,
            "starting trim command"
        );
        let TrimCommand {
            source,
            output,
            extension,
            in_place,
            dry_run,
            revert,
            recursive,
            threads,
        } = args;
        let operation = if revert {
            TrimOperation::Revert
        } else {
            TrimOperation::Trim
        };
        let context = self.context(threads);
        let thread_execution = Some(context.plan_threads(ThreadCapability::single_threaded()));
        let extension = extension
            .unwrap_or_else(|| Self::default_trim_extension_pattern(operation).to_string());
        let extension = match Self::normalize_trim_extension(&extension) {
            Ok(value) => value,
            Err(error) => {
                return self.finish(
                    "trim",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("nds".to_string()),
                        "validate",
                        error.to_string(),
                        thread_execution,
                    ),
                );
            }
        };

        let mut skipped_non_nds = 0usize;
        let trim_sources =
            match self.collect_trim_input_files(&source, recursive, &mut skipped_non_nds) {
                Ok(paths) => paths,
                Err(error) => {
                    return self.finish(
                        "trim",
                        OperationReport::failed(
                            OperationFamily::Command,
                            Some("nds".to_string()),
                            "validate",
                            error.to_string(),
                            thread_execution,
                        ),
                    );
                }
            };

        if trim_sources.is_empty() {
            return self.finish(
                "trim",
                OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("nds".to_string()),
                    "trim",
                    format!("no trim-eligible inputs found; skipped_non_nds={skipped_non_nds}"),
                    Some(100.0),
                    thread_execution,
                ),
            );
        }

        if output.is_some() && trim_sources.len() != 1 {
            return self.finish(
                "trim",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("nds".to_string()),
                    "validate",
                    "--output requires exactly one trim-eligible source file",
                    thread_execution,
                ),
            );
        }

        let mut trimmed_count = 0usize;
        let mut already_trimmed_count = 0usize;
        let mut failed_count = 0usize;
        let mut first_error = None;
        let mut mode_counts: BTreeMap<&'static str, usize> = BTreeMap::new();
        let mut single_detail = None;
        let mut irreversible_trimmed_count = 0usize;

        for trim_source in &trim_sources {
            let output_path = if in_place {
                trim_source.path.clone()
            } else if let Some(explicit_output) = output.as_ref() {
                explicit_output.clone()
            } else {
                Self::default_trim_output_path(&trim_source.path, &extension)
            };
            let output_label = if in_place {
                "in-place".to_string()
            } else {
                output_path.display().to_string()
            };

            self.emit_running(
                "trim",
                OperationFamily::Command,
                Some("nds"),
                operation.stage(),
                format!(
                    "{} `{}` -> `{output_label}`",
                    operation.running_label(dry_run),
                    trim_source.path.display()
                ),
                Some(0.0),
                thread_execution.clone(),
            );

            match Self::trim_file(
                &trim_source.path,
                &output_path,
                in_place,
                dry_run,
                operation,
                trim_source.kind,
            ) {
                Ok(outcome) => {
                    let mode_count = mode_counts.entry(outcome.mode).or_insert(0);
                    *mode_count = mode_count.saturating_add(1);
                    if operation == TrimOperation::Trim && !outcome.revert_supported {
                        irreversible_trimmed_count = irreversible_trimmed_count.saturating_add(1);
                    }
                    if outcome.already_target_size {
                        already_trimmed_count = already_trimmed_count.saturating_add(1);
                    } else {
                        trimmed_count = trimmed_count.saturating_add(1);
                    }
                    if trim_sources.len() == 1 {
                        let status = if outcome.already_target_size {
                            if operation == TrimOperation::Trim {
                                "already-trimmed"
                            } else {
                                "already-untrimmed"
                            }
                        } else if operation == TrimOperation::Trim {
                            "trimmed"
                        } else {
                            "reverted"
                        };
                        let result_size_label = if operation == TrimOperation::Trim {
                            "trimmed_size"
                        } else {
                            "reverted_size"
                        };
                        single_detail = Some(format!(
                            "{status} mode={} original_size={} {result_size_label}={} preserved_download_play_cert={} revert_supported={} output={}",
                            outcome.mode,
                            outcome.original_size,
                            outcome.result_size,
                            outcome.preserved_download_play_cert,
                            outcome.revert_supported,
                            outcome.output_path.display()
                        ));
                    }
                }
                Err(error) => {
                    failed_count = failed_count.saturating_add(1);
                    if first_error.is_none() {
                        first_error = Some(format!("{}: {error}", trim_source.path.display()));
                    }
                }
            }
        }

        if failed_count > 0 {
            return self.finish(
                "trim",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("nds".to_string()),
                    "trim",
                    format!(
                        "{} completed with failures; processed={} trimmed={} already_trimmed={} failed={} skipped_non_nds={}; first_error={}",
                        if dry_run {
                            if operation == TrimOperation::Trim {
                                "trim simulation"
                            } else {
                                "trim revert simulation"
                            }
                        } else if operation == TrimOperation::Trim {
                            "trim"
                        } else {
                            "trim revert"
                        },
                        trim_sources.len(),
                        trimmed_count,
                        already_trimmed_count,
                        failed_count,
                        skipped_non_nds,
                        first_error.unwrap_or_else(|| "(none)".to_string()),
                    ),
                    thread_execution,
                ),
            );
        }

        let irreversible_warning =
            if operation == TrimOperation::Trim && irreversible_trimmed_count > 0 {
                "; warning=trimmed xiso output cannot be reverted to original padding; keep backup"
            } else {
                ""
            };

        self.finish(
            "trim",
            OperationReport::succeeded(
                OperationFamily::Command,
                Some("nds".to_string()),
                "trim",
                match single_detail {
                    Some(single_detail) => format!(
                        "{single_detail}; {}; processed={} trimmed={} already_trimmed={} changed={} already_target={} skipped_non_nds={} mode_counts={}{}",
                        operation.summary_label(dry_run),
                        trim_sources.len(),
                        trimmed_count,
                        already_trimmed_count,
                        trimmed_count,
                        already_trimmed_count,
                        skipped_non_nds,
                        Self::format_mode_counts(&mode_counts),
                        irreversible_warning,
                    ),
                    None => format!(
                        "{}; processed={} trimmed={} already_trimmed={} changed={} already_target={} skipped_non_nds={} mode_counts={}{}",
                        operation.summary_label(dry_run),
                        trim_sources.len(),
                        trimmed_count,
                        already_trimmed_count,
                        trimmed_count,
                        already_trimmed_count,
                        skipped_non_nds,
                        Self::format_mode_counts(&mode_counts),
                        irreversible_warning,
                    ),
                },
                Some(100.0),
                thread_execution,
            ),
        )
    }

    fn run_patch_apply(&self, args: PatchApplyCommand) -> ExitCode {
        trace!(
            input = %args.input.display(),
            selections = args.select.len(),
            patch_count = args.patches.len(),
            output = %args.output.display(),
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            no_compress = args.no_compress,
            compress_format = ?args.compress_format,
            compress_codec = ?args.compress_codec,
            compress_level = ?args.compress_level,
            checksum_cache = args.checksum_cache.len(),
            validate_with_checksums = args.validate_with_checksums.len(),
            strip_header = args.strip_header,
            add_header = args.add_header,
            repair_checksum = args.repair_checksum,
            ignore_checksum_validation = args.ignore_checksum_validation,
            threads = %args.threads,
            "starting patch-apply command"
        );
        let PatchApplyCommand {
            input,
            select,
            no_extract,
            no_ignore,
            patches,
            output,
            no_compress,
            compress_format,
            compress_codec,
            compress_level,
            checksum_cache,
            validate_with_checksums,
            strip_header,
            add_header,
            repair_checksum,
            ignore_checksum_validation,
            threads,
        } = args;
        let context =
            self.context(threads)
                .with_patch_checksum_validation(if ignore_checksum_validation {
                    PatchChecksumValidation::Ignore
                } else {
                    PatchChecksumValidation::Strict
                });
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        let compression_options = match Self::parse_patch_apply_compression_options(
            no_compress,
            compress_format,
            compress_codec,
            compress_level,
        ) {
            Ok(options) => options,
            Err(error) => {
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        let cached_input_checksums =
            match Self::parse_patch_apply_checksum_values(&checksum_cache, "--checksum-cache") {
                Ok(values) => values,
                Err(error) => {
                    return self.finish(
                        "patch-apply",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            probe_threads.clone(),
                        ),
                    );
                }
            };
        let expected_input_checksums = match Self::parse_patch_apply_checksum_values(
            &validate_with_checksums,
            "--validate-with-checksum",
        ) {
            Ok(values) => values,
            Err(error) => {
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        if let Some(report) = self.require_existing_path(
            "patch-apply",
            OperationFamily::Patch,
            None,
            &input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-apply", report);
        }
        for patch_path in &patches {
            if let Some(report) = self.require_existing_path(
                "patch-apply",
                OperationFamily::Patch,
                None,
                patch_path,
                probe_threads.clone(),
            ) {
                return self.finish("patch-apply", report);
            }
        }

        let resolved_input = match self.resolve_source_with_auto_extract(
            &input,
            &select,
            no_extract,
            no_ignore,
            &context,
            AutoExtractResolutionLabels {
                command: "patch-apply",
                family: OperationFamily::Patch,
                format: None,
                source_label: "patch apply input",
                temp_prefix: "patch-apply-input-extract",
            },
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "prepare",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        let ResolvedChecksumSource {
            source: resolved_input,
            extracted_archives,
            cleanup_paths,
        } = resolved_input;
        let outer_container_format = if compression_options.enabled && compression_options.auto_mode
        {
            self.detect_patch_apply_outer_container_format(&input, &context)
        } else {
            None
        };

        let mut temp_paths = cleanup_paths;
        let report = (|| {
            if patches.is_empty() {
                return OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    "at least one --patch value is required",
                    probe_threads.clone(),
                );
            }

            let mut stripped_header = None;
            let mut stripped_header_match = None;
            let mut checksum_verification_labels = Vec::new();
            let apply_input = if strip_header {
                self.emit_running(
                    "patch-apply",
                    OperationFamily::Patch,
                    None,
                    "prepare",
                    "stripping ROM header before patch apply",
                    None,
                    None,
                );
                let stripped_path = context
                    .temp_paths()
                    .next_path("patch-apply-input-noheader", Some("bin"));
                match Self::strip_header_to_temp(&resolved_input, &stripped_path) {
                    Ok(result) => {
                        stripped_header = Some(result.header_bytes);
                        stripped_header_match = result.matched_header;
                        temp_paths.push(stripped_path.clone());
                        stripped_path
                    }
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "compat",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            } else {
                resolved_input.clone()
            };
            if !cached_input_checksums.is_empty() {
                self.emit_running(
                    "patch-apply",
                    OperationFamily::Patch,
                    None,
                    "prepare",
                    format!(
                        "seeding {} requested input checksum cache value(s)",
                        cached_input_checksums.len()
                    ),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                if let Err(error) =
                    seed_checksum_file_cache(&apply_input, &cached_input_checksums, &context)
                {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "prepare",
                        error.to_string(),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                }
            }
            if !expected_input_checksums.is_empty() {
                self.emit_running(
                    "patch-apply",
                    OperationFamily::Patch,
                    None,
                    "validate",
                    format!(
                        "validating {} requested input checksum(s)",
                        expected_input_checksums.len()
                    ),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                match Self::validate_patch_apply_expected_checksums(
                    &apply_input,
                    &expected_input_checksums,
                    "input",
                    &context,
                ) {
                    Ok(label) => checksum_verification_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            }

            let patch_count = patches.len();
            let requires_compat_finalize = add_header || repair_checksum || patch_count > 1;
            let needs_staged_output = requires_compat_finalize || compression_options.enabled;
            let staged_output = if needs_staged_output {
                let staged_path = context
                    .temp_paths()
                    .next_path("patch-apply-output-staged", Some("bin"));
                temp_paths.push(staged_path.clone());
                staged_path
            } else {
                output.clone()
            };

            let mut current_input = apply_input;
            let mut applied_formats = Vec::with_capacity(patch_count);
            let mut report = OperationReport::failed(
                OperationFamily::Patch,
                None,
                "apply",
                "patch apply was not executed",
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );

            for (index, patch_path) in patches.iter().enumerate() {
                let Some(handler) = self.patches.probe(patch_path) else {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "probe",
                        format!(
                            "patch {}/{}: no registered patch handler matched `{}`",
                            index + 1,
                            patch_count,
                            patch_path.display()
                        ),
                        probe_threads.clone(),
                    );
                };
                applied_formats.push(handler.descriptor().name);

                let is_last = index + 1 == patch_count;
                let apply_output = if is_last {
                    staged_output.clone()
                } else {
                    let intermediate_output = context
                        .temp_paths()
                        .next_path("patch-apply-output-step", Some("bin"));
                    temp_paths.push(intermediate_output.clone());
                    intermediate_output
                };
                if let Some(parent) = apply_output.parent()
                    && let Err(error) = fs::create_dir_all(parent)
                {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "prepare",
                        format!(
                            "failed to prepare output path `{}`: {error}",
                            apply_output.display()
                        ),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                }

                self.emit_running(
                    "patch-apply",
                    OperationFamily::Patch,
                    Some(handler.descriptor().name),
                    "apply",
                    if patch_count == 1 {
                        format!("applying patch using {}", handler.descriptor().name)
                    } else {
                        format!(
                            "applying patch {}/{} using {} (`{}`)",
                            index + 1,
                            patch_count,
                            handler.descriptor().name,
                            patch_path.display()
                        )
                    },
                    Some(0.0),
                    None,
                );

                let request = PatchApplyRequest {
                    input: current_input,
                    patches: vec![patch_path.clone()],
                    output: apply_output.clone(),
                };
                report = handler.apply(&request, &context).unwrap_or_else(|error| {
                    OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "apply",
                        error.to_string(),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    )
                });
                if report.status != OperationStatus::Succeeded {
                    if patch_count > 1 {
                        report.label = format!(
                            "patch {}/{} (`{}`): {}",
                            index + 1,
                            patch_count,
                            patch_path.display(),
                            report.label
                        );
                    }
                    return report;
                }

                current_input = apply_output;
            }

            let mut raw_ready_output = staged_output.clone();
            if report.status == OperationStatus::Succeeded && requires_compat_finalize {
                self.emit_running(
                    "patch-apply",
                    OperationFamily::Patch,
                    applied_formats.last().copied(),
                    "compat",
                    if add_header || repair_checksum {
                        "finalizing compatibility output transforms"
                    } else {
                        "finalizing multi-patch output"
                    },
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                let finalized_output_path = if compression_options.enabled {
                    let raw_path = context
                        .temp_paths()
                        .next_path("patch-apply-output-raw-final", Some("bin"));
                    temp_paths.push(raw_path.clone());
                    raw_path
                } else {
                    output.clone()
                };
                match Self::finalize_patch_apply_output(
                    &staged_output,
                    &finalized_output_path,
                    add_header,
                    stripped_header.as_deref(),
                    repair_checksum,
                    Some(&resolved_input),
                ) {
                    Ok(finalized) => {
                        raw_ready_output = finalized_output_path;
                        if finalized.repaired_profiles.len() == 1 {
                            report.label = format!(
                                "{}; repaired checksum ({})",
                                report.label, finalized.repaired_profiles[0]
                            );
                        } else if !finalized.repaired_profiles.is_empty() {
                            report.label = format!(
                                "{}; repaired headers ({})",
                                report.label,
                                finalized.repaired_profiles.join(", ")
                            );
                        }
                        if let Some(repair_warning) = finalized.repair_warning {
                            report.label = format!("{}; warning={repair_warning}", report.label);
                        }
                    }
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "compat",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            }

            if patch_count > 1 {
                report.label = format!(
                    "applied {patch_count} patches sequentially ({}); {}",
                    applied_formats.join(" -> "),
                    report.label
                );
            }
            if strip_header {
                if let Some(header_match) = stripped_header_match {
                    report.label = format!(
                        "{}; input header stripped ({} bytes, {})",
                        report.label,
                        header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES),
                        header_match.profile_name()
                    );
                } else {
                    report.label = format!(
                        "{}; input header stripped ({} bytes)",
                        report.label, ROM_HEADER_BYTES
                    );
                }
            }
            if extracted_archives > 0 {
                report.label = format!(
                    "{}; patch apply input source resolved via {extracted_archives} container extract step(s)",
                    report.label
                );
            }
            if !checksum_verification_labels.is_empty() {
                report.label = format!(
                    "{}; {}",
                    report.label,
                    checksum_verification_labels.join("; ")
                );
            }

            if report.status == OperationStatus::Succeeded && compression_options.enabled {
                let compression_plan = match self.resolve_patch_apply_compression_plan(
                    &output,
                    &raw_ready_output,
                    outer_container_format.as_deref(),
                    &compression_options,
                ) {
                    Ok(plan) => plan,
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "compress",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                };
                let Some(compress_handler) = self.containers.find_by_name(&compression_plan.format)
                else {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        report.format.clone(),
                        "compress",
                        "requested output format is not registered",
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                };
                let compress_threads =
                    Some(context.plan_threads(compress_handler.capabilities().create_threads));
                let codec_label = compression_plan
                    .codec
                    .as_deref()
                    .unwrap_or("default")
                    .to_string();
                self.emit_running(
                    "patch-apply",
                    OperationFamily::Patch,
                    report.format.as_deref(),
                    "compress",
                    format!(
                        "compressing patched output as {} (codec={codec_label})",
                        compression_plan.format
                    ),
                    Some(0.0),
                    compress_threads,
                );
                let compress_request = ContainerCreateRequest {
                    inputs: vec![raw_ready_output],
                    output: compression_plan.output_path.clone(),
                    format: compression_plan.format.clone(),
                    codec: compression_plan.codec.clone(),
                    level: compression_plan.level,
                };
                let compress_report = compress_handler
                    .create(&compress_request, &context)
                    .unwrap_or_else(|error| {
                        OperationReport::failed(
                            OperationFamily::Container,
                            Some(compress_handler.descriptor().name.to_string()),
                            "create",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        )
                    });
                if compress_report.status != OperationStatus::Succeeded {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        report.format.clone(),
                        "compress",
                        format!("patch output compression failed: {}", compress_report.label),
                        compress_report.thread_execution,
                    );
                }
                let extension_note = if compression_plan.extension_appended {
                    "; output extension appended to match container format"
                } else {
                    ""
                };
                report.stage = "compress".to_string();
                report.label = format!(
                    "{}; patch output compressed as {} (codec={}, path=`{}`; {}){}",
                    report.label,
                    compression_plan.format,
                    codec_label,
                    compression_plan.output_path.display(),
                    compression_plan.auto_note,
                    extension_note
                );
            }

            report
        })();

        Self::cleanup_temp_paths(temp_paths);
        self.finish("patch-apply", report)
    }

    fn run_patch_create(&self, args: PatchCreateCommand) -> ExitCode {
        trace!(
            original = %args.original.display(),
            modified = %args.modified.display(),
            output = %args.output.display(),
            format = %args.format,
            threads = %args.threads,
            "starting patch-create command"
        );
        let context = self.context(args.threads);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        if let Some(report) = self.require_existing_path(
            "patch-create",
            OperationFamily::Patch,
            Some(args.format.clone()),
            &args.original,
            probe_threads.clone(),
        ) {
            return self.finish("patch-create", report);
        }
        if let Some(report) = self.require_existing_path(
            "patch-create",
            OperationFamily::Patch,
            Some(args.format.clone()),
            &args.modified,
            probe_threads.clone(),
        ) {
            return self.finish("patch-create", report);
        }

        let Some(handler) = self.patches.find_by_name(&args.format) else {
            return self.finish(
                "patch-create",
                OperationReport::failed(
                    OperationFamily::Patch,
                    Some(args.format),
                    "probe",
                    "requested patch format is not registered",
                    probe_threads,
                ),
            );
        };

        let request = PatchCreateRequest {
            original: args.original,
            modified: args.modified,
            output: args.output,
            format: handler.descriptor().name.to_string(),
        };
        self.emit_running(
            "patch-create",
            OperationFamily::Patch,
            Some(handler.descriptor().name),
            "create",
            format!("creating {} patch", handler.descriptor().name),
            Some(0.0),
            None,
        );
        let report = handler.create(&request, &context).unwrap_or_else(|error| {
            OperationReport::failed(
                OperationFamily::Patch,
                Some(handler.descriptor().name.to_string()),
                "create",
                error.to_string(),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            )
        });
        self.finish("patch-create", report)
    }

    fn parse_patch_apply_checksum_values(
        values: &[String],
        flag_name: &str,
    ) -> Result<BTreeMap<String, String>> {
        let mut parsed = BTreeMap::new();
        for raw in values {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value cannot be empty; expected ALGO=HEX"
                )));
            }
            let (algorithm_raw, checksum_raw) = trimmed.split_once('=').ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; expected ALGO=HEX"
                ))
            })?;

            let algorithm = algorithm_raw.trim().to_ascii_lowercase();
            if algorithm.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; checksum algorithm is missing before `=`"
                )));
            }
            if !supported_algorithms()
                .iter()
                .any(|supported| supported.eq_ignore_ascii_case(&algorithm))
            {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} uses unsupported checksum algorithm `{}`",
                    algorithm_raw.trim()
                )));
            }

            let checksum = checksum_raw.trim();
            if checksum.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; checksum value is missing after `=`"
                )));
            }
            let checksum = checksum
                .strip_prefix("0x")
                .or_else(|| checksum.strip_prefix("0X"))
                .unwrap_or(checksum)
                .to_ascii_lowercase();
            if !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; checksum must be hexadecimal"
                )));
            }
            let Some(expected_hex_len) = Self::checksum_hex_len(&algorithm) else {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} uses unsupported checksum algorithm `{}`",
                    algorithm_raw.trim()
                )));
            };
            if checksum.len() != expected_hex_len {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; `{}` expects {expected_hex_len} hex characters, got {}",
                    algorithm,
                    checksum.len()
                )));
            }

            match parsed.get(&algorithm) {
                Some(existing) if existing != &checksum => {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} provides conflicting values for `{algorithm}`"
                    )));
                }
                Some(_) => {}
                None => {
                    parsed.insert(algorithm, checksum);
                }
            }
        }
        Ok(parsed)
    }

    fn validate_patch_apply_expected_checksums(
        source: &Path,
        expected: &BTreeMap<String, String>,
        scope: &str,
        context: &OperationContext,
    ) -> Result<String> {
        if expected.is_empty() {
            return Ok(String::new());
        }

        let algorithms = expected.keys().map(String::as_str).collect::<Vec<&str>>();
        let actual = checksum_file_values(source, &algorithms, context)?;
        for (algorithm, expected_value) in expected {
            let Some(actual_value) = actual.get(algorithm) else {
                return Err(RomWeaverError::Validation(format!(
                    "checksum engine did not return `{algorithm}` while validating {scope} checksums"
                )));
            };
            if actual_value != expected_value {
                return Err(RomWeaverError::Validation(format!(
                    "{scope} checksum mismatch for {algorithm}; expected {expected_value}, actual {actual_value}"
                )));
            }
        }

        let rendered = expected
            .iter()
            .map(|(algorithm, value)| format!("{algorithm}={value}"))
            .collect::<Vec<_>>()
            .join(", ");
        Ok(format!("{scope} checksum(s) verified ({rendered})"))
    }

    fn checksum_hex_len(algorithm: &str) -> Option<usize> {
        match algorithm {
            "crc16" => Some(4),
            "crc32" | "crc32c" | "adler32" => Some(8),
            "md5" => Some(32),
            "sha1" => Some(40),
            "sha256" | "blake3" => Some(64),
            _ => None,
        }
    }

    fn emit_running(
        &self,
        command: &str,
        family: OperationFamily,
        format: Option<&str>,
        stage: impl Into<String>,
        label: impl Into<String>,
        percent: Option<f32>,
        thread_execution: Option<ThreadExecution>,
    ) {
        if !self.emit_progress_events {
            return;
        }

        let stage = stage.into();
        let label = label.into();
        trace!(
            command,
            family = ?family,
            format = ?format,
            stage = %stage,
            label = %label,
            percent = ?percent,
            requested_threads = ?thread_execution.as_ref().map(|value| value.requested_threads),
            effective_threads = ?thread_execution.as_ref().map(|value| value.effective_threads),
            thread_mode = ?thread_execution.as_ref().map(|value| value.thread_mode),
            used_parallelism = ?thread_execution.as_ref().map(|value| value.used_parallelism),
            "emitting running progress event"
        );
        let thread_execution = thread_execution.as_ref();
        self.reporter.emit(ProgressEvent {
            command: command.to_string(),
            family,
            format: format.map(str::to_string),
            stage,
            label,
            percent,
            requested_threads: thread_execution.map(|value| value.requested_threads),
            effective_threads: thread_execution.map(|value| value.effective_threads),
            thread_mode: thread_execution.map(|value| value.thread_mode),
            used_parallelism: thread_execution.map(|value| value.used_parallelism),
            status: OperationStatus::Running,
        });
    }

    fn context(&self, thread_budget: ThreadBudget) -> OperationContext {
        let temp_root = Self::resolve_temp_dir().join("rom-weaver");
        OperationContext::new(
            thread_budget,
            temp_root,
            self.reporter.clone(),
            CancellationToken::new(),
        )
    }

    fn resolve_temp_dir() -> PathBuf {
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

    fn resolve_codec_level(
        codec: Option<String>,
        flag_name: &str,
    ) -> Result<(Option<String>, Option<i32>)> {
        let Some(codec) = codec else {
            return Ok((None, None));
        };

        let codec = codec.trim();
        if codec.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "{flag_name} cannot be empty"
            )));
        }

        let Some((raw_codec, raw_level)) = codec.split_once(':') else {
            return Ok((Some(codec.to_string()), None));
        };

        let codec_name = raw_codec.trim();
        if codec_name.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "codec name is missing before `:` in {flag_name}"
            )));
        }

        let level_text = raw_level.trim();
        if level_text.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "codec level is missing after `:` in {flag_name}"
            )));
        }

        let parsed_level = level_text.parse::<i32>().map_err(|_| {
            RomWeaverError::Validation(format!(
                "codec level `{level_text}` is not a valid integer in {flag_name}"
            ))
        })?;

        Ok((Some(codec_name.to_string()), Some(parsed_level)))
    }

    fn resolve_compression_level_for_profile(
        format_name: &str,
        codec: Option<&str>,
        explicit_level: Option<i32>,
        profile: CompressionLevelProfile,
    ) -> Option<i32> {
        if explicit_level.is_some() {
            return explicit_level;
        }

        let codec_kind = codec
            .and_then(Self::profile_codec_kind_for_codec_name)
            .or_else(|| Self::default_profile_codec_kind_for_format(format_name));
        match codec_kind {
            Some(ProfileCodecKind::Standard) => Some(profile.standard_level()),
            Some(ProfileCodecKind::Zstd) => Some(profile.zstd_level()),
            Some(ProfileCodecKind::NoLevel) | None => None,
        }
    }

    fn default_profile_codec_kind_for_format(format_name: &str) -> Option<ProfileCodecKind> {
        let normalized = format_name.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "zip" | "7z" | "tar.gz" | "tar.bz2" | "tar.xz" | "gz" | "bz2" | "xz" => {
                Some(ProfileCodecKind::Standard)
            }
            "zipx" | "zst" | "zstd" | "rvz" | "z3ds" | "3ds" | "chd" => {
                Some(ProfileCodecKind::Zstd)
            }
            "tar" => Some(ProfileCodecKind::NoLevel),
            _ => None,
        }
    }

    fn profile_codec_kind_for_codec_name(codec_name: &str) -> Option<ProfileCodecKind> {
        let codec = codec_name.trim();
        if codec.is_empty() {
            return None;
        }
        if codec.eq_ignore_ascii_case("cdzs")
            || codec.eq_ignore_ascii_case("zstd")
            || codec.eq_ignore_ascii_case("zst")
            || codec.eq_ignore_ascii_case("zstandard")
        {
            return Some(ProfileCodecKind::Zstd);
        }
        if codec.eq_ignore_ascii_case("cdzl") || codec.eq_ignore_ascii_case("cdlz") {
            return Some(ProfileCodecKind::Standard);
        }
        if codec.eq_ignore_ascii_case("store")
            || codec.eq_ignore_ascii_case("none")
            || codec.eq_ignore_ascii_case("uncompressed")
            || codec.eq_ignore_ascii_case("huffman")
            || codec.eq_ignore_ascii_case("huff")
            || codec.eq_ignore_ascii_case("flac")
            || codec.eq_ignore_ascii_case("cdfl")
            || codec.eq_ignore_ascii_case("avhuff")
            || codec.eq_ignore_ascii_case("avhu")
        {
            return Some(ProfileCodecKind::NoLevel);
        }
        match parse_requested_codec(Some(codec)) {
            RequestedCodec::Known(CanonicalCodec::Store) => Some(ProfileCodecKind::NoLevel),
            RequestedCodec::Known(CanonicalCodec::Zstd) => Some(ProfileCodecKind::Zstd),
            RequestedCodec::Known(CanonicalCodec::Huffman) => Some(ProfileCodecKind::NoLevel),
            RequestedCodec::Known(_) => Some(ProfileCodecKind::Standard),
            RequestedCodec::Unspecified | RequestedCodec::Unknown(_) => None,
        }
    }

    fn parse_patch_apply_compression_options(
        no_compress: bool,
        compress_format: Option<String>,
        compress_codec: Option<String>,
        compress_level: CompressionLevelProfile,
    ) -> Result<PatchApplyCompressionOptions> {
        if no_compress {
            if compress_format.is_some() {
                return Err(RomWeaverError::Validation(
                    "--no-compress cannot be combined with --compress-format".to_string(),
                ));
            }
            if compress_codec.is_some() {
                return Err(RomWeaverError::Validation(
                    "--no-compress cannot be combined with --compress-codec".to_string(),
                ));
            }
            return Ok(PatchApplyCompressionOptions {
                enabled: false,
                auto_mode: false,
                requested_format: None,
                codec: None,
                level: None,
                profile: CompressionLevelProfile::Max,
            });
        }

        let requested_format = match compress_format {
            Some(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return Err(RomWeaverError::Validation(
                        "--compress-format cannot be empty".to_string(),
                    ));
                }
                if trimmed.eq_ignore_ascii_case("auto") {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }
            None => None,
        };
        let auto_mode = requested_format.is_none();
        let (codec, level) = Self::resolve_codec_level(compress_codec, "--compress-codec")?;
        Ok(PatchApplyCompressionOptions {
            enabled: true,
            auto_mode,
            requested_format,
            codec,
            level,
            profile: compress_level,
        })
    }

    fn detect_patch_apply_outer_container_format(
        &self,
        source: &Path,
        context: &OperationContext,
    ) -> Option<String> {
        let handler = self.containers.probe(source)?;
        if !handler.capabilities().create {
            return None;
        }
        if matches!(handler.probe(source), ProbeConfidence::Extension)
            && handler
                .inspect(
                    &ContainerInspectRequest {
                        source: source.to_path_buf(),
                    },
                    context,
                )
                .is_err()
        {
            return None;
        }
        Some(handler.descriptor().name.to_string())
    }

    fn resolve_patch_apply_compression_plan(
        &self,
        requested_output: &Path,
        raw_output: &Path,
        outer_container_format: Option<&str>,
        options: &PatchApplyCompressionOptions,
    ) -> Result<PatchApplyCompressionPlan> {
        if !options.enabled {
            return Err(RomWeaverError::Validation(
                "patch-output compression was not enabled".to_string(),
            ));
        }

        let (resolved_format, auto_note) = if options.auto_mode {
            if let Some(format_name) = outer_container_format
                && self.patch_apply_format_supports_create(format_name)
            {
                (
                    format_name.to_string(),
                    format!("auto format={format_name} reason=outer-input-container"),
                )
            } else {
                let recommendation = self.containers.recommend_compress_format(raw_output);
                if recommendation.format_name.eq_ignore_ascii_case("rvz")
                    && self.patch_apply_format_supports_create("rvz")
                {
                    (
                        "rvz".to_string(),
                        format!("auto format=rvz reason={}", recommendation.reason),
                    )
                } else if self.patch_apply_chd_auto_viable(raw_output) {
                    (
                        "chd".to_string(),
                        "auto format=chd reason=viable-non-disc-output".to_string(),
                    )
                } else if self.patch_apply_format_supports_create("7z") {
                    (
                        "7z".to_string(),
                        "auto format=7z reason=fallback-7z-lzma2".to_string(),
                    )
                } else if self.patch_apply_format_supports_create(recommendation.format_name) {
                    (
                        recommendation.format_name.to_string(),
                        format!(
                            "auto format={} reason={}",
                            recommendation.format_name, recommendation.reason
                        ),
                    )
                } else {
                    return Err(RomWeaverError::Validation(
                        "no registered container format can compress patch output".to_string(),
                    ));
                }
            }
        } else {
            let explicit_format = options
                .requested_format
                .clone()
                .expect("non-auto patch compression must carry a requested format");
            (
                explicit_format.clone(),
                format!("explicit format={explicit_format}"),
            )
        };

        let Some(handler) = self.containers.find_by_name(&resolved_format) else {
            return Err(RomWeaverError::Validation(
                "requested output format is not registered".to_string(),
            ));
        };
        let capabilities = handler.capabilities();
        if !capabilities.inspect && !capabilities.extract && !capabilities.create {
            return Err(RomWeaverError::Validation(
                "requested output format is not registered".to_string(),
            ));
        }

        let mut codec = options.codec.clone();
        if codec.is_none() && resolved_format.eq_ignore_ascii_case("7z") {
            codec = Some("lzma2".to_string());
        }
        let level = Self::resolve_compression_level_for_profile(
            &resolved_format,
            codec.as_deref(),
            options.level,
            options.profile,
        );

        let (output_path, extension_appended) = Self::append_output_extension_if_missing(
            requested_output,
            handler.descriptor().extensions,
        );
        Ok(PatchApplyCompressionPlan {
            format: resolved_format,
            codec,
            level,
            output_path,
            extension_appended,
            auto_note,
        })
    }

    fn patch_apply_format_supports_create(&self, format_name: &str) -> bool {
        self.containers
            .find_by_name(format_name)
            .is_some_and(|handler| handler.capabilities().create)
    }

    fn patch_apply_chd_auto_viable(&self, source: &Path) -> bool {
        if !self.patch_apply_format_supports_create("chd") {
            return false;
        }
        let Ok(metadata) = fs::metadata(source) else {
            return false;
        };
        if !metadata.is_file() {
            return false;
        }
        let logical_bytes = metadata.len();
        // Prevent a known backend abort path for very small CHD inputs.
        if logical_bytes <= 4096 {
            return false;
        }

        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        match extension.as_deref() {
            Some("iso") => logical_bytes % 2048 == 0,
            Some("img") | Some("ima") => logical_bytes % 512 == 0,
            _ => true,
        }
    }

    fn append_output_extension_if_missing(
        requested_output: &Path,
        extensions: &[&str],
    ) -> (PathBuf, bool) {
        let Some(primary_extension) = extensions.first().copied() else {
            return (requested_output.to_path_buf(), false);
        };

        let Some(file_name) = requested_output.file_name() else {
            return (requested_output.to_path_buf(), false);
        };
        let file_name_text = file_name.to_string_lossy().to_ascii_lowercase();
        let has_matching_extension = extensions
            .iter()
            .any(|extension| file_name_text.ends_with(&extension.to_ascii_lowercase()));
        if has_matching_extension {
            return (requested_output.to_path_buf(), false);
        }

        let mut appended_name = file_name.to_os_string();
        appended_name.push(primary_extension);
        let mut appended_path = requested_output.to_path_buf();
        appended_path.set_file_name(appended_name);
        (appended_path, true)
    }

    fn normalize_trim_extension(extension: &str) -> Result<String> {
        let extension = extension.trim();
        if extension.is_empty() {
            return Err(RomWeaverError::Validation(
                "--extension cannot be empty".to_string(),
            ));
        }
        if extension.contains('/') || extension.contains('\\') {
            return Err(RomWeaverError::Validation(
                "--extension cannot contain path separators".to_string(),
            ));
        }
        Ok(extension.to_string())
    }

    const fn default_trim_extension_pattern(operation: TrimOperation) -> &'static str {
        match operation {
            TrimOperation::Trim => "trim.{ext}",
            TrimOperation::Revert => "untrim.{ext}",
        }
    }

    fn format_mode_counts(mode_counts: &BTreeMap<&'static str, usize>) -> String {
        if mode_counts.is_empty() {
            return "none".to_string();
        }

        mode_counts
            .iter()
            .map(|(mode, count)| format!("{mode}:{count}"))
            .collect::<Vec<_>>()
            .join(",")
    }

    fn trim_eligible_kind_for_path(&self, path: &Path) -> Option<TrimInputKind> {
        if let Some(kind) = TrimInputKind::from_path(path) {
            return Some(kind);
        }

        let extension = path.extension()?.to_str()?;
        if extension.eq_ignore_ascii_case("iso")
            && let Some(handler) = self.containers.probe(path)
            && handler.descriptor().matches_name("xiso")
        {
            return Some(TrimInputKind::Xiso);
        }

        None
    }

    fn read_checksum_trim_plan(&self, source: &Path) -> Result<ChecksumTrimPlan> {
        let Some(kind) = self.trim_eligible_kind_for_path(source) else {
            return Err(RomWeaverError::Validation(format!(
                "trim-fix unavailable for non-trim-eligible input: `{}`",
                source.display()
            )));
        };
        let file_size = fs::metadata(source)?.len();
        if file_size == 0 {
            return Err(RomWeaverError::Validation(format!(
                "input is empty and cannot be processed: `{}`",
                source.display()
            )));
        }
        match kind {
            TrimInputKind::NdsFamily => {
                if file_size < NDS_HEADER_TOTAL_BYTES as u64 {
                    return Err(RomWeaverError::Validation(format!(
                        "input is too small to contain a valid NDS/DSi header: `{}`",
                        source.display()
                    )));
                }
                let mut input = File::open(source)?;
                let plan = Self::read_nds_trim_plan(&mut input, file_size, false)?;
                Ok(ChecksumTrimPlan {
                    trimmed_size: plan.trimmed_size.min(file_size),
                    mode: if plan.dsi_mode { "dsi" } else { "ds" },
                    preserved_download_play_cert: plan.preserved_download_play_cert,
                })
            }
            TrimInputKind::Gba | TrimInputKind::ThreeDs => {
                let trimmed_size = Self::scan_trimmed_size_from_trailing_padding(
                    source,
                    kind.default_padding_byte(),
                )?;
                Ok(ChecksumTrimPlan {
                    trimmed_size,
                    mode: kind.mode_label(),
                    preserved_download_play_cert: false,
                })
            }
            TrimInputKind::Xiso => {
                let trimmed_size = Self::measure_trimmed_xiso_size(source).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "checksum trim-fix failed while evaluating xiso `{}`: {error}",
                        source.display()
                    ))
                })?;
                Ok(ChecksumTrimPlan {
                    trimmed_size,
                    mode: kind.mode_label(),
                    preserved_download_play_cert: false,
                })
            }
        }
    }

    fn collect_trim_input_files(
        &self,
        sources: &[PathBuf],
        recursive: bool,
        skipped_non_nds: &mut usize,
    ) -> Result<Vec<TrimSource>> {
        let mut files = Vec::new();
        for source in sources {
            let metadata = fs::metadata(source).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "input path is not accessible: `{}` ({error})",
                    source.display()
                ))
            })?;
            if metadata.is_file() {
                if let Some(kind) = self.trim_eligible_kind_for_path(source) {
                    files.push(TrimSource {
                        path: source.clone(),
                        kind,
                    });
                } else {
                    *skipped_non_nds = skipped_non_nds.saturating_add(1);
                }
                continue;
            }
            if metadata.is_dir() {
                self.collect_trim_directory_files(source, recursive, &mut files, skipped_non_nds)?;
                continue;
            }

            *skipped_non_nds = skipped_non_nds.saturating_add(1);
        }

        files.sort_by(|left, right| left.path.cmp(&right.path));
        files.dedup_by(|left, right| left.path == right.path);
        Ok(files)
    }

    fn collect_trim_directory_files(
        &self,
        root: &Path,
        recursive: bool,
        files: &mut Vec<TrimSource>,
        skipped_non_nds: &mut usize,
    ) -> Result<()> {
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            let mut entries =
                fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path());

            for entry in entries {
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_dir() {
                    if recursive {
                        directories.push(path);
                    }
                    continue;
                }
                if !file_type.is_file() {
                    *skipped_non_nds = skipped_non_nds.saturating_add(1);
                    continue;
                }
                if let Some(kind) = self.trim_eligible_kind_for_path(&path) {
                    files.push(TrimSource { path, kind });
                } else {
                    *skipped_non_nds = skipped_non_nds.saturating_add(1);
                }
            }
        }
        Ok(())
    }

    fn default_trim_output_path(source: &Path, extension: &str) -> PathBuf {
        let source_extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("bin");
        let extension = extension.replace("{ext}", source_extension);
        let mut output = source.to_path_buf();
        output.set_extension(extension);
        output
    }

    fn trim_file(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
        kind: TrimInputKind,
    ) -> Result<NdsTrimOutcome> {
        match kind {
            TrimInputKind::NdsFamily => {
                Self::trim_nds_file(source, destination, in_place, dry_run, operation)
            }
            TrimInputKind::Gba | TrimInputKind::ThreeDs => Self::trim_power_of_two_file(
                source,
                destination,
                in_place,
                dry_run,
                operation,
                kind,
            ),
            TrimInputKind::Xiso => {
                Self::trim_xiso_file(source, destination, in_place, dry_run, operation)
            }
        }
    }

    fn trim_nds_file(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
    ) -> Result<NdsTrimOutcome> {
        let mutate_source = in_place || source == destination;
        let mut input = File::options()
            .read(true)
            .write(mutate_source && !dry_run)
            .open(source)?;
        let original_size = input.metadata()?.len();
        if original_size < NDS_HEADER_TOTAL_BYTES as u64 {
            return Err(RomWeaverError::Validation(format!(
                "input is too small to contain a valid NDS/DSi header: `{}`",
                source.display()
            )));
        }

        let plan = Self::read_nds_trim_plan(
            &mut input,
            original_size,
            operation == TrimOperation::Revert,
        )?;
        let (target_size, already_target_size, fill_byte) = match operation {
            TrimOperation::Trim => (
                original_size.min(plan.trimmed_size),
                original_size <= plan.trimmed_size,
                0x00_u8,
            ),
            TrimOperation::Revert => {
                let mut revert_size = Self::power_of_two_target_size_for_revert(original_size)?;
                if revert_size < plan.trimmed_size {
                    revert_size = plan.trimmed_size;
                }
                (revert_size, original_size == revert_size, 0x00_u8)
            }
        };

        if dry_run {
            return Ok(NdsTrimOutcome {
                original_size,
                result_size: target_size,
                output_path: if in_place {
                    source.to_path_buf()
                } else {
                    destination.to_path_buf()
                },
                mode: if plan.dsi_mode { "dsi" } else { "ds" },
                preserved_download_play_cert: plan.preserved_download_play_cert,
                already_target_size,
                revert_supported: true,
            });
        }

        Self::apply_file_size_target(
            source,
            destination,
            in_place,
            original_size,
            target_size,
            fill_byte,
        )?;

        Ok(NdsTrimOutcome {
            original_size,
            result_size: target_size,
            output_path: if in_place {
                source.to_path_buf()
            } else {
                destination.to_path_buf()
            },
            mode: if plan.dsi_mode { "dsi" } else { "ds" },
            preserved_download_play_cert: plan.preserved_download_play_cert,
            already_target_size,
            revert_supported: true,
        })
    }

    fn trim_power_of_two_file(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
        kind: TrimInputKind,
    ) -> Result<NdsTrimOutcome> {
        let original_size = fs::metadata(source)?.len();
        if original_size == 0 {
            return Err(RomWeaverError::Validation(format!(
                "input is empty and cannot be processed: `{}`",
                source.display()
            )));
        }

        let fill_byte = kind.default_padding_byte();
        let (target_size, already_target_size) = match operation {
            TrimOperation::Trim => {
                let trimmed_size =
                    Self::scan_trimmed_size_from_trailing_padding(source, fill_byte)?;
                (trimmed_size, trimmed_size == original_size)
            }
            TrimOperation::Revert => {
                let revert_size = Self::power_of_two_target_size_for_revert(original_size)?;
                (revert_size, revert_size == original_size)
            }
        };

        if dry_run {
            return Ok(NdsTrimOutcome {
                original_size,
                result_size: target_size,
                output_path: if in_place {
                    source.to_path_buf()
                } else {
                    destination.to_path_buf()
                },
                mode: kind.mode_label(),
                preserved_download_play_cert: false,
                already_target_size,
                revert_supported: true,
            });
        }

        Self::apply_file_size_target(
            source,
            destination,
            in_place,
            original_size,
            target_size,
            fill_byte,
        )?;

        Ok(NdsTrimOutcome {
            original_size,
            result_size: target_size,
            output_path: if in_place {
                source.to_path_buf()
            } else {
                destination.to_path_buf()
            },
            mode: kind.mode_label(),
            preserved_download_play_cert: false,
            already_target_size,
            revert_supported: true,
        })
    }

    fn trim_xiso_file(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
    ) -> Result<NdsTrimOutcome> {
        if operation == TrimOperation::Revert {
            return Err(RomWeaverError::Validation(
                "xiso trim revert is not supported; trimmed padding cannot be reconstructed"
                    .to_string(),
            ));
        }

        let original_size = fs::metadata(source)?.len();
        if original_size == 0 {
            return Err(RomWeaverError::Validation(format!(
                "input is empty and cannot be processed: `{}`",
                source.display()
            )));
        }

        if dry_run {
            let result_size = Self::measure_trimmed_xiso_size(source).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "xiso trim simulation failed while rebuilding `{}`: {error}",
                    source.display()
                ))
            })?;
            return Ok(NdsTrimOutcome {
                original_size,
                result_size,
                output_path: if in_place {
                    source.to_path_buf()
                } else {
                    destination.to_path_buf()
                },
                mode: TrimInputKind::Xiso.mode_label(),
                preserved_download_play_cert: false,
                already_target_size: result_size == original_size,
                revert_supported: false,
            });
        }

        if in_place || source == destination {
            let temp_path = Self::temporary_xiso_trim_path(source);
            Self::create_trimmed_xiso(source, &temp_path)?;
            if let Err(rename_error) = fs::rename(&temp_path, source) {
                fs::copy(&temp_path, source).map_err(|copy_error| {
                    RomWeaverError::Validation(format!(
                        "failed to replace `{}` with trimmed xiso (rename error: {rename_error}; copy fallback error: {copy_error})",
                        source.display()
                    ))
                })?;
                fs::remove_file(&temp_path).ok();
            }
            let result_size = fs::metadata(source)?.len();
            return Ok(NdsTrimOutcome {
                original_size,
                result_size,
                output_path: source.to_path_buf(),
                mode: TrimInputKind::Xiso.mode_label(),
                preserved_download_play_cert: false,
                already_target_size: result_size == original_size,
                revert_supported: false,
            });
        }

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        Self::create_trimmed_xiso(source, destination)?;
        let result_size = fs::metadata(destination)?.len();
        Ok(NdsTrimOutcome {
            original_size,
            result_size,
            output_path: destination.to_path_buf(),
            mode: TrimInputKind::Xiso.mode_label(),
            preserved_download_play_cert: false,
            already_target_size: result_size == original_size,
            revert_supported: false,
        })
    }

    fn open_xiso_trim_source_filesystem(source_path: &Path) -> Result<XisoTrimSourceFilesystem> {
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

    fn create_trimmed_xiso(source: &Path, destination: &Path) -> Result<()> {
        let mut source_fs = Self::open_xiso_trim_source_filesystem(source)?;
        let output = File::create(destination)?;
        let mut output = BufWriter::new(output);
        create_xdvdfs_image(&mut source_fs, &mut output, |_| {}).map_err(|error| {
            RomWeaverError::Validation(format!(
                "xiso trim failed while rebuilding `{}`: {error}",
                source.display()
            ))
        })?;
        output.flush()?;
        Ok(())
    }

    fn measure_trimmed_xiso_size(source: &Path) -> Result<u64> {
        let temp_path = Self::temporary_xiso_trim_path(source);
        Self::create_trimmed_xiso(source, &temp_path)?;
        let measured = fs::metadata(&temp_path)?.len();
        fs::remove_file(&temp_path).ok();
        Ok(measured)
    }

    fn temporary_xiso_trim_path(source: &Path) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let name = source
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "xiso".to_string());
        let temp_name = format!(
            ".{name}.{}-{}-{timestamp}",
            XISO_TRIM_TEMP_SUFFIX,
            Self::runtime_process_id()
        );
        source
            .parent()
            .map(|parent| parent.join(&temp_name))
            .unwrap_or_else(|| PathBuf::from(temp_name))
    }

    fn apply_file_size_target(
        source: &Path,
        destination: &Path,
        in_place: bool,
        original_size: u64,
        target_size: u64,
        fill_byte: u8,
    ) -> Result<()> {
        if in_place || source == destination {
            let mut input = File::options().read(true).write(true).open(source)?;
            if target_size < original_size {
                input.set_len(target_size)?;
            } else if target_size > original_size {
                input.seek(SeekFrom::Start(original_size))?;
                Self::write_padding_bytes(&mut input, target_size - original_size, fill_byte)?;
            }
            return Ok(());
        }

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut input = BufReader::new(File::open(source)?);
        let mut output = BufWriter::new(File::create(destination)?);
        let copy_len = original_size.min(target_size);
        io::copy(
            &mut std::io::Read::by_ref(&mut input).take(copy_len),
            &mut output,
        )?;
        if target_size > copy_len {
            Self::write_padding_bytes(&mut output, target_size - copy_len, fill_byte)?;
        }
        output.flush()?;
        Ok(())
    }

    fn write_padding_bytes(writer: &mut dyn Write, length: u64, fill_byte: u8) -> io::Result<()> {
        if length == 0 {
            return Ok(());
        }

        let chunk = [fill_byte; 8192];
        let mut remaining = length;
        while remaining > 0 {
            let write_len =
                usize::try_from(remaining.min(chunk.len() as u64)).unwrap_or(chunk.len());
            writer.write_all(&chunk[..write_len])?;
            remaining -= write_len as u64;
        }
        Ok(())
    }

    fn scan_trimmed_size_from_trailing_padding(path: &Path, fill_byte: u8) -> Result<u64> {
        let mut input = File::open(path)?;
        let file_size = input.metadata()?.len();
        if file_size == 0 {
            return Ok(0);
        }

        let mut cursor = file_size;
        let mut buffer = vec![0_u8; TRIM_BINARY_SCAN_CHUNK_BYTES];
        while cursor > 0 {
            let read_len = usize::try_from(cursor.min(TRIM_BINARY_SCAN_CHUNK_BYTES as u64))
                .unwrap_or(TRIM_BINARY_SCAN_CHUNK_BYTES);
            cursor -= read_len as u64;
            input.seek(SeekFrom::Start(cursor))?;
            input.read_exact(&mut buffer[..read_len])?;
            for (offset, byte) in buffer[..read_len].iter().enumerate().rev() {
                if *byte != fill_byte {
                    return Ok(cursor + offset as u64 + 1);
                }
            }
        }

        Ok(1)
    }

    fn power_of_two_target_size_for_revert(size: u64) -> Result<u64> {
        if size == 0 {
            return Err(RomWeaverError::Validation(
                "cannot revert an empty file".to_string(),
            ));
        }
        size.checked_next_power_of_two().ok_or_else(|| {
            RomWeaverError::Validation("file is too large to revert safely".to_string())
        })
    }

    fn read_nds_trim_plan(
        input: &mut File,
        file_size: u64,
        allow_boundary_past_eof: bool,
    ) -> Result<NdsTrimPlan> {
        let mut header = vec![0_u8; NDS_HEADER_TOTAL_BYTES];
        input.seek(SeekFrom::Start(0))?;
        input.read_exact(&mut header)?;
        Self::validate_nds_header(&header)?;

        let unit_code = header[NDS_HEADER_UNIT_CODE_OFFSET];
        let dsi_mode = unit_code != 0x00;
        let ntr_rom_size = u64::from(Self::read_u32_le(
            &header,
            NDS_HEADER_NTR_ROM_SIZE_OFFSET,
            "NTR ROM size",
        )?);
        let ntr_twl_rom_size = u64::from(Self::read_u32_le(
            &header,
            NDS_HEADER_NTR_TWL_ROM_SIZE_OFFSET,
            "NTR+TWL ROM size",
        )?);

        let mut trimmed_size = if dsi_mode {
            ntr_twl_rom_size
        } else {
            ntr_rom_size
        };
        if trimmed_size == 0 {
            return Err(RomWeaverError::Validation(
                "NDS header reported a zero trim boundary".into(),
            ));
        }

        let mut preserved_download_play_cert = false;
        if !dsi_mode && trimmed_size + 2 <= file_size {
            input.seek(SeekFrom::Start(trimmed_size))?;
            let mut cert_magic = [0_u8; 2];
            input.read_exact(&mut cert_magic)?;
            if cert_magic == NDS_DOWNLOAD_PLAY_CERT_MAGIC {
                trimmed_size = trimmed_size.saturating_add(NDS_DOWNLOAD_PLAY_CERT_SIZE_BYTES);
                preserved_download_play_cert = true;
            }
        }

        if trimmed_size > file_size && !allow_boundary_past_eof {
            return Err(RomWeaverError::Validation(format!(
                "trim boundary ({trimmed_size} byte(s)) exceeds input size ({file_size} byte(s)); input may already be incorrectly trimmed or corrupt"
            )));
        }

        Ok(NdsTrimPlan {
            trimmed_size,
            dsi_mode,
            preserved_download_play_cert,
        })
    }

    fn validate_nds_header(header: &[u8]) -> Result<()> {
        if header.len() < NDS_HEADER_TOTAL_BYTES {
            return Err(RomWeaverError::Validation(
                "NDS header buffer is truncated".into(),
            ));
        }

        let header_size = Self::read_u32_le(header, NDS_HEADER_HEADER_SIZE_OFFSET, "header size")?;
        if header_size < 0x160 {
            return Err(RomWeaverError::Validation(format!(
                "invalid NDS header size {header_size:#X}; expected at least 0x160"
            )));
        }

        let logo = &header[NDS_HEADER_LOGO_OFFSET..NDS_HEADER_LOGO_OFFSET + NDS_HEADER_LOGO_LENGTH];
        let expected_logo_crc = Self::read_u16_le(header, NDS_HEADER_LOGO_CRC_OFFSET, "logo CRC")?;
        let calculated_logo_crc = Self::nds_crc16(logo);
        if expected_logo_crc != calculated_logo_crc {
            return Err(RomWeaverError::Validation(format!(
                "NDS logo CRC mismatch: expected {expected_logo_crc:04X}, got {calculated_logo_crc:04X}"
            )));
        }

        let expected_header_crc = Self::read_u16_le(header, NDS_HEADER_CRC_OFFSET, "header CRC")?;
        let calculated_header_crc = Self::nds_crc16(&header[..NDS_HEADER_CRC_OFFSET]);
        if expected_header_crc != calculated_header_crc {
            return Err(RomWeaverError::Validation(format!(
                "NDS header CRC mismatch: expected {expected_header_crc:04X}, got {calculated_header_crc:04X}"
            )));
        }

        Ok(())
    }

    fn nds_crc16(bytes: &[u8]) -> u16 {
        let mut crc = 0xFFFF_u16;
        for byte in bytes {
            crc ^= u16::from(*byte);
            for _ in 0..8 {
                let carry = (crc & 1) != 0;
                crc >>= 1;
                if carry {
                    crc ^= 0xA001;
                }
            }
        }
        crc
    }

    fn read_u16_le(buffer: &[u8], offset: usize, label: &str) -> Result<u16> {
        let bytes = buffer.get(offset..offset + 2).ok_or_else(|| {
            RomWeaverError::Validation(format!("missing {label} bytes at offset 0x{offset:X}"))
        })?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn read_u32_le(buffer: &[u8], offset: usize, label: &str) -> Result<u32> {
        let bytes = buffer.get(offset..offset + 4).ok_or_else(|| {
            RomWeaverError::Validation(format!("missing {label} bytes at offset 0x{offset:X}"))
        })?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn append_entry_list_label(base: &str, entries: &[String]) -> String {
        if entries.is_empty() {
            return format!("{base}; selectable entries: (none)");
        }
        format!(
            "{base}; selectable entries ({}): {}",
            entries.len(),
            entries.join(", ")
        )
    }

    fn inspect_compress_recommendation(
        &self,
        source: &Path,
    ) -> Option<CompressFormatRecommendation> {
        if source.is_file() {
            Some(self.containers.recommend_compress_format(source))
        } else {
            None
        }
    }

    fn append_recommended_compress_label(
        mut report: OperationReport,
        recommendation: Option<&CompressFormatRecommendation>,
    ) -> OperationReport {
        if let Some(recommendation) = recommendation {
            report.label =
                Self::append_compress_recommendation_label(&report.label, recommendation);
        }
        report
    }

    fn append_compress_recommendation_label(
        base: &str,
        recommendation: &CompressFormatRecommendation,
    ) -> String {
        format!(
            "{base}; recommended_compress_format={} reason={}",
            recommendation.format_name, recommendation.reason
        )
    }

    fn known_header_candidates_for_path(path: &Path) -> Vec<KnownRomHeader> {
        let mut candidates = Vec::with_capacity(KnownRomHeader::ALL.len());
        let extension_with_dot = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{value}"));

        if let Some(extension_with_dot) = extension_with_dot.as_deref() {
            for header in KnownRomHeader::ALL {
                if header.matches_extension(extension_with_dot) {
                    candidates.push(header);
                }
            }
        }

        for header in KnownRomHeader::ALL {
            if !candidates.contains(&header) {
                candidates.push(header);
            }
        }
        candidates
    }

    fn detect_known_rom_header_from_prefix(
        path: &Path,
        prefix: &[u8],
    ) -> Option<KnownRomHeaderMatch> {
        for header in Self::known_header_candidates_for_path(path) {
            if header.signature_matches(prefix) {
                return Some(KnownRomHeaderMatch {
                    header,
                    stripped_bytes: header.data_offset_bytes(),
                });
            }
        }
        None
    }

    fn detect_known_rom_header(path: &Path) -> Result<Option<KnownRomHeaderMatch>> {
        let mut source = BufReader::new(File::open(path)?);
        let mut prefix = vec![0_u8; ROM_HEADER_SCAN_BYTES];
        let bytes_read = source.read(&mut prefix)?;
        prefix.truncate(bytes_read);
        Ok(Self::detect_known_rom_header_from_prefix(path, &prefix))
    }

    fn has_extension(path: &Path, expected: &[&str]) -> bool {
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            return false;
        };
        expected
            .iter()
            .any(|candidate| extension.eq_ignore_ascii_case(candidate))
    }

    fn detect_size_based_copier_header(path: &Path, input_len: u64) -> Option<KnownRomHeaderMatch> {
        if input_len <= ROM_HEADER_BYTES as u64 {
            return None;
        }
        if Self::has_extension(path, &["smc", "sfc"])
            && input_len % SNES_COPIER_HEADER_MODULUS == ROM_HEADER_BYTES as u64
        {
            return Some(KnownRomHeaderMatch {
                header: KnownRomHeader::SnesCopier,
                stripped_bytes: Some(ROM_HEADER_BYTES),
            });
        }
        if Self::has_extension(path, &["pce", "tg16"])
            && input_len % PCE_COPIER_HEADER_MODULUS == ROM_HEADER_BYTES as u64
        {
            return Some(KnownRomHeaderMatch {
                header: KnownRomHeader::PceCopier,
                stripped_bytes: Some(ROM_HEADER_BYTES),
            });
        }
        None
    }

    fn strip_header_to_temp(input: &Path, stripped_path: &Path) -> Result<StripHeaderResult> {
        let input_len = fs::metadata(input)?.len();
        if let Some(parent) = stripped_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut source = BufReader::new(File::open(input)?);
        let probe_len =
            ROM_HEADER_SCAN_BYTES.min(usize::try_from(input_len).unwrap_or(ROM_HEADER_SCAN_BYTES));
        let mut probe_bytes = vec![0_u8; probe_len];
        source.read_exact(&mut probe_bytes)?;
        let mut matched_header = Self::detect_known_rom_header_from_prefix(input, &probe_bytes);
        if matched_header
            .and_then(|value| value.stripped_bytes())
            .is_none()
        {
            matched_header = Self::detect_size_based_copier_header(input, input_len);
        }
        let Some(header_len) = matched_header.and_then(|value| value.stripped_bytes()) else {
            return Err(RomWeaverError::Validation(format!(
                "could not detect a supported removable ROM header for `{}`",
                input.display()
            )));
        };
        if input_len < header_len as u64 {
            return Err(RomWeaverError::Validation(format!(
                "cannot strip {header_len}-byte header from `{}` (file is only {input_len} byte(s))",
                input.display()
            )));
        }
        source.seek(SeekFrom::Start(0))?;
        let mut header = vec![0_u8; header_len];
        source.read_exact(&mut header)?;

        let mut stripped = BufWriter::new(File::create(stripped_path)?);
        io::copy(&mut source, &mut stripped)?;
        stripped.flush()?;
        Ok(StripHeaderResult {
            header_bytes: header,
            matched_header,
        })
    }

    fn finalize_patch_apply_output(
        staged_output: &Path,
        final_output: &Path,
        add_header: bool,
        stripped_header: Option<&[u8]>,
        repair_checksum: bool,
        repair_hint_path: Option<&Path>,
    ) -> Result<PatchApplyFinalizeResult> {
        let header_bytes = if add_header {
            Some(stripped_header.unwrap_or(&[0_u8; ROM_HEADER_BYTES]))
        } else {
            None
        };

        if repair_checksum {
            let mut output_bytes = fs::read(staged_output)?;
            let repair_outcome =
                Self::repair_checksum_if_supported(&mut output_bytes, repair_hint_path);
            if let Some(parent) = final_output.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut writer = BufWriter::new(File::create(final_output)?);
            if let Some(header) = header_bytes {
                writer.write_all(header)?;
            }
            writer.write_all(&output_bytes)?;
            writer.flush()?;
            let repair_warning = if repair_outcome.repaired_profiles.is_empty() {
                if repair_outcome.matched_without_changes.is_empty() {
                    Some(
                        "no supported header repair profile matched; output left unchanged"
                            .to_string(),
                    )
                } else {
                    Some(format!(
                        "header repair matched profile(s) {} but no writable changes were required",
                        repair_outcome.matched_without_changes.join(", ")
                    ))
                }
            } else {
                None
            };
            return Ok(PatchApplyFinalizeResult {
                repaired_profiles: repair_outcome.repaired_profiles,
                repair_warning,
            });
        }

        Self::copy_with_optional_header(staged_output, final_output, header_bytes)?;
        Ok(PatchApplyFinalizeResult {
            repaired_profiles: Vec::new(),
            repair_warning: None,
        })
    }

    fn copy_with_optional_header(
        source: &Path,
        destination: &Path,
        header: Option<&[u8]>,
    ) -> Result<()> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut reader = BufReader::new(File::open(source)?);
        let mut writer = BufWriter::new(File::create(destination)?);
        if let Some(header) = header {
            writer.write_all(header)?;
        }
        io::copy(&mut reader, &mut writer)?;
        writer.flush()?;
        Ok(())
    }

    fn record_header_repair_status(
        outcome: &mut HeaderRepairOutcome,
        profile: &'static str,
        status: HeaderRepairStatus,
    ) {
        match status {
            HeaderRepairStatus::NotMatched => {}
            HeaderRepairStatus::MatchedNoChange => outcome.matched_without_changes.push(profile),
            HeaderRepairStatus::Repaired => outcome.repaired_profiles.push(profile),
        }
    }

    fn repair_checksum_if_supported(
        bytes: &mut Vec<u8>,
        hint_path: Option<&Path>,
    ) -> HeaderRepairOutcome {
        let extension = hint_path
            .and_then(|path| path.extension())
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        let extension = extension.as_deref();

        let mut outcome = HeaderRepairOutcome {
            repaired_profiles: Vec::new(),
            matched_without_changes: Vec::new(),
        };

        Self::record_header_repair_status(
            &mut outcome,
            "snes",
            Self::repair_snes_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "nes",
            Self::repair_nes_header_padding(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "game-boy",
            Self::repair_game_boy_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "gba",
            Self::repair_gba_header_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "sega-genesis",
            Self::repair_sega_genesis_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "sms-gg",
            Self::repair_sms_tmr_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "n64",
            Self::repair_n64_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "atari-7800",
            Self::repair_atari_7800_header(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "atari-lynx",
            Self::repair_atari_lynx_header(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "pce-tg16",
            Self::repair_pce_copier_header(bytes, extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "virtual-boy",
            Self::repair_virtual_boy_header(bytes.as_mut_slice(), extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "neo-geo-pocket",
            Self::repair_neo_geo_pocket_header(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "msx",
            Self::repair_msx_header(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "nds",
            Self::repair_nintendo_ds_header_crc(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "atari-jaguar",
            Self::validate_atari_jaguar_header(bytes.as_slice(), extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "colecovision",
            Self::validate_colecovision_header(bytes.as_slice(), extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "watara-supervision",
            Self::validate_watara_supervision_header(bytes.as_slice(), extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "intellivision",
            Self::validate_intellivision_header(bytes.as_slice(), extension),
        );

        outcome
    }

    fn repair_snes_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() <= ROM_HEADER_BYTES {
            return HeaderRepairStatus::NotMatched;
        }

        let copier_offset = if bytes.len() % SNES_COPIER_HEADER_MODULUS as usize == ROM_HEADER_BYTES
        {
            ROM_HEADER_BYTES
        } else {
            0
        };
        let rom_size = bytes.len().saturating_sub(copier_offset);
        if rom_size == 0 {
            return HeaderRepairStatus::NotMatched;
        }

        let lo_rom_header = copier_offset.saturating_add(0x7FC0);
        let hi_rom_header = copier_offset.saturating_add(0xFFC0);
        let header_offset = if hi_rom_header + 0x30 <= bytes.len()
            && Self::is_valid_snes_title(bytes, hi_rom_header)
        {
            hi_rom_header
        } else if lo_rom_header + 0x30 <= bytes.len()
            && Self::is_valid_snes_title(bytes, lo_rom_header)
        {
            lo_rom_header
        } else {
            return HeaderRepairStatus::NotMatched;
        };

        let checksum_complement_offset = header_offset + 0x1C;
        let checksum_offset = header_offset + 0x1E;
        if checksum_offset + 2 > bytes.len() || checksum_complement_offset + 2 > bytes.len() {
            return HeaderRepairStatus::NotMatched;
        }

        let old_complement = u16::from_le_bytes([
            bytes[checksum_complement_offset],
            bytes[checksum_complement_offset + 1],
        ]);
        let old_checksum = u16::from_le_bytes([bytes[checksum_offset], bytes[checksum_offset + 1]]);

        bytes[checksum_complement_offset] = 0;
        bytes[checksum_complement_offset + 1] = 0;
        bytes[checksum_offset] = 0;
        bytes[checksum_offset + 1] = 0;

        let mut sum = 0_u32;
        if rom_size.is_power_of_two() {
            for value in &bytes[copier_offset..] {
                sum = sum.wrapping_add(u32::from(*value));
            }
        } else {
            let base_size = rom_size.next_power_of_two() / 2;
            let excess_size = rom_size.saturating_sub(base_size);
            for value in &bytes[copier_offset..copier_offset + base_size] {
                sum = sum.wrapping_add(u32::from(*value));
            }
            if excess_size > 0 {
                let mut excess_sum = 0_u32;
                for value in &bytes[copier_offset + base_size..] {
                    excess_sum = excess_sum.wrapping_add(u32::from(*value));
                }
                let mirror_count = (rom_size.next_power_of_two() - base_size) / excess_size;
                sum = sum.wrapping_add(excess_sum.wrapping_mul(mirror_count as u32));
            }
        }

        let new_checksum = (sum & 0xFFFF) as u16;
        let new_complement = new_checksum ^ 0xFFFF;
        bytes[checksum_complement_offset..checksum_complement_offset + 2]
            .copy_from_slice(&new_complement.to_le_bytes());
        bytes[checksum_offset..checksum_offset + 2].copy_from_slice(&new_checksum.to_le_bytes());

        if old_checksum == new_checksum && old_complement == new_complement {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn is_valid_snes_title(bytes: &[u8], offset: usize) -> bool {
        if offset + 21 > bytes.len() {
            return false;
        }
        let mut printable_count = 0usize;
        for value in &bytes[offset..offset + 21] {
            if (0x20..=0x7E).contains(value) {
                printable_count = printable_count.saturating_add(1);
            }
        }
        printable_count >= 10
    }

    fn repair_nes_header_padding(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 16 || bytes[..4] != INES_HEADER_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let is_nes2 = (bytes[7] & 0x0C) == 0x08;
        if is_nes2 {
            return HeaderRepairStatus::MatchedNoChange;
        }

        let mut changed = false;
        for value in &mut bytes[11..16] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn repair_gba_header_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 0x1BE || bytes[0x04..0x08] != GBA_HEADER_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let old_checksum = bytes[0x1BD];
        let mut checksum = 0_i32;
        for value in &bytes[0xA0..=0xBC] {
            checksum -= i32::from(*value);
        }
        let new_checksum = ((checksum - 0x19) & 0xFF) as u8;
        bytes[0x1BD] = new_checksum;
        if old_checksum == new_checksum {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn repair_sega_genesis_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() <= 0x18F || bytes.len() < 0x200 {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes[0x100..0x104] != *b"SEGA" && bytes[0x101..0x105] != *b"SEGA" {
            return HeaderRepairStatus::NotMatched;
        }
        let old_checksum = u16::from_be_bytes([bytes[0x18E], bytes[0x18F]]);
        let mut sum = 0_u32;
        let mut cursor = 0x200usize;
        while cursor + 1 < bytes.len() {
            let word = u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]);
            sum = sum.wrapping_add(u32::from(word));
            cursor += 2;
        }
        if cursor < bytes.len() {
            sum = sum.wrapping_add(u32::from(bytes[cursor]) << 8);
        }
        let checksum = (sum & 0xFFFF) as u16;
        bytes[0x18E..=0x18F].copy_from_slice(&checksum.to_be_bytes());
        if old_checksum == checksum {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn repair_game_boy_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() <= 0x14F {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes[0x104..0x134] != GAME_BOY_NINTENDO_LOGO {
            return HeaderRepairStatus::NotMatched;
        }

        let old_header_checksum = bytes[0x14D];
        let old_global_checksum = u16::from_be_bytes([bytes[0x14E], bytes[0x14F]]);

        let mut header_checksum = 0_u8;
        for value in &bytes[0x134..=0x14C] {
            header_checksum = header_checksum.wrapping_sub(*value).wrapping_sub(1);
        }
        bytes[0x14D] = header_checksum;

        let mut global_checksum = 0_u16;
        for (index, value) in bytes.iter().copied().enumerate() {
            if index == 0x14E || index == 0x14F {
                continue;
            }
            global_checksum = global_checksum.wrapping_add(u16::from(value));
        }
        bytes[0x14E..=0x14F].copy_from_slice(&global_checksum.to_be_bytes());

        if old_header_checksum == header_checksum && old_global_checksum == global_checksum {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn repair_sms_tmr_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        let mut header_offset = None;
        for offset in [0x7FF0usize, 0x3FF0, 0x1FF0] {
            if bytes.get(offset..offset + SMS_TMR_SEGA_MAGIC.len())
                == Some(SMS_TMR_SEGA_MAGIC.as_slice())
            {
                header_offset = Some(offset);
                break;
            }
        }
        let Some(header_offset) = header_offset else {
            return HeaderRepairStatus::NotMatched;
        };
        if header_offset + 0x10 > bytes.len() {
            return HeaderRepairStatus::NotMatched;
        }
        let checksum_offset = header_offset + 0x0A;
        if checksum_offset + 2 > bytes.len() {
            return HeaderRepairStatus::NotMatched;
        }
        let old_checksum = u16::from_le_bytes([bytes[checksum_offset], bytes[checksum_offset + 1]]);
        let size_nibble = bytes[header_offset + 0x0F] & 0x0F;
        let declared_end = match size_nibble {
            0xA => 0x2000usize,
            0xB => 0x4000,
            0xC => 0x8000,
            0xD => 0xC000,
            0xE => 0x10000,
            0xF => 0x20000,
            0x0 => 0x40000,
            0x1 => 0x80000,
            0x2 => 0x100000,
            _ => bytes.len(),
        };
        let checksum_end = declared_end.min(bytes.len());
        let header_end = header_offset + 16;

        let mut sum = 0_u32;
        for value in &bytes[..header_offset.min(checksum_end)] {
            sum = sum.wrapping_add(u32::from(*value));
        }
        if header_end < checksum_end {
            for value in &bytes[header_end..checksum_end] {
                sum = sum.wrapping_add(u32::from(*value));
            }
        }
        let new_checksum = (sum & 0xFFFF) as u16;
        bytes[checksum_offset..checksum_offset + 2].copy_from_slice(&new_checksum.to_le_bytes());
        if old_checksum == new_checksum {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn repair_n64_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 0x101000 {
            return HeaderRepairStatus::NotMatched;
        }
        let Some(original_order) = Self::detect_n64_byte_order(bytes) else {
            return HeaderRepairStatus::NotMatched;
        };
        Self::normalize_n64_to_big_endian(bytes, original_order);

        let old_crc1 = u32::from_be_bytes([bytes[0x10], bytes[0x11], bytes[0x12], bytes[0x13]]);
        let old_crc2 = u32::from_be_bytes([bytes[0x14], bytes[0x15], bytes[0x16], bytes[0x17]]);

        let seed = 0xF8CA4DDCu32;
        let mut t1 = seed;
        let mut t2 = seed;
        let mut t3 = seed;
        let mut t4 = seed;
        let mut t5 = seed;
        let mut t6 = seed;

        for chunk in bytes[0x1000..0x101000].chunks_exact(4) {
            let d = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if t6.wrapping_add(d) < t6 {
                t4 = t4.wrapping_add(1);
            }
            t6 = t6.wrapping_add(d);
            t3 ^= d;

            let shift = (d & 0x1F) as u32;
            let rotated = if shift == 0 { d } else { d.rotate_left(shift) };

            t5 = t5.wrapping_add(rotated);
            if t2 > d {
                t2 ^= rotated;
            } else {
                t2 ^= t6 ^ d;
            }
            t1 = t1.wrapping_add(t5 ^ d);
        }

        let new_crc1 = t6 ^ t4 ^ t3;
        let new_crc2 = t5 ^ t2 ^ t1;
        bytes[0x10..0x14].copy_from_slice(&new_crc1.to_be_bytes());
        bytes[0x14..0x18].copy_from_slice(&new_crc2.to_be_bytes());
        Self::denormalize_n64_from_big_endian(bytes, original_order);

        if old_crc1 == new_crc1 && old_crc2 == new_crc2 {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn detect_n64_byte_order(bytes: &[u8]) -> Option<N64ByteOrder> {
        if bytes.len() < 4 {
            return None;
        }
        let magic = [bytes[0], bytes[1], bytes[2], bytes[3]];
        if magic == N64_BIG_ENDIAN_MAGIC {
            Some(N64ByteOrder::BigEndian)
        } else if magic == N64_LITTLE_ENDIAN_MAGIC {
            Some(N64ByteOrder::LittleEndian)
        } else if magic == N64_BYTE_SWAPPED_MAGIC {
            Some(N64ByteOrder::ByteSwapped)
        } else {
            None
        }
    }

    fn normalize_n64_to_big_endian(bytes: &mut [u8], order: N64ByteOrder) {
        match order {
            N64ByteOrder::BigEndian => {}
            N64ByteOrder::LittleEndian => {
                for chunk in bytes.chunks_exact_mut(4) {
                    chunk.reverse();
                }
            }
            N64ByteOrder::ByteSwapped => {
                for chunk in bytes.chunks_exact_mut(4) {
                    chunk.swap(0, 1);
                    chunk.swap(2, 3);
                }
            }
        }
    }

    fn denormalize_n64_from_big_endian(bytes: &mut [u8], order: N64ByteOrder) {
        match order {
            N64ByteOrder::BigEndian => {}
            N64ByteOrder::LittleEndian => {
                for chunk in bytes.chunks_exact_mut(4) {
                    chunk.reverse();
                }
            }
            N64ByteOrder::ByteSwapped => {
                for chunk in bytes.chunks_exact_mut(4) {
                    chunk.swap(0, 1);
                    chunk.swap(2, 3);
                }
            }
        }
    }

    fn repair_atari_7800_header(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 128 {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes[1..1 + A78_HEADER_MAGIC.len()] != A78_HEADER_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let mut changed = false;
        for value in &mut bytes[0x64..0x80] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn repair_atari_lynx_header(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 64 || bytes[..4] != LNX_HEADER_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let mut changed = false;
        let page_size = u16::from_le_bytes([bytes[4], bytes[5]]);
        if page_size == 0 {
            bytes[4] = 0x00;
            bytes[5] = 0x01;
            changed = true;
        }
        for value in &mut bytes[59..64] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn repair_neo_geo_pocket_header(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 0x30 {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes[..NGP_COPYRIGHT_MAGIC.len()] != NGP_COPYRIGHT_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let mut changed = false;
        for value in &mut bytes[0x24..0x30] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn repair_msx_header(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 16 || bytes[..2] != *b"AB" {
            return HeaderRepairStatus::NotMatched;
        }
        let mut changed = false;
        for value in &mut bytes[0x0A..0x10] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn repair_nintendo_ds_header_crc(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 0x200 || bytes[0xC0..0xC4] != GBA_HEADER_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let old_crc = u16::from_le_bytes([bytes[0x15E], bytes[0x15F]]);
        let new_crc = Self::nds_crc16(&bytes[..0x15E]);
        bytes[0x15E..0x160].copy_from_slice(&new_crc.to_le_bytes());
        if old_crc == new_crc {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn repair_pce_copier_header(
        bytes: &mut Vec<u8>,
        extension: Option<&str>,
    ) -> HeaderRepairStatus {
        let is_pce = matches!(extension, Some("pce" | "tg16"));
        if !is_pce {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() <= ROM_HEADER_BYTES || bytes.len() < PCE_COPIER_HEADER_MODULUS as usize {
            return HeaderRepairStatus::MatchedNoChange;
        }
        if bytes.len() as u64 % PCE_COPIER_HEADER_MODULUS != ROM_HEADER_BYTES as u64 {
            return HeaderRepairStatus::MatchedNoChange;
        }
        bytes.drain(0..ROM_HEADER_BYTES);
        HeaderRepairStatus::Repaired
    }

    fn repair_virtual_boy_header(bytes: &mut [u8], extension: Option<&str>) -> HeaderRepairStatus {
        let is_virtual_boy = matches!(extension, Some("vb" | "vboy"));
        if !is_virtual_boy || bytes.len() < 1024 {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() < 0x220 {
            return HeaderRepairStatus::MatchedNoChange;
        }
        let header_offset = bytes.len() - 0x220;
        let mut changed = false;
        for value in &mut bytes[header_offset + 0x14..header_offset + 0x19] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn validate_atari_jaguar_header(bytes: &[u8], extension: Option<&str>) -> HeaderRepairStatus {
        if !matches!(extension, Some("j64" | "jag")) {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() >= 0x2000 {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::NotMatched
        }
    }

    fn validate_colecovision_header(bytes: &[u8], extension: Option<&str>) -> HeaderRepairStatus {
        if !matches!(extension, Some("col" | "cv")) {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() >= 16
            && ((bytes[0] == 0xAA && bytes[1] == 0x55) || (bytes[0] == 0x55 && bytes[1] == 0xAA))
        {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::NotMatched
        }
    }

    fn validate_watara_supervision_header(
        bytes: &[u8],
        extension: Option<&str>,
    ) -> HeaderRepairStatus {
        if !matches!(extension, Some("sv")) {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() >= 64 {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::NotMatched
        }
    }

    fn validate_intellivision_header(bytes: &[u8], extension: Option<&str>) -> HeaderRepairStatus {
        if !matches!(extension, Some("int")) {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() >= 0x50 {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::NotMatched
        }
    }

    fn require_existing_path(
        &self,
        _command: &str,
        family: OperationFamily,
        format: Option<String>,
        path: &Path,
        thread_execution: Option<ThreadExecution>,
    ) -> Option<OperationReport> {
        if path.exists() {
            None
        } else {
            Some(OperationReport::failed(
                family,
                format,
                "validate",
                format!("input path does not exist: `{}`", path.display()),
                thread_execution,
            ))
        }
    }

    fn finish(&self, command: &str, report: OperationReport) -> ExitCode {
        trace!(
            command,
            family = ?report.family,
            format = ?report.format,
            stage = %report.stage,
            status = ?report.status,
            percent = ?report.percent,
            label = %report.label,
            "finishing command with terminal report"
        );
        let status = report.status;
        self.reporter.emit(report.into_event(command));
        ExitCode::from(status.exit_code())
    }

    fn extract_nested_archives(
        &self,
        root_source: &Path,
        root_out_dir: &Path,
        context: &OperationContext,
    ) -> Result<usize> {
        trace!(
            root_source = %root_source.display(),
            root_out_dir = %root_out_dir.display(),
            "starting nested archive extraction scan"
        );
        let root_source =
            fs::canonicalize(root_source).unwrap_or_else(|_| root_source.to_path_buf());
        let mut nested_count = 0usize;
        let mut processed = HashSet::new();
        processed.insert(root_source);

        let mut queue = VecDeque::new();
        self.enqueue_nested_candidates(root_out_dir, 1, &processed, &mut queue)?;
        trace!(
            initial_queue_len = queue.len(),
            "nested archive extraction initial queue prepared"
        );

        while let Some((source, depth)) = queue.pop_front() {
            trace!(
                source = %source.display(),
                depth,
                queue_remaining = queue.len(),
                extracted_nested_archives = nested_count,
                "processing nested archive candidate"
            );
            if depth > MAX_NESTED_EXTRACT_DEPTH {
                trace!(
                    source = %source.display(),
                    depth,
                    max_depth = MAX_NESTED_EXTRACT_DEPTH,
                    "nested archive extraction failed: exceeded max depth"
                );
                return Err(RomWeaverError::Validation(format!(
                    "nested extract exceeded max depth of {MAX_NESTED_EXTRACT_DEPTH} at `{}`",
                    source.display()
                )));
            }
            if nested_count >= MAX_NESTED_EXTRACT_ARCHIVES {
                trace!(
                    source = %source.display(),
                    extracted_nested_archives = nested_count,
                    max_archives = MAX_NESTED_EXTRACT_ARCHIVES,
                    "nested archive extraction failed: exceeded max archive count"
                );
                return Err(RomWeaverError::Validation(format!(
                    "nested extract exceeded max archive count of {MAX_NESTED_EXTRACT_ARCHIVES}"
                )));
            }

            let canonical_source = fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
            if !processed.insert(canonical_source) {
                trace!(
                    source = %source.display(),
                    "skipping nested archive candidate already processed"
                );
                continue;
            }

            let Some(handler) = self.containers.probe(&source) else {
                trace!(
                    source = %source.display(),
                    "skipping nested archive candidate with no container handler"
                );
                continue;
            };

            // Only recurse into containers that successfully inspect, so extension-only matches
            // do not fail nested extraction on non-container payload files.
            let inspect_request = ContainerInspectRequest {
                source: source.clone(),
            };
            if let Err(error) = handler.inspect(&inspect_request, context) {
                trace!(
                    source = %source.display(),
                    format = handler.descriptor().name,
                    error = %error,
                    "skipping nested archive candidate because inspect failed"
                );
                continue;
            }

            let nested_out_dir = self.next_nested_out_dir(&source);
            trace!(
                source = %source.display(),
                format = handler.descriptor().name,
                nested_out_dir = %nested_out_dir.display(),
                "extracting nested archive candidate"
            );
            let nested_request = ContainerExtractRequest {
                source: source.clone(),
                selections: Vec::new(),
                out_dir: nested_out_dir.clone(),
                split_bin: false,
            };
            handler.extract(&nested_request, context).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "nested extract failed for `{}` ({}): {error}",
                    source.display(),
                    handler.descriptor().name
                ))
            })?;
            nested_count = nested_count.saturating_add(1);
            trace!(
                source = %source.display(),
                nested_out_dir = %nested_out_dir.display(),
                format = handler.descriptor().name,
                extracted_nested_archives = nested_count,
                "nested archive extraction completed"
            );

            self.enqueue_nested_candidates(&nested_out_dir, depth + 1, &processed, &mut queue)?;
            trace!(
                source = %source.display(),
                queue_len = queue.len(),
                next_depth = depth + 1,
                "queued additional nested archive candidates"
            );
        }

        trace!(
            extracted_nested_archives = nested_count,
            processed_sources = processed.len(),
            "completed nested archive extraction scan"
        );
        Ok(nested_count)
    }

    fn enqueue_nested_candidates(
        &self,
        root: &Path,
        depth: usize,
        processed: &HashSet<PathBuf>,
        queue: &mut VecDeque<(PathBuf, usize)>,
    ) -> Result<()> {
        trace!(
            root = %root.display(),
            depth,
            processed_count = processed.len(),
            existing_queue_len = queue.len(),
            "scanning nested extract candidates"
        );
        let mut directories = vec![root.to_path_buf()];
        let mut queued_count = 0usize;
        while let Some(directory) = directories.pop() {
            let mut entries =
                fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path());

            for entry in entries {
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_dir() {
                    directories.push(path);
                    continue;
                }
                if !file_type.is_file() || self.containers.probe(&path).is_none() {
                    continue;
                }
                let canonical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
                if processed.contains(&canonical)
                    || queue
                        .iter()
                        .any(|(queued_path, _)| queued_path.as_path() == path)
                {
                    continue;
                }
                queue.push_back((path, depth));
                queued_count = queued_count.saturating_add(1);
                if let Some((queued_path, queued_depth)) = queue.back() {
                    trace!(
                        source = %queued_path.display(),
                        depth = *queued_depth,
                        queue_len = queue.len(),
                        "queued nested extract candidate"
                    );
                }
            }
        }
        trace!(
            root = %root.display(),
            depth,
            queued_count,
            final_queue_len = queue.len(),
            "completed nested candidate scan"
        );
        Ok(())
    }

    fn next_nested_out_dir(&self, source: &Path) -> PathBuf {
        let parent = source
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("archive");
        let base_name = self.nested_base_name(file_name);

        let mut candidate = parent.join(&base_name);
        if candidate != source && !candidate.exists() {
            return candidate;
        }

        for index in 1usize.. {
            candidate = parent.join(format!("{base_name}.nested-{index}"));
            if candidate != source && !candidate.exists() {
                return candidate;
            }
        }

        unreachable!("nested output directory search is unbounded");
    }

    fn nested_base_name(&self, file_name: &str) -> String {
        let file_name_lower = file_name.to_ascii_lowercase();
        let mut longest_extension = 0usize;
        for handler in self.containers.handlers() {
            for extension in handler.descriptor().extensions {
                let extension_lower = extension.to_ascii_lowercase();
                if file_name_lower.ends_with(&extension_lower)
                    && extension_lower.len() > longest_extension
                {
                    longest_extension = extension_lower.len();
                }
            }
        }

        let mut base = if longest_extension == 0 || longest_extension >= file_name.len() {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("archive")
                .to_string()
        } else {
            file_name[..file_name.len() - longest_extension].to_string()
        };

        base = base.trim().trim_matches('.').to_string();
        if base.is_empty() {
            "archive".to_string()
        } else {
            base
        }
    }
}

enum OutputMode {
    Json,
    Text,
}

struct StdoutReporter {
    mode: OutputMode,
}

impl StdoutReporter {
    fn json() -> Self {
        Self {
            mode: OutputMode::Json,
        }
    }

    fn text() -> Self {
        Self {
            mode: OutputMode::Text,
        }
    }
}

impl ProgressSink for StdoutReporter {
    fn emit(&self, event: ProgressEvent) {
        match self.mode {
            OutputMode::Json => {
                println!(
                    "{}",
                    serde_json::to_string(&event).expect("serialize CLI progress event")
                );
            }
            OutputMode::Text => {
                let format = event.format.as_deref().unwrap_or("-");
                let threads = match (
                    event.requested_threads,
                    event.effective_threads,
                    event.used_parallelism,
                    event.thread_mode,
                ) {
                    (
                        Some(requested),
                        Some(effective),
                        Some(used_parallelism),
                        Some(thread_mode),
                    ) => {
                        format!(
                            " requested_threads={requested} effective_threads={effective} thread_mode={thread_mode:?} used_parallelism={used_parallelism}"
                        )
                    }
                    _ => String::new(),
                };
                println!(
                    "[{}] family={:?} format={} stage={} status={:?} label={}{}",
                    event.command,
                    event.family,
                    format,
                    event.stage,
                    event.status,
                    event.label,
                    threads,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CliApp, CompressionLevelProfile, ParsedSelectionInput};

    #[test]
    fn parse_selection_input_accepts_valid_indexes() {
        assert_eq!(
            CliApp::parse_selection_input("1", 3),
            ParsedSelectionInput::Selected(0)
        );
        assert_eq!(
            CliApp::parse_selection_input("3", 3),
            ParsedSelectionInput::Selected(2)
        );
    }

    #[test]
    fn parse_selection_input_handles_cancel_and_invalid_values() {
        assert_eq!(
            CliApp::parse_selection_input("q", 4),
            ParsedSelectionInput::Cancelled
        );
        assert_eq!(
            CliApp::parse_selection_input("  quit ", 4),
            ParsedSelectionInput::Cancelled
        );
        assert_eq!(
            CliApp::parse_selection_input("0", 4),
            ParsedSelectionInput::Invalid
        );
        assert_eq!(
            CliApp::parse_selection_input("5", 4),
            ParsedSelectionInput::Invalid
        );
        assert_eq!(
            CliApp::parse_selection_input("abc", 4),
            ParsedSelectionInput::Invalid
        );
    }

    #[test]
    fn selection_error_detection_matches_known_selection_failures() {
        assert!(CliApp::is_selection_resolution_error(
            "validation failed: requested selections were not found: missing.iso"
        ));
        assert!(CliApp::is_selection_resolution_error(
            "validation failed: requested selections resolved to no extractable cd outputs"
        ));
        assert!(CliApp::is_selection_resolution_error(
            "validation failed: gcz extract does not support --select yet"
        ));
        assert!(!CliApp::is_selection_resolution_error(
            "validation failed: no registered handler matched `sample.bin`"
        ));
    }

    #[test]
    fn compression_profile_defaults_to_max_levels() {
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "zip",
                None,
                None,
                CompressionLevelProfile::Max,
            ),
            Some(9)
        );
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "zst",
                None,
                None,
                CompressionLevelProfile::Max,
            ),
            Some(22)
        );
    }

    #[test]
    fn compression_profile_respects_codec_and_explicit_levels() {
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "zip",
                Some("store"),
                None,
                CompressionLevelProfile::Max,
            ),
            None
        );
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "chd",
                Some("cdzs"),
                None,
                CompressionLevelProfile::VeryHigh,
            ),
            Some(21)
        );
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "chd",
                Some("cdlz"),
                None,
                CompressionLevelProfile::Max,
            ),
            Some(9)
        );
        assert_eq!(
            CliApp::resolve_compression_level_for_profile(
                "zst",
                Some("zstd"),
                Some(4),
                CompressionLevelProfile::Max,
            ),
            Some(4)
        );
    }
}
