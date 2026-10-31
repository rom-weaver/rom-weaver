use super::cheats_apply::CheatApplySummary;
use super::*;

use rom_weaver_core::{PatchHandler, format_human_bytes};
use rom_weaver_patches::{BPS_CREATE_MAX_COMBINED_INPUT_BYTES, bps_create_inputs_fit};

use super::patch_commands::{
    CREATE_PATCH_ARCHIVE_DEFAULT_EXTENSIONS, CREATE_PATCH_ARCHIVE_DEFAULT_LIMIT_BYTES,
    CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES, CREATE_PATCH_DEFAULT_FORMAT, CREATE_PATCH_FORMAT_ALIASES,
    CREATE_PATCH_IPS_SIZE_LIMIT_BYTES, CREATE_PATCH_LARGE_DEFAULT_FORMAT,
    CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES, CREATE_PATCH_SPECIAL_COMPRESSION_EXTENSIONS,
    LARGE_CREATE_PATCH_FORMATS, MEDIUM_CREATE_PATCH_FORMATS, MID_LARGE_CREATE_PATCH_FORMATS,
    NO_SHRINK_CREATE_PATCH_FORMATS, PatchCreateFormatCandidates, PatchCreateInputInfo,
    PatchCreateInputSizes, PatchCreateSourceInfo, SMALL_CREATE_PATCH_FORMATS,
};

/// Validated output, context, and format for a non-plan `patch create`.
struct PatchCreateSetup {
    output: PathBuf,
    context: OperationContext,
    requested_format: String,
    format_warning: Option<String>,
}

fn solid_create_options(args: &PatchCreateCommand) -> Option<PatchCreateFormatOptions> {
    let extended = args.solid_extended
        || args.solid_version.is_some()
        || args.solid_author.is_some()
        || args.solid_contact.is_some()
        || args.solid_comment.is_some();
    let supplied = extended
        || args.solid_system.is_some()
        || args.solid_game.is_some()
        || args.solid_hack.is_some();
    supplied.then(|| {
        PatchCreateFormatOptions::Solid(SolidPatchMetadata {
            system: args.solid_system.clone(),
            game: args.solid_game.clone(),
            hack: args.solid_hack.clone(),
            version: args.solid_version.clone(),
            author: args.solid_author.clone(),
            contact: args.solid_contact.clone(),
            comment: args.solid_comment.clone(),
            extended,
        })
    })
}

/// An extended SOLID header with no comment gets the code list, so a cheat
/// patch says what it does without a sidecar. A caller-supplied comment wins.
fn fill_solid_comment_with_codes(
    options: Option<&mut PatchCreateFormatOptions>,
    summary: Option<&CheatApplySummary>,
    codes: &[String],
) {
    if let Some(PatchCreateFormatOptions::Solid(metadata)) = options
        && let Some(summary) = summary
        && !codes.is_empty()
        && metadata.extended
        && metadata.comment.is_none()
    {
        metadata.comment = Some(summary.comment(codes));
    }
}

pub(super) fn normalize_create_patch_format(format: &str) -> String {
    let normalized = format.trim().to_ascii_lowercase();
    match CREATE_PATCH_FORMAT_ALIASES
        .iter()
        .find(|(alias, _canonical)| normalized == *alias)
    {
        Some((_alias, canonical)) => (*canonical).to_string(),
        None => normalized,
    }
}

pub(super) fn max_create_patch_input_size(sizes: PatchCreateInputSizes) -> u64 {
    sizes.original.max(sizes.modified)
}

pub(super) fn create_patch_input_sizes(info: &PatchCreateInputInfo) -> PatchCreateInputSizes {
    PatchCreateInputSizes {
        original: info.original.size,
        modified: info.modified.size,
    }
}

pub(super) fn create_patch_formats_for_sizes(sizes: PatchCreateInputSizes) -> Vec<&'static str> {
    let max_size = max_create_patch_input_size(sizes);
    let mut formats = if max_size > CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES {
        LARGE_CREATE_PATCH_FORMATS
    } else if max_size >= CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES {
        MID_LARGE_CREATE_PATCH_FORMATS
    } else if max_size >= CREATE_PATCH_IPS_SIZE_LIMIT_BYTES {
        MEDIUM_CREATE_PATCH_FORMATS
    } else {
        SMALL_CREATE_PATCH_FORMATS
    }
    .to_vec();
    if !bps_create_inputs_fit(sizes.original, sizes.modified) {
        debug!("patch create formats drop bps: inputs exceed its suffix-index memory budget");
        formats.retain(|format| *format != "bps");
    }
    formats
}

/// MOD (pmsr) patches can only apply to Paper Mario (USA) v1.0, so the plan lists the format
/// only for that exact original. The CRC32 is read only when the size already matches.
fn original_is_paper_mario_usa10(original: &Path, size: u64) -> bool {
    const PAPER_MARIO_USA10_SIZE: u64 = 41_943_040;
    const PAPER_MARIO_USA10_CRC32: u32 = 0xA7F5_CD7E;
    if size != PAPER_MARIO_USA10_SIZE {
        return false;
    }
    let Ok(mut file) = fs::File::open(original) else {
        return false;
    };
    let mut hasher = crc32fast::Hasher::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        match rom_weaver_core::read_full(&mut file, &mut buffer) {
            Ok(0) => break,
            Ok(read) => hasher.update(&buffer[..read]),
            Err(_) => return false,
        }
    }
    hasher.finalize() == PAPER_MARIO_USA10_CRC32
}

pub(super) fn create_patch_source_matches_extension(path: &Path, extensions: &[&str]) -> bool {
    let normalized_path = path.to_string_lossy().to_ascii_lowercase();
    extensions
        .iter()
        .any(|extension| normalized_path.ends_with(extension))
}

pub(super) fn create_patch_default_format_for_sources(info: &PatchCreateInputInfo) -> &'static str {
    let sources = [&info.original, &info.modified];
    if sources.iter().any(|source| source.special_compression)
        || sources
            .iter()
            .any(|source| source.archive && source.size > CREATE_PATCH_ARCHIVE_DEFAULT_LIMIT_BYTES)
    {
        return CREATE_PATCH_LARGE_DEFAULT_FORMAT;
    }
    let sizes = create_patch_input_sizes(info);
    if max_create_patch_input_size(sizes) < CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES
        && bps_create_inputs_fit(sizes.original, sizes.modified)
    {
        CREATE_PATCH_DEFAULT_FORMAT
    } else {
        CREATE_PATCH_LARGE_DEFAULT_FORMAT
    }
}

pub(super) fn create_patch_format_candidates_for_sources(
    info: &PatchCreateInputInfo,
) -> PatchCreateFormatCandidates {
    PatchCreateFormatCandidates {
        formats: create_patch_formats_for_sizes(create_patch_input_sizes(info)),
        default_format: create_patch_default_format_for_sources(info),
    }
}

pub(super) fn create_patch_format_size_error_message(
    format: &str,
    sizes: PatchCreateInputSizes,
) -> Option<String> {
    let normalized_format = normalize_create_patch_format(format);
    let max_size = max_create_patch_input_size(sizes);
    if matches!(normalized_format.as_str(), "ips" | "ips32" | "ebp")
        && max_size >= CREATE_PATCH_IPS_SIZE_LIMIT_BYTES
    {
        let limit = format_human_bytes(CREATE_PATCH_IPS_SIZE_LIMIT_BYTES);
        return Some(format!(
            "Create inputs at or above {limit} should use BPS, xdelta, or another large-capable patch type; selected patch type: {normalized_format}"
        ));
    }
    if sizes.modified < sizes.original
        && NO_SHRINK_CREATE_PATCH_FORMATS.contains(&normalized_format.as_str())
    {
        return Some(format!(
            "{} patches cannot shrink the output (original: {}, modified: {}); use BPS, xdelta, or another patch type that can; selected patch type: {normalized_format}",
            normalized_format.to_ascii_uppercase(),
            sizes.original,
            sizes.modified
        ));
    }
    if max_size > CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES
        && !matches!(normalized_format.as_str(), "xdelta" | "vcdiff" | "ppf")
    {
        let limit = format_human_bytes(CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES);
        return Some(format!(
            "Create inputs above {limit} require xdelta, VCDIFF, or PPF patches; selected patch type: {normalized_format}"
        ));
    }
    if normalized_format == "bps" && !bps_create_inputs_fit(sizes.original, sizes.modified) {
        return Some(format!(
            "BPS patches can be created only when the original and modified files total at most {BPS_CREATE_MAX_COMBINED_INPUT_BYTES} bytes; these total {} bytes (original: {}, modified: {}); use xdelta instead; selected patch type: {normalized_format}",
            sizes.original.saturating_add(sizes.modified),
            sizes.original,
            sizes.modified
        ));
    }
    None
}

impl CliApp {
    pub(super) fn inspect_patch_create_input_sizes(
        &self,
        command: &str,
        format: Option<String>,
        original: &Path,
        modified: &Path,
        thread_execution: Option<ThreadExecution>,
    ) -> std::result::Result<PatchCreateInputSizes, Box<OperationReport>> {
        let inspect = |role: &str, path: &Path| -> std::result::Result<u64, Box<OperationReport>> {
            let fail = |message: String| {
                Box::new(
                    OperationReport::failed(
                        OperationFamily::Patch,
                        format.clone(),
                        "validate",
                        message,
                        thread_execution.clone(),
                    )
                    .with_error_kind(rom_weaver_core::RomWeaverErrorKind::Io),
                )
            };
            let metadata = fs::metadata(path).map_err(|error| {
                fail(format!(
                    "failed to inspect {command} {role} input `{}`: {error}",
                    path.display()
                ))
            })?;
            // Creation sizes and re-reads its inputs, so a pipe or device would
            // report size 0 and yield a wrong patch or a partial output.
            if !metadata.is_file() {
                debug!(role, path = %path.display(), "patch create rejected a non-regular input");
                return Err(fail(format!(
                    "{command} {role} input `{}` is not a regular file; patch create needs seekable inputs, so write the stream to a file first",
                    path.display()
                )));
            }
            Ok(metadata.len())
        };
        let original_size = inspect("original", original)?;
        let modified_size = inspect("modified", modified)?;
        Ok(PatchCreateInputSizes {
            original: original_size,
            modified: modified_size,
        })
    }

    pub(super) fn inspect_patch_create_input_info(
        &self,
        command: &str,
        format: Option<String>,
        original: &Path,
        modified: &Path,
        thread_execution: Option<ThreadExecution>,
    ) -> std::result::Result<PatchCreateInputInfo, Box<OperationReport>> {
        let sizes = self.inspect_patch_create_input_sizes(
            command,
            format,
            original,
            modified,
            thread_execution,
        )?;
        Ok(PatchCreateInputInfo {
            original: PatchCreateSourceInfo {
                archive: create_patch_source_matches_extension(
                    original,
                    CREATE_PATCH_ARCHIVE_DEFAULT_EXTENSIONS,
                ),
                size: sizes.original,
                special_compression: create_patch_source_matches_extension(
                    original,
                    CREATE_PATCH_SPECIAL_COMPRESSION_EXTENSIONS,
                ),
            },
            modified: PatchCreateSourceInfo {
                archive: create_patch_source_matches_extension(
                    modified,
                    CREATE_PATCH_ARCHIVE_DEFAULT_EXTENSIONS,
                ),
                size: sizes.modified,
                special_compression: create_patch_source_matches_extension(
                    modified,
                    CREATE_PATCH_SPECIAL_COMPRESSION_EXTENSIONS,
                ),
            },
        })
    }
    /// Resolve the patch format for `patch create` from an explicit `--format` and/or the output
    /// extension, mirroring [`CliApp::resolve_container_output_format`]: the extension is
    /// authoritative when no flag is given; an explicit flag wins (with a warning) when it disagrees
    /// with the extension; and an extensionless output with no flag is an error. The resolved name
    /// is normalized via [`normalize_create_patch_format`]; capability/registration checks stay in
    /// the caller so the existing patch-create error messages are reused.
    pub(super) fn resolve_patch_create_format(
        &self,
        flag: Option<&str>,
        output: &Path,
    ) -> Result<FormatResolution> {
        let normalized_flag = flag.map(normalize_create_patch_format);
        let flag_canonical_name = normalized_flag.as_deref().and_then(|flag| {
            self.patches
                .find_by_name(flag)
                .map(|handler| handler.descriptor().name.to_string())
        });
        let extension_name = self
            .patches
            .find_by_output_extension(output)
            .map(|handler| handler.descriptor().name);

        Self::resolve_output_format_core(
            flag,
            output,
            normalize_create_patch_format,
            flag_canonical_name.as_deref(),
            extension_name,
            OutputFormatResolutionMessages {
                flag_label: "--format",
                format_noun: "patch format",
                missing_extension_label: "a supported patch extension",
                raw_output_hint: "",
                supported_formats: None,
            },
        )
    }

    pub(super) fn run_patch_create(&self, args: PatchCreateCommand) -> AppRunOutcome {
        let mut solid_options = solid_create_options(&args);
        trace!(
            original = %args.original.display(),
            modified = ?args.modified,
            output = ?args.output.as_ref().map(|path| path.display().to_string()),
            format = ?args.format,
            ignore_checksum_validation = args.ignore_checksum_validation,
            checksum_name = args.checksum_name,
            code_count = args.codes.len(),
            code_system = ?args.code_system,
            code_kind = %args.code_kind,
            threads = %args.threads,
            xdelta_secondary = %args.xdelta_secondary,
            "starting patch-create command"
        );
        let base_context = self.context(args.threads);
        let probe_threads = base_context.single_thread_execution();
        if args.plan {
            let report = self.run_patch_create_plan(
                &args,
                solid_options.is_some(),
                &base_context,
                probe_threads,
            );
            return self.finish("patch-create", report);
        }
        let PatchCreateSetup {
            output,
            context,
            requested_format,
            format_warning,
        } = match self.prepare_patch_create(
            &args,
            solid_options.is_some(),
            base_context,
            &probe_threads,
        ) {
            Ok(setup) => setup,
            Err(report) => return self.finish("patch-create", *report),
        };

        // Derive the modified ROM from cheat codes when `--code` or `--cheat` is
        // given, otherwise require an explicit `--modified`. A synthesized ROM is
        // a temp file under the context's temp namespace, which the diff-based
        // create below treats like any other; the namespace is reclaimed when the
        // context drops, so no explicit cleanup is needed.
        #[cfg(not(target_arch = "wasm32"))]
        let native_cheat_selection = !args.cheat_selection.cheats.is_empty();
        let PatchCreateModifiedSource {
            modified_path,
            cheat_summary,
            #[cfg_attr(target_arch = "wasm32", allow(unused_variables))]
            skipped_cheats,
        } = match self.resolve_patch_create_modified(
            &args,
            &context,
            Some(requested_format.clone()),
        ) {
            Ok(source) => source,
            Err(report) => return self.finish("patch-create", *report),
        };
        fill_solid_comment_with_codes(solid_options.as_mut(), cheat_summary.as_ref(), &args.codes);
        let handler = match self.resolve_patch_create_handler(
            &args.original,
            &modified_path,
            requested_format,
            &probe_threads,
        ) {
            Ok(handler) => handler,
            Err(report) => return self.finish("patch-create", *report),
        };
        let create_output = match self.patch_create_output_path(
            &args,
            &modified_path,
            handler.descriptor().name,
            output,
            &context,
            &probe_threads,
        ) {
            Ok(create_output) => create_output,
            Err(report) => return self.finish("patch-create", *report),
        };
        let request = PatchCreateRequest {
            original: args.original,
            modified: modified_path,
            output: create_output.clone(),
            format: handler.descriptor().name.to_string(),
        };
        let mut report = self.create_patch_with_handler(
            handler.as_ref(),
            &request,
            solid_options.or(args.ppf_undo.then_some(PatchCreateFormatOptions::PpfUndo)),
            &context,
        );
        if report.status == OperationStatus::Succeeded {
            self.warn_patch_create_container_inputs(
                &mut report,
                &request.original,
                &request.modified,
                &context,
            );
        }
        if report.status == OperationStatus::Succeeded
            && let Some(warning) = format_warning.as_deref()
        {
            report.label = format!("{}; warning: {warning}", report.label);
            Self::append_report_warnings(&mut report, [warning.to_string()]);
        }
        if report.status == OperationStatus::Succeeded
            && let Some(summary) = cheat_summary.as_ref()
        {
            report.label = format!("{}; {}", report.label, summary.label());
        }
        #[cfg(not(target_arch = "wasm32"))]
        if report.status == OperationStatus::Succeeded && native_cheat_selection {
            report = Self::annotate_patch_create_cheats(report, &create_output, &skipped_cheats);
        }
        if report.status == OperationStatus::Succeeded {
            report = Self::attach_emitted_files_details(report, vec![create_output.clone()], None);
        }
        self.finish("patch-create", report)
    }

    fn warn_patch_create_container_inputs(
        &self,
        report: &mut OperationReport,
        original: &Path,
        modified: &Path,
        context: &OperationContext,
    ) {
        let uses_container_bytes = [original, modified]
            .into_iter()
            .any(|path| self.apply_would_extract_container(path, context));
        debug!(
            original = %original.display(),
            modified = %modified.display(),
            uses_container_bytes,
            "patch create raw-container warning decision"
        );
        if uses_container_bytes {
            let warning = "patch create compares raw container bytes without extraction. Apply with --no-extract --no-compress to reconstruct Modified exactly, including any container. Extract both ROMs before creation to patch ROM payloads";
            report.label = format!("{}; warning: {warning}", report.label);
            Self::append_report_warnings(report, [warning.to_string()]);
        }
    }

    /// Mirrors the default `patch apply` auto-extract gate (`source_resolution.rs`): true only
    /// when apply would extract `path` as a container rather than use the raw file.
    fn apply_would_extract_container(&self, path: &Path, context: &OperationContext) -> bool {
        let Some(handler) = self
            .containers
            .probe(path)
            .filter(|handler| !handler.is_self_contained_rom(path))
        else {
            trace!(path = %path.display(), "raw-container check: no extractable handler matched");
            return false;
        };
        let format = handler.descriptor().name;
        let is_xiso = handler.descriptor().matches_name("xiso");
        let can_extract = handler.capabilities().extract;
        if is_xiso || !can_extract {
            trace!(path = %path.display(), format, is_xiso, can_extract, "raw-container check: handler not eligible for extract");
            return false;
        }
        // A name match settles it without the probe (apply errors on a damaged one), and the
        // probe can decompress the whole stream.
        if handler.descriptor().matches_path(path) {
            trace!(path = %path.display(), format, "raw-container check: apply would extract");
            return true;
        }
        let request = ContainerProbeRequest {
            source: path.to_path_buf(),
            split_bin: false,
        };
        if let Err(error) = handler.probe_details(&request, context) {
            debug!(path = %path.display(), format, error = %error, "raw-container check: signature-only match failed its probe; apply uses the raw file");
            return false;
        }
        trace!(path = %path.display(), format, "raw-container check: apply would extract");
        true
    }

    /// `patch create --plan`: recommend a format for the two inputs without writing a patch.
    fn run_patch_create_plan(
        &self,
        args: &PatchCreateCommand,
        has_solid_options: bool,
        base_context: &OperationContext,
        probe_threads: Option<ThreadExecution>,
    ) -> OperationReport {
        if has_solid_options {
            return OperationReport::failed(
                OperationFamily::Patch,
                args.format.clone(),
                "validate",
                "SOLID metadata options cannot be combined with --plan".to_string(),
                probe_threads,
            );
        }
        if args.ppf_undo {
            return OperationReport::failed(
                OperationFamily::Patch,
                args.format.clone(),
                "validate",
                "--ppf-undo cannot be combined with --plan".to_string(),
                probe_threads,
            );
        }
        let modified = match args.modified.as_ref() {
            Some(path) => path,
            None => {
                return OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    "patch create --plan requires --modified".to_string(),
                    probe_threads,
                );
            }
        };
        if let Some(report) = self.require_readable_path(
            "patch-create",
            OperationFamily::Patch,
            None,
            &args.original,
            base_context.single_thread_execution(),
        ) {
            return report;
        }
        if let Some(report) = self.require_readable_path(
            "patch-create",
            OperationFamily::Patch,
            None,
            modified,
            base_context.single_thread_execution(),
        ) {
            return report;
        }
        let input_info = match self.inspect_patch_create_input_info(
            "patch-create",
            None,
            &args.original,
            modified,
            base_context.single_thread_execution(),
        ) {
            Ok(input_info) => input_info,
            Err(report) => return *report,
        };
        let sizes = create_patch_input_sizes(&input_info);
        let candidates = create_patch_format_candidates_for_sources(&input_info);
        let mut formats = candidates.formats;
        let input_sizes_are_raw = [&input_info.original, &input_info.modified]
            .iter()
            .all(|source| !source.archive && !source.special_compression);
        if input_sizes_are_raw && sizes.modified < sizes.original {
            debug!("patch create plan drops formats that cannot shrink the output");
            formats.retain(|format| !NO_SHRINK_CREATE_PATCH_FORMATS.contains(format));
        }
        if !original_is_paper_mario_usa10(&args.original, input_info.original.size) {
            debug!("patch create plan drops pmsr: original is not Paper Mario (USA) v1.0");
            formats.retain(|format| *format != "pmsr");
        }
        let mut report = OperationReport::succeeded(
            OperationFamily::Patch,
            Some(candidates.default_format.to_string()),
            "recommend",
            format!(
                "recommended patch create format {}; candidates={}",
                candidates.default_format,
                formats.join(",")
            ),
            Some(100.0),
            base_context.single_thread_execution(),
        );
        report.details = Some(json!({
            "patch_create_format_candidates": {
                "default": candidates.default_format,
                "formats": formats,
                "limits": {
                    "archive_default_size_bytes": CREATE_PATCH_ARCHIVE_DEFAULT_LIMIT_BYTES,
                    "bps_default_size_bytes": CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES,
                    "bps_max_combined_input_bytes": BPS_CREATE_MAX_COMBINED_INPUT_BYTES,
                    "ips_size_limit_bytes": CREATE_PATCH_IPS_SIZE_LIMIT_BYTES,
                    "legacy_size_limit_bytes": CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES,
                },
                "source_values": {
                    "original": {
                        "path": args.original.display().to_string(),
                        "archive": input_info.original.archive,
                        "size": sizes.original,
                        "special_compression": input_info.original.special_compression,
                    },
                    "modified": {
                        "path": modified.display().to_string(),
                        "archive": input_info.modified.archive,
                        "size": sizes.modified,
                        "special_compression": input_info.modified.special_compression,
                    },
                },
            }
        }));
        self.warn_patch_create_container_inputs(
            &mut report,
            &args.original,
            modified,
            base_context,
        );
        report
    }

    /// Validates the output, xdelta mode, and format flags, and builds the create context.
    fn prepare_patch_create(
        &self,
        args: &PatchCreateCommand,
        has_solid_options: bool,
        base_context: OperationContext,
        probe_threads: &Option<ThreadExecution>,
    ) -> std::result::Result<PatchCreateSetup, Box<OperationReport>> {
        let output = match args.output.clone() {
            Some(output) => output,
            None => {
                return Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    args.format.clone(),
                    "validate",
                    "patch create requires --output unless --plan is used".to_string(),
                    probe_threads.clone(),
                )));
            }
        };
        let fail = |format: Option<String>, stage: &str, message: String| {
            Box::new(OperationReport::failed(
                OperationFamily::Patch,
                format,
                stage,
                message,
                probe_threads.clone(),
            ))
        };
        let xdelta_secondary_mode = args
            .xdelta_secondary
            .parse::<XdeltaSecondaryMode>()
            .map_err(|error| fail(args.format.clone(), "validate", error.to_string()))?;
        let context = base_context
            .with_patch_checksum_validation(if args.ignore_checksum_validation {
                PatchChecksumValidation::Ignore
            } else {
                PatchChecksumValidation::Strict
            })
            .with_xdelta_secondary_mode(xdelta_secondary_mode);
        let resolution = self
            .resolve_patch_create_format(args.format.as_deref(), &output)
            .map_err(|error| {
                Box::new(OperationReport::failed_with_error(
                    OperationFamily::Patch,
                    args.format.clone(),
                    "validate",
                    error,
                    probe_threads.clone(),
                ))
            })?;
        let requested_format = resolution.format;
        let format_warning = resolution.warning;
        if has_solid_options && !requested_format.eq_ignore_ascii_case("solid") {
            return Err(fail(
                Some(requested_format),
                "validate",
                "SOLID metadata options require --format solid or a .solid output".to_string(),
            ));
        }
        if xdelta_secondary_mode != XdeltaSecondaryMode::None
            && !requested_format.eq_ignore_ascii_case("xdelta")
        {
            return Err(fail(
                Some(requested_format),
                "validate",
                format!(
                    "--xdelta-secondary {} requires --format xdelta or a .xdelta output",
                    args.xdelta_secondary
                ),
            ));
        }
        if args.ppf_undo && !requested_format.eq_ignore_ascii_case("ppf") {
            return Err(fail(
                Some(requested_format),
                "validate",
                "--ppf-undo requires --format ppf or a .ppf output".to_string(),
            ));
        }
        if let Some(warning) = format_warning.as_deref() {
            debug!(
                command = "patch-create",
                format = %requested_format,
                output = %output.display(),
                "{warning}"
            );
        }
        if let Some(report) = self.require_readable_path(
            "patch-create",
            OperationFamily::Patch,
            Some(requested_format.clone()),
            &args.original,
            probe_threads.clone(),
        ) {
            return Err(Box::new(report));
        }
        if let Some(report) = self.require_writable_output_parent(
            "patch-create",
            OperationFamily::Patch,
            Some(requested_format.clone()),
            &output,
            probe_threads.clone(),
        ) {
            return Err(Box::new(report));
        }
        // Cheat-derived creates read and copy the whole original before the diff handler runs, so reject
        // a format the sizes already rule out first. The cheat-patched ROM keeps the original's length
        // (cheats overwrite bytes in place), so the pair is the original twice.
        if args.modified.is_none()
            && !(args.codes.is_empty() && args.cheat_selection.cheats.is_empty())
        {
            let sizes = self.inspect_patch_create_input_sizes(
                "patch-create",
                Some(requested_format.clone()),
                &args.original,
                &args.original,
                probe_threads.clone(),
            )?;
            if let Some(label) = create_patch_format_size_error_message(&requested_format, sizes) {
                return Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    Some(requested_format),
                    "validate",
                    label,
                    probe_threads.clone(),
                )));
            }
        }
        Ok(PatchCreateSetup {
            output,
            context,
            requested_format,
            format_warning,
        })
    }

    /// Checks the modified input, finds the create handler, and enforces its size limits.
    fn resolve_patch_create_handler(
        &self,
        original: &Path,
        modified_path: &Path,
        requested_format: String,
        probe_threads: &Option<ThreadExecution>,
    ) -> std::result::Result<Arc<dyn PatchHandler>, Box<OperationReport>> {
        if let Some(report) = self.require_readable_path(
            "patch-create",
            OperationFamily::Patch,
            Some(requested_format.clone()),
            modified_path,
            probe_threads.clone(),
        ) {
            return Err(Box::new(report));
        }

        let Some(handler) = self.patches.find_by_name(&requested_format) else {
            let label = explicitly_unsupported_patch_reason_for_name(&requested_format)
                .map(|reason| {
                    format!(
                        "requested patch format `{requested_format}` is explicitly not supported: {reason}"
                    )
                })
                .unwrap_or_else(|| self.patches.unregistered_create_format_message(&requested_format));
            return Err(Box::new(OperationReport::failed(
                OperationFamily::Patch,
                Some(requested_format),
                "probe",
                label,
                probe_threads.clone(),
            )));
        };
        let sizes = self.inspect_patch_create_input_sizes(
            "patch-create",
            Some(handler.descriptor().name.to_string()),
            original,
            modified_path,
            probe_threads.clone(),
        )?;
        if let Some(label) =
            create_patch_format_size_error_message(handler.descriptor().name, sizes)
        {
            return Err(Box::new(OperationReport::failed(
                OperationFamily::Patch,
                Some(handler.descriptor().name.to_string()),
                "validate",
                label,
                probe_threads.clone(),
            )));
        }
        Ok(handler)
    }

    /// Settles the final patch file name (with `--checksum-name`) and checks it is writable.
    fn patch_create_output_path(
        &self,
        args: &PatchCreateCommand,
        modified: &Path,
        format_name: &str,
        output: PathBuf,
        context: &OperationContext,
        probe_threads: &Option<ThreadExecution>,
    ) -> std::result::Result<PathBuf, Box<OperationReport>> {
        let fail_error = |error: RomWeaverError| {
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                Some(format_name.to_string()),
                "validate",
                error,
                probe_threads.clone(),
            ))
        };
        let mut create_output = output;
        if args.checksum_name {
            // Prefer a caller-supplied source crc32 (the browser already hashes the
            // original during input prep) to avoid re-reading the original here; fall
            // back to computing it only when no crc32 assumption was supplied. A
            // malformed or conflicting --assume-in is a hard error, not a silent
            // recompute, so an invalid trusted value never passes unnoticed.
            let provided_crc32 = parse_expect_tokens(&args.assume_in, "--assume-in", false)
                .map_err(fail_error)?
                .checksums
                .get("crc32")
                .cloned();
            let crc32 = match provided_crc32 {
                Some(crc32) => Some(crc32),
                None => checksum_file_values(&args.original, &["crc32"], context)
                    .map_err(fail_error)?
                    .get("crc32")
                    .cloned(),
            };
            if let Some(crc32) = crc32 {
                let embedded = embed_checksum_in_filename(&create_output, "crc32", &crc32);
                if embedded != create_output {
                    trace!(
                        output = %embedded.display(),
                        crc32 = %crc32,
                        "embedded source crc32 into patch file name"
                    );
                }
                create_output = embedded;
            }
        }

        if crate::path_access::paths_refer_to_same_file(&args.original, &create_output)
            || crate::path_access::paths_refer_to_same_file(modified, &create_output)
        {
            return Err(fail_error(RomWeaverError::Validation(
                "patch create input and output resolve to the same file; choose a different --output path"
                    .to_string(),
            )));
        }

        // Guarded after --checksum-name has settled the final file name, so the
        // path checked is the path written.
        ensure_output_available(&create_output, args.force).map_err(fail_error)?;
        Ok(create_output)
    }

    fn create_patch_with_handler(
        &self,
        handler: &dyn PatchHandler,
        request: &PatchCreateRequest,
        solid_options: Option<PatchCreateFormatOptions>,
        context: &OperationContext,
    ) -> OperationReport {
        self.emit_running(
            OperationLabel {
                command: "patch-create",
                family: OperationFamily::Patch,
                format: Some(handler.descriptor().name),
            },
            "create",
            format!("creating {} patch", handler.descriptor().name),
            Some(0.0),
            None,
        );
        match handler.create_with_options(request, solid_options.as_ref(), context) {
            Ok(mut report) => {
                Self::lift_handler_label_warnings(&mut report);
                report
            }
            Err(RomWeaverError::Unsupported(op)) => OperationReport::unsupported(
                OperationFamily::Patch,
                Some(handler.descriptor().name.to_string()),
                "create",
                op.to_string(),
                context.single_thread_execution(),
            ),
            Err(error) => OperationReport::failed_with_error(
                OperationFamily::Patch,
                Some(handler.descriptor().name.to_string()),
                "create",
                error,
                context.single_thread_execution(),
            ),
        }
    }

    /// Decide which ROM the patch is diffed against, and what the cheat
    /// selection produced on the way. The error carries the stage the failed
    /// report should name.
    fn resolve_patch_create_modified(
        &self,
        args: &PatchCreateCommand,
        context: &OperationContext,
        format: Option<String>,
    ) -> std::result::Result<PatchCreateModifiedSource, Box<OperationReport>> {
        let fail = |stage: &'static str, message: String| {
            Box::new(OperationReport::failed(
                OperationFamily::Patch,
                format.clone(),
                stage,
                message,
                context.single_thread_execution(),
            ))
        };
        let fail_error = |stage: &'static str, error: RomWeaverError| {
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                format.clone(),
                stage,
                error,
                context.single_thread_execution(),
            ))
        };
        // Native-only: the cheat database lives on disk and `cheat_selection`
        // is `serde(skip)`, so a wasm run never carries a selection.
        #[cfg(not(target_arch = "wasm32"))]
        if !args.cheat_selection.cheats.is_empty() {
            let plan = self
                .plan_patch_create_cheats(crate::cheat_resolution::PatchCreateCheatRequest {
                    original: &args.original,
                    selection: &args.cheat_selection,
                    has_other_source: args.modified.is_some() || !args.codes.is_empty(),
                    context,
                })
                .map_err(|error| fail_error("prepare", error))?;
            return Ok(PatchCreateModifiedSource {
                modified_path: plan.modified,
                cheat_summary: Some(plan.summary),
                skipped_cheats: plan.skipped,
            });
        }
        if !args.codes.is_empty() {
            if args.modified.is_some() {
                return Err(fail(
                    "validate",
                    "--modified cannot be combined with --code".to_string(),
                ));
            }
            let dest = context
                .temp_paths()
                .next_path("patch-create-cheat-modified", Some("bin"));
            let summary = self
                .write_cheat_patched_rom(
                    &args.original,
                    &args.codes,
                    args.code_system.as_deref(),
                    &args.code_kind,
                    &dest,
                )
                .map_err(|error| fail_error("prepare", error))?;
            return Ok(PatchCreateModifiedSource {
                modified_path: dest,
                cheat_summary: Some(summary),
                ..PatchCreateModifiedSource::default()
            });
        }
        let modified_path = args.modified.clone().ok_or_else(|| {
            fail(
                "validate",
                "patch create requires --modified or --code".to_string(),
            )
        })?;
        Ok(PatchCreateModifiedSource {
            modified_path,
            ..PatchCreateModifiedSource::default()
        })
    }
}

/// The ROM `patch create` diffs against, plus what the cheat selection produced.
#[derive(Default)]
struct PatchCreateModifiedSource {
    modified_path: PathBuf,
    cheat_summary: Option<crate::cheats_apply::CheatApplySummary>,
    skipped_cheats: Vec<String>,
}

#[cfg(test)]
mod create_format_tests {
    use super::*;

    #[test]
    fn vcdiff_is_its_own_create_format_and_xdelta3_is_an_xdelta_alias() {
        assert_eq!(normalize_create_patch_format("vcdiff"), "vcdiff");
        assert_eq!(normalize_create_patch_format(" VCDIFF "), "vcdiff");
        assert_eq!(normalize_create_patch_format("xdelta3"), "xdelta");
    }

    #[test]
    fn inputs_above_the_legacy_limit_may_use_vcdiff_but_not_bps() {
        let sizes = PatchCreateInputSizes {
            original: CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES + 1,
            modified: CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES + 1,
        };
        for format in ["xdelta", "VCDIFF", "ppf"] {
            assert_eq!(
                create_patch_format_size_error_message(format, sizes),
                None,
                "{format}"
            );
        }
        assert!(create_patch_format_size_error_message("bps", sizes).is_some());
    }

    fn sizes_totalling(combined: u64) -> PatchCreateInputSizes {
        PatchCreateInputSizes {
            original: combined / 2,
            modified: combined - combined / 2,
        }
    }

    fn info_totalling(combined: u64) -> PatchCreateInputInfo {
        let sizes = sizes_totalling(combined);
        let source = |size| PatchCreateSourceInfo {
            archive: false,
            size,
            special_compression: false,
        };
        PatchCreateInputInfo {
            original: source(sizes.original),
            modified: source(sizes.modified),
        }
    }

    #[test]
    fn bps_is_offered_only_while_the_pair_fits_the_suffix_index_budget() {
        let cap = BPS_CREATE_MAX_COMBINED_INPUT_BYTES;
        // Both sides are below the per-side default limit, so only the combined cap can drop BPS.
        assert!(cap / 2 < CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES);
        assert!(create_patch_formats_for_sizes(sizes_totalling(cap)).contains(&"bps"));
        assert!(!create_patch_formats_for_sizes(sizes_totalling(cap + 1)).contains(&"bps"));
        // A skewed pair is bucketed by its larger side but capped by the total.
        let skewed = PatchCreateInputSizes {
            original: CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES,
            modified: cap - CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES,
        };
        assert!(create_patch_formats_for_sizes(skewed).contains(&"bps"));
        let skewed = PatchCreateInputSizes {
            modified: skewed.modified + 1,
            ..skewed
        };
        assert!(!create_patch_formats_for_sizes(skewed).contains(&"bps"));
        assert!(create_patch_formats_for_sizes(skewed).contains(&"xdelta"));
    }

    #[test]
    fn the_default_format_leaves_bps_when_the_pair_exceeds_the_cap() {
        let cap = BPS_CREATE_MAX_COMBINED_INPUT_BYTES;
        assert_eq!(
            create_patch_default_format_for_sources(&info_totalling(cap)),
            "bps"
        );
        assert_eq!(
            create_patch_default_format_for_sources(&info_totalling(cap + 1)),
            CREATE_PATCH_LARGE_DEFAULT_FORMAT
        );
    }

    #[test]
    fn explicit_bps_over_the_cap_names_the_cap_and_suggests_xdelta() {
        let cap = BPS_CREATE_MAX_COMBINED_INPUT_BYTES;
        assert_eq!(
            create_patch_format_size_error_message("bps", sizes_totalling(cap)),
            None
        );
        let message = create_patch_format_size_error_message("BPS", sizes_totalling(cap + 1))
            .expect("one byte over the cap is rejected");
        assert!(message.contains(&format!("{cap} bytes")), "{message}");
        assert!(message.contains("use xdelta"), "{message}");
        assert_eq!(
            create_patch_format_size_error_message("xdelta", sizes_totalling(cap + 1)),
            None
        );
    }
}
