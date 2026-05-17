use std::{
    collections::{HashSet, VecDeque},
    fs,
    fs::File,
    io::{self, BufReader, BufWriter, Read, Write},
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
    format: String,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    codec: Option<String>,
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
const ROM_HEADER_BYTES: usize = 512;
const GAME_BOY_NINTENDO_LOGO: [u8; 48] = [
    0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00, 0x0D,
    0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E, 0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD, 0xD9, 0x99,
    0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC, 0xDD, 0xDC, 0x99, 0x9F, 0xBB, 0xB9, 0x33, 0x3E,
];

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
        let source = args.source.clone();
        if let Some(report) =
            self.require_existing_path("inspect", OperationFamily::Command, None, &source, None)
        {
            return self.finish("inspect", report);
        }

        if let Some(handler) = self.containers.probe(&source) {
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
            return self.finish("inspect", report);
        }

        if let Some(handler) = self.patches.probe(&source) {
            if args.list {
                return self.finish(
                    "inspect",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "list",
                        "inspect --list is only supported for container formats",
                        None,
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
            return self.finish("inspect", report);
        }

        self.finish(
            "inspect",
            OperationReport::failed(
                OperationFamily::Command,
                None,
                "probe",
                format!("no registered handler matched `{}`", source.display()),
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

        let mut temp_paths = Vec::new();
        let checksum_source = if strip_header {
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

        let context = self.context(threads);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        for input in &input {
            if let Some(report) = self.require_existing_path(
                "compress",
                OperationFamily::Container,
                Some(format.clone()),
                input,
                probe_threads.clone(),
            ) {
                return self.finish("compress", report);
            }
        }

        let (codec, level) = match Self::resolve_codec_level(codec) {
            Ok(value) => value,
            Err(error) => {
                return self.finish(
                    "compress",
                    OperationReport::failed(
                        OperationFamily::Container,
                        Some(format.clone()),
                        "validate",
                        error.to_string(),
                        probe_threads,
                    ),
                );
            }
        };

        let Some(handler) = self.containers.find_by_name(&format) else {
            return self.finish(
                "compress",
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(format),
                    "probe",
                    "requested output format is not registered",
                    probe_threads,
                ),
            );
        };

        let request = ContainerCreateRequest {
            inputs: input,
            output,
            format: handler.descriptor().name.to_string(),
            codec,
            level,
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
        let PatchApplyCommand {
            input,
            patch,
            output,
            strip_header,
            add_header,
            repair_checksum,
            threads,
        } = args;
        let context = self.context(threads);
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
