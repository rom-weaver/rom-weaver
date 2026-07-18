use super::*;

/// Generate `rom_filter()` / `patch_filter()` accessors over a `filter:
/// Vec<FilterKind>` field so handler call sites stay a mechanical rename from
/// the old boolean flags. Shared by every command that takes `--filter`.
macro_rules! filter_accessors {
    ($command:ty) => {
        impl $command {
            pub fn rom_filter(&self) -> bool {
                self.filter
                    .iter()
                    .any(|kind| matches!(kind, FilterKind::Rom))
            }

            pub fn patch_filter(&self) -> bool {
                self.filter
                    .iter()
                    .any(|kind| matches!(kind, FilterKind::Patch))
            }
        }
    };
}

filter_accessors!(ProbeCommand);
filter_accessors!(ExtractCommand);
filter_accessors!(ChecksumCommand);
filter_accessors!(PatchApplyCommand);
filter_accessors!(PatchValidateCommand);
filter_accessors!(BundleParseCommand);

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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "input",
            value_name = "INPUT",
            help = "File or container to inspect, or - to read from stdin"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
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
            long = "filter",
            value_enum,
            value_delimiter = ',',
            help = "Keep only payload candidates of the given class during automatic extraction: rom, patch, or both (repeatable, comma-separable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
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
pub struct ExtractCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "input",
            value_name = "INPUT",
            help = "Container or disc image to extract"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
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
            long = "filter",
            value_enum,
            value_delimiter = ',',
            help = "Extract only entries (and nested containers) of the given class: rom, patch, or both (repeatable, comma-separable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
            long = "output",
            value_name = "DIR",
            help = "Directory for extracted files"
        )
    )]
    pub output: PathBuf,
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
            long = "force",
            help = "Overwrite destination output files that already exist (default: fail if any exist)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub force: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum",
            value_name = "ALGO",
            value_delimiter = ',',
            help = "Compute an output checksum while extracting; repeat or comma-separate for multiple algorithms"
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
            value_delimiter = ',',
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = "Thread budget: auto or a positive integer"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ChecksumCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "input",
            value_name = "INPUT",
            help = "File or container payload to checksum, or - to read from stdin"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'a',
            long = "algo",
            required = true,
            value_name = "ALGO",
            value_delimiter = ',',
            help = "Checksum algorithm; repeat or comma-separate for multiple algorithms"
        )
    )]
    pub algo: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "select",
            help = "Select a container payload by exact name, prefix, or glob (repeatable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "filter",
            value_enum,
            value_delimiter = ',',
            help = "Keep only payload candidates of the given class during checksum auto-extract: rom, patch, or both (repeatable, comma-separable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            value_name = "BYTE",
            help = "Zero-based byte offset at which hashing begins"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub start: Option<u64>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            value_name = "BYTES",
            help = "Number of bytes to hash from --start (defaults to the remaining input)"
        )
    )]
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = "Thread budget: auto or a positive integer"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IngestCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "input",
            value_name = "INPUT",
            help = "Dropped file or container to classify"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
            long = "output",
            value_name = "DIR",
            help = "Directory for extracted ingest outputs"
        )
    )]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "select",
            help = "Select a payload by exact name, prefix, or glob when an archive carries more than one ROM (repeatable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    /// Optional loose patch names to match against `source` without ingesting it. This keeps the
    /// browser's sibling-sidecar lookup on the ingest command surface while reusing Rust's matcher.
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long = "sidecar-name", action = ArgAction::Append, hide = true)
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub sidecar_names: Vec<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long = "sidecar-only", hide = true))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub sidecar_only: bool,
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
            value_delimiter = ',',
            help = "ROM checksum algorithm to compute (repeatable, comma-separable); defaults to crc32, md5, sha1 when omitted"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub checksum: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = "Thread budget: auto or a positive integer"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct CompressCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "input",
            required = true,
            value_name = "INPUT",
            help = "Input file(s) to place in the output container (repeatable)"
        )
    )]
    pub input: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'f',
            long,
            help = "Output container format (derived from the output extension when omitted; required when the output has no recognizable extension; overrides the extension with a warning when they disagree)"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub format: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(short = 'o', long, value_name = "PATH", help = "Output container path")
    )]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            action = ArgAction::Append,
            value_delimiter = ',',
            help = "Compression codec override; supports codec[:level]. Repeat or comma-separate --codec for multiple codecs (for example CHD: --codec cdzs[:19],cdzl,cdfl). If :level is omitted, falls back to --level profile."
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = "Thread budget: auto or a positive integer"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct TrimCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "input",
            required = true,
            value_name = "INPUT",
            help = "File, container, or directory to trim (repeatable)"
        )
    )]
    pub input: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
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
            long = "in-place",
            help = "Trim the source file in place instead of writing a new file"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub in_place: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'n',
            long = "dry-run",
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
            help = "Restore trimmed files using an embedded revert marker when present; otherwise use the format's header-derived size (NDS/3DS) or next power of two (GBA). Not supported for xiso or rvz-scrub"
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
        long = "no-filter",
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = "Thread budget: auto or a positive integer"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PatchApplyCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long,
            value_name = "PATH",
            help = "ROM, disc sheet, bundle, or container to patch"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
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
            long = "filter",
            value_enum,
            value_delimiter = ',',
            help = "Keep only payload candidates of the given class while resolving patch input/patch archives: rom, patch, or both (repeatable, comma-separable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
            long,
            help = "Output path for the patched result. Optional when a rom-weaver-bundle.json bundle supplies output.name"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "bundle",
            help = "Apply using a rom-weaver-bundle.json bundle (a path, or an http(s) URL on native builds). Also auto-detected when the input is rom-weaver-bundle.json[.gz|.bz2|.xz|.zst], or an archive carrying a root rom-weaver-bundle.json without explicit --patch flags"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub bundle: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "with",
            value_name = "GLOB",
            help = "Include bundle patches matching GLOB (by name or file name) even when default is false; repeatable"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub with_patches: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "without",
            value_name = "GLOB",
            help = "Exclude bundle patches matching GLOB (by name or file name), overriding their default; repeatable"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub without_patches: Vec<String>,
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
            value_delimiter = ',',
            help = "Patch-output compression codec override; supports codec[:level]. Repeat or comma-separate --compress-codec for multiple codecs (for example CHD: --compress-codec cdzs[:19],cdzl,cdfl). If :level is omitted, falls back to --compress-level profile."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub compress_codec: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "compress-level",
            value_enum,
            help = "Global patch-output compression level profile (min|very-low|low|medium|high|very-high|max). Defaults to max"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub compress_level: Option<CompressionLevelProfile>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "assume-in",
            value_name = "ALGO=HEX",
            value_delimiter = ',',
            value_parser = crate::expect_tokens::validate_expect_token,
            help = "Provide trusted effective patch input checksum values so validation skips recomputing them; repeat or comma-separate for multiple algorithms (for example: --assume-in crc32=1234abcd)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub assume_in: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "expect-in",
            value_name = "ALGO=HEX",
            value_delimiter = ',',
            value_parser = crate::expect_tokens::validate_expect_token,
            help = "Validate the effective patch input checksum before apply; ALGO=HEX tokens (repeatable, comma-separable, for example: --expect-in crc32=1234abcd). Size gates (size=N/min-size=N) are only supported on `patch validate`"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub expect_in: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-header",
            value_enum,
            action = ArgAction::Append,
            help = "Which bytes patches apply against: auto (default; strip the detected ROM copier header only when that patch's required input checksum matches the headerless bytes - decided per patch in a chain), keep (patch the current bytes as-is), or strip (strip the detected header). Repeatable: each occurrence applies to the most recent preceding --patch and carries forward until the next occurrence; an occurrence before any --patch applies to every patch. Detected headers: A78/LNX/NES/FDS/SMC signatures plus SNES/PCE copier-size rules."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_header: Vec<PatchApplyHeaderMode>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-basis",
            value_enum,
            action = ArgAction::Append,
            help = "What the preceding --patch's input checks were authored against: auto (default; infer from checksums), base (the original ROM - verified up front, embedded checks skipped mid-chain), or previous (the prior patch's output). Binds to the most recent --patch; index-aligned on the wasm path."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_basis: Vec<PatchBasisMode>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "output-header",
            value_enum,
            overrides_with = "output_header",
            help = "Whether the final patched output carries the ROM header: keep (re-add a header stripped for apply), strip (headerless output, removing a still-present header if needed), or auto (default; keep emulator-required headers like iNES/FDS/LNX/A78, drop junk copier headers like SNES/PCE/Game Doctor). The chain produces one output, so this is a single setting; if repeated, the last value wins. When the final header state changes the ROM's conventional extension (for example SNES .smc vs headerless .sfc), the output extension is adjusted to match."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output_header: Option<PatchApplyOutputHeaderMode>,
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
            action = ArgAction::Append,
            help = "N64 byte order for each patch: auto (default; match the patch source CRC32), keep, big-endian, little-endian, or byte-swapped. Repeatable per patch; a shorter list carries the last mode forward. The original input order is restored on output."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub n64_byte_order: Vec<PatchN64ByteOrderMode>,
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
            long = "expect-out",
            value_name = "ALGO=HEX",
            value_delimiter = ',',
            value_parser = crate::expect_tokens::validate_expect_token,
            help = "Validate the patched output checksum after apply; ALGO=HEX tokens (repeatable, comma-separable, for example: --expect-out sha1=...)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub expect_out: Vec<String>,
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
    // Native-only authoring conveniences (serde/ts skip keeps them off the
    // wasm wire + generated TS; the webapp has its own bundle export).
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "emit-bundle",
            value_name = "PATH",
            help = "Also write a rom-weaver-bundle.json describing this apply (input rom + ordered patches + computed checks)"
        )
    )]
    #[serde(skip)]
    #[cfg_attr(feature = "typescript-types", ts(skip))]
    pub emit_bundle: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "tui",
            help = "Interactively fill in bundle metadata (needs a terminal), then apply and write rom-weaver-bundle.json"
        )
    )]
    #[serde(skip)]
    #[cfg_attr(feature = "typescript-types", ts(skip))]
    pub tui: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = "Thread budget: auto or a positive integer"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[cfg(not(target_arch = "wasm32"))]
impl PatchApplyCommand {
    /// Expand positional `--patch-header` occurrences into one mode per `--patch`.
    /// Each occurrence applies to the most recent preceding `--patch` and carries
    /// forward until the next occurrence; an occurrence before any `--patch` (or a
    /// run with only discovered sidecar patches) applies to every patch. Clap's
    /// parsed `Vec` loses the interleave order, so this re-derives it from the
    /// argv indices of the raw matches.
    pub fn align_patch_header_modes(&mut self, matches: &clap::ArgMatches) {
        if self.patch_header.is_empty() {
            return;
        }
        let modes = std::mem::take(&mut self.patch_header);
        let mode_indices: Vec<usize> = matches
            .indices_of("patch_header")
            .map(Iterator::collect)
            .unwrap_or_default();
        let patch_indices: Vec<usize> = matches
            .indices_of("patches")
            .map(Iterator::collect)
            .unwrap_or_default();
        if patch_indices.is_empty() || mode_indices.len() != modes.len() {
            // No explicit --patch flags (sidecar discovery): the last given mode
            // applies to every discovered patch via the carry-forward lookup.
            self.patch_header = modes
                .last()
                .copied()
                .map(|mode| vec![mode])
                .unwrap_or_default();
            return;
        }
        let mut resolved = Vec::with_capacity(patch_indices.len());
        for position in 0..patch_indices.len() {
            let next_patch_index = patch_indices
                .get(position + 1)
                .copied()
                .unwrap_or(usize::MAX);
            let mode = mode_indices
                .iter()
                .zip(&modes)
                .filter(|(index, _)| **index < next_patch_index)
                .map(|(_, mode)| *mode)
                .next_back()
                .unwrap_or_default();
            resolved.push(mode);
        }
        trace!(modes = ?resolved, "aligned positional --patch-header occurrences per patch");
        self.patch_header = resolved;
    }

    /// Bind each `--patch-basis` occurrence to the most recent preceding
    /// `--patch` and rewrite the vector index-aligned with `patches` (the
    /// wasm path sends it index-aligned already).
    pub fn align_patch_basis(&mut self, matches: &clap::ArgMatches) {
        if self.patch_basis.is_empty() {
            return;
        }
        let patch_indices: Vec<usize> = matches
            .indices_of("patches")
            .map(Iterator::collect)
            .unwrap_or_default();
        if patch_indices.is_empty() {
            return;
        }
        let patch_position = |value_index: usize| -> usize {
            patch_indices
                .partition_point(|patch_index| *patch_index < value_index)
                .saturating_sub(1)
        };
        let values = std::mem::take(&mut self.patch_basis);
        let indices: Vec<usize> = matches
            .indices_of("patch_basis")
            .map(Iterator::collect)
            .unwrap_or_default();
        self.patch_basis = bind_per_patch(
            values,
            indices,
            patch_indices.len(),
            PatchBasisMode::Auto,
            &patch_position,
        );
        trace!(basis = ?self.patch_basis, "aligned positional --patch-basis occurrences per patch");
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PatchValidateCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long,
            value_name = "PATH",
            help = "ROM or container input against which patches are validated"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
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
            long = "filter",
            value_enum,
            value_delimiter = ',',
            help = "Keep only payload candidates of the given class while resolving patch validation input/patch archives: rom, patch, or both (repeatable, comma-separable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
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
            long = "assume-in",
            value_name = "ALGO=HEX",
            value_delimiter = ',',
            value_parser = crate::expect_tokens::validate_expect_token,
            help = "Provide trusted effective patch input checksum values so validation skips recomputing them; repeat or comma-separate for multiple algorithms (for example: --assume-in crc32=1234abcd)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub assume_in: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "expect-in",
            value_name = "ALGO=HEX",
            value_delimiter = ',',
            value_parser = crate::expect_tokens::validate_expect_token,
            help = "Validate the effective patch input before preflight; ALGO=HEX checksum and/or size=N / min-size=N tokens (repeatable, comma-separable, for example: --expect-in crc32=1234abcd,size=1048576)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub expect_in: Vec<String>,
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
            help = "N64 byte order before patch validation: auto (default; match the patch source CRC32), keep, big-endian, little-endian, or byte-swapped"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub n64_byte_order: Option<PatchN64ByteOrderMode>,
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Validate each --patch independently against the original input (no sequential chaining); report a per-patch verdict and never abort the batch on a single failing patch"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub independent: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Resolve every patch's input basis and chain order statically and report a typed verification plan; runs preflight only for patches that consume the original input"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub plan: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-basis",
            value_enum,
            help = "What the preceding --patch's input checks were authored against: auto (infer from checksums), base (the original ROM), or previous (the prior patch's output); binds to the most recent --patch"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_basis: Vec<PatchBasisMode>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-input-check",
            value_name = "ALGO=HEX",
            help = "Declared input checks for the preceding --patch (comma-separable ALGO=HEX tokens; empty skips); binds to the most recent --patch"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_input_check: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-output-check",
            value_name = "ALGO=HEX",
            help = "Declared output checks for the preceding --patch (comma-separable ALGO=HEX tokens; empty skips); binds to the most recent --patch"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_output_check: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = "Thread budget: auto or a positive integer"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

/// Bind positional flag occurrences to their patch positions, producing an
/// index-aligned vector (`default` fills unbound positions). Shared by the
/// per-patch flag aligners.
#[cfg(not(target_arch = "wasm32"))]
fn bind_per_patch<T: Clone>(
    values: Vec<T>,
    indices: Vec<usize>,
    count: usize,
    default: T,
    patch_position: &impl Fn(usize) -> usize,
) -> Vec<T> {
    let mut aligned = vec![default; count];
    if indices.len() == values.len() {
        for (occurrence, value_index) in indices.into_iter().enumerate() {
            aligned[patch_position(value_index)] = values[occurrence].clone();
        }
    }
    aligned
}

#[cfg(not(target_arch = "wasm32"))]
impl PatchValidateCommand {
    /// Bind each per-patch plan flag occurrence to the most recent preceding
    /// `--patch` and rewrite the vectors index-aligned with `patches` (the
    /// wasm path sends them index-aligned already). Clap's parsed `Vec`s lose
    /// the interleave order, so this re-derives it from raw argv indices.
    pub fn align_plan_flags(&mut self, matches: &clap::ArgMatches) {
        if self.patch_basis.is_empty()
            && self.patch_input_check.is_empty()
            && self.patch_output_check.is_empty()
        {
            return;
        }
        let patch_indices: Vec<usize> = matches
            .indices_of("patches")
            .map(Iterator::collect)
            .unwrap_or_default();
        if patch_indices.is_empty() {
            return;
        }
        let count = patch_indices.len();
        let patch_position = |value_index: usize| -> usize {
            patch_indices
                .partition_point(|patch_index| *patch_index < value_index)
                .saturating_sub(1)
        };
        if !self.patch_basis.is_empty() {
            let values = std::mem::take(&mut self.patch_basis);
            let indices: Vec<usize> = matches
                .indices_of("patch_basis")
                .map(Iterator::collect)
                .unwrap_or_default();
            self.patch_basis = bind_per_patch(
                values,
                indices,
                count,
                PatchBasisMode::Auto,
                &patch_position,
            );
        }
        if !self.patch_input_check.is_empty() {
            let values = std::mem::take(&mut self.patch_input_check);
            let indices: Vec<usize> = matches
                .indices_of("patch_input_check")
                .map(Iterator::collect)
                .unwrap_or_default();
            self.patch_input_check =
                bind_per_patch(values, indices, count, String::new(), &patch_position);
        }
        if !self.patch_output_check.is_empty() {
            let values = std::mem::take(&mut self.patch_output_check);
            let indices: Vec<usize> = matches
                .indices_of("patch_output_check")
                .map(Iterator::collect)
                .unwrap_or_default();
            self.patch_output_check =
                bind_per_patch(values, indices, count, String::new(), &patch_position);
        }
        trace!(
            basis = ?self.patch_basis,
            input_checks = ?self.patch_input_check,
            output_checks = ?self.patch_output_check,
            "aligned positional plan flags per patch"
        );
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PatchCreateCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            value_name = "PATH",
            help = "Original ROM from which to create the patch"
        )
    )]
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
            short = 'f',
            long,
            help = "Patch format (derived from the output extension when omitted; required when the output has no recognizable patch extension)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub format: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
            long,
            value_name = "PATH",
            help = "Output patch path; optional only with --plan"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long, help = "Only return recommended formats; do not create a patch")
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub plan: bool,
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
            long = "assume-in",
            value_name = "ALGO=HEX",
            value_delimiter = ',',
            value_parser = crate::expect_tokens::validate_expect_token,
            help = "Trusted checksum(s) of the original ROM; with --checksum-name the crc32 value is embedded without re-reading the original (for example: --assume-in crc32=1234abcd)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub assume_in: Vec<String>,
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = "Thread budget: auto or a positive integer"
        )
    )]
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

/// Compute a memory-/thread-aware concurrent extraction schedule from per-job source sizes, without
/// touching any files. The result (an `extract_batch_plan` in the report details) groups the jobs
/// into concurrent waves with a per-job thread allotment, so the host can run a batch of extractions
/// at a safe concurrency for the device. Pure planning - no I/O - so it runs the same on native and
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = "Thread budget: auto or a positive integer"
        )
    )]
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct BundleParseCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "input",
            value_name = "INPUT",
            help = "Bundle file or archive containing a root bundle"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "select",
            help = "Resolve/extract only bundle entries whose file name matches this exact name, prefix, or glob (repeatable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "filter",
            value_enum,
            value_delimiter = ',',
            help = "Resolve/extract only bundle entries of the given class: rom, patch, or both (repeatable, comma-separable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Report the bundle structure without extracting archive members (path entries stay unresolved)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
            long = "output",
            value_name = "DIR",
            help = "Extract bundle-referenced archive members into this directory (path entries stay unresolved without it when the source is an archive)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = "Thread budget: auto or a positive integer"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

/// One normalized `bundle create` patch entry, bound from the per-patch
/// metadata flags (native argv alignment) or from index-aligned vectors on
/// the wasm JSON path.
#[derive(Clone, Debug, Default)]
pub struct BundleCreatePatchSpec {
    pub path: PathBuf,
    pub id: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub label: Option<String>,
    pub optional: Option<bool>,
    /// Emitted `url` source override for the entry.
    pub source_url: Option<String>,
    pub header: Option<PatchApplyHeaderMode>,
    /// Emitted `basis` for the entry (`None` omits the field).
    pub basis: Option<PatchInputBasis>,
    /// Expected pre-apply ROM checksums for this entry (`algo=hex` tokens),
    /// emitted as the entry's `inputChecks` when they differ from the rom's.
    pub input_checks: Vec<String>,
    /// Expected post-apply ROM checksums for this entry, emitted as the
    /// entry's `outputChecks` when they differ from the bundle's final
    /// `output.checks`.
    pub output_checks: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct BundleCreateCommand {
    // Field/wire name stays `rom` (the bundle's rom entry); only the CLI flag
    // mirrors apply's `-i/--input` so the webapp wasm wire is untouched.
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "input",
            value_name = "INPUT",
            help = "Local ROM file the patch chain applies to; its checksums/size become the bundle's rom checks"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub rom: Option<PathBuf>,
    /// Trusted ROM checksum/size values from a prior staging pass, so bundle
    /// export skips re-hashing the same prepared leaf. `algo=hex` tokens supply
    /// the emitted rom checks; a `size=N` token supplies the prepared size.
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "assume-in",
            value_name = "ALGO=HEX",
            value_delimiter = ',',
            value_parser = crate::expect_tokens::validate_expect_token,
            help = "Trusted rom checksum(s) and/or size for the bundle's rom checks, skipping recompute (for example: --assume-in crc32=1234abcd,size=1048576)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub assume_in: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "rom-url",
            help = "Emitted rom download url (combined with --rom the local file still supplies checks; alone it emits a url-only rom entry)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub rom_url: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "rom-name",
            help = "Display/output-naming file name for the rom entry"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub rom_name: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch",
            help = "Patch file to include, in apply order; repeat --patch for each entry. --patch-id, --patch-version, --patch-author, --patch-name, --patch-description, --patch-label, --patch-optional, --patch-source-url, and --patch-header bind to the preceding --patch"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long = "patch-id", help = "Stable identity for the preceding --patch")
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_id: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-version",
            help = "Author-controlled version for the preceding --patch"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_version: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long = "patch-name", help = "Display name for the preceding --patch")
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_name: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-description",
            help = "Description for the preceding --patch"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_description: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-author",
            help = "Author credit for the preceding --patch"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_author: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-label",
            help = "Free-form maturity or status label for the preceding --patch"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_label: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-optional",
            help = "Set whether the preceding --patch is optional; optional patches are deselected by default"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_optional: Vec<bool>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-source-url",
            help = "Emitted url source for the preceding --patch (the local file is still read for the bundle)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_source_url: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-header",
            value_enum,
            help = "Header handling mode for the preceding --patch"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_header: Vec<PatchApplyHeaderMode>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-basis",
            value_enum,
            help = "What the preceding --patch's input checks were authored against: base (the bundle's rom) or previous (the prior patch's output, the default); auto omits the field for inference"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_basis: Vec<PatchBasisMode>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-expect-in",
            value_name = "ALGO=HEX",
            help = "Expected pre-apply ROM checksum for the preceding --patch (algo=hex; repeatable and comma-separable); emitted as inputChecks only when it differs from the rom checks. On the wasm path this is index-aligned with --patch (one comma-separated value per entry, empty for none)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_input_check: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-expect-out",
            value_name = "ALGO=HEX",
            help = "Expected post-apply ROM checksum for the preceding --patch (algo=hex; repeatable and comma-separable); emitted as outputChecks only when it differs from the final output checks"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_output_check: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "expect-out",
            value_name = "ALGO=HEX",
            help = "Expected checksum of the final output once the full patch chain is applied (algo=hex; repeatable and comma-separable); emitted as output.checks"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub output_check: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "output-name",
            help = "Default output file name the bundle suggests"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output_name: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "output-header",
            value_enum,
            help = "Default header handling mode for the final bundle output"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output_header: Option<PatchApplyOutputHeaderMode>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
            long,
            help = "Where to write the bundle: rom-weaver-bundle.json, or rom-weaver-bundle.json.gz / rom-weaver-bundle.json.zst for a compressed one"
        )
    )]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Also bundle the bundle plus the local rom/patch files into this archive (creatable formats only, for example .zip); bundle path entries then reference the archived names"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub bundle: Option<PathBuf>,
    /// Optional packaged ROM payload. Checks are still calculated from `rom`.
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "bundle-rom",
            help = "ROM payload to package in --bundle while --rom supplies its checks and metadata"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub bundle_rom: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-bundle-rom",
            help = "Don't distribute the local --rom: leave it out of --bundle and emit its bundle entry with checks only (the applying user supplies the ROM)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_bundle_rom: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum",
            help = "Checksum algorithm(s) for rom checks (repeatable; default crc32, md5, sha1)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub checksum: Vec<String>,
    // Native-only authoring front door: read a hand-authored bundle spec (a
    // RomWeaverBundle with local `path`s and optional/omitted checks) and bake
    // it into the canonical checksummed bundle. `serde(skip)`/`ts(skip)` keep
    // it off the wasm wire and out of the generated TS types (the webapp builds
    // the command directly). `-` reads the spec from stdin.
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "from",
            value_name = "FILE",
            help = "Author the bundle from a rom-weaver-bundle.json spec (local paths, checksums filled in for you); - reads the spec from stdin. Explicit flags override spec values"
        )
    )]
    #[serde(skip)]
    #[cfg_attr(feature = "typescript-types", ts(skip))]
    pub from: Option<PathBuf>,
    // Native-only: stamp a `$schema` reference into the emitted bundle so
    // editors bind validation. Never auto-set (would change output bytes).
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "schema-ref",
            value_name = "URL",
            help = "Write this $schema URL into the emitted bundle for editor validation"
        )
    )]
    #[serde(skip)]
    #[cfg_attr(feature = "typescript-types", ts(skip))]
    pub schema_ref: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = "Thread budget: auto or a positive integer"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
    /// Normalized per-patch specs; filled natively by argv alignment, and on
    /// the wasm path from the index-aligned metadata vectors.
    #[cfg_attr(not(target_arch = "wasm32"), arg(skip))]
    #[serde(skip)]
    #[cfg_attr(feature = "typescript-types", ts(skip))]
    pub patch_specs: Vec<BundleCreatePatchSpec>,
}

#[cfg(not(target_arch = "wasm32"))]
impl BundleCreateCommand {
    /// Bind each per-patch metadata occurrence to the most recent preceding
    /// `--patch` (clap's parsed `Vec`s lose the interleave order, so this
    /// re-derives it from the raw argv indices). The last occurrence bound to
    /// a patch wins; an occurrence before any `--patch` binds to the first.
    pub fn align_bundle_patch_metadata(&mut self, matches: &clap::ArgMatches) {
        let patch_indices: Vec<usize> = matches
            .indices_of("patch")
            .map(Iterator::collect)
            .unwrap_or_default();
        if patch_indices.is_empty() {
            return;
        }
        let mut specs: Vec<BundleCreatePatchSpec> = self
            .patch
            .iter()
            .map(|path| BundleCreatePatchSpec {
                path: path.clone(),
                ..BundleCreatePatchSpec::default()
            })
            .collect();
        let patch_position = |value_index: usize| -> usize {
            patch_indices
                .partition_point(|patch_index| *patch_index < value_index)
                .saturating_sub(1)
        };
        let bind = |specs: &mut Vec<BundleCreatePatchSpec>,
                    id: &str,
                    count: usize,
                    assign: &mut dyn FnMut(&mut BundleCreatePatchSpec, usize)| {
            let indices: Vec<usize> = matches
                .indices_of(id)
                .map(Iterator::collect)
                .unwrap_or_default();
            if indices.len() != count {
                return;
            }
            for (occurrence, value_index) in indices.into_iter().enumerate() {
                let position = patch_position(value_index);
                assign(&mut specs[position], occurrence);
            }
        };
        let ids = self.patch_id.clone();
        bind(&mut specs, "patch_id", ids.len(), &mut |spec, index| {
            spec.id = Some(ids[index].clone());
        });
        let versions = self.patch_version.clone();
        bind(
            &mut specs,
            "patch_version",
            versions.len(),
            &mut |spec, index| {
                spec.version = Some(versions[index].clone());
            },
        );
        let names = self.patch_name.clone();
        bind(&mut specs, "patch_name", names.len(), &mut |spec, index| {
            spec.name = Some(names[index].clone());
        });
        let descriptions = self.patch_description.clone();
        bind(
            &mut specs,
            "patch_description",
            descriptions.len(),
            &mut |spec, index| {
                spec.description = Some(descriptions[index].clone());
            },
        );
        let authors = self.patch_author.clone();
        bind(
            &mut specs,
            "patch_author",
            authors.len(),
            &mut |spec, index| {
                spec.author = Some(authors[index].clone());
            },
        );
        let labels = self.patch_label.clone();
        bind(
            &mut specs,
            "patch_label",
            labels.len(),
            &mut |spec, index| {
                spec.label = Some(labels[index].clone());
            },
        );
        let optionals = self.patch_optional.clone();
        bind(
            &mut specs,
            "patch_optional",
            optionals.len(),
            &mut |spec, index| {
                spec.optional = Some(optionals[index]);
            },
        );
        let source_urls = self.patch_source_url.clone();
        bind(
            &mut specs,
            "patch_source_url",
            source_urls.len(),
            &mut |spec, index| {
                spec.source_url = Some(source_urls[index].clone());
            },
        );
        let headers = self.patch_header.clone();
        bind(
            &mut specs,
            "patch_header",
            headers.len(),
            &mut |spec, index| {
                spec.header = Some(headers[index]);
            },
        );
        let bases = self.patch_basis.clone();
        bind(
            &mut specs,
            "patch_basis",
            bases.len(),
            &mut |spec, index| {
                spec.basis = bases[index].declared();
            },
        );
        // Checks accumulate (a patch may pin several algorithms) instead of
        // last-occurrence-wins like the scalar metadata above.
        let input_checks = self.patch_input_check.clone();
        bind(
            &mut specs,
            "patch_input_check",
            input_checks.len(),
            &mut |spec, index| {
                spec.input_checks.push(input_checks[index].clone());
            },
        );
        let output_checks = self.patch_output_check.clone();
        bind(
            &mut specs,
            "patch_output_check",
            output_checks.len(),
            &mut |spec, index| {
                spec.output_checks.push(output_checks[index].clone());
            },
        );
        self.patch_specs = specs;
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PpfUndoCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "input",
            value_name = "ROM",
            help = "ROM produced by applying the PPF patch"
        )
    )]
    pub rom: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch",
            value_name = "PPF",
            help = "PPF3 patch containing undo data"
        )
    )]
    pub patch: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short,
            long,
            value_name = "PATH",
            help = "Output path for the restored ROM"
        )
    )]
    pub output: PathBuf,
}
