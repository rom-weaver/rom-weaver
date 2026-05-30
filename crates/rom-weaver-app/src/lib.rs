use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    fs,
    fs::File,
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::{Arc, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(not(target_arch = "wasm32"))]
use clap::{ArgAction, Args, Subcommand, ValueEnum};
use rom_weaver_checksum::checksum_reader_values_with_progress;
use rom_weaver_checksum::{
    NativeChecksumEngine, checksum_file_values, seed_checksum_file_cache, supported_algorithms,
};
use rom_weaver_codecs::{CanonicalCodec, RequestedCodec, parse_requested_codec};
use rom_weaver_containers::{CompressFormatRecommendation, ContainerRegistry};
use rom_weaver_core::{
    CancellationToken, ChecksumEngine, ChecksumRequest, ContainerCreateRequest,
    ContainerExtractRequest, ContainerHandler, ContainerInspectRequest, ContainerListEntry,
    OperationContext, OperationFamily, OperationReport, OperationStatus, PatchApplyRequest,
    PatchChecksumValidation, PatchCreateRequest, ProbeConfidence, ProgressEvent, ProgressSink,
    Result, RomWeaverError, ThreadBudget, ThreadCapability, ThreadExecution, XdeltaSecondaryMode,
    should_ignore_common_container_file,
};
use rom_weaver_libarchive::{
    ReadFilter as LibarchiveReadFilter, list_regular_archive_file_entries, with_raw_stream_reader,
    with_regular_archive_file_entry_reader,
};
use rom_weaver_patches::{
    PatchRegistry, explicitly_unsupported_patch_reason_for_name,
    explicitly_unsupported_patch_reason_for_path,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tracing::trace;
#[cfg(not(target_arch = "wasm32"))]
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};
#[cfg(feature = "typescript-types")]
use ts_rs::TS;
use xdvdfs::{
    blockdev::{BlockDeviceWrite as XdvdfsBlockDeviceWrite, OffsetWrapper as XdvdfsOffsetWrapper},
    write::{fs::XDVDFSFilesystem as XdvdfsFilesystem, img::create_xdvdfs_image},
};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Subcommand))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case", tag = "type", content = "args")]
#[cfg_attr(
    feature = "typescript-types",
    ts(rename_all = "kebab-case", tag = "type", content = "args")
)]
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(ValueEnum))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript-types", ts(rename_all = "kebab-case"))]
pub enum CompressionLevelProfile {
    Min,
    #[cfg_attr(not(target_arch = "wasm32"), value(name = "very-low"))]
    VeryLow,
    Low,
    Medium,
    #[default]
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

const fn default_true() -> bool {
    true
}

const fn default_high_compression_level() -> CompressionLevelProfile {
    CompressionLevelProfile::High
}

fn default_xdelta_secondary() -> String {
    XdeltaSecondaryMode::Lzma.to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct InspectCommand {
    pub source: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "List selectable archive entries in the inspect label when supported"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub list: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ExtractCommand {
    pub source: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "select",
            help = "Select extracted entries by exact name, prefix, or glob (repeatable). Examples: --select game.disc02.cue --select 'game.disc0?.bin'"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
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
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub split_bin: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable default common-file ignore filtering during container extraction"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-nested-extract",
            help = "Do not recursively extract nested containers emitted by this extraction"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_nested_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-overwrite",
            help = "Fail extraction if any destination output file already exists"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_overwrite: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum",
            value_name = "ALGO",
            help = "Compute an output checksum while extracting; repeat for multiple algorithms"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub checksum: Vec<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ChecksumCommand {
    pub source: PathBuf,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long = "algo", required = true))]
    pub algo: Vec<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long = "select"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable container auto-extract and checksum the source bytes directly"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable default ignore filtering during checksum container payload resolution"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Remove a detected ROM header before checksum (A78/LNX/NES/FDS/SMC signatures; SNES/PCE copier-size rules)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub strip_header: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable automatic trim-boundary checksum fixes for trim-eligible ROMs"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_trim_fix: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub start: Option<u64>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub length: Option<u64>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct CompressCommand {
    #[cfg_attr(not(target_arch = "wasm32"), arg(required = true))]
    pub input: Vec<PathBuf>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
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
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub codec: Vec<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long,
        value_enum,
        default_value_t = CompressionLevelProfile::High,
        help = "Global compression level profile (min|very-low|low|medium|high|very-high|max)"
    ))]
    #[serde(default = "default_high_compression_level")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub level: CompressionLevelProfile,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
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
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'e',
            long,
            help = "Output extension for side-by-side output (supports `{ext}` placeholder, for example `trim.{ext}`)"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
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
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
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
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
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
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub revert: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long = "no-recursive",
        action = ArgAction::SetFalse,
        default_value_t = true,
        help = "Do not recursively scan subdirectories when input sources include folders"
    ))]
    #[serde(default = "default_true")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub recursive: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
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
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'e',
            long,
            help = "Output extension for side-by-side output (supports `{ext}` placeholder, for example `fixed.{ext}`)"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
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
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
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
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub dry_run: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long = "no-recursive",
        action = ArgAction::SetFalse,
        default_value_t = true,
        help = "Do not recursively scan subdirectories when input sources include folders"
    ))]
    #[serde(default = "default_true")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub recursive: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
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
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable container auto-extract and patch the raw input and patch bytes directly"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable default ignore filtering during patch-apply container payload resolution"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
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
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_compress: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "compress-format",
            help = "Patch-output compression container format (default: auto). Use `auto` to force auto selection."
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub compress_format: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "compress-codec",
            action = ArgAction::Append,
            help = "Patch-output compression codec override; supports codec[:level]. Repeat --compress-codec for multiple codecs (for example CHD: --compress-codec cdzs[:19] --compress-codec cdzl --compress-codec cdfl). If :level is omitted, falls back to --compress-level profile."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub compress_codec: Vec<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long = "compress-level",
        value_enum,
        default_value_t = CompressionLevelProfile::High,
        help = "Global patch-output compression level profile (min|very-low|low|medium|high|very-high|max)"
    ))]
    #[serde(default = "default_high_compression_level")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub compress_level: CompressionLevelProfile,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum-cache",
            value_name = "ALGO=HEX",
            help = "Seed effective patch input checksum cache before apply; repeat for multiple algorithms (for example: --checksum-cache crc32=1234abcd)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub checksum_cache: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "validate-with-checksum",
            value_name = "ALGO=HEX",
            help = "Validate effective patch input checksum before apply; repeat for multiple algorithms (for example: --validate-with-checksum crc32=1234abcd)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub validate_with_checksums: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Remove a detected ROM header before patch apply (A78/LNX/NES/FDS/SMC signatures; SNES/PCE copier-size rules)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub strip_header: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Add header bytes after patch apply (reuses stripped header bytes when available; defaults to 512-byte copier header)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub add_header: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Repair supported ROM headers/checksums after patch apply (SNES/NES/GB/GBA/MD/SMS/N64/NDS and related profiles; auto-detect)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub repair_checksum: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Skip patch-provided checksum validation during patch apply (source, target, and patch-level checks when supported)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub ignore_checksum_validation: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
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
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub ignore_checksum_validation: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
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
    #[serde(default = "default_xdelta_secondary")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub xdelta_secondary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct RomWeaverRunRequest {
    pub command: Commands,
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub output: RomWeaverRunOutputOptions,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct RomWeaverRunOutputOptions {
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub json: bool,
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub progress: Option<bool>,
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub trace: bool,
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub interactive_selection_enabled: bool,
}

impl RomWeaverRunOutputOptions {
    pub fn emit_progress_events(self, stdout_is_tty: bool) -> bool {
        self.progress.unwrap_or(self.json || stdout_is_tty)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AppRunOptions {
    pub emit_progress_events: bool,
    pub interactive_selection_enabled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AppRunOutcome {
    pub status: OperationStatus,
    pub exit_code: u8,
}

pub struct RomWeaverApp;

impl RomWeaverApp {
    pub fn run(
        command: Commands,
        options: AppRunOptions,
        reporter: Arc<dyn ProgressSink>,
    ) -> AppRunOutcome {
        let app = CliApp::new(
            reporter,
            options.emit_progress_events,
            options.interactive_selection_enabled,
        );
        app.run(command)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RunCommandOptions {
    pub json: bool,
    pub trace: bool,
    pub emit_progress_events: bool,
    pub interactive_selection_enabled: bool,
}

impl RunCommandOptions {
    pub fn from_output(output: RomWeaverRunOutputOptions, stdout_is_tty: bool) -> Self {
        Self {
            json: output.json,
            trace: output.trace,
            emit_progress_events: output.emit_progress_events(stdout_is_tty),
            interactive_selection_enabled: output.interactive_selection_enabled,
        }
    }
}

pub fn run_request(request: RomWeaverRunRequest, stdout_is_tty: bool) -> ExitCode {
    let output = request.output;
    run_command(
        request.command,
        RunCommandOptions::from_output(output, stdout_is_tty),
    )
}

pub fn run_command(command: Commands, options: RunCommandOptions) -> ExitCode {
    init_trace_logging(options.trace, options.json);
    trace!(
        json = options.json,
        emit_progress_events = options.emit_progress_events,
        trace_requested = options.trace,
        command = ?command,
        "running rom-weaver command"
    );
    let reporter: Arc<dyn ProgressSink> = if options.json {
        Arc::new(StdoutReporter::json())
    } else {
        Arc::new(StdoutReporter::text())
    };
    let outcome = RomWeaverApp::run(
        command,
        AppRunOptions {
            emit_progress_events: options.emit_progress_events,
            interactive_selection_enabled: options.interactive_selection_enabled,
        },
        reporter,
    );
    ExitCode::from(outcome.exit_code)
}

#[cfg(not(target_arch = "wasm32"))]
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
                        "rom_weaver_app=trace,rom_weaver_core=trace,rom_weaver_containers=trace,rom_weaver_patches=trace,rom_weaver_checksum=trace,rom_weaver_codecs=trace"
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
                eprintln!("warning: invalid trace filter `{filter_spec}` ({error}); using `off`");
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

#[cfg(target_arch = "wasm32")]
fn init_trace_logging(trace_flag: bool, _json_mode: bool) {
    static TRACE_LOGGING_INIT: OnceLock<()> = OnceLock::new();
    TRACE_LOGGING_INIT.get_or_init(|| {
        let trace_requested = trace_flag
            || std::env::var("ROM_WEAVER_LOG")
                .ok()
                .and_then(trim_non_empty)
                .is_some()
            || std::env::var("RUST_LOG")
                .ok()
                .and_then(trim_non_empty)
                .is_some();
        if !trace_requested {
            return;
        }

        let _ = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(io::stderr)
            .with_max_level(tracing::level_filters::LevelFilter::TRACE)
            .compact()
            .try_init();
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
            OutputMode::Json => match serde_json::to_string(&event) {
                Ok(serialized) => {
                    println!("{serialized}");
                    let _ = io::Write::flush(&mut io::stdout());
                }
                Err(error) => eprintln!("failed to serialize progress event: {error}"),
            },
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
                let _ = io::Write::flush(&mut io::stdout());
            }
        }
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

#[derive(Default)]
struct XisoMeasuredLengthSink {
    output_len: u64,
}

impl XisoMeasuredLengthSink {
    const fn output_len(&self) -> u64 {
        self.output_len
    }
}

impl XdvdfsBlockDeviceWrite<io::Error> for XisoMeasuredLengthSink {
    fn write(&mut self, offset: u64, buffer: &[u8]) -> std::result::Result<(), io::Error> {
        let end = offset
            .checked_add(buffer.len() as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "xiso output overflow"))?;
        self.output_len = self.output_len.max(end);
        Ok(())
    }

    fn len(&mut self) -> std::result::Result<u64, io::Error> {
        Ok(self.output_len)
    }
}

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

struct ProgressFilterReporter {
    inner: Arc<dyn ProgressSink>,
    allow_running: bool,
}

impl ProgressFilterReporter {
    fn suppress_running(inner: Arc<dyn ProgressSink>) -> Self {
        Self {
            inner,
            allow_running: false,
        }
    }
}

impl ProgressSink for ProgressFilterReporter {
    fn emit(&self, event: ProgressEvent) {
        if !self.allow_running && event.status == OperationStatus::Running {
            return;
        }
        self.inner.emit(event);
    }
}

#[cfg(test)]
mod tests;
