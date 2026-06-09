use super::*;

use rom_weaver_core::format_human_bytes;

use super::patch_commands::{
    CREATE_PATCH_ARCHIVE_DEFAULT_EXTENSIONS, CREATE_PATCH_ARCHIVE_DEFAULT_LIMIT_BYTES,
    CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES, CREATE_PATCH_DEFAULT_FORMAT, CREATE_PATCH_FORMAT_ALIASES,
    CREATE_PATCH_IPS_SIZE_LIMIT_BYTES, CREATE_PATCH_LARGE_DEFAULT_FORMAT,
    CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES, CREATE_PATCH_SPECIAL_COMPRESSION_EXTENSIONS,
    LARGE_CREATE_PATCH_FORMATS, MEDIUM_CREATE_PATCH_FORMATS, MID_LARGE_CREATE_PATCH_FORMATS,
    PatchCreateFormatCandidates, PatchCreateInputInfo, PatchCreateInputSizes,
    PatchCreateSourceInfo, SMALL_CREATE_PATCH_FORMATS,
};

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

pub(super) fn create_patch_formats_for_sizes(
    sizes: PatchCreateInputSizes,
) -> &'static [&'static str] {
    let max_size = max_create_patch_input_size(sizes);
    if max_size > CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES {
        return LARGE_CREATE_PATCH_FORMATS;
    }
    if max_size >= CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES {
        return MID_LARGE_CREATE_PATCH_FORMATS;
    }
    if max_size >= CREATE_PATCH_IPS_SIZE_LIMIT_BYTES {
        return MEDIUM_CREATE_PATCH_FORMATS;
    }
    SMALL_CREATE_PATCH_FORMATS
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
    if max_create_patch_input_size(create_patch_input_sizes(info))
        < CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES
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
    if max_size > CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES
        && !matches!(normalized_format.as_str(), "xdelta" | "ppf")
    {
        let limit = format_human_bytes(CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES);
        return Some(format!(
            "Create inputs above {limit} require xdelta or PPF patches; selected patch type: {normalized_format}"
        ));
    }
    None
}

/* jscpd:ignore-start */

impl CliApp {
    pub(super) fn inspect_patch_create_input_sizes(
        &self,
        command: &str,
        format: Option<String>,
        original: &Path,
        modified: &Path,
        thread_execution: Option<ThreadExecution>,
    ) -> std::result::Result<PatchCreateInputSizes, Box<OperationReport>> {
        let original_size = match fs::metadata(original) {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                return Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    format,
                    "validate",
                    format!(
                        "failed to inspect {command} original input `{}`: {error}",
                        original.display()
                    ),
                    thread_execution,
                )));
            }
        };
        let modified_size = match fs::metadata(modified) {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                return Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    format,
                    "validate",
                    format!(
                        "failed to inspect {command} modified input `{}`: {error}",
                        modified.display()
                    ),
                    thread_execution,
                )));
            }
        };
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
    pub(super) fn run_patch_create_candidates(
        &self,
        args: PatchCreateCandidatesCommand,
    ) -> AppRunOutcome {
        trace!(
            original = %args.original.display(),
            modified = %args.modified.display(),
            threads = %args.threads,
            "starting patch-create-candidates command"
        );
        let context = self.context(args.threads);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        if let Some(report) = self.require_existing_path(
            "patch-create-candidates",
            OperationFamily::Patch,
            None,
            &args.original,
            probe_threads.clone(),
        ) {
            return self.finish("patch-create-candidates", report);
        }
        if let Some(report) = self.require_existing_path(
            "patch-create-candidates",
            OperationFamily::Patch,
            None,
            &args.modified,
            probe_threads.clone(),
        ) {
            return self.finish("patch-create-candidates", report);
        }
        let input_info = match self.inspect_patch_create_input_info(
            "patch-create-candidates",
            None,
            &args.original,
            &args.modified,
            probe_threads.clone(),
        ) {
            Ok(input_info) => input_info,
            Err(report) => return self.finish("patch-create-candidates", *report),
        };
        let sizes = create_patch_input_sizes(&input_info);
        let candidates = create_patch_format_candidates_for_sources(&input_info);
        let formats = candidates.formats.to_vec();
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
            Some(context.plan_threads(ThreadCapability::single_threaded())),
        );
        report.details = Some(json!({
            "patch_create_format_candidates": {
                "default": candidates.default_format,
                "formats": formats,
                "limits": {
                    "archive_default_size_bytes": CREATE_PATCH_ARCHIVE_DEFAULT_LIMIT_BYTES,
                    "bps_default_size_bytes": CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES,
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
                        "path": args.modified.display().to_string(),
                        "archive": input_info.modified.archive,
                        "size": sizes.modified,
                        "special_compression": input_info.modified.special_compression,
                    },
                },
            }
        }));
        self.finish("patch-create-candidates", report)
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
        let extension_display = output
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{value}"));
        let extension_handler = self.patches.find_by_output_extension(output);

        if let Some(flag) = flag {
            let normalized = normalize_create_patch_format(flag);
            let flag_canonical = self
                .patches
                .find_by_name(&normalized)
                .map(|handler| handler.descriptor().name.to_string());
            let warning = match &extension_display {
                None => None,
                Some(extension) => {
                    let extension_name = extension_handler
                        .as_ref()
                        .map(|handler| handler.descriptor().name);
                    let matches = match (&flag_canonical, extension_name) {
                        (Some(flag_name), Some(extension_name)) => {
                            flag_name.eq_ignore_ascii_case(extension_name)
                        }
                        _ => false,
                    };
                    if matches {
                        None
                    } else {
                        Some(format!(
                            "output extension `{extension}` does not match --format `{flag}`; writing `{normalized}`"
                        ))
                    }
                }
            };
            return Ok(FormatResolution {
                note: format!("explicit format={normalized}"),
                format: normalized,
                warning,
            });
        }

        let Some(extension_display) = extension_display else {
            return Err(RomWeaverError::Validation(
                "output has no file extension; pass --format <name> or use a supported patch extension"
                    .to_string(),
            ));
        };
        match extension_handler {
            Some(handler) => {
                let resolved = handler.descriptor().name.to_string();
                Ok(FormatResolution {
                    note: format!("format={resolved} from output extension"),
                    format: resolved,
                    warning: None,
                })
            }
            None => Err(RomWeaverError::Validation(format!(
                "output extension `{extension_display}` is not a supported patch format; pass --format <name> or use a supported extension"
            ))),
        }
    }

    pub(super) fn run_patch_create(&self, args: PatchCreateCommand) -> AppRunOutcome {
        trace!(
            original = %args.original.display(),
            modified = %args.modified.display(),
            output = %args.output.display(),
            format = ?args.format,
            ignore_checksum_validation = args.ignore_checksum_validation,
            checksum_name = args.checksum_name,
            threads = %args.threads,
            xdelta_secondary = %args.xdelta_secondary,
            "starting patch-create command"
        );
        let base_context = self.context(args.threads);
        let probe_threads = Some(base_context.plan_threads(ThreadCapability::single_threaded()));
        let xdelta_secondary_mode = match args.xdelta_secondary.parse::<XdeltaSecondaryMode>() {
            Ok(mode) => mode,
            Err(error) => {
                return self.finish(
                    "patch-create",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        args.format.clone(),
                        "validate",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        let context = base_context
            .with_patch_checksum_validation(if args.ignore_checksum_validation {
                PatchChecksumValidation::Ignore
            } else {
                PatchChecksumValidation::Strict
            })
            .with_xdelta_secondary_mode(xdelta_secondary_mode);
        let resolution =
            match self.resolve_patch_create_format(args.format.as_deref(), &args.output) {
                Ok(resolution) => resolution,
                Err(error) => {
                    return self.finish(
                        "patch-create",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            args.format.clone(),
                            "validate",
                            error.to_string(),
                            probe_threads,
                        ),
                    );
                }
            };
        let requested_format = resolution.format;
        let format_warning = resolution.warning;
        if let Some(warning) = format_warning.as_deref() {
            warn!(
                command = "patch-create",
                format = %requested_format,
                output = %args.output.display(),
                "{warning}"
            );
        }
        if let Some(report) = self.require_existing_path(
            "patch-create",
            OperationFamily::Patch,
            Some(requested_format.clone()),
            &args.original,
            probe_threads.clone(),
        ) {
            return self.finish("patch-create", report);
        }
        if let Some(report) = self.require_existing_path(
            "patch-create",
            OperationFamily::Patch,
            Some(requested_format.clone()),
            &args.modified,
            probe_threads.clone(),
        ) {
            return self.finish("patch-create", report);
        }

        let Some(handler) = self.patches.find_by_name(&requested_format) else {
            let label = explicitly_unsupported_patch_reason_for_name(&requested_format)
                .map(|reason| {
                    format!(
                        "requested patch format `{requested_format}` is explicitly not supported: {reason}"
                    )
                })
                .unwrap_or_else(|| "requested patch format is not registered".to_string());
            return self.finish(
                "patch-create",
                OperationReport::failed(
                    OperationFamily::Patch,
                    Some(requested_format),
                    "probe",
                    label,
                    probe_threads,
                ),
            );
        };
        let sizes = match self.inspect_patch_create_input_sizes(
            "patch-create",
            Some(handler.descriptor().name.to_string()),
            &args.original,
            &args.modified,
            probe_threads.clone(),
        ) {
            Ok(sizes) => sizes,
            Err(report) => return self.finish("patch-create", *report),
        };
        if let Some(label) =
            create_patch_format_size_error_message(handler.descriptor().name, sizes)
        {
            return self.finish(
                "patch-create",
                OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "validate",
                    label,
                    probe_threads,
                ),
            );
        }

        let mut create_output = args.output;
        if args.checksum_name {
            match checksum_file_values(&args.original, &["crc32"], &context) {
                Ok(values) => {
                    if let Some(crc32) = values.get("crc32") {
                        let embedded = embed_checksum_in_filename(&create_output, "crc32", crc32);
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
                Err(error) => {
                    return self.finish(
                        "patch-create",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            Some(handler.descriptor().name.to_string()),
                            "validate",
                            error.to_string(),
                            probe_threads,
                        ),
                    );
                }
            }
        }

        let request = PatchCreateRequest {
            original: args.original,
            modified: args.modified,
            output: create_output.clone(),
            format: handler.descriptor().name.to_string(),
        };
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
        let report = match handler.create(&request, &context) {
            Ok(report) => report,
            Err(RomWeaverError::Unsupported(label)) => OperationReport::unsupported(
                OperationFamily::Patch,
                Some(handler.descriptor().name.to_string()),
                "create",
                label,
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            ),
            Err(error) => OperationReport::failed(
                OperationFamily::Patch,
                Some(handler.descriptor().name.to_string()),
                "create",
                error.to_string(),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            ),
        };
        let mut report = report;
        if report.status == OperationStatus::Succeeded
            && let Some(warning) = format_warning.as_deref()
        {
            report.label = format!("{}; warning: {warning}", report.label);
        }
        if report.status == OperationStatus::Succeeded && args.checksum_name {
            report = Self::attach_emitted_files_details(report, vec![create_output.clone()], None);
        }
        self.finish("patch-create", report)
    }
}
