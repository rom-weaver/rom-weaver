#[cfg(target_arch = "wasm32")]
#[derive(Debug)]
enum WasmCliParseError {
    Message(&'static str),
    UnknownCommand {
        command: String,
    },
    UnknownOption {
        command: &'static str,
        option: String,
    },
    UnexpectedArgument {
        command: &'static str,
        argument: String,
    },
    MissingValue {
        flag: &'static str,
    },
    InvalidU64 {
        flag: &'static str,
        value: String,
    },
    InvalidThreadBudget {
        flag: &'static str,
        value: String,
        source: RomWeaverError,
    },
    InvalidCompressionLevel {
        value: String,
    },
}

#[cfg(target_arch = "wasm32")]
impl std::fmt::Display for WasmCliParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(message) => formatter.write_str(message),
            Self::UnknownCommand { command } => write!(formatter, "unknown command `{command}`"),
            Self::UnknownOption { command, option } => {
                write!(formatter, "unknown {command} option `{option}`")
            }
            Self::UnexpectedArgument { command, argument } => {
                write!(formatter, "unexpected {command} argument `{argument}`")
            }
            Self::MissingValue { flag } => write!(formatter, "missing value for {flag}"),
            Self::InvalidU64 { flag, value } => {
                write!(formatter, "invalid value `{value}` for {flag}")
            }
            Self::InvalidThreadBudget {
                flag,
                value,
                source,
            } => write!(formatter, "invalid value `{value}` for {flag}: {source}"),
            Self::InvalidCompressionLevel { value } => write!(
                formatter,
                "invalid compression level `{value}` (expected: min|very-low|low|medium|high|very-high|max)"
            ),
        }
    }
}

#[cfg(target_arch = "wasm32")]
impl std::error::Error for WasmCliParseError {}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_cli() -> WasmCliParseResult<Cli> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    let mut json = false;
    let mut progress = false;
    let mut no_progress = false;
    let mut trace = false;

    loop {
        let Some(arg) = args.first() else {
            return Err(WasmCliParseError::Message(
                "missing command (inspect|extract|checksum|compress|trim|batch-header-fixer|patch-apply|patch-create)",
            ));
        };
        match arg.as_str() {
            "--json" => {
                json = true;
                args.remove(0);
            }
            "--progress" => {
                if no_progress {
                    return Err(WasmCliParseError::Message(
                        "cannot combine --progress and --no-progress",
                    ));
                }
                progress = true;
                args.remove(0);
            }
            "--no-progress" => {
                if progress {
                    return Err(WasmCliParseError::Message(
                        "cannot combine --progress and --no-progress",
                    ));
                }
                no_progress = true;
                args.remove(0);
            }
            "--trace" => {
                trace = true;
                args.remove(0);
            }
            _ => break,
        }
    }

    if args.is_empty() {
        return Err(WasmCliParseError::Message(
            "missing command (inspect|extract|checksum|compress|trim|batch-header-fixer|patch-apply|patch-create)",
        ));
    }
    let command_name = args.remove(0);
    let command = match command_name.as_str() {
        "inspect" => Commands::Inspect(parse_wasm_inspect(args)?),
        "extract" => Commands::Extract(parse_wasm_extract(args)?),
        "checksum" => Commands::Checksum(parse_wasm_checksum(args)?),
        "compress" => Commands::Compress(parse_wasm_compress(args)?),
        "trim" => Commands::Trim(parse_wasm_trim(args)?),
        "batch-header-fixer" => Commands::BatchHeaderFixer(parse_wasm_batch_header_fixer(args)?),
        "patch-apply" => Commands::PatchApply(parse_wasm_patch_apply(args)?),
        "patch-create" => Commands::PatchCreate(parse_wasm_patch_create(args)?),
        other => {
            return Err(WasmCliParseError::UnknownCommand {
                command: other.to_owned(),
            });
        }
    };
    Ok(Cli {
        json,
        progress,
        no_progress,
        trace,
        command,
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_inspect(args: Vec<String>) -> WasmCliParseResult<InspectCommand> {
    let mut list = false;
    let mut source: Option<PathBuf> = None;
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--list" {
            list = true;
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return Err(WasmCliParseError::UnknownOption {
                command: "inspect",
                option: arg.clone(),
            });
        }
        if source.is_some() {
            return Err(WasmCliParseError::UnexpectedArgument {
                command: "inspect",
                argument: arg.clone(),
            });
        }
        source = Some(PathBuf::from(arg));
        index += 1;
    }
    let source = source.ok_or(WasmCliParseError::Message("inspect requires <source>"))?;
    Ok(InspectCommand { source, list })
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_extract(args: Vec<String>) -> WasmCliParseResult<ExtractCommand> {
    let mut source: Option<PathBuf> = None;
    let mut select = Vec::new();
    let mut out_dir: Option<PathBuf> = None;
    let mut split_bin = false;
    let mut threads = ThreadBudget::Auto;
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("--select=") {
            select.push(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--select" {
            select.push(parse_wasm_required_value(&args, &mut index, "--select")?);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--out-dir=") {
            out_dir = Some(PathBuf::from(value));
            index += 1;
            continue;
        }
        if arg == "--out-dir" {
            out_dir = Some(PathBuf::from(parse_wasm_required_value(
                &args,
                &mut index,
                "--out-dir",
            )?));
            continue;
        }
        if arg == "--split-bin" {
            split_bin = true;
            index += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--threads=") {
            threads = parse_wasm_thread_budget(value, "--threads")?;
            index += 1;
            continue;
        }
        if arg == "--threads" {
            threads = parse_wasm_thread_budget(
                &parse_wasm_required_value(&args, &mut index, "--threads")?,
                "--threads",
            )?;
            continue;
        }
        if arg.starts_with('-') {
            return Err(WasmCliParseError::UnknownOption {
                command: "extract",
                option: arg.clone(),
            });
        }
        if source.is_some() {
            return Err(WasmCliParseError::UnexpectedArgument {
                command: "extract",
                argument: arg.clone(),
            });
        }
        source = Some(PathBuf::from(arg));
        index += 1;
    }

    let source = source.ok_or(WasmCliParseError::Message("extract requires <source>"))?;
    let out_dir = out_dir.ok_or(WasmCliParseError::Message(
        "extract requires --out-dir <path>",
    ))?;
    Ok(ExtractCommand {
        source,
        select,
        out_dir,
        split_bin,
        threads,
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_checksum(args: Vec<String>) -> WasmCliParseResult<ChecksumCommand> {
    let mut source: Option<PathBuf> = None;
    let mut algo = Vec::new();
    let mut select = Vec::new();
    let mut no_extract = false;
    let mut no_ignore = false;
    let mut strip_header = false;
    let mut no_trim_fix = false;
    let mut start: Option<u64> = None;
    let mut length: Option<u64> = None;
    let mut threads = ThreadBudget::Auto;
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("--algo=") {
            algo.push(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--algo" {
            algo.push(parse_wasm_required_value(&args, &mut index, "--algo")?);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--select=") {
            select.push(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--select" {
            select.push(parse_wasm_required_value(&args, &mut index, "--select")?);
            continue;
        }
        if arg == "--no-extract" {
            no_extract = true;
            index += 1;
            continue;
        }
        if arg == "--no-ignore" {
            no_ignore = true;
            index += 1;
            continue;
        }
        if arg == "--strip-header" {
            strip_header = true;
            index += 1;
            continue;
        }
        if arg == "--no-trim-fix" {
            no_trim_fix = true;
            index += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--start=") {
            start = Some(parse_wasm_u64(value, "--start")?);
            index += 1;
            continue;
        }
        if arg == "--start" {
            start = Some(parse_wasm_u64(
                &parse_wasm_required_value(&args, &mut index, "--start")?,
                "--start",
            )?);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--length=") {
            length = Some(parse_wasm_u64(value, "--length")?);
            index += 1;
            continue;
        }
        if arg == "--length" {
            length = Some(parse_wasm_u64(
                &parse_wasm_required_value(&args, &mut index, "--length")?,
                "--length",
            )?);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--threads=") {
            threads = parse_wasm_thread_budget(value, "--threads")?;
            index += 1;
            continue;
        }
        if arg == "--threads" {
            threads = parse_wasm_thread_budget(
                &parse_wasm_required_value(&args, &mut index, "--threads")?,
                "--threads",
            )?;
            continue;
        }
        if arg.starts_with('-') {
            return Err(WasmCliParseError::UnknownOption {
                command: "checksum",
                option: arg.clone(),
            });
        }
        if source.is_some() {
            return Err(WasmCliParseError::UnexpectedArgument {
                command: "checksum",
                argument: arg.clone(),
            });
        }
        source = Some(PathBuf::from(arg));
        index += 1;
    }

    if algo.is_empty() {
        return Err(WasmCliParseError::Message(
            "checksum requires at least one --algo <name>",
        ));
    }
    let source = source.ok_or(WasmCliParseError::Message("checksum requires <source>"))?;
    Ok(ChecksumCommand {
        source,
        algo,
        select,
        no_extract,
        no_ignore,
        strip_header,
        no_trim_fix,
        start,
        length,
        threads,
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_compress(args: Vec<String>) -> WasmCliParseResult<CompressCommand> {
    let mut input = Vec::new();
    let mut format: Option<String> = None;
    let mut output: Option<PathBuf> = None;
    let mut codec = Vec::new();
    let mut level = CompressionLevelProfile::Max;
    let mut threads = ThreadBudget::Auto;
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("--format=") {
            format = Some(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--format" {
            format = Some(parse_wasm_required_value(&args, &mut index, "--format")?);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--output=") {
            output = Some(PathBuf::from(value));
            index += 1;
            continue;
        }
        if arg == "--output" {
            output = Some(PathBuf::from(parse_wasm_required_value(
                &args, &mut index, "--output",
            )?));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--codec=") {
            codec.push(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--codec" {
            codec.push(parse_wasm_required_value(&args, &mut index, "--codec")?);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--level=") {
            level = parse_wasm_compression_level(value)?;
            index += 1;
            continue;
        }
        if arg == "--level" {
            level = parse_wasm_compression_level(&parse_wasm_required_value(
                &args, &mut index, "--level",
            )?)?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--threads=") {
            threads = parse_wasm_thread_budget(value, "--threads")?;
            index += 1;
            continue;
        }
        if arg == "--threads" {
            threads = parse_wasm_thread_budget(
                &parse_wasm_required_value(&args, &mut index, "--threads")?,
                "--threads",
            )?;
            continue;
        }
        if arg.starts_with('-') {
            return Err(WasmCliParseError::UnknownOption {
                command: "compress",
                option: arg.clone(),
            });
        }
        input.push(PathBuf::from(arg));
        index += 1;
    }

    if input.is_empty() {
        return Err(WasmCliParseError::Message(
            "compress requires at least one <input>",
        ));
    }
    let output = output.ok_or(WasmCliParseError::Message(
        "compress requires --output <path>",
    ))?;
    Ok(CompressCommand {
        input,
        format,
        output,
        codec,
        level,
        threads,
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_trim(args: Vec<String>) -> WasmCliParseResult<TrimCommand> {
    let mut source = Vec::new();
    let mut output: Option<PathBuf> = None;
    let mut extension: Option<String> = None;
    let mut in_place = false;
    let mut dry_run = false;
    let mut revert = false;
    let mut recursive = true;
    let mut threads = ThreadBudget::Auto;
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("--output=") {
            output = Some(PathBuf::from(value));
            index += 1;
            continue;
        }
        if arg == "--output" {
            output = Some(PathBuf::from(parse_wasm_required_value(
                &args, &mut index, "--output",
            )?));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--extension=") {
            extension = Some(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--extension" || arg == "-e" {
            extension = Some(parse_wasm_required_value(&args, &mut index, "--extension")?);
            continue;
        }
        if arg == "--in-place" || arg == "--inplace" || arg == "-i" {
            in_place = true;
            index += 1;
            continue;
        }
        if arg == "--simulate" || arg == "--dry-run" || arg == "-s" {
            dry_run = true;
            index += 1;
            continue;
        }
        if arg == "--revert" || arg == "--untrim" || arg == "--restore" {
            revert = true;
            index += 1;
            continue;
        }
        if arg == "--no-recursive" {
            recursive = false;
            index += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--threads=") {
            threads = parse_wasm_thread_budget(value, "--threads")?;
            index += 1;
            continue;
        }
        if arg == "--threads" {
            threads = parse_wasm_thread_budget(
                &parse_wasm_required_value(&args, &mut index, "--threads")?,
                "--threads",
            )?;
            continue;
        }
        if arg.starts_with('-') {
            return Err(WasmCliParseError::UnknownOption {
                command: "trim",
                option: arg.clone(),
            });
        }
        source.push(PathBuf::from(arg));
        index += 1;
    }

    if source.is_empty() {
        return Err(WasmCliParseError::Message(
            "trim requires at least one <source>",
        ));
    }
    if output.is_some() && in_place {
        return Err(WasmCliParseError::Message(
            "trim --output conflicts with --in-place",
        ));
    }

    Ok(TrimCommand {
        source,
        output,
        extension,
        in_place,
        dry_run,
        revert,
        recursive,
        threads,
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_batch_header_fixer(args: Vec<String>) -> WasmCliParseResult<BatchHeaderFixerCommand> {
    let mut source = Vec::new();
    let mut output: Option<PathBuf> = None;
    let mut extension: Option<String> = None;
    let mut in_place = false;
    let mut dry_run = false;
    let mut recursive = true;
    let mut threads = ThreadBudget::Auto;
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("--output=") {
            output = Some(PathBuf::from(value));
            index += 1;
            continue;
        }
        if arg == "--output" {
            output = Some(PathBuf::from(parse_wasm_required_value(
                &args, &mut index, "--output",
            )?));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--extension=") {
            extension = Some(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--extension" || arg == "-e" {
            extension = Some(parse_wasm_required_value(&args, &mut index, "--extension")?);
            continue;
        }
        if arg == "--in-place" || arg == "--inplace" || arg == "-i" {
            in_place = true;
            index += 1;
            continue;
        }
        if arg == "--simulate" || arg == "--dry-run" || arg == "-s" {
            dry_run = true;
            index += 1;
            continue;
        }
        if arg == "--no-recursive" {
            recursive = false;
            index += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--threads=") {
            threads = parse_wasm_thread_budget(value, "--threads")?;
            index += 1;
            continue;
        }
        if arg == "--threads" {
            threads = parse_wasm_thread_budget(
                &parse_wasm_required_value(&args, &mut index, "--threads")?,
                "--threads",
            )?;
            continue;
        }
        if arg.starts_with('-') {
            return Err(WasmCliParseError::UnknownOption {
                command: "batch-header-fixer",
                option: arg.clone(),
            });
        }
        source.push(PathBuf::from(arg));
        index += 1;
    }

    if source.is_empty() {
        return Err(WasmCliParseError::Message(
            "batch-header-fixer requires at least one <source>",
        ));
    }
    if output.is_some() && in_place {
        return Err(WasmCliParseError::Message(
            "batch-header-fixer --output conflicts with --in-place",
        ));
    }

    Ok(BatchHeaderFixerCommand {
        source,
        output,
        extension,
        in_place,
        dry_run,
        recursive,
        threads,
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_patch_apply(args: Vec<String>) -> WasmCliParseResult<PatchApplyCommand> {
    let mut input: Option<PathBuf> = None;
    let mut select = Vec::new();
    let mut no_extract = false;
    let mut no_ignore = false;
    let mut patches = Vec::new();
    let mut output: Option<PathBuf> = None;
    let mut no_compress = false;
    let mut compress_format: Option<String> = None;
    let mut compress_codec = Vec::new();
    let mut compress_level = CompressionLevelProfile::Max;
    let mut checksum_cache = Vec::new();
    let mut validate_with_checksums = Vec::new();
    let mut strip_header = false;
    let mut add_header = false;
    let mut repair_checksum = false;
    let mut ignore_checksum_validation = false;
    let mut threads = ThreadBudget::Auto;

    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("--input=") {
            input = Some(PathBuf::from(value));
            index += 1;
            continue;
        }
        if arg == "--input" {
            input = Some(PathBuf::from(parse_wasm_required_value(
                &args, &mut index, "--input",
            )?));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--select=") {
            select.push(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--select" {
            select.push(parse_wasm_required_value(&args, &mut index, "--select")?);
            continue;
        }
        if arg == "--no-extract" {
            no_extract = true;
            index += 1;
            continue;
        }
        if arg == "--no-ignore" {
            no_ignore = true;
            index += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--patch=") {
            patches.push(PathBuf::from(value));
            index += 1;
            continue;
        }
        if arg == "--patch" {
            patches.push(PathBuf::from(parse_wasm_required_value(
                &args, &mut index, "--patch",
            )?));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--output=") {
            output = Some(PathBuf::from(value));
            index += 1;
            continue;
        }
        if arg == "--output" {
            output = Some(PathBuf::from(parse_wasm_required_value(
                &args, &mut index, "--output",
            )?));
            continue;
        }
        if arg == "--no-compress" {
            no_compress = true;
            index += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--compress-format=") {
            compress_format = Some(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--compress-format" {
            compress_format = Some(parse_wasm_required_value(
                &args,
                &mut index,
                "--compress-format",
            )?);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--compress-codec=") {
            compress_codec.push(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--compress-codec" {
            compress_codec.push(parse_wasm_required_value(
                &args,
                &mut index,
                "--compress-codec",
            )?);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--compress-level=") {
            compress_level = parse_wasm_compression_level(value)?;
            index += 1;
            continue;
        }
        if arg == "--compress-level" {
            compress_level = parse_wasm_compression_level(&parse_wasm_required_value(
                &args,
                &mut index,
                "--compress-level",
            )?)?;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--checksum-cache=") {
            checksum_cache.push(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--checksum-cache" {
            checksum_cache.push(parse_wasm_required_value(
                &args,
                &mut index,
                "--checksum-cache",
            )?);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--validate-with-checksum=") {
            validate_with_checksums.push(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--validate-with-checksum" {
            validate_with_checksums.push(parse_wasm_required_value(
                &args,
                &mut index,
                "--validate-with-checksum",
            )?);
            continue;
        }
        if arg == "--strip-header" {
            strip_header = true;
            index += 1;
            continue;
        }
        if arg == "--add-header" {
            add_header = true;
            index += 1;
            continue;
        }
        if arg == "--repair-checksum" {
            repair_checksum = true;
            index += 1;
            continue;
        }
        if arg == "--ignore-checksum-validation" {
            ignore_checksum_validation = true;
            index += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--threads=") {
            threads = parse_wasm_thread_budget(value, "--threads")?;
            index += 1;
            continue;
        }
        if arg == "--threads" {
            threads = parse_wasm_thread_budget(
                &parse_wasm_required_value(&args, &mut index, "--threads")?,
                "--threads",
            )?;
            continue;
        }
        if arg.starts_with('-') {
            return Err(WasmCliParseError::UnknownOption {
                command: "patch-apply",
                option: arg.clone(),
            });
        }
        return Err(WasmCliParseError::UnexpectedArgument {
            command: "patch-apply",
            argument: arg.clone(),
        });
    }

    let input = input.ok_or(WasmCliParseError::Message(
        "patch-apply requires --input <path>",
    ))?;
    if patches.is_empty() {
        return Err(WasmCliParseError::Message(
            "patch-apply requires at least one --patch <path>",
        ));
    }
    let output = output.ok_or(WasmCliParseError::Message(
        "patch-apply requires --output <path>",
    ))?;
    Ok(PatchApplyCommand {
        input,
        select,
        no_extract,
        no_ignore,
        patches,
        output,
        no_compress,
        compress_format,
        compress_codec,
        compress_level,
        checksum_cache,
        validate_with_checksums,
        strip_header,
        add_header,
        repair_checksum,
        ignore_checksum_validation,
        threads,
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_patch_create(args: Vec<String>) -> WasmCliParseResult<PatchCreateCommand> {
    let mut original: Option<PathBuf> = None;
    let mut modified: Option<PathBuf> = None;
    let mut format: Option<String> = None;
    let mut output: Option<PathBuf> = None;
    let mut ignore_checksum_validation = false;
    let mut threads = ThreadBudget::Auto;
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if let Some(value) = arg.strip_prefix("--original=") {
            original = Some(PathBuf::from(value));
            index += 1;
            continue;
        }
        if arg == "--original" {
            original = Some(PathBuf::from(parse_wasm_required_value(
                &args,
                &mut index,
                "--original",
            )?));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--modified=") {
            modified = Some(PathBuf::from(value));
            index += 1;
            continue;
        }
        if arg == "--modified" {
            modified = Some(PathBuf::from(parse_wasm_required_value(
                &args,
                &mut index,
                "--modified",
            )?));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--format=") {
            format = Some(value.to_string());
            index += 1;
            continue;
        }
        if arg == "--format" {
            format = Some(parse_wasm_required_value(&args, &mut index, "--format")?);
            continue;
        }
        if let Some(value) = arg.strip_prefix("--output=") {
            output = Some(PathBuf::from(value));
            index += 1;
            continue;
        }
        if arg == "--output" {
            output = Some(PathBuf::from(parse_wasm_required_value(
                &args, &mut index, "--output",
            )?));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--threads=") {
            threads = parse_wasm_thread_budget(value, "--threads")?;
            index += 1;
            continue;
        }
        if arg == "--ignore-checksum-validation" {
            ignore_checksum_validation = true;
            index += 1;
            continue;
        }
        if arg == "--threads" {
            threads = parse_wasm_thread_budget(
                &parse_wasm_required_value(&args, &mut index, "--threads")?,
                "--threads",
            )?;
            continue;
        }
        if arg.starts_with('-') {
            return Err(WasmCliParseError::UnknownOption {
                command: "patch-create",
                option: arg.clone(),
            });
        }
        return Err(WasmCliParseError::UnexpectedArgument {
            command: "patch-create",
            argument: arg.clone(),
        });
    }
    let original = original.ok_or(WasmCliParseError::Message(
        "patch-create requires --original <path>",
    ))?;
    let modified = modified.ok_or(WasmCliParseError::Message(
        "patch-create requires --modified <path>",
    ))?;
    let format = format.ok_or(WasmCliParseError::Message(
        "patch-create requires --format <name>",
    ))?;
    let output = output.ok_or(WasmCliParseError::Message(
        "patch-create requires --output <path>",
    ))?;
    Ok(PatchCreateCommand {
        original,
        modified,
        format,
        output,
        ignore_checksum_validation,
        threads,
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_required_value(
    args: &[String],
    index: &mut usize,
    flag: &'static str,
) -> WasmCliParseResult<String> {
    *index += 1;
    if *index >= args.len() {
        return Err(WasmCliParseError::MissingValue { flag });
    }
    let value = args[*index].clone();
    *index += 1;
    Ok(value)
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_u64(value: &str, flag: &'static str) -> WasmCliParseResult<u64> {
    value
        .parse::<u64>()
        .map_err(|_| WasmCliParseError::InvalidU64 {
            flag,
            value: value.to_owned(),
        })
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_thread_budget(value: &str, flag: &'static str) -> WasmCliParseResult<ThreadBudget> {
    value
        .parse::<ThreadBudget>()
        .map_err(|source| WasmCliParseError::InvalidThreadBudget {
            flag,
            value: value.to_owned(),
            source,
        })
}

#[cfg(target_arch = "wasm32")]
fn parse_wasm_compression_level(value: &str) -> WasmCliParseResult<CompressionLevelProfile> {
    match value {
        "min" => Ok(CompressionLevelProfile::Min),
        "very-low" => Ok(CompressionLevelProfile::VeryLow),
        "low" => Ok(CompressionLevelProfile::Low),
        "medium" => Ok(CompressionLevelProfile::Medium),
        "high" => Ok(CompressionLevelProfile::High),
        "very-high" => Ok(CompressionLevelProfile::VeryHigh),
        "max" => Ok(CompressionLevelProfile::Max),
        _ => Err(WasmCliParseError::InvalidCompressionLevel {
            value: value.to_owned(),
        }),
    }
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
                        "rom_weaver_cli=trace,rom_weaver_core=trace,rom_weaver_containers=trace,rom_weaver_patches=trace,rom_weaver_checksum=trace,rom_weaver_codecs=trace"
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
                eprintln!(
                    "warning: invalid trace filter `{filter_spec}` ({error}); using `off`"
                );
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

