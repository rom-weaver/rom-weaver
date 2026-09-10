use std::{
    fs::{self, File},
    io::{self, IsTerminal, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use rom_weaver_core::{
    OperationStatus, ProgressEvent, ProgressSink, SelectionPrompter, process_cancellation_token,
};
use tracing::trace;

use crate::{
    Commands, PatchCommands, Result, RomWeaverError, RunCommandOptions, SaveCommands,
    ToolsCommands, run_command_outcome,
};

pub(crate) fn decorate(command: clap::Command) -> clap::Command {
    let command = ["extract", "compress"].into_iter().fold(command, |command, name| {
        command.mut_subcommand(name, |command| {
            command
                .arg(clap::Arg::new("stdin_name").long("stdin-name").value_name("NAME")
                    .help("Filename for input - (default: stdin.bin); one filename, no directories"))
                .mut_arg("input", |arg| arg.help("Input path; - reads stdin using a temporary file"))
                .mut_arg("output", |arg| arg.help("Output path; - writes one binary result to stdout (compress requires --format)"))
        })
    });
    command
        .mut_subcommand("trim", decorate_output)
        .mut_subcommand("weave", decorate_output)
        .mut_subcommand("patch", |command| {
            command
                .mut_subcommand("apply", decorate_output)
                .mut_subcommand("create", decorate_output)
        })
        .mut_subcommand("save", |command| {
            command.mut_subcommand("set", decorate_output)
        })
        .mut_subcommand("tools", |command| {
            command.mut_subcommand("ppf-undo", decorate_output)
        })
}

fn decorate_output(command: clap::Command) -> clap::Command {
    command.mut_arg("output", |arg| {
        arg.help("Output path; - writes one completed binary file to stdout")
    })
}

fn stdin_count(command: &Commands) -> usize {
    match command {
        Commands::Extract(args) => usize::from(args.input == Path::new("-")),
        Commands::Compress(args) => args
            .input
            .iter()
            .filter(|path| *path == Path::new("-"))
            .count(),
        _ => 0,
    }
}

fn stdout_requested(command: &Commands) -> bool {
    match command {
        Commands::Extract(args) => args.output == Path::new("-"),
        Commands::Compress(args) => args.output == Path::new("-"),
        Commands::Patch(PatchCommands::Apply(args)) => {
            args.output.as_deref() == Some(Path::new("-"))
        }
        Commands::Patch(PatchCommands::Create(args)) => {
            args.output.as_deref() == Some(Path::new("-"))
        }
        Commands::Trim(args) => args.output.as_deref() == Some(Path::new("-")),
        Commands::Save(SaveCommands::Set(args)) => args.output.as_deref() == Some(Path::new("-")),
        Commands::Tools(ToolsCommands::PpfUndo(args)) => args.output == Path::new("-"),
        _ => false,
    }
}

pub(crate) fn handles(command: &Commands, stdin_name: Option<&str>) -> bool {
    stdin_count(command) != 0 || stdout_requested(command) || stdin_name.is_some()
}

pub(crate) fn run(
    command: Commands,
    options: RunCommandOptions,
    reporter: Arc<dyn ProgressSink>,
    prompter: Arc<dyn SelectionPrompter>,
    stdin_name: Option<&str>,
) -> ExitCode {
    if let Err(error) = validate(&command, &options, stdin_name) {
        eprintln!("error: {error}");
        return ExitCode::from(2);
    }
    crate::init_logging(options.log_level, options.dep_trace, options.json);
    match run_staged(
        command,
        options,
        reporter,
        prompter,
        stdin_name.unwrap_or("stdin.bin"),
    ) {
        Ok(status) => status,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn invalid(message: &str) -> RomWeaverError {
    RomWeaverError::Validation(message.to_string())
}

fn validate(command: &Commands, options: &RunCommandOptions, name: Option<&str>) -> Result<()> {
    let inputs = stdin_count(command);
    if inputs > 1 {
        return Err(invalid("stdin can be used only once; give one input -"));
    }
    if let Some(name) = name {
        if inputs == 0 {
            return Err(invalid("--stdin-name requires input -"));
        }
        if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', ':']) {
            return Err(invalid(
                "--stdin-name must be one filename, without directory components",
            ));
        }
    }
    if inputs != 0 && options.dry_run {
        return Err(invalid("--dry-run cannot read stdin; use an input file"));
    }
    if !stdout_requested(command) {
        return Ok(());
    }
    if options.json || options.dry_run {
        return Err(invalid(
            "output - cannot be combined with --json or --dry-run",
        ));
    }
    if io::stdout().is_terminal() {
        return Err(invalid(
            "refusing to write binary data to a terminal; redirect stdout or use an output path",
        ));
    }
    if let Commands::Compress(args) = command
        && args
            .format
            .as_ref()
            .is_none_or(|format| format.trim().is_empty())
    {
        return Err(invalid("compress output - requires --format FORMAT"));
    }
    match command {
        Commands::Patch(PatchCommands::Create(args)) => {
            if args.plan || args.checksum_name {
                return Err(invalid(
                    "patch create output - cannot use --plan or --checksum-name",
                ));
            }
            if args
                .format
                .as_ref()
                .is_none_or(|format| format.trim().is_empty())
            {
                return Err(invalid("patch create output - requires --format FORMAT"));
            }
        }
        Commands::Patch(PatchCommands::Apply(args)) => {
            if args.tui || args.emit_bundle.is_some() {
                return Err(invalid(
                    "patch apply output - cannot use --tui or --emit-bundle",
                ));
            }
            if !args.no_compress && args.compress_format.is_none() {
                return Err(invalid(
                    "patch apply output - requires --no-compress or --compress-format FORMAT",
                ));
            }
        }
        Commands::Trim(args) if args.in_place || args.extension.is_some() => {
            return Err(invalid(
                "trim output - cannot use --in-place or --extension",
            ));
        }
        Commands::Save(SaveCommands::Set(args)) if args.dry_run => {
            return Err(invalid("output - cannot be combined with --dry-run"));
        }
        _ => {}
    }
    Ok(())
}

fn run_staged(
    mut command: Commands,
    mut options: RunCommandOptions,
    reporter: Arc<dyn ProgressSink>,
    prompter: Arc<dyn SelectionPrompter>,
    stdin_name: &str,
) -> Result<ExitCode> {
    let binary_stdout = stdout_requested(&command);
    let stdin = stdin_count(&command) != 0;
    let staging = StagingDir::new()?;
    if stdin {
        let input_dir = staging.0.join("input");
        fs::create_dir(&input_dir)?;
        let path = input_dir.join(stdin_name);
        trace!(path = %path.display(), "spooling stream input");
        let mut output = File::create_new(&path)?;
        copy_cancelable(&mut io::stdin().lock(), &mut output)?;
        drop(output);
        match &mut command {
            Commands::Extract(args) => args.input = path,
            Commands::Compress(args) => {
                for input in &mut args.input {
                    if input == Path::new("-") {
                        *input = path.clone();
                    }
                }
            }
            _ => unreachable!("only extract and compress accept stream inputs"),
        }
    }
    if !binary_stdout {
        return Ok(ExitCode::from(
            run_command_outcome(command, options, reporter, prompter).exit_code,
        ));
    }

    options.interactive_selection_enabled = false;
    let out_dir = staging.0.join("output");
    fs::create_dir(&out_dir)?;
    let payload = out_dir.join("payload");
    let mut fallback = None;
    let mut unchanged_save = None;
    match &mut command {
        Commands::Extract(args) => args.output = out_dir.clone(),
        Commands::Compress(args) => args.output = payload.clone(),
        Commands::Patch(PatchCommands::Apply(args)) => args.output = Some(payload.clone()),
        Commands::Patch(PatchCommands::Create(args)) => {
            args.output = Some(payload.clone());
            fallback = Some(payload.clone());
        }
        Commands::Trim(args) => {
            args.output = Some(payload.clone());
            fallback = Some(payload.clone());
        }
        Commands::Save(SaveCommands::Set(args)) => {
            unchanged_save = Some(args.input.clone());
            args.output = Some(payload.clone());
            fallback = Some(payload.clone());
        }
        Commands::Tools(ToolsCommands::PpfUndo(args)) => {
            args.output = payload.clone();
            fallback = Some(payload.clone());
        }
        _ => unreachable!("stream outputs are checked before staging"),
    }
    let terminal = Arc::new(Mutex::new(None));
    let sink = Arc::new(BinaryProgressSink {
        reporter,
        terminal: Arc::clone(&terminal),
    });
    let outcome = run_command_outcome(command, options, sink, prompter);
    if outcome.exit_code != 0 {
        return Ok(ExitCode::from(outcome.exit_code));
    }
    let terminal = terminal.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(input) = unchanged_save
        && terminal
            .as_ref()
            .and_then(|event: &ProgressEvent| event.details.as_ref())
            .and_then(|details| details.pointer("/save_editor/result/preview/changed"))
            .and_then(serde_json::Value::as_bool)
            == Some(false)
    {
        let mut source = File::open(input)?;
        let mut output = File::create_new(&payload)?;
        copy_cancelable(&mut source, &mut output)?;
    }
    let fallback_files = fallback.map(|path| vec![serde_json::json!({ "path": path })]);
    let files = terminal
        .as_ref()
        .and_then(|event: &ProgressEvent| event.details.as_ref())
        .and_then(|details| details.get("emitted_files"))
        .and_then(serde_json::Value::as_array)
        .or(fallback_files.as_ref())
        .ok_or_else(|| invalid("output - needs a reported output file"))?;
    if files.len() != 1 {
        return Err(invalid(
            "output - requires exactly one final file; use --select for one archive member or an output directory",
        ));
    }
    let path = files[0]
        .get("path")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| invalid("output - needs a reported output path"))?;
    let path = fs::canonicalize(path)?;
    if !path.starts_with(fs::canonicalize(&out_dir)?) || !path.is_file() {
        return Err(invalid(
            "output - requires a regular file inside the output directory",
        ));
    }
    if path.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("cue") || extension.eq_ignore_ascii_case("gdi")
    }) {
        return Err(invalid(
            "disc sheets need companion files; use an output directory",
        ));
    }
    trace!(path = %path.display(), "copying completed binary output to stdout");
    let mut source = File::open(path)?;
    match copy_cancelable(&mut source, &mut io::stdout().lock()) {
        Ok(()) => Ok(ExitCode::SUCCESS),
        Err(RomWeaverError::Io(error)) if error.kind() == io::ErrorKind::BrokenPipe => {
            Ok(ExitCode::SUCCESS)
        }
        Err(error) => Err(error),
    }
}

fn copy_cancelable(input: &mut impl Read, output: &mut impl Write) -> Result<()> {
    let token = process_cancellation_token();
    let mut buffer = [0; 64 * 1024];
    loop {
        token.check()?;
        let count = match input.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            output.flush()?;
            return Ok(());
        }
        output.write_all(&buffer[..count])?;
    }
}

struct BinaryProgressSink {
    reporter: Arc<dyn ProgressSink>,
    terminal: Arc<Mutex<Option<ProgressEvent>>>,
}

impl ProgressSink for BinaryProgressSink {
    fn emit(&self, event: ProgressEvent) {
        if event.status == OperationStatus::Succeeded {
            if matches!(
                event.command.as_str(),
                "extract"
                    | "compress"
                    | "patch-apply"
                    | "patch-create"
                    | "trim"
                    | "save-set"
                    | "tools-ppf-undo"
            ) {
                *self
                    .terminal
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(event);
            }
            return;
        }
        self.reporter.emit(event);
    }
}

struct StagingDir(PathBuf);

impl StagingDir {
    fn new() -> Result<Self> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        loop {
            let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "rom-weaver-stream-{}-{sequence}",
                std::process::id()
            ));
            match builder.create(&path) {
                Ok(()) => {
                    trace!(path = %path.display(), "created private stream staging directory");
                    return Ok(Self(path));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
    }
}

impl Drop for StagingDir {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            tracing::warn!(path = %self.0.display(), %error, "failed to remove stream staging directory");
        }
    }
}
