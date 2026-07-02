use super::*;

const fn default_true() -> bool {
    true
}

const fn default_max_compression_level() -> CompressionLevelProfile {
    CompressionLevelProfile::Max
}

fn default_xdelta_secondary() -> String {
    // No in-patch secondary compression by default (this also matches xdelta3, which only compresses
    // when you pass `-S`). The patch's literal sections are frequently already-compressed disc assets
    // where LZMA burns tens of seconds for a few percent, and the patch is typically re-compressed
    // downstream anyway. Callers wanting a self-contained compressed patch can pass `lzma`.
    XdeltaSecondaryMode::None.to_string()
}

fn default_code_kind() -> String {
    // Infer the code scheme (Game Genie vs Pro Action Replay/GameShark) from the
    // code's shape unless the caller pins it explicitly.
    "auto".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ProbeCommand {
    pub source: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "select",
            help = "Select an extracted probe payload by exact name, prefix, or glob (repeatable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "rom-filter",
            help = "Keep ROM-like payload candidates during automatic extraction"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub rom_filter: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-filter",
            help = "Keep patch-like payload candidates during automatic extraction"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_filter: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable container auto-extract and probe the source bytes directly"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable default ignore filtering during probe container payload resolution"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ListCommand {
    pub source: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "select",
            help = "Select a nested container by exact name, prefix, or glob before listing entries (repeatable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "rom-filter",
            help = "Keep ROM-like payload candidates during nested list source resolution"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub rom_filter: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-filter",
            help = "Keep patch-like payload candidates during nested list source resolution"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_filter: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable default ignore filtering during nested list container selection"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "For CHD CD listing, report split CUE + per-track BIN entries (`*.trackNN.bin`) instead of a single BIN; ignored for containers that do not support it"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub split_bin: bool,
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "rom-filter",
            help = "Extract ROM-like entries and nested containers only"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub rom_filter: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-filter",
            help = "Extract patch-like entries and nested containers only"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_filter: bool,
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum-rom",
            value_name = "ALGO",
            help = "Like --checksum but only ROM-like outputs are hashed (sidecar/non-ROM entries are skipped); safe to always pass. Ignored if --checksum is also set"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub checksum_rom: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Fold container/platform probe metadata into the result and fail when a single-payload source resolves to no known platform"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub probe: bool,
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
            long = "rom-filter",
            help = "Keep ROM-like payload candidates during checksum auto-extract"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub rom_filter: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-filter",
            help = "Keep patch-like payload candidates during checksum auto-extract"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_filter: bool,
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Fold platform probe metadata into the result and fail when the checksummed bytes resolve to no known platform"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub probe: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IngestCommand {
    pub source: PathBuf,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub out_dir: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "select",
            help = "Select a payload by exact name, prefix, or glob when an archive carries more than one ROM (repeatable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable default common-file ignore filtering during classification and extraction"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-nested-extract",
            help = "Do not recursively extract nested containers emitted while ingesting"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_nested_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "split-bin",
            num_args = 0..=1,
            default_missing_value = "true",
            help = "For a multi-track CHD CD, force split per-track BIN (`--split-bin`/`--split-bin true`) or a single merged BIN (`--split-bin false`). Omit to ask the host interactively when the disc offers the choice"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub split_bin: Option<bool>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum",
            value_name = "ALGO",
            help = "ROM checksum algorithm to compute (repeatable); defaults to crc32, md5, sha1 when omitted"
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
pub struct CompressCommand {
    #[cfg_attr(not(target_arch = "wasm32"), arg(required = true))]
    pub input: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Output container format (derived from the output extension when omitted; required when the output has no recognizable extension; overrides the extension with a warning when they disagree)"
        )
    )]
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
        default_value_t = CompressionLevelProfile::Max,
        help = "Global compression level profile (min|very-low|low|medium|high|very-high|max)"
    ))]
    #[serde(default = "default_max_compression_level")]
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
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long = "no-rom-filter",
        action = ArgAction::SetFalse,
        default_value_t = true,
        help = "Disable the default ROM-only filter applied to archive payloads before trimming"
    ))]
    #[serde(default = "default_true")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub rom_filter: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable archive auto-extract; only trim direct file inputs"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "revert-marker",
            alias = "reversible",
            help = "Embed a small footer in the trimmed output so it can later be reverted to a byte-identical original"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub revert_marker: bool,
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
            help = "Container payload selection pattern(s) used while auto-extracting patch apply input and patch files"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "target",
            help = "For a disc-sheet (.cue/.gdi) input, glob selecting which referenced track (.bin) receives the patch; must match exactly one track. Uses the same matching as --select."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub target: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "rom-filter",
            help = "Keep ROM-like payload candidates while resolving the patch input archive"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub rom_filter: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-filter",
            help = "Keep patch-like payload candidates while resolving patch archives"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_filter: bool,
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
            help = "Disable default ignore filtering during patch apply container payload resolution"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch",
            help = "Patch file(s) to apply in order; repeat --patch for each step. If omitted, patch apply discovers RetroArch-style sidecar patches inside the input archive."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
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
            help = "Patch-output compression container format (derived from the output extension when omitted; required when the output has no recognizable extension; overrides the extension with a warning when they disagree). Use --no-compress to write raw patched bytes."
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
        default_value_t = CompressionLevelProfile::Max,
        help = "Global patch-output compression level profile (min|very-low|low|medium|high|very-high|max)"
    ))]
    #[serde(default = "default_max_compression_level")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub compress_level: CompressionLevelProfile,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum-cache",
            value_name = "ALGO=HEX",
            help = "Provide trusted effective patch input checksum values for validation without recomputing; repeat for multiple algorithms (for example: --checksum-cache crc32=1234abcd)"
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
            long = "n64-byte-order",
            value_enum,
            help = "Transform an N64 input to the requested byte order before patch apply, then restore the original order after output"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub n64_byte_order: Option<N64ByteOrder>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Skip patch-provided checksum validation during patch apply and permit recoverable patch-format validation issues"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub ignore_checksum_validation: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "validate-output-checksum",
            value_name = "ALGO=HEX",
            help = "Validate the patched output checksum after apply; repeat for multiple algorithms (for example: --validate-output-checksum sha1=...)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub validate_with_output_checksums: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "ppf-undo-aware",
            help = "For PPF patches that carry undo data, reconstruct the original validation region so an already-patched ROM can be safely re-applied (no-op for a clean ROM)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub ppf_undo_aware: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "code",
            action = ArgAction::Append,
            help = "Cheat code (Game Genie or Pro Action Replay/GameShark) to bake into the input ROM; repeat --code for each. Codes are decoded against the input ROM and applied as a synthetic patch."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub codes: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "code-system",
            help = "Override the cheat-code system (nes, snes, genesis, gameboy) when it cannot be auto-detected from the ROM header"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub code_system: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "code-kind",
            default_value = "auto",
            help = "Cheat code scheme: auto (infer), game-genie, or gameshark/par"
        )
    )]
    #[serde(default = "default_code_kind")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub code_kind: String,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PatchValidateCommand {
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "select",
            help = "Container payload selection pattern(s) used while auto-extracting patch validate input and patch files"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "rom-filter",
            help = "Keep ROM-like payload candidates while resolving the patch validation input archive"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub rom_filter: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-filter",
            help = "Keep patch-like payload candidates while resolving patch archives"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_filter: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable container auto-extract and validate the raw input and patch bytes directly"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Disable default ignore filtering during patch validate container payload resolution"
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
            help = "Patch file(s) to validate in order; repeat --patch for each step"
        )
    )]
    pub patches: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum-cache",
            value_name = "ALGO=HEX",
            help = "Provide trusted effective patch input checksum values for validation without recomputing; repeat for multiple algorithms (for example: --checksum-cache crc32=1234abcd)"
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
            help = "Validate effective patch input checksum before dry-run apply; repeat for multiple algorithms (for example: --validate-with-checksum crc32=1234abcd)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub validate_with_checksums: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "validate-with-size",
            value_name = "BYTES",
            help = "Validate exact effective patch input size before dry-run apply"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub validate_with_size: Option<u64>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "validate-with-min-size",
            value_name = "BYTES",
            help = "Validate minimum effective patch input size before dry-run apply"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub validate_with_min_size: Option<u64>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Remove a detected ROM header before patch validation (A78/LNX/NES/FDS/SMC signatures; SNES/PCE copier-size rules)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub strip_header: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "n64-byte-order",
            value_enum,
            help = "Transform an N64 input to the requested byte order before patch validation"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub n64_byte_order: Option<N64ByteOrder>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Skip patch-provided checksum validation during patch validation and permit recoverable patch-format validation issues"
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Modified ROM to diff against the original. Optional when --code is used; the modified ROM is then derived by baking the cheat codes into the original."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub modified: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Patch format (derived from the output extension when omitted; required when the output has no recognizable patch extension)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub format: Option<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Skip strict patch validation during patch create when supported, including checksum emission and compatibility checks"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub ignore_checksum_validation: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum-name",
            help = "Embed the original ROM crc32 into the output patch file name (as `[crc32:HEX]`) so patch apply can validate the input ROM; most useful for formats that carry no embedded checksum"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub checksum_name: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "source-crc32",
            help = "Precomputed crc32 (8 hex digits) of the original ROM; used with --checksum-name to embed the value without re-reading the original"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub source_crc32: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "code",
            action = ArgAction::Append,
            help = "Cheat code (Game Genie or Pro Action Replay/GameShark) to bake into the original ROM to derive the modified ROM; repeat --code for each. Mutually exclusive with --modified."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub codes: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "code-system",
            help = "Override the cheat-code system (nes, snes, genesis, gameboy) when it cannot be auto-detected from the ROM header"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub code_system: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "code-kind",
            default_value = "auto",
            help = "Cheat code scheme: auto (infer), game-genie, or gameshark/par"
        )
    )]
    #[serde(default = "default_code_kind")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub code_kind: String,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "xdelta-secondary",
            default_value = "none",
            value_parser = ["auto", "lzma", "djw", "fgk", "none"],
            help = "xdelta secondary compression mode during patch create (default none = no in-patch compression, matching xdelta3 without -S; lzma adds LZMA like xdelta -S lzma; djw/fgk are xdelta3's huffman coders; auto compares djw/lzma/fgk and keeps the smallest)"
        )
    )]
    #[serde(default = "default_xdelta_secondary")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub xdelta_secondary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PatchCreateCandidatesCommand {
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub original: PathBuf,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long))]
    pub modified: PathBuf,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

/// Compute a memory-/thread-aware concurrent extraction schedule from per-job source sizes, without
/// touching any files. The result (an `extract_batch_plan` in the report details) groups the jobs
/// into concurrent waves with a per-job thread allotment, so the host can run a batch of extractions
/// at a safe concurrency for the device. Pure planning — no I/O — so it runs the same on native and
/// in the browser: one Rust policy schedules both.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PlanExtractBatchCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "job-size",
            value_name = "BYTES",
            help = "Source size in bytes for one job; repeat once per job, in input order"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub job_sizes: Vec<u64>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, default_value = "auto"))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "max-concurrency",
            help = "Hard cap on jobs running at once; defaults to the thread budget"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub max_concurrency: Option<usize>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "total-memory-bytes",
            help = "Total memory budget concurrent jobs may reserve (e.g. browser device memory); defaults to the platform's physical memory"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub total_memory_bytes: Option<u64>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "memory-ceiling-bytes",
            help = "Combined working-set ceiling to plan against, used verbatim (no fraction/clamp). The browser passes its own resolved, mobile-capped ceiling here; when set it overrides --total-memory-bytes"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub memory_ceiling_bytes: Option<u64>,
}

/// Match RetroArch/libretro sidecar patches against a ROM by name — the single source of truth for the
/// `<rom-stem>.<patch-ext>` soft-patch convention, so the browser (which has no native access to the
/// matcher) and the native CLI agree exactly. Given a ROM path and candidate patch paths (full paths so
/// the same-directory rule applies), the report details carry a `sidecar_matches` array of the matched
/// patches in apply order (`{ name, order }`). Pure name logic — no I/O — so it runs the same on native
/// and in the browser.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct MatchSidecarsCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "rom-name",
            value_name = "PATH",
            help = "ROM path the sidecar patches must match"
        )
    )]
    pub rom_name: String,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-name",
            value_name = "PATH",
            help = "Candidate patch path; repeat once per candidate"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_names: Vec<String>,
}
