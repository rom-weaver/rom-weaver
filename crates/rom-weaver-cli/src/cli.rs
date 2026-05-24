use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    fs,
    fs::File,
    io::{self, BufReader, BufWriter, IsTerminal, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::{Arc, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(not(target_arch = "wasm32"))]
use clap::{ArgAction, Args, Parser, Subcommand, ValueEnum};
use rom_weaver_checksum::checksum_reader_values_with_progress;
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
    ThreadBudget, ThreadCapability, ThreadExecution, XdeltaSecondaryMode,
};
use rom_weaver_libarchive::{
    ReadFilter as LibarchiveReadFilter, list_regular_archive_file_entries, with_raw_stream_reader,
    with_regular_archive_file_entry_reader,
};
use rom_weaver_patches::{
    PatchRegistry, explicitly_unsupported_patch_reason_for_name,
    explicitly_unsupported_patch_reason_for_path,
};
use serde_json::{Map, Value, json};
use tracing::trace;
#[cfg(not(target_arch = "wasm32"))]
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};
use xdvdfs::{
    blockdev::{BlockDeviceWrite as XdvdfsBlockDeviceWrite, OffsetWrapper as XdvdfsOffsetWrapper},
    write::{fs::XDVDFSFilesystem as XdvdfsFilesystem, img::create_xdvdfs_image},
};

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Parser))]
#[cfg_attr(
    not(target_arch = "wasm32"),
    command(
        name = "rom-weaver",
        version,
        about = "Native CLI groundwork for ROM inspection, extraction, checksums, compression, trimming, and patching."
    )
)]
struct Cli {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            help = "Emit progress and terminal status as JSON lines"
        )
    )]
    json: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            conflicts_with = "no_progress",
            help = "Force running progress events on"
        )
    )]
    progress: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-progress",
            global = true,
            conflicts_with = "progress",
            help = "Disable running progress events"
        )
    )]
    no_progress: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            global = true,
            help = "Enable trace logs (also enabled by ROM_WEAVER_LOG or RUST_LOG)"
        )
    )]
    trace: bool,
    #[cfg_attr(not(target_arch = "wasm32"), command(subcommand))]
    command: Commands,
}

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Subcommand))]
pub enum Commands {
    Inspect(InspectCommand),
    Extract(ExtractCommand),
    Checksum(ChecksumCommand),
    Compress(CompressCommand),
    Trim(TrimCommand),
    BatchHeaderFixer(BatchHeaderFixerCommand),
    PatchApply(PatchApplyCommand),
    PatchCreate(PatchCreateCommand),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg_attr(not(target_arch = "wasm32"), derive(ValueEnum))]
pub enum CompressionLevelProfile {
    Min,
    #[cfg_attr(not(target_arch = "wasm32"), value(name = "very-low"))]
    VeryLow,
    Low,
    Medium,
    High,
    #[cfg_attr(not(target_arch = "wasm32"), value(name = "very-high"))]
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

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
pub struct InspectCommand {
    pub source: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "List selectable archive entries in the inspect label when supported"
        )
    )]
    pub list: bool,
}

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
pub struct ExtractCommand {
    pub source: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "select",
            help = "Select extracted entries by exact name, prefix, or glob (repeatable). Examples: --select game.disc02.cue --select 'game.disc0?.bin'"
        )
    )]
    pub select: Vec<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub out_dir: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "For CHD CD extraction, force split CUE + per-track BIN output (`*.trackNN.bin`) instead of a single BIN when possible"
        )
    )]
    pub split_bin: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    pub threads: ThreadBudget,
}

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
pub struct ChecksumCommand {
    pub source: PathBuf,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long = "algo", required = true))]
    pub algo: Vec<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long = "select"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable container auto-extract and checksum the source bytes directly"
        )
    )]
    pub no_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable default ignore filtering during checksum container payload resolution"
        )
    )]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Remove a detected ROM header before checksum (A78/LNX/NES/FDS/SMC signatures; SNES/PCE copier-size rules)"
        )
    )]
    pub strip_header: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable automatic trim-boundary checksum fixes for trim-eligible ROMs"
        )
    )]
    pub no_trim_fix: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub start: Option<u64>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub length: Option<u64>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    pub threads: ThreadBudget,
}

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
pub struct CompressCommand {
    #[cfg_attr(not(target_arch = "wasm32"), arg(required = true))]
    pub input: Vec<PathBuf>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub format: Option<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            action = ArgAction::Append,
            help = "Compression codec override; supports codec[:level]. Repeat --codec for multiple codecs (for example CHD: --codec cdzs[:19] --codec cdzl --codec cdfl). If :level is omitted, falls back to --level profile."
        )
    )]
    pub codec: Vec<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long,
        value_enum,
        default_value_t = CompressionLevelProfile::High,
        help = "Global compression level profile (min|very-low|low|medium|high|very-high|max)"
    ))]
    pub level: CompressionLevelProfile,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    pub threads: ThreadBudget,
}

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
pub struct TrimCommand {
    #[cfg_attr(not(target_arch = "wasm32"), arg(required = true))]
    pub source: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            conflicts_with = "in_place",
            help = "Destination file for trimmed output (single trim-eligible source only)"
        )
    )]
    pub output: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'e',
            long,
            help = "Output extension for side-by-side output (supports `{ext}` placeholder, for example `trim.{ext}`)"
        )
    )]
    pub extension: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "in-place",
            alias = "inplace",
            help = "Trim the source file in place instead of writing a new file"
        )
    )]
    pub in_place: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "simulate",
            alias = "dry-run",
            help = "Simulate trim operations without writing output files"
        )
    )]
    pub dry_run: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            alias = "untrim",
            alias = "restore",
            help = "Revert trimmed files by padding back to the nearest power-of-two size (not supported for xiso or rvz-scrub)"
        )
    )]
    pub revert: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long = "no-recursive",
        action = ArgAction::SetFalse,
        default_value_t = true,
        help = "Do not recursively scan subdirectories when input sources include folders"
    ))]
    pub recursive: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    pub threads: ThreadBudget,
}

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
pub struct BatchHeaderFixerCommand {
    #[cfg_attr(not(target_arch = "wasm32"), arg(required = true))]
    pub source: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            conflicts_with = "in_place",
            help = "Destination file for fixed output (single header-fix source only)"
        )
    )]
    pub output: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'e',
            long,
            help = "Output extension for side-by-side output (supports `{ext}` placeholder, for example `fixed.{ext}`)"
        )
    )]
    pub extension: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "in-place",
            alias = "inplace",
            help = "Fix headers in place instead of writing a new file"
        )
    )]
    pub in_place: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "simulate",
            alias = "dry-run",
            help = "Simulate header fixing without writing output files"
        )
    )]
    pub dry_run: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long = "no-recursive",
        action = ArgAction::SetFalse,
        default_value_t = true,
        help = "Do not recursively scan subdirectories when input sources include folders"
    ))]
    pub recursive: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    pub threads: ThreadBudget,
}

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
pub struct PatchApplyCommand {
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "select",
            help = "Container payload selection pattern(s) used while auto-extracting patch-apply input and patch files"
        )
    )]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable container auto-extract and patch the raw input and patch bytes directly"
        )
    )]
    pub no_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable default ignore filtering during patch-apply container payload resolution"
        )
    )]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch",
            required = true,
            help = "Patch file(s) to apply in order; repeat --patch for each step"
        )
    )]
    pub patches: Vec<PathBuf>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Write raw patched bytes without the default patch-output compression step"
        )
    )]
    pub no_compress: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "compress-format",
            help = "Patch-output compression container format (default: auto). Use `auto` to force auto selection."
        )
    )]
    pub compress_format: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "compress-codec",
            action = ArgAction::Append,
            help = "Patch-output compression codec override; supports codec[:level]. Repeat --compress-codec for multiple codecs (for example CHD: --compress-codec cdzs[:19] --compress-codec cdzl --compress-codec cdfl). If :level is omitted, falls back to --compress-level profile."
        )
    )]
    pub compress_codec: Vec<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long = "compress-level",
        value_enum,
        default_value_t = CompressionLevelProfile::High,
        help = "Global patch-output compression level profile (min|very-low|low|medium|high|very-high|max)"
    ))]
    pub compress_level: CompressionLevelProfile,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum-cache",
            value_name = "ALGO=HEX",
            help = "Seed effective patch input checksum cache before apply; repeat for multiple algorithms (for example: --checksum-cache crc32=1234abcd)"
        )
    )]
    pub checksum_cache: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "validate-with-checksum",
            value_name = "ALGO=HEX",
            help = "Validate effective patch input checksum before apply; repeat for multiple algorithms (for example: --validate-with-checksum crc32=1234abcd)"
        )
    )]
    pub validate_with_checksums: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Remove a detected ROM header before patch apply (A78/LNX/NES/FDS/SMC signatures; SNES/PCE copier-size rules)"
        )
    )]
    pub strip_header: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Add header bytes after patch apply (reuses stripped header bytes when available; defaults to 512-byte copier header)"
        )
    )]
    pub add_header: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Repair supported ROM headers/checksums after patch apply (SNES/NES/GB/GBA/MD/SMS/N64/NDS and related profiles; auto-detect)"
        )
    )]
    pub repair_checksum: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Skip patch-provided checksum validation during patch apply (source, target, and patch-level checks when supported)"
        )
    )]
    pub ignore_checksum_validation: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    pub threads: ThreadBudget,
}

#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
pub struct PatchCreateCommand {
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub original: PathBuf,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub modified: PathBuf,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub format: String,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Skip patch checksum emission during patch create when supported (for example xdelta or VCDIFF window checksums)"
        )
    )]
    pub ignore_checksum_validation: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    pub threads: ThreadBudget,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "xdelta-secondary",
            default_value = "lzma",
            value_parser = ["auto", "auto-fast", "lzma", "djw", "fgk", "none"],
            help = "xdelta secondary compression mode during patch create (default lzma matches upstream xdelta when LZMA is available; auto compares djw/lzma/fgk; auto-fast prefers speed via lzma-only plus incompressible-data skip; none disables secondary recoding)"
        )
    )]
    pub xdelta_secondary: String,
}

#[derive(Clone, Copy, Debug)]
pub struct RunCommandOptions {
    pub json: bool,
    pub trace: bool,
    pub emit_progress_events: bool,
    pub interactive_selection_enabled: bool,
}

impl RunCommandOptions {
    fn resolve_emit_progress_events(
        json: bool,
        progress: bool,
        no_progress: bool,
        stdout_is_tty: bool,
    ) -> bool {
        if no_progress {
            return false;
        }
        if progress {
            return true;
        }
        if json {
            return true;
        }
        stdout_is_tty
    }

    pub fn detect_for_terminal(json: bool, trace: bool, progress: bool, no_progress: bool) -> Self {
        let interactive_selection_enabled =
            !json && io::stdin().is_terminal() && io::stderr().is_terminal();
        let emit_progress_events = Self::resolve_emit_progress_events(
            json,
            progress,
            no_progress,
            io::stdout().is_terminal(),
        );
        Self {
            json,
            trace,
            emit_progress_events,
            interactive_selection_enabled,
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn main_entry() -> ExitCode {
    let cli = Cli::parse();
    let options =
        RunCommandOptions::detect_for_terminal(cli.json, cli.trace, cli.progress, cli.no_progress);
    run_command(cli.command, options)
}

#[cfg(target_arch = "wasm32")]
pub fn main_entry() -> ExitCode {
    let cli = match parse_wasm_cli() {
        Ok(cli) => cli,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::from(2);
        }
    };
    let options =
        RunCommandOptions::detect_for_terminal(cli.json, cli.trace, cli.progress, cli.no_progress);
    run_command(cli.command, options)
}

pub fn run_command(command: Commands, options: RunCommandOptions) -> ExitCode {
    init_trace_logging(options.trace, options.json);
    trace!(
        json = options.json,
        emit_progress_events = options.emit_progress_events,
        trace_requested = options.trace,
        command = ?command,
        "parsed command-line arguments"
    );
    let reporter: Arc<dyn ProgressSink> = if options.json {
        Arc::new(StdoutReporter::json())
    } else {
        Arc::new(StdoutReporter::text())
    };
    let app = CliApp::new(
        reporter,
        options.emit_progress_events,
        options.interactive_selection_enabled,
    );
    app.run(command)
}

#[cfg(target_arch = "wasm32")]
type WasmCliParseResult<T> = std::result::Result<T, WasmCliParseError>;

include!("wasm_parse.rs");

include!("app.rs");

include!("reporters.rs");

include!("../tests/unit/cli.rs");
