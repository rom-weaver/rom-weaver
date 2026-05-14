use std::{
    path::{Path, PathBuf},
    process::ExitCode,
    sync::Arc,
};

use clap::{Args, Parser, Subcommand};
use rom_weaver_checksum::{NativeChecksumEngine, supported_algorithms};
use rom_weaver_codecs::CodecRegistry;
use rom_weaver_containers::ContainerRegistry;
use rom_weaver_core::{
    CancellationToken, ChecksumEngine, ChecksumRequest, ContainerCreateRequest,
    ContainerExtractRequest, ContainerInspectRequest, OperationContext, OperationFamily,
    OperationReport, PatchApplyRequest, PatchCreateRequest, ProgressEvent, ProgressSink,
    ThreadBudget, ThreadCapability,
};
use rom_weaver_patches::PatchRegistry;

#[derive(Debug, Parser)]
#[command(
    name = "rom-weaver",
    version,
    about = "Native CLI groundwork for ROM inspection, extraction, checksums, compression, and patching."
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
    PatchApply(PatchApplyCommand),
    PatchCreate(PatchCreateCommand),
}

#[derive(Debug, Args)]
struct InspectCommand {
    source: PathBuf,
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
    format: String,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    codec: Option<String>,
    #[arg(long)]
    level: Option<i32>,
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
    let app = CliApp::new(reporter);
    app.run(cli.command)
}

struct CliApp {
    reporter: Arc<dyn ProgressSink>,
    containers: ContainerRegistry,
    patches: PatchRegistry,
    checksum: NativeChecksumEngine,
    codecs: CodecRegistry,
}

impl CliApp {
    fn new(reporter: Arc<dyn ProgressSink>) -> Self {
        Self {
            reporter,
            containers: ContainerRegistry::new(),
            patches: PatchRegistry::new(),
            checksum: NativeChecksumEngine,
            codecs: CodecRegistry::new(),
        }
    }

    fn run(&self, command: Commands) -> ExitCode {
        match command {
            Commands::Inspect(args) => self.run_inspect(args),
            Commands::Extract(args) => self.run_extract(args),
            Commands::Checksum(args) => self.run_checksum(args),
            Commands::Compress(args) => self.run_compress(args),
            Commands::PatchApply(args) => self.run_patch_apply(args),
            Commands::PatchCreate(args) => self.run_patch_create(args),
        }
    }

    fn run_inspect(&self, args: InspectCommand) -> ExitCode {
        let context = self.context(ThreadBudget::Fixed(1));
        if let Some(report) = self.require_existing_path(
            "inspect",
            OperationFamily::Command,
            None,
            &args.source,
            None,
        ) {
            return self.finish("inspect", report);
        }

        if let Some(handler) = self.containers.probe(&args.source) {
            let request = ContainerInspectRequest {
                source: args.source,
            };
            let report = handler.inspect(&request, &context).unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    "inspect",
                    error.to_string(),
                    None,
                )
            });
            return self.finish("inspect", report);
        }

        if let Some(handler) = self.patches.probe(&args.source) {
            let report = handler
                .parse(&args.source, &context)
                .unwrap_or_else(|error| {
                    OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "inspect",
                        error.to_string(),
                        None,
                    )
                });
            return self.finish("inspect", report);
        }

        self.finish(
            "inspect",
            OperationReport::failed(
                OperationFamily::Command,
                None,
                "probe",
                format!("no registered handler matched `{}`", args.source.display()),
                None,
            ),
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

        let request = ContainerExtractRequest {
            source: args.source,
            selections: args.select,
            out_dir: args.out_dir,
        };
        let report = handler.extract(&request, &context).unwrap_or_else(|error| {
            OperationReport::failed(
                OperationFamily::Container,
                Some(handler.descriptor().name.to_string()),
                "extract",
                error.to_string(),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            )
        });
        self.finish("extract", report)
    }

    fn run_checksum(&self, args: ChecksumCommand) -> ExitCode {
        let context = self.context(args.threads);
        let thread_execution =
            Some(context.plan_threads(ThreadCapability::parallel(Some(args.algo.len().max(1)))));
        if let Some(report) = self.require_existing_path(
            "checksum",
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            &args.source,
            thread_execution.clone(),
        ) {
            return self.finish("checksum", report);
        }

        let invalid = args.algo.iter().find(|algo| {
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

        let request = ChecksumRequest {
            source: args.source,
            algorithms: args
                .algo
                .into_iter()
                .map(|algo| algo.to_ascii_lowercase())
                .collect(),
            start: args.start,
            length: args.length,
        };
        let report = if request.start.is_some() || request.length.is_some() {
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
        self.finish("checksum", report)
    }

    fn run_compress(&self, args: CompressCommand) -> ExitCode {
        let context = self.context(args.threads);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        for input in &args.input {
            if let Some(report) = self.require_existing_path(
                "compress",
                OperationFamily::Container,
                Some(args.format.clone()),
                input,
                probe_threads.clone(),
            ) {
                return self.finish("compress", report);
            }
        }

        let Some(handler) = self.containers.find_by_name(&args.format) else {
            return self.finish(
                "compress",
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(args.format),
                    "probe",
                    "requested output format is not registered",
                    probe_threads,
                ),
            );
        };

        if handler.descriptor().name != "chd" {
            if let Some(codec) = args.codec.as_ref() {
                if self.codecs.find_by_name(codec).is_none() {
                    return self.finish(
                        "compress",
                        OperationReport::failed(
                            OperationFamily::Codec,
                            Some(codec.clone()),
                            "validate",
                            format!("unknown codec `{codec}`"),
                            probe_threads.clone(),
                        ),
                    );
                }
            }
        }

        let request = ContainerCreateRequest {
            inputs: args.input,
            output: args.output,
            format: handler.descriptor().name.to_string(),
            codec: args.codec,
            level: args.level,
        };
        let report = handler.create(&request, &context).unwrap_or_else(|error| {
            OperationReport::failed(
                OperationFamily::Container,
                Some(handler.descriptor().name.to_string()),
                "create",
                error.to_string(),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            )
        });
        self.finish("compress", report)
    }

    fn run_patch_apply(&self, args: PatchApplyCommand) -> ExitCode {
        let context = self.context(args.threads);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        if let Some(report) = self.require_existing_path(
            "patch-apply",
            OperationFamily::Patch,
            None,
            &args.input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-apply", report);
        }
        for patch in &args.patch {
            if let Some(report) = self.require_existing_path(
                "patch-apply",
                OperationFamily::Patch,
                None,
                patch,
                probe_threads.clone(),
            ) {
                return self.finish("patch-apply", report);
            }
        }

        let Some(handler) = self.patches.probe(&args.patch[0]) else {
            return self.finish(
                "patch-apply",
                OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "probe",
                    format!(
                        "no registered patch handler matched `{}`",
                        args.patch[0].display()
                    ),
                    probe_threads,
                ),
            );
        };

        let request = PatchApplyRequest {
            input: args.input,
            patches: args.patch,
            output: args.output,
        };
        let report = handler.apply(&request, &context).unwrap_or_else(|error| {
            OperationReport::failed(
                OperationFamily::Patch,
                Some(handler.descriptor().name.to_string()),
                "apply",
                error.to_string(),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            )
        });
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

    fn context(&self, thread_budget: ThreadBudget) -> OperationContext {
        let temp_root = std::env::temp_dir().join("rom-weaver");
        OperationContext::new(
            thread_budget,
            temp_root,
            self.reporter.clone(),
            CancellationToken::new(),
        )
    }

    fn require_existing_path(
        &self,
        _command: &str,
        family: OperationFamily,
        format: Option<String>,
        path: &Path,
        thread_execution: Option<rom_weaver_core::ThreadExecution>,
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
