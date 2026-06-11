use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    fs,
    fs::File,
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::{Arc, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(not(target_arch = "wasm32"))]
use clap::{ArgAction, Args, Subcommand, ValueEnum};
use rom_weaver_checksum::checksum_reader_values_with_progress;
use rom_weaver_checksum::rom_headers::{
    A78_HEADER_MAGIC, FDS_HEADER_MAGIC, GAME_BOY_NINTENDO_LOGO, GBA_HEADER_MAGIC,
    INES_HEADER_MAGIC, KnownRomHeader, KnownRomHeaderMatch, LNX_HEADER_MAGIC, N64_BIG_ENDIAN_MAGIC,
    N64_BYTE_SWAPPED_MAGIC, N64_LITTLE_ENDIAN_MAGIC, NGP_COPYRIGHT_MAGIC,
    PCE_COPIER_HEADER_MODULUS, ROM_HEADER_BYTES, ROM_HEADER_SCAN_BYTES, SMS_TMR_SEGA_MAGIC,
    SNES_COPIER_HEADER_MODULUS, StripHeaderResult,
};
use rom_weaver_checksum::{
    ChecksumProgress, NativeChecksumEngine, StreamingVariantChecksums, VariantOutput, VariantRow,
    checksum_file_values, overlay_checksums, supported_algorithms,
};
use rom_weaver_containers::{
    CompressFormatRecommendation, ContainerRegistry, extract_only_create_validation_message,
};
use rom_weaver_core::{
    ArchiveEntryKindFilter, CancellationToken, ChecksumEngine, ChecksumRequest,
    ContainerCreateRequest, ContainerExtractRequest, ContainerHandler, ContainerListEntry,
    ContainerProbeRequest, OperationContext, OperationFamily, OperationReport, OperationStatus,
    PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchValidateRequest,
    ProgressEvent, ProgressSink, PromptCandidate, Result, RomWeaverError, Selection, SelectionList,
    SelectionMatcher, SelectionPrompter, ThreadBudget, ThreadCapability, ThreadExecution,
    XdeltaSecondaryMode, is_patch_filter_candidate_name, is_rom_filter_candidate_name,
    normalize_archive_name, should_ignore_common_container_file,
};
// The selection-input parser moved to core; the app keeps a thin wrapper only so the existing unit
// test in `tests.rs` can exercise it through `CliApp`.
#[cfg(test)]
use rom_weaver_core::{ParsedSelectionInput, parse_selection_input};
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
use tracing::{trace, warn};
#[cfg(not(target_arch = "wasm32"))]
use tracing_subscriber::{filter::Targets, fmt, layer::SubscriberExt, util::SubscriberInitExt};
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
    Probe(ProbeCommand),
    List(ListCommand),
    Extract(ExtractCommand),
    Checksum(ChecksumCommand),
    Compress(CompressCommand),
    Trim(TrimCommand),
    #[cfg_attr(not(target_arch = "wasm32"), command(subcommand))]
    Patch(PatchCommands),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Subcommand))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case", tag = "type", content = "args")]
#[cfg_attr(
    feature = "typescript-types",
    ts(rename_all = "kebab-case", tag = "type", content = "args")
)]
pub enum PatchCommands {
    #[cfg_attr(
        not(target_arch = "wasm32"),
        command(
            about = "Apply one or more ROM patch files to an input in sequence",
            long_about = "Apply one or more ROM patch files to an input in sequence.\n\nSupported patch apply formats:\nIPS, IPS32, SOLID, BPS, UPS, VCDIFF, xdelta, GDIFF, HDiffPatch/HPatchZ, APS (N64), APSGBA, RUP, PPF, PAT/FFP, EBP, BDF/BSDIFF40, BSP, MOD/PMSR, DLDI, DPS.\n\nCaveats:\n- NINJA1 headers are recognized but apply is unsupported.\n- PDS is explicitly unsupported.\n- HDiffPatch directory patches (HDIFF19) are unsupported; only single-file .hdiff/.hpatchz is supported."
        )
    )]
    Apply(PatchApplyCommand),
    #[cfg_attr(
        not(target_arch = "wasm32"),
        command(
            about = "Validate one or more ROM patch files against an input without writing output",
            long_about = "Validate one or more ROM patch files against an input without writing output.\n\nValidation performs the same patch-format checksum checks as patch apply when the handler supports them, including VCDIFF/xdelta target-window checksums. It also accepts optional input checksum and size values for source preflight."
        )
    )]
    Validate(PatchValidateCommand),
    #[cfg_attr(
        not(target_arch = "wasm32"),
        command(
            name = "create-candidates",
            about = "List recommended patch-create formats for an original/modified input pair",
            long_about = "List recommended patch-create formats for an original/modified input pair.\n\nThe result includes the ranked candidate formats and the default format the create UI should select for the supplied inputs."
        )
    )]
    CreateCandidates(PatchCreateCandidatesCommand),
    Create(PatchCreateCommand),
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
        prompter: Arc<dyn SelectionPrompter>,
    ) -> AppRunOutcome {
        let reporter = Arc::new(TimingProgressSink::new(reporter));
        let app = CliApp::new(
            reporter,
            prompter,
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

/// Browser host selection callback. The wasm prompter serializes the choice request to JSON and
/// hands it to the JS runner, which blocks the worker until the UI resolves the pick (or a negative
/// return cancels — also used when no interactive handler is registered). Lives in the `env` import
/// module the runner already supplies at instantiation.
#[cfg(target_arch = "wasm32")]
mod wasm_host_prompt {
    use std::sync::Arc;

    use rom_weaver_core::{PromptCandidate, Selection, SelectionPrompter};
    use serde_json::json;

    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        fn rom_weaver_host_select(request_ptr: *const u8, request_len: usize) -> i32;
    }

    /// Prompter that delegates list selection to the browser host. Confirmation prompts are declined
    /// (matching the historical headless behavior); only candidate selection is interactive.
    pub struct WasmHostPrompter;

    impl SelectionPrompter for WasmHostPrompter {
        fn select(&self, heading: &str, candidates: &[PromptCandidate]) -> Selection {
            let request = json!({
                "heading": heading,
                "candidates": candidates
                    .iter()
                    .map(|candidate| json!({ "value": candidate.value, "label": candidate.label, "size": candidate.size }))
                    .collect::<Vec<_>>(),
            })
            .to_string();
            let bytes = request.as_bytes();
            // SAFETY: the pointer and length describe a live byte slice for the duration of the
            // call; the host reads it synchronously before returning.
            let selected = unsafe { rom_weaver_host_select(bytes.as_ptr(), bytes.len()) };
            match usize::try_from(selected) {
                Ok(index) if index < candidates.len() => Selection::Selected(index),
                _ => Selection::Cancelled,
            }
        }

        fn confirm(&self, _heading: &str, _details: &[String]) -> bool {
            false
        }
    }

    pub fn prompter() -> Arc<dyn SelectionPrompter> {
        Arc::new(WasmHostPrompter)
    }
}

/// Entrypoint for headless callers (wasm). Always emits the JSON event stream. On wasm it routes
/// interactive selection back to the browser host; elsewhere it never prompts.
pub fn run_request(request: RomWeaverRunRequest, stdout_is_tty: bool) -> ExitCode {
    let output = request.output;
    #[cfg(target_arch = "wasm32")]
    let prompter: Arc<dyn SelectionPrompter> = wasm_host_prompt::prompter();
    #[cfg(not(target_arch = "wasm32"))]
    let prompter: Arc<dyn SelectionPrompter> = Arc::new(rom_weaver_core::NoninteractivePrompter);
    run_command(
        request.command,
        RunCommandOptions::from_output(output, stdout_is_tty),
        Arc::new(JsonProgressSink),
        prompter,
    )
}

/// Run one command with caller-provided terminal IO. The front-end injects the `reporter` (JSON or
/// a human renderer) and the `prompter` (stdin-backed or non-interactive), so this crate stays free
/// of presentation concerns.
pub fn run_command(
    command: Commands,
    options: RunCommandOptions,
    reporter: Arc<dyn ProgressSink>,
    prompter: Arc<dyn SelectionPrompter>,
) -> ExitCode {
    init_trace_logging(options.trace, options.json);
    trace!(
        json = options.json,
        emit_progress_events = options.emit_progress_events,
        trace_requested = options.trace,
        command = ?command,
        "running rom-weaver command"
    );
    let outcome = RomWeaverApp::run(
        command,
        AppRunOptions {
            emit_progress_events: options.emit_progress_events,
            interactive_selection_enabled: options.interactive_selection_enabled,
        },
        reporter,
        prompter,
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

        let filter = match filter_spec.parse::<Targets>() {
            Ok(filter) => filter,
            Err(error) => {
                eprintln!("warning: invalid trace filter `{filter_spec}` ({error}); using off");
                Targets::default()
            }
        };

        if json_mode {
            let _ = tracing_subscriber::registry()
                .with(filter)
                .with(fmt::layer().json().with_ansi(false).with_writer(io::stderr))
                .try_init();
        } else {
            let _ = tracing_subscriber::registry()
                .with(filter)
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

/// Progress sink that serializes each event to a stdout JSON line. Used by the wasm entrypoint
/// (whose worker parses the JSON stream) and by the native CLI's `--json` mode. Human-readable
/// rendering lives in the front-end crates, not here.
pub struct JsonProgressSink;

impl ProgressSink for JsonProgressSink {
    fn emit(&self, event: ProgressEvent) {
        match serde_json::to_string(&event) {
            Ok(serialized) => {
                println!("{serialized}");
                let _ = io::Write::flush(&mut io::stdout());
            }
            Err(error) => eprintln!("failed to serialize progress event: {error}"),
        }
    }
}

struct TimingProgressSink {
    inner: Arc<dyn ProgressSink>,
    started_at: Instant,
}

impl TimingProgressSink {
    fn new(inner: Arc<dyn ProgressSink>) -> Self {
        Self {
            inner,
            started_at: Instant::now(),
        }
    }

    fn elapsed_ms(&self) -> u32 {
        self.started_at.elapsed().as_millis().min(u32::MAX as u128) as u32
    }
}

impl ProgressSink for TimingProgressSink {
    fn emit(&self, mut event: ProgressEvent) {
        event.elapsed_ms.get_or_insert_with(|| self.elapsed_ms());
        self.inner.emit(event);
    }
}

struct CliApp {
    reporter: Arc<dyn ProgressSink>,
    prompter: Arc<dyn SelectionPrompter>,
    emit_progress_events: bool,
    interactive_selection_enabled: bool,
    containers: ContainerRegistry,
    patches: PatchRegistry,
    checksum: NativeChecksumEngine,
}

const MAX_NESTED_EXTRACT_DEPTH: usize = 8;
const MAX_NESTED_EXTRACT_ARCHIVES: usize = 256;
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
    /// When the trim payload was extracted from an archive, the original archive path. Used to
    /// place side-by-side output next to the archive and to drive `--in-place` repacking.
    archive_origin: Option<PathBuf>,
    /// For `--in-place` archive inputs, the temp directory holding the archive's full extracted
    /// contents. The trimmed ROM is written back here and the directory is recompressed over the
    /// original archive. `None` for direct files and side-by-side archive output.
    repack_root: Option<PathBuf>,
}

/// Shared options threaded through trim input collection so archive payloads can be auto-extracted
/// and filtered to trim-supported types.
#[derive(Clone, Copy)]
struct TrimCollectOptions<'a> {
    recursive: bool,
    rom_filter: bool,
    no_extract: bool,
    in_place: bool,
    context: &'a OperationContext,
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
            // GBA and 3DS carts pad unused trailing space with 0xFF; trimming scans for that fill
            // and revert restores it so round-tripped ROMs match the original dump.
            Self::ThreeDs | Self::Gba => 0xFF,
            Self::NdsFamily | Self::Xiso | Self::RvzScrub => 0x00,
        }
    }
}

#[derive(Clone, Debug)]
struct ChecksumExtractCandidate {
    source: PathBuf,
    display_name: String,
    ignored: bool,
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
    note: String,
    warning: Option<String>,
}

/// Outcome of resolving an output format from an explicit flag and/or the output extension. Used
/// for both container formats ([`CliApp::resolve_container_output_format`]) and patch formats
/// ([`CliApp::resolve_patch_create_format`]).
#[derive(Clone, Debug)]
struct FormatResolution {
    format: String,
    note: String,
    warning: Option<String>,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(ValueEnum))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum N64ByteOrder {
    BigEndian,
    LittleEndian,
    ByteSwapped,
}

impl N64ByteOrder {
    const fn id(self) -> &'static str {
        match self {
            Self::BigEndian => "big-endian",
            Self::LittleEndian => "little-endian",
            Self::ByteSwapped => "byte-swapped",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::BigEndian => "big-endian",
            Self::LittleEndian => "little-endian",
            Self::ByteSwapped => "byte-swapped",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct N64ByteOrderTransform {
    from: N64ByteOrder,
    to: N64ByteOrder,
}

#[path = "command_dispatch.rs"]
mod command_dispatch;

#[path = "probe_command.rs"]
mod probe_command;

#[path = "list_command.rs"]
mod list_command;

#[path = "extract_command.rs"]
mod extract_command;

#[path = "checksum_command.rs"]
mod checksum_command;

#[path = "source_resolution.rs"]
mod source_resolution;
use source_resolution::*;

#[path = "checksum_streaming.rs"]
mod checksum_streaming;

#[path = "checksum_variants.rs"]
mod checksum_variants;

#[path = "selection_resolution.rs"]
mod selection_resolution;

#[path = "output_details.rs"]
mod output_details;

#[path = "extract_progress.rs"]
mod extract_progress;
use extract_progress::*;

#[path = "compress_trim_batch.rs"]
mod compress_trim_batch;

mod patch_apply;
#[path = "patch_commands.rs"]
mod patch_commands;
mod patch_create;
mod patch_validate;
pub use patch_commands::{PatchCreateFormatPolicyMetadata, patch_create_format_policy_metadata};

#[path = "patch_filename_checksum.rs"]
mod patch_filename_checksum;
use patch_filename_checksum::{embed_checksum_in_filename, parse_filename_requirements};

mod command_args;
pub use command_args::{
    ChecksumCommand, CompressCommand, ExtractCommand, ListCommand, PatchApplyCommand,
    PatchCreateCandidatesCommand, PatchCreateCommand, PatchValidateCommand, ProbeCommand,
    TrimCommand,
};

mod compression;
pub use compression::{
    CompressionCodecFieldMetadata, CompressionCodecLevelMetadata, CompressionCodecMetadata,
    CompressionDefaultsMetadata, CompressionLevelProfile, CompressionMetadata,
    CompressionProfileMetadata, compression_metadata,
};

mod compression_planning;
use compression_planning::*;

#[path = "trim_detection.rs"]
mod trim_detection;

#[path = "trim_execution.rs"]
mod trim_execution;
use trim_execution::*;

#[path = "revert_footer.rs"]
mod revert_footer;

#[path = "probe_details.rs"]
mod probe_details;

#[path = "header_detection_and_finalize.rs"]
mod header_detection_and_finalize;

#[path = "header_repair_byte_io.rs"]
mod header_repair_byte_io;
pub(crate) use header_repair_byte_io::{
    read_exact_at, read_vec_at, remove_prefix_in_place, sum_range_with_zeroed, sum_sega_words,
    write_all_at,
};

#[path = "header_repair_n64.rs"]
mod header_repair_n64;

#[path = "header_repair_systems.rs"]
mod header_repair_systems;

#[path = "header_repair.rs"]
mod header_repair;

#[path = "nested_extract.rs"]
mod nested_extract;

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

#[cfg(test)]
mod header_repair_tests;
