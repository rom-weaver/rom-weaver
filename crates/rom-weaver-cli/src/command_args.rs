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

impl TrimCommand {
    /// `--filter rom` (the default) and the older no-value `--no-filter` both
    /// feed one answer: whether archive entries are narrowed to ROM-looking
    /// names.
    pub fn rom_filter_enabled(&self) -> bool {
        self.rom_filter
            && self
                .filter
                .iter()
                .any(|kind| matches!(kind, FilterKind::Rom))
    }
}

/// `patch apply` and its top-level `weave` spelling are the same command, so
/// they share one set of help strings. Without this the alias would show a
/// shorter help than the command it aliases.
pub const PATCH_APPLY_ABOUT: &str = "Apply one or more patches to a ROM, in order";

pub const PATCH_APPLY_LONG_ABOUT: &str = "\
Apply one or more patches to a ROM, in order.

Use `rom-weaver patch apply` for the canonical command. The compatibility
spelling `rom-weaver weave` runs the same command.

Repeat --patch once per patch. They run left to right, each one on the result
of the last. --input takes a plain ROM, an archive, or a single-payload
compressed format (the ROM inside is found for you), or a
rom-weaver-bundle.json that already names the ROM, the patches, and the
output.

When --output names the selected ROM leaf's extension, rom-weaver writes a
plain ROM. A registered container extension such as .zip compresses the result.
Pass --no-compress (or --raw) to force a plain ROM, or use --compress-format,
--compress-codec, and --compress-level (also accepted as --format, --codec,
and --level) to force compression. Without --output, an ordinary file apply
writes a collision-safe sibling named <stem>-patched.<ext>.

Patch formats: IPS, IPS32, SOLID, BPS, UPS, VCDIFF, xdelta, GDIFF,
HDiffPatch/HPatchZ, APS (N64), APSGBA, RUP, PPF, PAT/FFP, EBP, BDF/BSDIFF40,
BSP, MOD/PMSR, DLDI, DPS, and DCP (Dreamcast).

Not supported: PDS; NINJA1 (recognized, but cannot be applied); HDiffPatch
directory patches, HDIFF19 (single-file .hdiff and .hpatchz are fine).

DCP needs a Dreamcast .cue or .gdi input. It rebuilds the whole disc, so it
cannot be combined with other patches or with the header and checksum options.";

pub const PATCH_APPLY_AFTER_HELP: &str = "\
Example:
  rom-weaver patch apply -i game.sfc --patch hack.bps -o hacked.sfc";

/// Shared wording for the archive-lookup flags. Every command that can reach
/// inside a container takes the same four, so they read the same everywhere.
#[cfg(not(target_arch = "wasm32"))]
pub const SELECT_HELP: &str =
    "Pick which file inside the archive to use, by exact name, prefix, or glob (repeatable)";

#[cfg(not(target_arch = "wasm32"))]
pub const FILTER_HELP: &str = "Consider only files that look like a rom or a patch, judged by extension (repeatable, comma-separable)";

#[cfg(not(target_arch = "wasm32"))]
pub const NO_IGNORE_HELP: &str = "Also consider files normally skipped inside archives: readmes, images, checksum sidecars, and OS clutter such as .DS_Store";

#[cfg(not(target_arch = "wasm32"))]
pub const THREADS_HELP: &str =
    "How many threads to use at most. auto uses every core; a format may still use fewer";

/// `compress` and `patch apply` both choose an output container, so the format
/// and codec flags say the same thing in both places.
#[cfg(not(target_arch = "wasm32"))]
pub const FORMAT_HELP: &str =
    "Output format, such as zip, 7z, chd, rvz, or z3ds [default: from the --output extension]";

#[cfg(not(target_arch = "wasm32"))]
pub const FORMAT_LONG_HELP: &str = "\
Output format, such as zip, 7z, chd, rvz, or z3ds.

Normally you do not need this: the format comes from the --output extension.
Pass it when the output name has no usable extension. If it disagrees with the
extension, this flag wins and a warning is printed.

Common alternate spellings are accepted, so `7zip` works as well as `7z` and
`3ds` as well as `z3ds`. The CLI guide lists every alias.";

#[cfg(not(target_arch = "wasm32"))]
pub const CODEC_HELP: &str =
    "Compression method to use, as codec or codec:level (repeatable, comma-separable)";

#[cfg(not(target_arch = "wasm32"))]
pub const CODEC_LONG_HELP: &str = "\
Compression method to use, written as codec or codec:level.

Each format has its own codecs, and each picks a sensible one on its own, so
this is only for overriding that choice. CHD takes a list, tried in order:

  --codec cdzs:19,cdzl,cdfl

Without :level, a codec follows the --level profile.

Only the codec names a format actually supports are accepted; there are no
cross-format synonyms. The CLI guide lists them per format.";

/// `--assume-in` means the same thing on apply, validate, and create: trust
/// this checksum rather than reading the file to compute it.
#[cfg(not(target_arch = "wasm32"))]
pub const ASSUME_IN_HELP: &str = "Take this checksum on trust instead of reading the ROM to compute it, as in crc32=1234abcd (repeatable, comma-separable)";

#[cfg(not(target_arch = "wasm32"))]
pub const ASSUME_IN_LONG_HELP: &str = "\
Take this checksum on trust instead of reading the ROM to compute it, as in
crc32=1234abcd. Repeatable and comma-separable.

This is a speed option for scripts that already know the checksum: it skips a
full read of a large ROM. It does not verify anything. To check a ROM against a
checksum, use --expect-in.";

/// Advertises the create-capable container formats to help and shell
/// completions without taking over validation: an extract-only or unknown name
/// still reaches the handler, which explains *why* it cannot be written
/// (extract-only vs not registered). A hard possible-value check here would
/// replace those with a bare "invalid value".
#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone)]
pub struct CreateFormatValueParser;

#[cfg(not(target_arch = "wasm32"))]
impl clap::builder::TypedValueParser for CreateFormatValueParser {
    type Value = String;

    fn parse_ref(
        &self,
        cmd: &clap::Command,
        _arg: Option<&clap::Arg>,
        value: &std::ffi::OsStr,
    ) -> std::result::Result<Self::Value, clap::Error> {
        value.to_str().map(str::to_string).ok_or_else(|| {
            clap::Error::raw(
                clap::error::ErrorKind::InvalidUtf8,
                "format names must be valid UTF-8\n",
            )
            .with_cmd(cmd)
        })
    }

    fn possible_values(
        &self,
    ) -> Option<Box<dyn Iterator<Item = clap::builder::PossibleValue> + '_>> {
        Some(Box::new(
            rom_weaver_containers::container_format_metadata()
                .into_iter()
                .filter(|format| format.capabilities.create)
                .map(|format| {
                    format.aliases.iter().fold(
                        clap::builder::PossibleValue::new(format.name),
                        |value, alias| value.alias(*alias),
                    )
                })
                .collect::<Vec<_>>()
                .into_iter(),
        ))
    }
}

/// A `--codec` value is `codec` or `codec:level`. The registry values are
/// exposed for help and shell completion, while the format handler retains
/// validation so JSON operation errors use the normal command envelope.
/// Wrapping [`clap::builder::PossibleValuesParser`] keeps completion names
/// discoverable without turning invalid values into clap parse failures.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone)]
pub struct CodecValueParser;

#[cfg(not(target_arch = "wasm32"))]
impl clap::builder::TypedValueParser for CodecValueParser {
    type Value = String;

    fn parse_ref(
        &self,
        cmd: &clap::Command,
        _arg: Option<&clap::Arg>,
        value: &std::ffi::OsStr,
    ) -> std::result::Result<Self::Value, clap::Error> {
        let raw = value.to_str().ok_or_else(|| {
            clap::Error::raw(
                clap::error::ErrorKind::InvalidUtf8,
                "codec values must be valid UTF-8\n",
            )
            .with_cmd(cmd)
        })?;
        Ok(raw.to_string())
    }

    fn possible_values(
        &self,
    ) -> Option<Box<dyn Iterator<Item = clap::builder::PossibleValue> + '_>> {
        Some(Box::new(
            compression_metadata()
                .codecs
                .iter()
                .map(|codec| {
                    codec.aliases.iter().fold(
                        clap::builder::PossibleValue::new(codec.name),
                        |value, alias| value.alias(*alias),
                    )
                })
                .collect::<Vec<_>>()
                .into_iter(),
        ))
    }
}

/// clap's possible-value set for a plain checksum-algorithm argument, taken
/// straight from the checksum registry so help, completions, and did-you-mean
/// track the real list.
#[cfg(not(target_arch = "wasm32"))]
fn checksum_algorithm_parser() -> clap::builder::PossibleValuesParser {
    clap::builder::PossibleValuesParser::new(supported_algorithms())
}

#[cfg(not(target_arch = "wasm32"))]
pub const CHECKSUM_ALGO_HELP: &str = "Which checksum to compute (repeatable, comma-separable)";

/// The `--patch-*` metadata flags on `bundle create` all bind positionally to
/// the `--patch` before them, so every one of them repeats the same rule. This
/// appends it to the flag's own long help.
#[cfg(not(target_arch = "wasm32"))]
macro_rules! patch_adjacency_long_help {
    ($help:literal) => {
        concat!(
            $help,
            "\n\nThis flag must follow the --patch it describes. Give it once per --patch, ",
            "in the same order, or leave it out entirely - a partial list is an error. ",
            "An occurrence before any --patch has nothing to bind to.\n\n  ",
            "--patch a.bps --patch-name \"First\" --patch b.ups --patch-name \"Second\""
        )
    };
}

const fn default_true() -> bool {
    true
}

/// `trim` filters to ROM-looking files by default; its siblings default to no
/// filter at all.
fn default_rom_filter_kinds() -> Vec<FilterKind> {
    vec![FilterKind::Rom]
}

fn default_checksum_algorithms() -> Vec<String> {
    ["crc32", "md5", "sha1"]
        .into_iter()
        .map(String::from)
        .collect()
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
            help = "File to identify. Use - to read from stdin"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "select",
            help = SELECT_HELP
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
            help = FILTER_HELP
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long, help = "Do not look inside archives; identify the file itself")
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, help = NO_IGNORE_HELP))]
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
            help = "Archive or single-payload compressed format to unpack"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "select",
            help = "Extract only these files, by exact name, prefix, or glob (repeatable). For example: --select 'game.disc0?.bin'"
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
            help = "Extract only files that look like a rom or a patch, judged by extension (repeatable, comma-separable)"
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
            help = "Directory to write the extracted files into"
        )
    )]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Write a CD-format CHD as a CUE plus one BIN per track (*.trackNN.bin), rather than one merged BIN"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub split_bin: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, help = NO_IGNORE_HELP))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-nested-extract",
            help = "Stop after one layer; leave any archive found inside the input packed"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_nested_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "force",
            help = "Overwrite files already in the output directory (without this, extraction stops instead)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub force: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum",
            visible_alias = "algo",
            value_name = "ALGO",
            value_delimiter = ',',
            ignore_case = true,
            value_parser = checksum_algorithm_parser(),
            help = "Also hash every extracted file (repeatable, comma-separable)"
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
            ignore_case = true,
            conflicts_with = "checksum",
            value_parser = checksum_algorithm_parser(),
            help = "Like --checksum, but hash only the ROMs and skip sidecar files. Cannot be combined with --checksum"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub checksum_rom: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Also report the format and platform of what was extracted, and fail if a lone payload matches no known platform"
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
            help = THREADS_HELP
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
            help = "File to hash. Use - to read from stdin"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'a',
            long = "algo",
            visible_alias = "checksum",
            default_values_t = default_checksum_algorithms(),
            value_name = "ALGO",
            value_delimiter = ',',
            ignore_case = true,
            value_parser = checksum_algorithm_parser(),
            help = CHECKSUM_ALGO_HELP
        )
    )]
    #[serde(default = "default_checksum_algorithms")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub algo: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "select",
            help = SELECT_HELP
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
            help = FILTER_HELP
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long, help = "Do not look inside archives; hash the file itself")
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, help = NO_IGNORE_HELP))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Skip the extra checksums computed for how a trimmable ROM would hash trimmed or untrimmed"
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
            help = "Start hashing at this byte offset, counting from 0"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub start: Option<u64>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            value_name = "BYTES",
            help = "How many bytes to hash from --start. Defaults to the rest of the file"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub length: Option<u64>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Also report the platform of the hashed bytes, and fail if it matches no known platform"
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
            help = THREADS_HELP
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'i',
            long = "input",
            value_name = "INPUT",
            help = "ROM to identify. Use - to read from stdin"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub input: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "hash",
            value_name = "HEX",
            help = "Identify by a checksum instead of a file; accepts crc32/md5/sha1 hex"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub hash: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'd',
            long = "database",
            value_name = "PACK",
            help = "RWFP4 identify pack to search instead of the built-in data (repeatable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub database: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "system",
            value_name = "SYSTEM",
            help = "Search only this system's pack. Takes a canonical platform name or a common alias (e.g. `snes`, `psx`)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub system: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Assert that identify performs no network access (it never does natively; this flag records the guarantee)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub offline: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "database-dir",
            value_name = "DIR",
            help = "Directory of installed identify packs (*.pack plus optional catalog.json). Defaults to the per-user data directory"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub database_dir: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "exhaustive-database-search",
            help = "Search every installed pack instead of only the packs the detected platform routes to"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub exhaustive_database_search: bool,
    #[cfg_attr(not(target_arch = "wasm32"), command(subcommand))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub subcommand: Option<IdentifySubcommands>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(short = 's', long = "select", help = SELECT_HELP))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long = "filter", value_enum, value_delimiter = ',', help = FILTER_HELP)
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long, help = "Do not look inside archives; identify the file itself")
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, help = NO_IGNORE_HELP))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Skip extra checksums for trimmed and untrimmed ROM forms"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_trim_fix: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = THREADS_HELP
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
            help = "File to sort into ROMs and patches"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
            long = "output",
            value_name = "DIR",
            help = "Directory to write anything unpacked along the way into"
        )
    )]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'd',
            long = "database",
            value_name = "PACK",
            action = ArgAction::Append,
            help = "RWFP4 identify pack to use for ROM titles (repeatable; native defaults to built-in data)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub database: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "select",
            help = "Pick which ROM to use when the archive holds more than one, by exact name, prefix, or glob (repeatable)"
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
            help = NO_IGNORE_HELP
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-nested-extract",
            help = "Stop after one layer; leave any archive found inside the input packed"
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
            help = "For a multi-track CD-format CHD, write one BIN per track (--split-bin) or one merged BIN (--split-bin false). Omit to be asked"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub split_bin: Option<bool>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum",
            visible_alias = "algo",
            value_name = "ALGO",
            value_delimiter = ',',
            ignore_case = true,
            value_parser = checksum_algorithm_parser(),
            help = "Which checksums to compute for each ROM found (repeatable, comma-separable) [default: crc32,md5,sha1]"
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
            help = THREADS_HELP
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
            help = "File to put in the archive; repeat for each one. For a disc image, pass the .cue or .gdi alone and its tracks come along"
        )
    )]
    pub input: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'f',
            long,
            ignore_case = true,
            value_parser = CreateFormatValueParser,
            help = FORMAT_HELP,
            long_help = FORMAT_LONG_HELP
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub format: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
            long,
            value_name = "PATH",
            help = "Where to write the archive"
        )
    )]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            action = ArgAction::Append,
            value_delimiter = ',',
            ignore_case = true,
            value_parser = CodecValueParser,
            help = CODEC_HELP,
            long_help = CODEC_LONG_HELP
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub codec: Vec<String>,
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long,
        value_enum,
        default_value_t = CompressionLevelProfile::Max,
        help = "How hard to compress: min, very-low, low, medium, high, very-high, or max"
    ))]
    #[serde(default = "default_max_compression_level")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub level: CompressionLevelProfile,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "force",
            help = "Overwrite the output if it already exists (without this, the command stops instead)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub force: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'n',
            long = "dry-run",
            help = "Print the plan (inputs, output, format, codec, level, threads) and stop without writing"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub dry_run: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'j',
            long,
            default_value = "auto",
            value_name = "auto|N",
            help = THREADS_HELP
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
            help = "File or folder to trim. Repeat for each one"
        )
    )]
    pub input: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'o',
            long,
            conflicts_with = "in_place",
            help = "Where to write the trimmed file. Only valid with a single trimmable input"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'e',
            long,
            help = "Save next to each original under this extension. {ext} stands for the original one, as in trim.{ext}"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub extension: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "in-place",
            help = "Overwrite the original instead of writing a new file"
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
            help = "Report what would be trimmed without writing anything"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub dry_run: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            visible_alias = "untrim",
            visible_alias = "restore",
            help = "Pad a trimmed file back to full size (NDS, GBA, and 3DS only)",
            long_help = "\
Pad a trimmed file back to full size. `--untrim` and `--restore` do the same
thing.

If the file carries a revert footer from an earlier --revert-marker run, the
original is restored byte for byte. Otherwise the size is worked out from the
ROM header (NDS and 3DS) or rounded up to the next power of two (GBA), which
usually matches but is not guaranteed to.

XISO and RVZ scrub cannot be reverted."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub revert: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long = "no-recursive",
        action = ArgAction::SetFalse,
        default_value_t = true,
        help = "When an input is a folder, look only at its top level"
    ))]
    #[serde(default = "default_true")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub recursive: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "filter",
            value_enum,
            value_delimiter = ',',
            default_value = "rom",
            help = FILTER_HELP
        )
    )]
    #[serde(default = "default_rom_filter_kinds")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
    /// `--filter` has no "off" value, so this stays the visible way to disable
    /// the ROM filter entirely (and keeps older scripts working).
    #[cfg_attr(not(target_arch = "wasm32"), arg(
        long = "no-filter",
        action = ArgAction::SetFalse,
        default_value_t = true,
        help = "Consider every file inside an archive, not just the ones that look like ROMs"
    ))]
    #[serde(default = "default_true")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub rom_filter: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Do not look inside archives; trim only the files named directly"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "revert-marker",
            visible_alias = "reversible",
            help = "Add a small footer recording what was cut, so --revert can restore the original exactly"
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
            help = THREADS_HELP
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "force",
            help = "Overwrite the output if it already exists (without this, the command stops instead)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub force: bool,
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
            help_heading = "Basic",
            help = "ROM to patch. May be an archive, a disc sheet (.cue/.gdi), or a bundle"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "select",
            help_heading = "Archive/bundle",
            help = "Pick which file to use when the ROM or a patch is inside an archive, by exact name, prefix, or glob (repeatable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub select: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "target",
            help_heading = "Archive/bundle",
            help = "For a .cue or .gdi input, which track gets the patch. Matched like --select and must hit exactly one track"
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
            help_heading = "Archive/bundle",
            help = FILTER_HELP
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help_heading = "Archive/bundle",
            help = "Do not look inside archives; treat the input and every patch as raw files"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long, help_heading = "Archive/bundle", help = NO_IGNORE_HELP)
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch",
            help_heading = "Basic",
            help = "Patch to apply. Repeat once per patch; they run in the order given",
            long_help = "\
Patch to apply. Repeat once per patch; they run in the order given, each on the
result of the last.

Leave it out and rom-weaver looks for RetroArch-style patches sitting next to
the ROM inside the input archive."
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
            help_heading = "Basic",
            help = "Where to write the patched ROM. Optional when a bundle already names the output"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "bundle",
            help_heading = "Archive/bundle",
            help = "Follow a rom-weaver-bundle.json recipe: a file path, or an http(s) URL",
            long_help = "\
Follow a rom-weaver-bundle.json recipe, which lists the patches, their order,
and the expected checksums. Takes a file path or an http(s) URL.

You can usually skip this flag. A bundle is picked up automatically when
--input is a rom-weaver-bundle.json (optionally .gz, .bz2, .xz, or .zst), or an
archive with one at its root, and you passed no --patch of your own."
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
            help_heading = "Archive/bundle",
            help = "Turn on a bundle patch the bundle leaves off by default, matched by name or file name (repeatable)"
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
            help_heading = "Archive/bundle",
            help = "Turn off a bundle patch, matched by name or file name (repeatable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub without_patches: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            visible_alias = "raw",
            help_heading = "Basic",
            help = "Write a plain ROM instead of compressing the result"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_compress: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "compress-format",
            ignore_case = true,
            value_parser = CreateFormatValueParser,
            visible_alias = "format",
            help_heading = "Basic",
            help = "Format to compress the patched ROM into [default: from the --output extension]",
            long_help = "\
Format to compress the patched ROM into, such as zip, 7z, chd, rvz, or z3ds.

Normally you do not need this: the format comes from the --output extension.
Pass it when the output name has no usable extension. If it disagrees with the
extension, this flag wins and a warning is printed. Use --no-compress to write
a plain ROM instead."
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub compress_format: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "compress-codec",
            visible_alias = "codec",
            action = ArgAction::Append,
            value_delimiter = ',',
            ignore_case = true,
            value_parser = CodecValueParser,
            help_heading = "Basic",
            help = CODEC_HELP,
            long_help = "\
Compression method for the patched ROM, written as codec or codec:level.

Each format has its own codecs, and each picks a sensible one on its own, so
this is only for overriding that choice. CHD takes a list, tried in order:

  --compress-codec cdzs:19,cdzl,cdfl

Without :level, a codec follows the --compress-level profile."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub compress_codec: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "compress-level",
            visible_alias = "level",
            value_enum,
            help_heading = "Basic",
            help = "How hard to compress: min, very-low, low, medium, high, very-high, or max [default: max]"
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
            help_heading = "Compatibility",
            help = ASSUME_IN_HELP,
            long_help = ASSUME_IN_LONG_HELP
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
            help_heading = "Compatibility",
            help = "Stop unless the ROM about to be patched has this checksum, as in crc32=1234abcd (repeatable, comma-separable)",
            long_help = "\
Stop unless the ROM about to be patched has this checksum, as in
crc32=1234abcd. Repeatable and comma-separable.

Use it when a patch's readme publishes a source checksum, to be sure you are
starting from the ROM the author used. The size gates size=N and min-size=N
work on `patch validate` only."
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
            help_heading = "Compatibility",
            help = "Whether a patch applies to the ROM with or without its copier header: auto, keep, or strip [default: auto]",
            long_help = "\
Whether a patch applies to the ROM with or without its copier header.

Some ROMs carry a small header added by old copier hardware, and a patch may
have been made either with it or without it. Getting this wrong makes the patch
fail or produce a broken ROM.

  auto    Work it out per patch (the default). A patch carrying its own source
          checksum (BPS, UPS, RUP) settles it outright. A patch without one
          (IPS) is judged on where its records land, and if that is still
          unclear by applying it both ways and keeping the result the console
          still recognises as its own ROM. Any remaining doubt leaves the
          bytes alone.
  keep    Apply to the bytes as they are.
  strip   Remove the header first.

Repeatable, and each occurrence binds to the --patch before it and carries
forward until the next one:

  --patch a.bps --patch-header strip --patch b.ups   strips for both
  --patch a.bps --patch b.ups --patch-header strip   strips for b.ups only

An occurrence before any --patch applies to every patch.

Headers detected: A78, LNX, NES, FDS, and SMC signatures, plus the SNES and PCE
copier size rules."
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
            help_heading = "Compatibility",
            help = "Which ROM the preceding --patch was built against: auto, base, or previous [default: auto]",
            long_help = "\
Which ROM the preceding --patch was built against, and so which one its
checksums describe.

  auto      Work it out from the checksums (the default).
  base      The original ROM. It is verified once up front, and the patch's own
            checks are skipped when it runs later in the chain.
  previous  The output of the patch before it.

Reach for this when several patches in a chain were each written against the
unmodified ROM rather than against each other.

This flag must follow the --patch it describes; it binds to the most recent
--patch and carries forward until the next occurrence. An occurrence before any
--patch applies to every patch."
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
            help_heading = "Compatibility",
            help = "Whether the finished ROM keeps its copier header: auto, keep, or strip [default: auto]",
            long_help = "\
Whether the finished ROM keeps its copier header.

  auto   Keep headers emulators need (iNES, FDS, LNX, A78) and drop the ones
         they do not (SNES, PCE, Game Doctor). The default.
  keep   Put back a header that was stripped in order to patch.
  strip  Write a headerless ROM, removing the header if it is still there.

The chain produces one file, so this is a single setting; if repeated, the last
value wins.

When the header decision changes which extension is conventional, the output
extension follows (SNES .smc becomes headerless .sfc, for instance) and the
report says so. Extensions unrelated to headers are never touched."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output_header: Option<PatchApplyOutputHeaderMode>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help_heading = "Compatibility",
            help = "Recompute the ROM's internal header checksum afterwards, so the console does not reject it (SNES, NES, GB, GBA, Mega Drive, SMS, N64, NDS)"
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
            help_heading = "Compatibility",
            help = "Byte order to put an N64 ROM in for each patch: auto, keep, big-endian, little-endian, or byte-swapped [default: auto]",
            long_help = "\
Byte order to put an N64 ROM in before each patch runs.

N64 dumps circulate in three interleavings (.z64 big-endian, .v64 byte-swapped,
.n64 little-endian) and a patch only matches one of them.

  auto           Match whichever order the patch's source CRC32 names. The
                 default, and almost always right. For the first patch, one
                 that carries no checksum (IPS) falls back to the shape of its
                 changes; an order settled that way is named in the report.
  keep           Leave the ROM as it is.
  big-endian     Rewrite to .z64 order.
  little-endian  Rewrite to .n64 order.
  byte-swapped   Rewrite to .v64 order.

Repeatable, one per patch; a short list carries its last value forward. The
output is written back in the order the input arrived in."
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub n64_byte_order: Vec<PatchN64ByteOrderMode>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help_heading = "Compatibility",
            help = "Apply the patch even when its own checksums do not match. Can produce a broken ROM"
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
            help_heading = "Diagnostics/authoring",
            help = "Fail unless the patched ROM has this checksum, as in sha1=abc... (repeatable, comma-separable)"
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
            help_heading = "Diagnostics/authoring",
            help = "Game Genie or GameShark/Pro Action Replay code to bake into the ROM. Repeat for each code"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub codes: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "code-system",
            help_heading = "Diagnostics/authoring",
            help = "Console the --code values are for (nes, snes, genesis, gameboy, gba, psx), when the ROM header does not say"
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
            help_heading = "Diagnostics/authoring",
            help = "Which cheat scheme the --code values use: auto, game-genie, gameshark/par, or xploder"
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
            help_heading = "Diagnostics/authoring",
            help = "Also write a rom-weaver-bundle.json recording this run, so someone else can repeat it"
        )
    )]
    #[serde(skip)]
    #[cfg_attr(feature = "typescript-types", ts(skip))]
    pub emit_bundle: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "tui",
            help_heading = "Diagnostics/authoring",
            help = "Ask for each patch's name, version, and author, then apply and write a bundle. Needs a terminal"
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
            help_heading = "Performance",
            help = THREADS_HELP
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "force",
            help = "Overwrite the output if it already exists (without this, the command stops instead)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub force: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 'n',
            long = "dry-run",
            help = "Print the plan (inputs, patches, output, format, codec, level, threads) and stop without writing"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub dry_run: bool,
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
            help = "ROM to check the patches against. May be an archive"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "select",
            help = "Pick which file to use when the ROM or a patch is inside an archive, by exact name, prefix, or glob (repeatable)"
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
            help = FILTER_HELP
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Do not look inside archives; treat the input and every patch as raw files"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_extract: bool,
    #[cfg_attr(not(target_arch = "wasm32"), arg(long, help = NO_IGNORE_HELP))]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_ignore: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch",
            required = true,
            help = "Patch to check. Repeat once per patch; they are checked in the order given"
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
            help = ASSUME_IN_HELP,
            long_help = ASSUME_IN_LONG_HELP
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
            help = "Fail unless the ROM matches: a checksum (crc32=1234abcd), an exact size (size=N), or a floor (min-size=N). Repeatable, comma-separable"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub expect_in: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Remove the ROM's copier header before checking (A78, LNX, NES, FDS, SMC signatures, plus the SNES and PCE size rules)"
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
            help = "Byte order to put an N64 ROM in before checking: auto, keep, big-endian, little-endian, or byte-swapped [default: auto]"
        )
    )]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub n64_byte_order: Option<PatchN64ByteOrderMode>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Report a patch as usable even when its own checksums do not match"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub ignore_checksum_validation: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Check every patch against the original ROM rather than as a chain, and report a verdict for each instead of stopping at the first failure"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub independent: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Report the order the patches would run in and what each would be checked against, without reading the ROM more than needed"
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
            help = "Which ROM the preceding --patch was built against: auto, base, or previous [default: auto]"
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
            help = "Checksum the preceding --patch expects to see going in, when the patch does not carry one (comma-separable; empty means none)"
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
            help = "Checksum the preceding --patch should produce, when the patch does not carry one (comma-separable; empty means none)"
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
            help = THREADS_HELP
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
        arg(long, value_name = "PATH", help = "The unmodified ROM")
    )]
    pub original: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "The changed ROM. Leave out when using --code, which produces the changed ROM for you"
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
            help = "Patch format, such as bps, ips, or xdelta [default: from the --output extension]",
            long_help = "\
Patch format, such as bps, ips, or xdelta.

Normally you do not need this: the format comes from the --output extension, so
`--output hack.bps` writes a BPS patch. Pass it when the output name has no
recognizable patch extension.

Common alternate spellings are accepted, so `xdelta3` works as well as `xdelta`
and `bsdiff` as well as `bdf`. The CLI guide lists every alias."
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
            help = "Where to write the patch. Required unless --plan is used"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub output: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Only report which formats suit these two ROMs; write nothing"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub plan: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Write the patch even when the format's own consistency checks fail, and leave its checksums out"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub ignore_checksum_validation: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum-name",
            help = "Put the original ROM's crc32 in the patch file name, as [crc32:HEX]",
            long_help = "\
Put the original ROM's crc32 in the patch file name, as [crc32:HEX].

Formats like IPS carry no checksum of their own, so there is nothing to catch
the patch being applied to the wrong ROM. rom-weaver reads this token back on
apply and verifies the input, as long as the file name survives."
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
            help = "Take the original ROM's checksum on trust rather than reading the file, as in crc32=1234abcd (repeatable, comma-separable)"
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
            help = "Build the patch from a Game Genie or GameShark/Pro Action Replay code instead of a second ROM. Repeat for each code; cannot be used with --modified"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub codes: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "code-system",
            help = "Console the --code values are for (nes, snes, genesis, gameboy, gba, psx), when the ROM header does not say"
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
            help = "Which cheat scheme the --code values use: auto, game-genie, gameshark/par, or xploder"
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
            help = THREADS_HELP
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub threads: ThreadBudget,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "solid-system",
            help = "SOLID patches only: console the ROM is for"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub solid_system: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long = "solid-game", help = "SOLID patches only: name of the game")
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub solid_game: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(long = "solid-hack", help = "SOLID patches only: name of the hack")
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub solid_hack: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "solid-version",
            help = "SOLID patches only: version of the hack. Switches the patch to its extended header"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub solid_version: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "solid-author",
            help = "SOLID patches only: who made the hack. Switches the patch to its extended header"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub solid_author: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "solid-contact",
            help = "SOLID patches only: how to reach the author. Switches the patch to its extended header"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub solid_contact: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "solid-comment",
            help = "SOLID patches only: free-form note. Switches the patch to its extended header"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub solid_comment: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "solid-extended",
            help = "SOLID patches only: use the extended header even with none of the extended fields filled in"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub solid_extended: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "xdelta-secondary",
            default_value = "none",
            value_parser = ["auto", "lzma", "djw", "fgk", "none"],
            help = "xdelta patches only: compress the patch's own contents",
            long_help = "\
xdelta patches only: compress the patch's own contents.

  none  Leave it uncompressed. The default, and what xdelta3 does without -S.
  lzma  Add LZMA, like xdelta3 -S lzma.
  djw   xdelta3's Huffman coder.
  fgk   xdelta3's adaptive Huffman coder.
  auto  Try djw, lzma, and fgk, and keep whichever comes out smallest.

Leaving it at none is usually right: patch payloads are often already-compressed
game assets, and the patch tends to get compressed again downstream anyway."
        )
    )]
    #[serde(default = "default_xdelta_secondary")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub xdelta_secondary: String,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "force",
            help = "Overwrite the output if it already exists (without this, the command stops instead)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub force: bool,
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
            help = THREADS_HELP
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
            help = "Bundle file, or an archive with a bundle at its root"
        )
    )]
    pub input: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short = 's',
            long = "select",
            help = "Handle only the bundle entries whose file name matches this exact name, prefix, or glob (repeatable)"
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
            help = "Handle only the bundle's rom entry or only its patch entries (repeatable, comma-separable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub filter: Vec<FilterKind>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Report what the bundle contains without unpacking any of it"
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
            help = "Directory to unpack the bundle's files into. Without it, files packed in an archive are listed but not written out"
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
            help = THREADS_HELP
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
            help = "ROM the patches apply to. Its checksums and size are read from the file and recorded in the bundle"
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
            help = "Take the ROM's checksum and size on trust rather than reading it, as in crc32=1234abcd,size=1048576 (repeatable, comma-separable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub assume_in: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "rom-url",
            help = "Where the ROM can be downloaded from. With --input, the local file still supplies the checksums; on its own, the bundle records only this url"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub rom_url: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "rom-name",
            help = "Expected ROM file name to show and use for output naming; a supplied ROM with a different name only warns"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub rom_name: Option<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch",
            help = "Patch to list in the bundle. Repeat once per patch, in the order they should be applied",
            long_help = "\
Patch to list in the bundle. Repeat once per patch, in the order they should be
applied.

Every --patch-* flag describes the --patch before it, so metadata for several
patches reads left to right:

  --patch tl.bps  --patch-name 'Translation' --patch-author 'Team A' \\
  --patch fix.ips --patch-name 'Bugfixes'    --patch-optional true"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch: Vec<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-id",
            help = "Identifier for the preceding --patch that stays the same across releases, so a replacement keeps its settings",
            long_help = patch_adjacency_long_help!("Identifier for the preceding --patch that stays the same across releases, so a replacement keeps its settings")
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_id: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-version",
            help = "Version of the preceding --patch, in whatever form its author uses",
            long_help = patch_adjacency_long_help!("Version of the preceding --patch, in whatever form its author uses")
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_version: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-name",
            help = "Name to show for the preceding --patch",
            long_help = patch_adjacency_long_help!("Name to show for the preceding --patch")
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_name: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-description",
            help = "What the preceding --patch does",
            long_help = patch_adjacency_long_help!("What the preceding --patch does")
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_description: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-author",
            help = "Who made the preceding --patch",
            long_help = patch_adjacency_long_help!("Who made the preceding --patch")
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_author: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-label",
            help = "Short status note for the preceding --patch, such as beta or recommended",
            long_help = patch_adjacency_long_help!("Short status note for the preceding --patch, such as beta or recommended")
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_label: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-optional",
            help = "Mark the preceding --patch optional, so it starts switched off and needs --with to run",
            long_help = patch_adjacency_long_help!("Mark the preceding --patch optional, so it starts switched off and needs --with to run")
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_optional: Vec<bool>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch-source-url",
            help = "Where the preceding --patch can be downloaded from. The local file is still read to build the bundle",
            long_help = patch_adjacency_long_help!("Where the preceding --patch can be downloaded from. The local file is still read to build the bundle")
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
            help = "Whether the preceding --patch applies to the ROM with or without its copier header: auto, keep, or strip",
            long_help = patch_adjacency_long_help!("Whether the preceding --patch applies to the ROM with or without its copier header: auto, keep, or strip")
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
            help = "Which ROM the preceding --patch was built against: base (the bundle's ROM) or previous (the patch before it). Use auto to leave it out and let apply infer it",
            long_help = patch_adjacency_long_help!("Which ROM the preceding --patch was built against: base (the bundle's ROM) or previous (the patch before it). Use auto to leave it out and let apply infer it")
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
            help = "Checksum the ROM should have before the preceding --patch runs. Recorded only when it differs from the bundle's ROM checksums (repeatable, comma-separable)",
            long_help = patch_adjacency_long_help!("Checksum the ROM should have before the preceding --patch runs. Recorded only when it differs from the bundle's ROM checksums (repeatable, comma-separable)")
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
            help = "Checksum the ROM should have after the preceding --patch runs. Recorded only when it differs from the final output checksums (repeatable, comma-separable)"
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
            help = "Checksum the ROM should have once every patch has run, so users can confirm they got the right result (repeatable, comma-separable)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub output_check: Vec<String>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "output-name",
            help = "File name the bundle suggests for the patched ROM"
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
            help = "Whether the patched ROM should keep its copier header: auto, keep, or strip"
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
            help = "Where to write the bundle. Name it rom-weaver-bundle.json, or add .gz or .zst to compress it"
        )
    )]
    pub output: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long,
            help = "Also pack the bundle and its ROM and patches into one shareable archive, such as release.zip"
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
            help = "Pack this file into --bundle as the ROM, while --input supplies the checksums and metadata"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub bundle_rom: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "no-bundle-rom",
            help = "Keep the ROM out of --bundle and record only its checksums, so whoever applies the bundle brings their own copy"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub no_bundle_rom: bool,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "checksum",
            visible_alias = "algo",
            value_name = "ALGO",
            value_delimiter = ',',
            ignore_case = true,
            value_parser = checksum_algorithm_parser(),
            help = "Which checksums to record for the ROM (repeatable, comma-separable) [default: crc32,md5,sha1]"
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
            help = "Build the bundle from a hand-written rom-weaver-bundle.json instead of flags. Use - to read it from stdin",
            long_help = "\
Build the bundle from a hand-written rom-weaver-bundle.json instead of flags.
Use - to read it from stdin.

Write the file with local paths and leave the checksums out; they are filled in
from the real files. Get the schema with `rom-weaver bundle schema` so your
editor can check the file as you write it.

Any flag you also pass overrides what the file says."
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
            help = "Record this $schema URL in the bundle so editors can validate it. Left out unless asked for"
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
            help = THREADS_HELP
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
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "force",
            help = "Overwrite the output if it already exists (without this, the command stops instead)"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub force: bool,
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
            help = "The already-patched ROM to undo"
        )
    )]
    pub rom: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "patch",
            value_name = "PPF",
            help = "The PPF3 patch that was applied. It must carry undo data"
        )
    )]
    pub patch: PathBuf,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            short,
            long,
            value_name = "PATH",
            help = "Where to write the restored ROM"
        )
    )]
    pub output: PathBuf,
}

/// `identify` subcommands. Today only `database`; a plain `identify --input`
/// run has no subcommand.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Subcommand))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case", tag = "type", content = "args")]
#[cfg_attr(
    feature = "typescript-types",
    ts(rename_all = "kebab-case", tag = "type", content = "args")
)]
pub enum IdentifySubcommands {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        command(subcommand, about = "Manage the installed identify database packs")
    )]
    Database(IdentifyDatabaseCommands),
}

/// `identify database` subcommands (native only; the browser build reports
/// them as unsupported).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Subcommand))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case", tag = "type", content = "args")]
#[cfg_attr(
    feature = "typescript-types",
    ts(rename_all = "kebab-case", tag = "type", content = "args")
)]
pub enum IdentifyDatabaseCommands {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        command(
            about = "List every catalog platform, its source, and whether its pack is installed"
        )
    )]
    List(Box<IdentifyDatabaseDirCommand>),
    #[cfg_attr(
        not(target_arch = "wasm32"),
        command(about = "List the installed pack files: slug, format, size, and sha256")
    )]
    Status(Box<IdentifyDatabaseDirCommand>),
    #[cfg_attr(
        not(target_arch = "wasm32"),
        command(about = "Print the identify database directory")
    )]
    Path(Box<IdentifyDatabaseDirCommand>),
    #[cfg_attr(
        not(target_arch = "wasm32"),
        command(about = "Remove one system's installed pack")
    )]
    Remove(Box<IdentifyDatabaseSystemCommand>),
    #[cfg_attr(
        not(target_arch = "wasm32"),
        command(about = "Install the full identify database for this rom-weaver version")
    )]
    InstallAll(Box<IdentifyDatabaseDirCommand>),
    #[cfg_attr(
        not(target_arch = "wasm32"),
        command(about = "Download and install one optional identify pack group")
    )]
    InstallGroup(Box<IdentifyDatabaseGroupCommand>),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyDatabaseDirCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "database-dir",
            value_name = "DIR",
            help = "Identify database directory. Defaults to the per-user data directory"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub database_dir: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyDatabaseSystemCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(value_name = "SYSTEM", help = "Canonical platform name or alias")
    )]
    pub system: String,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "database-dir",
            value_name = "DIR",
            help = "Identify database directory. Defaults to the per-user data directory"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub database_dir: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Args))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyDatabaseGroupCommand {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(value_name = "GROUP", help = "Optional identify pack group to install")
    )]
    pub group: String,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "from",
            value_name = "ARCHIVE",
            help = "Local group archive; omit to download the archive for this version"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub from: Option<PathBuf>,
    #[cfg_attr(
        not(target_arch = "wasm32"),
        arg(
            long = "database-dir",
            value_name = "DIR",
            help = "Identify database directory. Defaults to the per-user data directory"
        )
    )]
    #[serde(default)]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub database_dir: Option<PathBuf>,
}
