use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs,
    fs::File,
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{self, ExitCode},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use clap::{ArgAction, Args, Parser, Subcommand};
use rom_weaver_checksum::{NativeChecksumEngine, supported_algorithms};
use rom_weaver_containers::{CompressFormatRecommendation, ContainerRegistry};
use rom_weaver_core::{
    CancellationToken, ChecksumEngine, ChecksumRequest, ContainerCreateRequest,
    ContainerExtractRequest, ContainerInspectRequest, OperationContext, OperationFamily,
    OperationReport, OperationStatus, PatchApplyRequest, PatchChecksumValidation,
    PatchCreateRequest, ProgressEvent, ProgressSink, Result, RomWeaverError, ThreadBudget,
    ThreadCapability, ThreadExecution,
};
use rom_weaver_patches::PatchRegistry;
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
    #[arg(long = "select")]
    select: Vec<String>,
    #[arg(long)]
    out_dir: PathBuf,
    #[arg(long, default_value = "auto")]
    threads: ThreadBudget,
}

#[derive(Debug, Args)]
struct ChecksumCommand {
    source: PathBuf,
    #[arg(long = "algo", required = true)]
    algo: Vec<String>,
    #[arg(long, help = "Remove a 512-byte copier header before checksum")]
    strip_header: bool,
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
    #[arg(long = "patch", required = true)]
    patch: Vec<PathBuf>,
    #[arg(long)]
    output: PathBuf,
    #[arg(long, help = "Remove a 512-byte copier header before patch apply")]
    strip_header: bool,
    #[arg(
        long,
        help = "Add a 512-byte header after patch apply (reuses stripped header bytes when available)"
    )]
    add_header: bool,
    #[arg(
        long,
        help = "Repair supported ROM header checksums after patch apply (auto-detect)"
    )]
    repair_checksum: bool,
    #[arg(
        long,
        help = "Skip patch-provided checksum validation for source/target compatibility checks"
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
    let reporter: Arc<dyn ProgressSink> = if cli.json {
        Arc::new(StdoutReporter::json())
    } else {
        Arc::new(StdoutReporter::text())
    };
    let app = CliApp::new(reporter, cli.json);
    app.run(cli.command)
}

struct CliApp {
    reporter: Arc<dyn ProgressSink>,
    emit_progress_events: bool,
    containers: ContainerRegistry,
    patches: PatchRegistry,
    checksum: NativeChecksumEngine,
}

const MAX_NESTED_EXTRACT_DEPTH: usize = 8;
const MAX_NESTED_EXTRACT_ARCHIVES: usize = 256;
const ROM_HEADER_BYTES: usize = 512;
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
const GAME_BOY_NINTENDO_LOGO: [u8; 48] = [
    0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00, 0x0D,
    0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E, 0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD, 0xD9, 0x99,
    0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC, 0xDD, 0xDC, 0x99, 0x9F, 0xBB, 0xB9, 0x33, 0x3E,
];

type XisoTrimSourceDevice = XdvdfsOffsetWrapper<BufReader<File>, io::Error>;
type XisoTrimSourceFilesystem = XdvdfsFilesystem<io::Error, XisoTrimSourceDevice>;

struct NdsTrimPlan {
    trimmed_size: u64,
    dsi_mode: bool,
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

impl CliApp {
    fn new(reporter: Arc<dyn ProgressSink>, emit_progress_events: bool) -> Self {
        Self {
            reporter,
            emit_progress_events,
            containers: ContainerRegistry::new(),
            patches: PatchRegistry::new(),
            checksum: NativeChecksumEngine,
        }
    }

    fn run(&self, command: Commands) -> ExitCode {
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

    fn run_inspect(&self, args: InspectCommand) -> ExitCode {
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
        let context = self.context(args.threads);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        if let Some(report) = self.require_existing_path(
            "extract",
            OperationFamily::Container,
            None,
            &args.source,
            probe_threads.clone(),
        ) {
            return self.finish("extract", report);
        }

        let Some(handler) = self.containers.probe(&args.source) else {
            return self.finish(
                "extract",
                OperationReport::failed(
                    OperationFamily::Container,
                    None,
                    "probe",
                    format!(
                        "no registered container matched `{}`",
                        args.source.display()
                    ),
                    probe_threads,
                ),
            );
        };

        let source = args.source;
        let out_dir = args.out_dir;
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
        let request = ContainerExtractRequest {
            source: source.clone(),
            selections: args.select,
            out_dir: out_dir.clone(),
        };
        let mut report = handler.extract(&request, &context).unwrap_or_else(|error| {
            OperationReport::failed(
                OperationFamily::Container,
                Some(handler.descriptor().name.to_string()),
                "extract",
                error.to_string(),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            )
        });
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
        let ChecksumCommand {
            source,
            algo,
            strip_header,
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
        let checksum_source = if strip_header {
            self.emit_running(
                "checksum",
                OperationFamily::Checksum,
                Some(self.checksum.name()),
                "prepare",
                "stripping 512-byte header before checksum",
                None,
                thread_execution.clone(),
            );
            let stripped_path = context
                .temp_paths()
                .next_path("checksum-input-noheader", Some("bin"));
            match Self::strip_header_to_temp(&source, &stripped_path) {
                Ok(_) => {
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
            source.clone()
        };
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
        if report.status == OperationStatus::Succeeded && strip_header {
            report.label = format!("{}; input header stripped (512 bytes)", report.label);
        }
        for temp_path in temp_paths {
            let _ = fs::remove_file(temp_path);
        }
        self.finish("checksum", report)
    }

    fn run_compress(&self, args: CompressCommand) -> ExitCode {
        let CompressCommand {
            input,
            format,
            output,
            codec,
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

        let (codec, level) = if auto_mode {
            (None, None)
        } else {
            match Self::resolve_codec_level(codec) {
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
            }
        };

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
            Some(context.plan_threads(handler.capabilities().create_threads)),
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
        let PatchApplyCommand {
            input,
            patch,
            output,
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
        if let Some(report) = self.require_existing_path(
            "patch-apply",
            OperationFamily::Patch,
            None,
            &input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-apply", report);
        }
        for patch_path in &patch {
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

        let Some(handler) = self.patches.probe(&patch[0]) else {
            return self.finish(
                "patch-apply",
                OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "probe",
                    format!(
                        "no registered patch handler matched `{}`",
                        patch[0].display()
                    ),
                    probe_threads,
                ),
            );
        };

        let mut temp_paths = Vec::new();
        let mut stripped_header = None;
        let apply_input = if strip_header {
            self.emit_running(
                "patch-apply",
                OperationFamily::Patch,
                Some(handler.descriptor().name),
                "prepare",
                "stripping 512-byte header before patch apply",
                None,
                None,
            );
            let stripped_path = context
                .temp_paths()
                .next_path("patch-apply-input-noheader", Some("bin"));
            match Self::strip_header_to_temp(&input, &stripped_path) {
                Ok(header) => {
                    stripped_header = Some(header);
                    temp_paths.push(stripped_path.clone());
                    stripped_path
                }
                Err(error) => {
                    return self.finish(
                        "patch-apply",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            Some(handler.descriptor().name.to_string()),
                            "compat",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        ),
                    );
                }
            }
        } else {
            input.clone()
        };
        let needs_postprocess = add_header || repair_checksum;
        let apply_output = if needs_postprocess {
            let staged_path = context
                .temp_paths()
                .next_path("patch-apply-output-staged", Some("bin"));
            temp_paths.push(staged_path.clone());
            staged_path
        } else {
            output.clone()
        };
        let request = PatchApplyRequest {
            input: apply_input,
            patches: patch,
            output: apply_output.clone(),
        };
        self.emit_running(
            "patch-apply",
            OperationFamily::Patch,
            Some(handler.descriptor().name),
            "apply",
            format!("applying patch using {}", handler.descriptor().name),
            Some(0.0),
            None,
        );
        let mut report = handler.apply(&request, &context).unwrap_or_else(|error| {
            OperationReport::failed(
                OperationFamily::Patch,
                Some(handler.descriptor().name.to_string()),
                "apply",
                error.to_string(),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            )
        });
        if report.status == OperationStatus::Succeeded && needs_postprocess {
            self.emit_running(
                "patch-apply",
                OperationFamily::Patch,
                Some(handler.descriptor().name),
                "compat",
                "finalizing compatibility output transforms",
                None,
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            match Self::finalize_patch_apply_output(
                &apply_output,
                &output,
                add_header,
                stripped_header.as_deref(),
                repair_checksum,
            ) {
                Ok(repaired_kind) => {
                    if let Some(kind) = repaired_kind {
                        report.label = format!("{}; repaired checksum ({kind})", report.label);
                    }
                }
                Err(error) => {
                    report = OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "compat",
                        error.to_string(),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                }
            }
        }
        for temp_path in temp_paths {
            let _ = fs::remove_file(temp_path);
        }
        self.finish("patch-apply", report)
    }

    fn run_patch_create(&self, args: PatchCreateCommand) -> ExitCode {
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

        let thread_execution = thread_execution.as_ref();
        self.reporter.emit(ProgressEvent {
            command: command.to_string(),
            family,
            format: format.map(str::to_string),
            stage: stage.into(),
            label: label.into(),
            percent,
            requested_threads: thread_execution.map(|value| value.requested_threads),
            effective_threads: thread_execution.map(|value| value.effective_threads),
            thread_mode: thread_execution.map(|value| value.thread_mode),
            used_parallelism: thread_execution.map(|value| value.used_parallelism),
            status: OperationStatus::Running,
        });
    }

    fn context(&self, thread_budget: ThreadBudget) -> OperationContext {
        let temp_root = std::env::temp_dir().join("rom-weaver");
        OperationContext::new(
            thread_budget,
            temp_root,
            self.reporter.clone(),
            CancellationToken::new(),
        )
    }

    fn resolve_codec_level(codec: Option<String>) -> Result<(Option<String>, Option<i32>)> {
        let Some(codec) = codec else {
            return Ok((None, None));
        };

        let codec = codec.trim();
        if codec.is_empty() {
            return Err(RomWeaverError::Validation(
                "--codec cannot be empty".to_string(),
            ));
        }

        let Some((raw_codec, raw_level)) = codec.split_once(':') else {
            return Ok((Some(codec.to_string()), None));
        };

        let codec_name = raw_codec.trim();
        if codec_name.is_empty() {
            return Err(RomWeaverError::Validation(
                "codec name is missing before `:` in --codec".to_string(),
            ));
        }

        let level_text = raw_level.trim();
        if level_text.is_empty() {
            return Err(RomWeaverError::Validation(
                "codec level is missing after `:` in --codec".to_string(),
            ));
        }

        let parsed_level = level_text.parse::<i32>().map_err(|_| {
            RomWeaverError::Validation(format!(
                "codec level `{level_text}` is not a valid integer in --codec"
            ))
        })?;

        Ok((Some(codec_name.to_string()), Some(parsed_level)))
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
            process::id()
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

    fn strip_header_to_temp(input: &Path, stripped_path: &Path) -> Result<Vec<u8>> {
        let input_len = fs::metadata(input)?.len();
        if input_len < ROM_HEADER_BYTES as u64 {
            return Err(RomWeaverError::Validation(format!(
                "cannot strip 512-byte header from `{}` (file is only {input_len} byte(s))",
                input.display()
            )));
        }
        if let Some(parent) = stripped_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut source = BufReader::new(File::open(input)?);
        let mut header = vec![0_u8; ROM_HEADER_BYTES];
        source.read_exact(&mut header)?;

        let mut stripped = BufWriter::new(File::create(stripped_path)?);
        io::copy(&mut source, &mut stripped)?;
        stripped.flush()?;
        Ok(header)
    }

    fn finalize_patch_apply_output(
        staged_output: &Path,
        final_output: &Path,
        add_header: bool,
        stripped_header: Option<&[u8]>,
        repair_checksum: bool,
    ) -> Result<Option<&'static str>> {
        let header_bytes = if add_header {
            Some(stripped_header.unwrap_or(&[0_u8; ROM_HEADER_BYTES]))
        } else {
            None
        };

        if repair_checksum {
            let mut output_bytes = fs::read(staged_output)?;
            let repaired_kind =
                Self::repair_checksum_if_supported(&mut output_bytes).ok_or_else(|| {
                    RomWeaverError::Validation(
                        "could not auto-detect a supported checksum header to repair; currently supported targets are sega-genesis and game-boy"
                            .into(),
                    )
                })?;
            if let Some(parent) = final_output.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut writer = BufWriter::new(File::create(final_output)?);
            if let Some(header) = header_bytes {
                writer.write_all(header)?;
            }
            writer.write_all(&output_bytes)?;
            writer.flush()?;
            return Ok(Some(repaired_kind));
        }

        Self::copy_with_optional_header(staged_output, final_output, header_bytes)?;
        Ok(None)
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

    fn repair_checksum_if_supported(bytes: &mut [u8]) -> Option<&'static str> {
        if Self::repair_sega_genesis_checksum(bytes) {
            return Some("sega-genesis");
        }
        if Self::repair_game_boy_checksum(bytes) {
            return Some("game-boy");
        }
        None
    }

    fn repair_sega_genesis_checksum(bytes: &mut [u8]) -> bool {
        if bytes.len() <= 0x18F || bytes.len() < 0x200 {
            return false;
        }
        if &bytes[0x100..0x104] != b"SEGA" {
            return false;
        }
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
        true
    }

    fn repair_game_boy_checksum(bytes: &mut [u8]) -> bool {
        if bytes.len() <= 0x14F {
            return false;
        }
        if bytes[0x104..0x134] != GAME_BOY_NINTENDO_LOGO {
            return false;
        }

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
        true
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
        let root_source =
            fs::canonicalize(root_source).unwrap_or_else(|_| root_source.to_path_buf());
        let mut nested_count = 0usize;
        let mut processed = HashSet::new();
        processed.insert(root_source);

        let mut queue = VecDeque::new();
        self.enqueue_nested_candidates(root_out_dir, 1, &processed, &mut queue)?;

        while let Some((source, depth)) = queue.pop_front() {
            if depth > MAX_NESTED_EXTRACT_DEPTH {
                return Err(RomWeaverError::Validation(format!(
                    "nested extract exceeded max depth of {MAX_NESTED_EXTRACT_DEPTH} at `{}`",
                    source.display()
                )));
            }
            if nested_count >= MAX_NESTED_EXTRACT_ARCHIVES {
                return Err(RomWeaverError::Validation(format!(
                    "nested extract exceeded max archive count of {MAX_NESTED_EXTRACT_ARCHIVES}"
                )));
            }

            let canonical_source = fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
            if !processed.insert(canonical_source) {
                continue;
            }

            let Some(handler) = self.containers.probe(&source) else {
                continue;
            };

            // Only recurse into containers that successfully inspect, so extension-only matches
            // do not fail nested extraction on non-container payload files.
            let inspect_request = ContainerInspectRequest {
                source: source.clone(),
            };
            if handler.inspect(&inspect_request, context).is_err() {
                continue;
            }

            let nested_out_dir = self.next_nested_out_dir(&source);
            let nested_request = ContainerExtractRequest {
                source: source.clone(),
                selections: Vec::new(),
                out_dir: nested_out_dir.clone(),
            };
            handler.extract(&nested_request, context).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "nested extract failed for `{}` ({}): {error}",
                    source.display(),
                    handler.descriptor().name
                ))
            })?;
            nested_count = nested_count.saturating_add(1);

            self.enqueue_nested_candidates(&nested_out_dir, depth + 1, &processed, &mut queue)?;
        }

        Ok(nested_count)
    }

    fn enqueue_nested_candidates(
        &self,
        root: &Path,
        depth: usize,
        processed: &HashSet<PathBuf>,
        queue: &mut VecDeque<(PathBuf, usize)>,
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
            }
        }
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
