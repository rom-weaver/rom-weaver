use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    process::ExitCode,
    sync::Arc,
};

use clap::{Args, Parser, Subcommand};
use rom_weaver_checksum::{NativeChecksumEngine, supported_algorithms};
use rom_weaver_containers::ContainerRegistry;
use rom_weaver_core::{
    CancellationToken, ChecksumEngine, ChecksumRequest, ContainerCreateRequest,
    ContainerExtractRequest, ContainerInspectRequest, OperationContext, OperationFamily,
    OperationReport, OperationStatus, PatchApplyRequest, PatchCreateRequest, ProgressEvent,
    ProgressSink, Result, RomWeaverError, ThreadBudget, ThreadCapability,
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
}

const MAX_NESTED_EXTRACT_DEPTH: usize = 8;
const MAX_NESTED_EXTRACT_ARCHIVES: usize = 256;

impl CliApp {
    fn new(reporter: Arc<dyn ProgressSink>) -> Self {
        Self {
            reporter,
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

        let source = args.source;
        let out_dir = args.out_dir;
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
