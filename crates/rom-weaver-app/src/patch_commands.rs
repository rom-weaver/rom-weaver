const CREATE_PATCH_IPS_SIZE_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
const CREATE_PATCH_ARCHIVE_DEFAULT_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
const CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES: u64 = 128 * 1024 * 1024;
const CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES: u64 = 256 * 1024 * 1024;

const SMALL_CREATE_PATCH_FORMATS: &[&str] = &[
    "bps", "xdelta", "aps", "bdf", "ebp", "ips", "pmsr", "ppf", "rup", "ups",
];
const MEDIUM_CREATE_PATCH_FORMATS: &[&str] =
    &["bps", "xdelta", "aps", "bdf", "pmsr", "ppf", "rup", "ups"];
const MID_LARGE_CREATE_PATCH_FORMATS: &[&str] =
    &["xdelta", "bps", "aps", "bdf", "pmsr", "ppf", "rup", "ups"];
const LARGE_CREATE_PATCH_FORMATS: &[&str] = &["xdelta", "ppf"];
const CREATE_PATCH_ARCHIVE_DEFAULT_EXTENSIONS: &[&str] = &[
    ".7z",
    ".apk",
    ".br",
    ".brotli",
    ".bz2",
    ".bzip2",
    ".cbz",
    ".epub",
    ".gz",
    ".gzip",
    ".jar",
    ".lz",
    ".lz4",
    ".lz5",
    ".lzip",
    ".lzma",
    ".r00",
    ".rar",
    ".tar",
    ".tar.br",
    ".tar.brotli",
    ".tar.bz2",
    ".tar.gz",
    ".tar.lz",
    ".tar.lz4",
    ".tar.lz5",
    ".tar.lzip",
    ".tar.lzma",
    ".tar.xz",
    ".tar.zst",
    ".tar.zstd",
    ".taz",
    ".tbz",
    ".tbz2",
    ".tbr",
    ".tgz",
    ".tlz",
    ".tlz4",
    ".tlz5",
    ".tpz",
    ".txz",
    ".tzst",
    ".tzstd",
    ".xpi",
    ".xz",
    ".z",
    ".z01",
    ".zip",
    ".zipx",
    ".zst",
    ".zstd",
];
const CREATE_PATCH_SPECIAL_COMPRESSION_EXTENSIONS: &[&str] = &[
    ".chd", ".rvz", ".gcz", ".wia", ".z3ds", ".z3dsx", ".zcci", ".zcia", ".zcxi",
];
const LIBRETRO_PATCH_ORDER_EXTENSIONS: &[&str] = &[
    ".ips", ".ups", ".bps", ".aps", ".rup", ".ppf", ".ebp", ".bdf", ".bsp",
    ".bspatch", ".mod", ".xdelta", ".delta", ".dat", ".vcdiff",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PatchCreateInputSizes {
    original: u64,
    modified: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PatchCreateSourceInfo {
    archive: bool,
    size: u64,
    special_compression: bool,
}

#[derive(Debug, Default)]
struct DiscoveredPatchApplySidecars {
    patches: Vec<PathBuf>,
    cleanup_paths: Vec<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ResolvedSidecarPatchEntry {
    entry: ContainerListEntry,
    order: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PatchCreateInputInfo {
    original: PatchCreateSourceInfo,
    modified: PatchCreateSourceInfo,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PatchCreateFormatCandidates {
    formats: &'static [&'static str],
    default_format: &'static str,
}

fn normalize_create_patch_format(format: &str) -> String {
    let normalized = format.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "vcdiff" | "xdelta3" => "xdelta".to_string(),
        "mod" => "pmsr".to_string(),
        "bdf/bsdiff40" | "bsdiff" | "bsdiff40" => "bdf".to_string(),
        other => other.to_string(),
    }
}

fn max_create_patch_input_size(sizes: PatchCreateInputSizes) -> u64 {
    sizes.original.max(sizes.modified)
}

fn create_patch_input_sizes(info: &PatchCreateInputInfo) -> PatchCreateInputSizes {
    PatchCreateInputSizes {
        original: info.original.size,
        modified: info.modified.size,
    }
}

fn create_patch_formats_for_sizes(sizes: PatchCreateInputSizes) -> &'static [&'static str] {
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

fn create_patch_source_matches_extension(path: &Path, extensions: &[&str]) -> bool {
    let normalized_path = path.to_string_lossy().to_ascii_lowercase();
    extensions
        .iter()
        .any(|extension| normalized_path.ends_with(extension))
}

fn create_patch_default_format_for_sources(info: &PatchCreateInputInfo) -> &'static str {
    let sources = [&info.original, &info.modified];
    if sources.iter().any(|source| source.special_compression)
        || sources.iter().any(|source| {
            source.archive && source.size > CREATE_PATCH_ARCHIVE_DEFAULT_LIMIT_BYTES
        })
    {
        return "xdelta";
    }
    if max_create_patch_input_size(create_patch_input_sizes(info)) < CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES
    {
        "bps"
    } else {
        "xdelta"
    }
}

fn create_patch_format_candidates_for_sources(info: &PatchCreateInputInfo) -> PatchCreateFormatCandidates {
    PatchCreateFormatCandidates {
        formats: create_patch_formats_for_sizes(create_patch_input_sizes(info)),
        default_format: create_patch_default_format_for_sources(info),
    }
}

fn create_patch_format_size_error_message(
    format: &str,
    sizes: PatchCreateInputSizes,
) -> Option<String> {
    let normalized_format = normalize_create_patch_format(format);
    let max_size = max_create_patch_input_size(sizes);
    if matches!(normalized_format.as_str(), "ips" | "ips32" | "ebp")
        && max_size >= CREATE_PATCH_IPS_SIZE_LIMIT_BYTES
    {
        return Some(format!(
            "Create inputs at or above 16.8 MB should use BPS, xdelta, or another large-capable patch type; selected patch type: {normalized_format}"
        ));
    }
    if max_size > CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES
        && !matches!(normalized_format.as_str(), "xdelta" | "ppf")
    {
        return Some(format!(
            "Create inputs above 268.4 MB require xdelta or PPF patches; selected patch type: {normalized_format}"
        ));
    }
    None
}

/* jscpd:ignore-start */
impl CliApp {
    fn inspect_patch_create_input_sizes(
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

    fn inspect_patch_create_input_info(
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

    fn archive_entry_directory(entry_name: &str) -> &str {
        entry_name.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("")
    }

    fn archive_entry_file_name(entry_name: &str) -> &str {
        entry_name.rsplit('/').next().unwrap_or(entry_name)
    }

    fn archive_entry_stem(entry_name: &str) -> &str {
        let file_name = Self::archive_entry_file_name(entry_name);
        file_name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file_name)
    }

    fn strip_bracket_label_suffix(value: &str) -> &str {
        let Some(end) = value.strip_suffix(']') else {
            return value.trim();
        };
        let Some((base, _label)) = end.rsplit_once('[') else {
            return value.trim();
        };
        base.trim_end()
    }

    fn parse_libretro_patch_file_name(file_name: &str) -> Option<(&str, u32)> {
        let lower = file_name.to_ascii_lowercase();
        let mut best: Option<(usize, usize, u32)> = None;
        for extension in LIBRETRO_PATCH_ORDER_EXTENSIONS {
            let Some(extension_start) = lower.rfind(extension) else {
                continue;
            };
            if extension_start == 0 {
                continue;
            }
            let suffix = &lower[extension_start + extension.len()..];
            if !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            let order = if suffix.is_empty() {
                0
            } else {
                suffix.parse::<u32>().ok()?
            };
            let extension_len = extension.len();
            if best
                .map(|(best_start, best_len, _)| {
                    extension_len > best_len
                        || (extension_len == best_len && extension_start > best_start)
                })
                .unwrap_or(true)
            {
                best = Some((extension_start, extension_len, order));
            }
        }
        let (extension_start, _, order) = best?;
        Some((Self::strip_bracket_label_suffix(&file_name[..extension_start]), order))
    }

    fn entry_matches_libretro_sidecar(rom_entry: &str, patch_entry: &str) -> Option<u32> {
        if Self::archive_entry_directory(rom_entry) != Self::archive_entry_directory(patch_entry)
        {
            return None;
        }
        let patch_file_name = Self::archive_entry_file_name(patch_entry);
        let (patch_base, order) = Self::parse_libretro_patch_file_name(patch_file_name)?;
        if patch_base == Self::archive_entry_file_name(rom_entry)
            || patch_base == Self::archive_entry_stem(rom_entry)
        {
            Some(order)
        } else {
            None
        }
    }

    fn selected_libretro_rom_entry(
        archive_path: &Path,
        select: &[String],
        entries: &[ContainerListEntry],
    ) -> Result<Option<ContainerListEntry>> {
        let mut matcher = SelectionMatcher::new(select);
        let selected = entries
            .iter()
            .filter(|entry| is_rom_filter_candidate_name(&entry.path))
            .filter(|entry| matcher.matches(&entry.path))
            .cloned()
            .collect::<Vec<_>>();
        matcher.ensure_all_matched()?;
        match selected.len() {
            0 => Ok(None),
            1 => Ok(selected.into_iter().next()),
            _ => {
                let choices = selected
                    .iter()
                    .map(|entry| format!("`{}`", entry.path))
                    .collect::<Vec<_>>()
                    .join(", ");
                Err(RomWeaverError::Validation(format!(
                    "patch apply input sidecar discovery is ambiguous for `{}`; ROM candidates: {choices}. Pass --select <pattern> to choose one payload",
                    archive_path.display()
                )))
            }
        }
    }

    fn discover_patch_apply_sidecars(
        &self,
        input: &Path,
        select: &[String],
        no_ignore: bool,
        context: &OperationContext,
    ) -> Result<DiscoveredPatchApplySidecars> {
        let Some(handler) = self.containers.probe(input) else {
            return Ok(DiscoveredPatchApplySidecars::default());
        };
        if handler.descriptor().matches_name("xiso") || !handler.capabilities().extract {
            return Ok(DiscoveredPatchApplySidecars::default());
        }

        let probe_request = ContainerProbeRequest {
            source: input.to_path_buf(),
        };
        handler.probe_details(&probe_request, context)?;
        let listed_entries = handler.list_entries(&probe_request, context)?;
        let entries = listed_entries
            .into_iter()
            .map(|entry| ContainerListEntry {
                path: normalize_archive_name(&entry),
                size: None,
            })
            .filter(|entry| !entry.path.is_empty())
            .filter(|entry| no_ignore || !should_ignore_common_container_file(&entry.path))
            .collect::<Vec<_>>();
        let Some(rom_entry) = Self::selected_libretro_rom_entry(input, select, &entries)? else {
            return Ok(DiscoveredPatchApplySidecars::default());
        };

        let mut sidecars = entries
            .iter()
            .filter(|entry| is_patch_filter_candidate_name(&entry.path))
            .filter_map(|entry| {
                let order = Self::entry_matches_libretro_sidecar(&rom_entry.path, &entry.path)?;
                Some(ResolvedSidecarPatchEntry {
                    entry: entry.clone(),
                    order,
                })
            })
            .collect::<Vec<_>>();
        sidecars.sort_by(|left, right| {
            left.order
                .cmp(&right.order)
                .then_with(|| left.entry.path.cmp(&right.entry.path))
        });
        if sidecars.is_empty() {
            return Ok(DiscoveredPatchApplySidecars::default());
        }

        let out_dir = context
            .temp_paths()
            .next_path("patch-apply-sidecar-patch-extract", None);
        fs::create_dir_all(&out_dir)?;
        self.emit_running(
            OperationLabel {
                command: "patch-apply",
                family: OperationFamily::Patch,
                format: Some(handler.descriptor().name),
            },
            "prepare",
            format!(
                "extracting {} RetroArch sidecar patch file(s) from `{}`",
                sidecars.len(),
                input.display()
            ),
            None,
            Some(context.plan_threads(handler.capabilities().extract_threads)),
        );
        let selections = sidecars
            .iter()
            .map(|sidecar| sidecar.entry.path.clone())
            .collect::<Vec<_>>();
        let request = ContainerExtractRequest {
            source: input.to_path_buf(),
            selections: Vec::new(),
            kind_filter: Self::archive_entry_kind_filter(false, true),
            out_dir: out_dir.clone(),
            split_bin: false,
            ignore_common_files: !no_ignore,
            overwrite: true,
            parent: None,
        };
        handler.extract(&request, context)?;
        let selected_names = selections.into_iter().collect::<BTreeSet<_>>();
        let patches = self
            .collect_checksum_extract_candidates(&out_dir)?
            .into_iter()
            .filter(|candidate| selected_names.contains(&candidate.display_name))
            .map(|candidate| candidate.source)
            .collect::<Vec<_>>();
        if patches.len() != selected_names.len() {
            return Err(RomWeaverError::Validation(format!(
                "failed to extract all RetroArch sidecar patches from `{}`",
                input.display()
            )));
        }
        Ok(DiscoveredPatchApplySidecars {
            patches,
            cleanup_paths: vec![out_dir],
        })
    }

    fn run_patch_apply(&self, args: PatchApplyCommand) -> AppRunOutcome {
        trace!(
            input = %args.input.display(),
            selections = args.select.len(),
            rom_filter = args.rom_filter,
            patch_filter = args.patch_filter,
            patch_count = args.patches.len(),
            output = %args.output.display(),
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            no_compress = args.no_compress,
            compress_format = ?args.compress_format,
            compress_codec = ?args.compress_codec,
            compress_level = ?args.compress_level,
            checksum_cache = args.checksum_cache.len(),
            validate_with_checksums = args.validate_with_checksums.len(),
            strip_header = args.strip_header,
            add_header = args.add_header,
            repair_checksum = args.repair_checksum,
            ignore_checksum_validation = args.ignore_checksum_validation,
            validate_with_output_checksums = args.validate_with_output_checksums.len(),
            ppf_undo_aware = args.ppf_undo_aware,
            threads = %args.threads,
            "starting patch-apply command"
        );
        let PatchApplyCommand {
            input,
            select,
            rom_filter,
            patch_filter,
            no_extract,
            no_ignore,
            mut patches,
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
            validate_with_output_checksums,
            ppf_undo_aware,
            threads,
        } = args;
        let discover_implicit_patches = patches.is_empty() && !no_extract;
        let input_kind_filter = Self::archive_entry_kind_filter(rom_filter || discover_implicit_patches, false);
        let patch_kind_filter = Self::archive_entry_kind_filter(false, patch_filter);
        let context = self
            .context(threads)
            .with_patch_checksum_validation(if ignore_checksum_validation {
                PatchChecksumValidation::Ignore
            } else {
                PatchChecksumValidation::Strict
            })
            .with_ppf_undo_aware(ppf_undo_aware);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        let compression_options = match Self::parse_patch_apply_compression_options(
            no_compress,
            compress_format,
            compress_codec,
            compress_level,
        ) {
            Ok(options) => options,
            Err(error) => {
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        let cached_input_checksums =
            match Self::parse_patch_apply_checksum_values(&checksum_cache, "--checksum-cache") {
                Ok(values) => values,
                Err(error) => {
                    return self.finish(
                        "patch-apply",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            probe_threads.clone(),
                        ),
                    );
                }
            };
        let expected_input_checksums = match Self::parse_patch_apply_checksum_values(
            &validate_with_checksums,
            "--validate-with-checksum",
        ) {
            Ok(values) => values,
            Err(error) => {
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        let expected_output_checksums = match Self::parse_patch_apply_checksum_values(
            &validate_with_output_checksums,
            "--validate-output-checksum",
        ) {
            Ok(values) => values,
            Err(error) => {
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        if let Some(report) = self.require_existing_path(
            "patch-apply",
            OperationFamily::Patch,
            None,
            &input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-apply", report);
        }
        let discovered_sidecars = if discover_implicit_patches {
            match self.discover_patch_apply_sidecars(&input, &select, no_ignore, &context) {
                Ok(discovered) => discovered,
                Err(error) => {
                    return self.finish(
                        "patch-apply",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "prepare",
                            error.to_string(),
                            probe_threads.clone(),
                        ),
                    );
                }
            }
        } else {
            DiscoveredPatchApplySidecars::default()
        };
        if patches.is_empty() {
            patches = discovered_sidecars.patches.clone();
        }
        if patches.is_empty() {
            return self.finish(
                "patch-apply",
                OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    "patch apply requires at least one --patch file or RetroArch-style sidecar patch inside the input archive".to_string(),
                    probe_threads.clone(),
                ),
            );
        }
        for patch_path in &patches {
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

        let resolved_input = match self.resolve_source_with_auto_extract(
            &input,
            &select,
            &context,
            AutoExtractResolutionLabels {
                command: "patch-apply",
                family: OperationFamily::Patch,
                format: None,
                source_label: "patch apply input",
                temp_prefix: "patch-apply-input-extract",
            },
            AutoExtractResolutionFlags {
                no_extract,
                no_ignore,
                kind_filter: input_kind_filter,
            },
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "prepare",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        let ResolvedChecksumSource {
            source: resolved_input,
            extracted_archives,
            cleanup_paths,
        } = resolved_input;
        let mut temp_paths = cleanup_paths;
        temp_paths.extend(discovered_sidecars.cleanup_paths);
        let mut resolved_patches = Vec::with_capacity(patches.len());
        let mut extracted_patch_notes = Vec::new();
        for (index, patch_path) in patches.iter().enumerate() {
            let patch_source_label = if patches.len() == 1 {
                "patch apply patch source".to_string()
            } else {
                format!("patch apply patch {}/{} source", index + 1, patches.len())
            };
            let resolved_patch = match self.resolve_source_with_auto_extract(
                patch_path,
                &select,
                &context,
                AutoExtractResolutionLabels {
                    command: "patch-apply",
                    family: OperationFamily::Patch,
                    format: None,
                    source_label: patch_source_label.as_str(),
                    temp_prefix: "patch-apply-patch-extract",
                },
                AutoExtractResolutionFlags {
                    no_extract,
                    no_ignore,
                    kind_filter: patch_kind_filter,
                },
            ) {
                Ok(resolved) => resolved,
                Err(error) => {
                    return self.finish(
                        "patch-apply",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "prepare",
                            error.to_string(),
                            probe_threads.clone(),
                        ),
                    );
                }
            };
            let ResolvedChecksumSource {
                source: resolved_patch_source,
                extracted_archives: resolved_patch_extracted_archives,
                cleanup_paths: resolved_patch_cleanup_paths,
            } = resolved_patch;
            if resolved_patch_extracted_archives > 0 {
                let note = if patches.len() == 1 {
                    format!(
                        "patch apply patch source resolved via {} container extract step(s)",
                        resolved_patch_extracted_archives
                    )
                } else {
                    format!(
                        "patch {}/{} source resolved via {} container extract step(s)",
                        index + 1,
                        patches.len(),
                        resolved_patch_extracted_archives
                    )
                };
                extracted_patch_notes.push(note);
            }
            temp_paths.extend(resolved_patch_cleanup_paths);
            resolved_patches.push((patch_path.clone(), resolved_patch_source));
        }

        let report = (|| {
            if patches.is_empty() {
                return OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    "at least one --patch value is required",
                    probe_threads.clone(),
                );
            }

            let mut stripped_header = None;
            let mut stripped_header_match = None;
            let mut checksum_verification_labels = Vec::new();
            let apply_input = if strip_header {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "prepare",
                    "stripping ROM header before patch apply",
                    None,
                    None,
                );
                let stripped_path = context
                    .temp_paths()
                    .next_path("patch-apply-input-noheader", Some("bin"));
                match Self::strip_header_to_temp(&resolved_input, &stripped_path) {
                    Ok(result) => {
                        stripped_header = Some(result.header_bytes);
                        stripped_header_match = result.matched_header;
                        temp_paths.push(stripped_path.clone());
                        stripped_path
                    }
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "compat",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            } else {
                resolved_input.clone()
            };
            if !expected_input_checksums.is_empty() {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "validate",
                    format!(
                        "validating {} requested input checksum(s)",
                        expected_input_checksums.len()
                    ),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                match Self::validate_patch_apply_expected_checksums(
                    &apply_input,
                    &expected_input_checksums,
                    &cached_input_checksums,
                    "input",
                    &context,
                ) {
                    Ok(label) => checksum_verification_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            }

            let patch_count = resolved_patches.len();
            let requires_compat_finalize = add_header || repair_checksum || patch_count > 1;
            let needs_staged_output = requires_compat_finalize || compression_options.enabled;
            let staged_output = if needs_staged_output {
                if compression_options.enabled {
                    match Self::patch_apply_raw_output_path(
                        &output,
                        &resolved_input,
                        &context,
                        "patch-apply-output-staged",
                        &mut temp_paths,
                    ) {
                        Ok(path) => path,
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                None,
                                "prepare",
                                error.to_string(),
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                    }
                } else {
                    let staged_path = context
                        .temp_paths()
                        .next_path("patch-apply-output-staged", Some("bin"));
                    temp_paths.push(staged_path.clone());
                    staged_path
                }
            } else {
                output.clone()
            };
            let mut terminal_output_path = output.clone();

            let mut current_input = apply_input;
            let mut applied_formats = Vec::with_capacity(patch_count);
            let mut report = OperationReport::failed(
                OperationFamily::Patch,
                None,
                "apply",
                "patch apply was not executed",
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );

            for (index, (patch_path, resolved_patch_path)) in resolved_patches.iter().enumerate() {
                let Some(handler) = self.patches.probe(resolved_patch_path) else {
                    let patch_label = if patch_path == resolved_patch_path {
                        format!("`{}`", patch_path.display())
                    } else {
                        format!(
                            "`{}` (resolved from `{}`)",
                            resolved_patch_path.display(),
                            patch_path.display()
                        )
                    };
                    let unsupported_reason =
                        explicitly_unsupported_patch_reason_for_path(resolved_patch_path);
                    let (format_name, label) = match unsupported_reason {
                        Some(reason) => (
                            Some("PDS".to_string()),
                            format!(
                                "patch {}/{}: {} is explicitly not supported: {reason}",
                                index + 1,
                                patch_count,
                                patch_label
                            ),
                        ),
                        None => (
                            None,
                            format!(
                                "patch {}/{}: no registered patch handler matched {}",
                                index + 1,
                                patch_count,
                                patch_label
                            ),
                        ),
                    };
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        format_name,
                        "probe",
                        label,
                        probe_threads.clone(),
                    );
                };
                applied_formats.push(handler.descriptor().name);
                let patch_start_percent = patch_progress_segment_start(index, patch_count);

                let is_last = index + 1 == patch_count;
                let apply_output = if is_last {
                    staged_output.clone()
                } else {
                    let intermediate_output = context
                        .temp_paths()
                        .next_path("patch-apply-output-step", Some("bin"));
                    temp_paths.push(intermediate_output.clone());
                    intermediate_output
                };
                if let Some(parent) = apply_output.parent()
                    && !parent.exists()
                    && let Err(error) = fs::create_dir_all(parent)
                {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "prepare",
                        format!(
                            "failed to prepare output path `{}`: {error}",
                            apply_output.display()
                        ),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                }

                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: Some(handler.descriptor().name),
                    },
                    "apply",
                    if patch_count == 1 {
                        format!("applying patch using {}", handler.descriptor().name)
                    } else {
                        format!(
                            "applying patch {}/{} using {} (`{}`)",
                            index + 1,
                            patch_count,
                            handler.descriptor().name,
                            patch_path.display()
                        )
                    },
                    Some(patch_start_percent),
                    None,
                );

                let request = PatchApplyRequest {
                    input: current_input,
                    patches: vec![resolved_patch_path.clone()],
                    output: apply_output.clone(),
                };
                let progress_tracker = Arc::new(PatchApplyProgressTracker::default());
                let patch_context = context.clone().with_progress_sink(Arc::new(
                    PatchApplyProgressSink::new(
                        context.progress_sink(),
                        index,
                        patch_count,
                        progress_tracker.clone(),
                    ),
                ));
                report = match handler.apply(&request, &patch_context) {
                    Ok(report) => report,
                    Err(RomWeaverError::Unsupported(label)) => OperationReport::unsupported(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "apply",
                        label,
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    ),
                    Err(error) => OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "apply",
                        error.to_string(),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    ),
                };
                if report.status != OperationStatus::Succeeded {
                    if patch_count > 1 {
                        report.label = format!(
                            "patch {}/{} (`{}`): {}",
                            index + 1,
                            patch_count,
                            patch_path.display(),
                            report.label
                        );
                    }
                    return report;
                }
                if !progress_tracker.saw_meaningful_running_progress() {
                    self.emit_running(
                        OperationLabel {
                            command: "patch-apply",
                            family: OperationFamily::Patch,
                            format: Some(handler.descriptor().name),
                        },
                        "apply",
                        if patch_count == 1 {
                            format!("applied patch using {}", handler.descriptor().name)
                        } else {
                            format!(
                                "applied patch {}/{} using {} (`{}`)",
                                index + 1,
                                patch_count,
                                handler.descriptor().name,
                                patch_path.display()
                            )
                        },
                        None,
                        report.thread_execution.clone(),
                    );
                }

                current_input = apply_output;
            }

            let mut raw_ready_output = staged_output.clone();
            if report.status == OperationStatus::Succeeded && requires_compat_finalize {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: applied_formats.last().copied(),
                    },
                    "compat",
                    if add_header || repair_checksum {
                        "finalizing compatibility output transforms"
                    } else {
                        "finalizing multi-patch output"
                    },
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                let finalized_output_path = if compression_options.enabled {
                    match Self::patch_apply_raw_output_path(
                        &output,
                        &resolved_input,
                        &context,
                        "patch-apply-output-raw-final",
                        &mut temp_paths,
                    ) {
                        Ok(path) => path,
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                report.format.clone(),
                                "prepare",
                                error.to_string(),
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                    }
                } else {
                    output.clone()
                };
                match Self::finalize_patch_apply_output(
                    &staged_output,
                    &finalized_output_path,
                    add_header,
                    stripped_header.as_deref(),
                    repair_checksum,
                    Some(&resolved_input),
                ) {
                    Ok(finalized) => {
                        raw_ready_output = finalized_output_path;
                        if finalized.repaired_profiles.len() == 1 {
                            report.label = format!(
                                "{}; repaired checksum ({})",
                                report.label, finalized.repaired_profiles[0]
                            );
                        } else if !finalized.repaired_profiles.is_empty() {
                            report.label = format!(
                                "{}; repaired headers ({})",
                                report.label,
                                finalized.repaired_profiles.join(", ")
                            );
                        }
                        if let Some(repair_warning) = finalized.repair_warning {
                            report.label = format!("{}; warning={repair_warning}", report.label);
                        }
                    }
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "compat",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            }

            if patch_count > 1 {
                report.label = format!(
                    "applied {patch_count} patches sequentially ({}); {}",
                    applied_formats.join(" -> "),
                    report.label
                );
            }
            if strip_header {
                if let Some(header_match) = stripped_header_match {
                    report.label = format!(
                        "{}; input header stripped ({} bytes, {})",
                        report.label,
                        header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES),
                        header_match.profile_name()
                    );
                } else {
                    report.label = format!(
                        "{}; input header stripped ({} bytes)",
                        report.label, ROM_HEADER_BYTES
                    );
                }
            }
            if extracted_archives > 0 {
                report.label = format!(
                    "{}; patch apply input source resolved via {extracted_archives} container extract step(s)",
                    report.label
                );
            }
            if !extracted_patch_notes.is_empty() {
                report.label = format!("{}; {}", report.label, extracted_patch_notes.join("; "));
            }
            if report.status == OperationStatus::Succeeded && !expected_output_checksums.is_empty() {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: report.format.as_deref(),
                    },
                    "validate",
                    format!(
                        "validating {} requested output checksum(s)",
                        expected_output_checksums.len()
                    ),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                match Self::validate_patch_apply_expected_checksums(
                    &raw_ready_output,
                    &expected_output_checksums,
                    &BTreeMap::new(),
                    "output",
                    &context,
                ) {
                    Ok(label) => checksum_verification_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "validate",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            }

            if !checksum_verification_labels.is_empty() {
                report.label = format!(
                    "{}; {}",
                    report.label,
                    checksum_verification_labels.join("; ")
                );
            }

            if report.status == OperationStatus::Succeeded && compression_options.enabled {
                let compression_plan = match self.resolve_patch_apply_compression_plan(
                    &output,
                    &resolved_input,
                    &compression_options,
                ) {
                    Ok(plan) => plan,
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "compress",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                };
                let Some(compress_handler) = self.containers.find_by_name(&compression_plan.format)
                else {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        report.format.clone(),
                        "compress",
                        "requested output format is not registered",
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                };
                let archive_input = match Self::stage_patch_apply_archive_input(
                    &raw_ready_output,
                    &output,
                    &resolved_input,
                ) {
                    Ok(path) => path,
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "compress",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                };
                let compress_threads =
                    Some(context.plan_threads(compress_handler.capabilities().create_threads));
                let codec_label = compression_plan
                    .codec
                    .as_deref()
                    .unwrap_or("default")
                    .to_string();
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: Some(compression_plan.format.as_str()),
                    },
                    "compress",
                    format!(
                        "compressing patched output as {} (codec={codec_label})",
                        compression_plan.format
                    ),
                    Some(0.0),
                    compress_threads,
                );
                let compress_request = ContainerCreateRequest {
                    inputs: vec![archive_input],
                    output: compression_plan.output_path.clone(),
                    format: compression_plan.format.clone(),
                    codec: compression_plan.codec.clone(),
                    level: compression_plan.level,
                    parent: None,
                };
                let compress_report = compress_handler
                    .create(&compress_request, &context)
                    .unwrap_or_else(|error| {
                        OperationReport::failed(
                            OperationFamily::Container,
                            Some(compress_handler.descriptor().name.to_string()),
                            "create",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        )
                    });
                if compress_report.status != OperationStatus::Succeeded {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        report.format.clone(),
                        "compress",
                        format!("patch output compression failed: {}", compress_report.label),
                        compress_report.thread_execution,
                    );
                }
                let extension_note = if compression_plan.extension_appended {
                    "; output extension appended to match container format"
                } else {
                    ""
                };
                let warning_note = compression_plan
                    .warning
                    .as_deref()
                    .map(|warning| format!("; warning: {warning}"))
                    .unwrap_or_default();
                report.stage = "compress".to_string();
                report.label = format!(
                    "{}; patch output compressed as {} (codec={}, path=`{}`; {}){}{}",
                    report.label,
                    compression_plan.format,
                    codec_label,
                    compression_plan.output_path.display(),
                    compression_plan.note,
                    extension_note,
                    warning_note
                );
                terminal_output_path = compression_plan.output_path;
            }

            if report.status == OperationStatus::Succeeded {
                let kind_hint = if compression_options.enabled {
                    Some("archive")
                } else {
                    None
                };
                report = Self::attach_emitted_files_details(
                    report,
                    vec![terminal_output_path],
                    kind_hint,
                );
            }

            report
        })();

        Self::cleanup_temp_paths(temp_paths);
        self.finish("patch-apply", report)
    }

    fn patch_apply_raw_output_path(
        requested_output: &Path,
        extension_source: &Path,
        context: &OperationContext,
        purpose: &str,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<PathBuf> {
        let entry_file_name =
            Self::patch_apply_archive_entry_file_name(requested_output, extension_source);
        let source_extension = extension_source
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("");
        let entry_dir = context.temp_paths().next_path(purpose, None);
        fs::create_dir_all(&entry_dir)?;
        let raw_output = entry_dir.join(&entry_file_name);
        trace!(
            raw_output = %raw_output.display(),
            requested_output = %requested_output.display(),
            extension_source = %extension_source.display(),
            source_extension,
            archive_entry_name = %entry_file_name.to_string_lossy(),
            "patch apply raw output path resolved with archive entry name"
        );
        temp_paths.push(entry_dir);
        Ok(raw_output)
    }

    fn stage_patch_apply_archive_input(
        raw_ready_output: &Path,
        requested_output: &Path,
        extension_source: &Path,
    ) -> Result<PathBuf> {
        let entry_file_name =
            Self::patch_apply_archive_entry_file_name(requested_output, extension_source);
        let source_extension = extension_source
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("");
        if raw_ready_output
            .file_name()
            .is_some_and(|file_name| file_name == entry_file_name.as_os_str())
        {
            trace!(
                raw_ready_output = %raw_ready_output.display(),
                requested_output = %requested_output.display(),
                extension_source = %extension_source.display(),
                source_extension,
                archive_entry_name = %entry_file_name.to_string_lossy(),
                "patch apply archive input already matches requested entry name"
            );
            return Ok(raw_ready_output.to_path_buf());
        }

        trace!(
            raw_ready_output = %raw_ready_output.display(),
            requested_output = %requested_output.display(),
            extension_source = %extension_source.display(),
            source_extension,
            archive_entry_name = %entry_file_name.to_string_lossy(),
            "patch apply archive input name did not match requested entry name"
        );
        Err(RomWeaverError::Validation(format!(
            "patched output `{}` does not match archive entry name `{}`",
            raw_ready_output.display(),
            entry_file_name.to_string_lossy()
        )))
    }

    fn patch_apply_archive_entry_file_name(
        requested_output: &Path,
        extension_source: &Path,
    ) -> std::ffi::OsString {
        let fallback = std::ffi::OsString::from("patched.bin");
        let Some(file_name) = requested_output.file_name() else {
            return fallback;
        };
        let file_name_text = file_name.to_string_lossy();
        let archive_entry_name = Self::strip_archive_extension(&file_name_text);
        let archive_entry_path = Path::new(&archive_entry_name);
        if archive_entry_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| !extension.is_empty())
        {
            return archive_entry_path.as_os_str().to_os_string();
        }

        let Some(source_extension) = extension_source
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::trim)
            .filter(|extension| !extension.is_empty())
        else {
            return archive_entry_path.as_os_str().to_os_string();
        };

        let mut archive_entry_path = archive_entry_path.to_path_buf();
        archive_entry_path.set_extension(source_extension);
        archive_entry_path.as_os_str().to_os_string()
    }

    fn strip_archive_extension(file_name: &str) -> String {
        let lower = file_name.to_ascii_lowercase();
        for extension in [".zipx", ".zip", ".7z"] {
            if lower.ends_with(extension) {
                let stripped_len = file_name.len().saturating_sub(extension.len());
                return file_name[..stripped_len].to_string();
            }
        }
        file_name.to_string()
    }

    fn run_patch_validate(&self, args: PatchValidateCommand) -> AppRunOutcome {
        trace!(
            input = %args.input.display(),
            selections = args.select.len(),
            rom_filter = args.rom_filter,
            patch_filter = args.patch_filter,
            patch_count = args.patches.len(),
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            checksum_cache = args.checksum_cache.len(),
            validate_with_checksums = args.validate_with_checksums.len(),
            validate_with_size = ?args.validate_with_size,
            validate_with_min_size = ?args.validate_with_min_size,
            strip_header = args.strip_header,
            ignore_checksum_validation = args.ignore_checksum_validation,
            threads = %args.threads,
            "starting patch-validate command"
        );
        let PatchValidateCommand {
            input,
            select,
            rom_filter,
            patch_filter,
            no_extract,
            no_ignore,
            patches,
            checksum_cache,
            validate_with_checksums,
            validate_with_size,
            validate_with_min_size,
            strip_header,
            ignore_checksum_validation,
            threads,
        } = args;
        let input_kind_filter = Self::archive_entry_kind_filter(rom_filter, false);
        let patch_kind_filter = Self::archive_entry_kind_filter(false, patch_filter);
        let context =
            self.context(threads)
                .with_patch_checksum_validation(if ignore_checksum_validation {
                    PatchChecksumValidation::Ignore
                } else {
                    PatchChecksumValidation::Strict
                });
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        let cached_input_checksums =
            match Self::parse_patch_apply_checksum_values(&checksum_cache, "--checksum-cache") {
                Ok(values) => values,
                Err(error) => {
                    return self.finish(
                        "patch-validate",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            probe_threads.clone(),
                        ),
                    );
                }
            };
        let expected_input_checksums = match Self::parse_patch_apply_checksum_values(
            &validate_with_checksums,
            "--validate-with-checksum",
        ) {
            Ok(values) => values,
            Err(error) => {
                return self.finish(
                    "patch-validate",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        if let Some(report) = self.require_existing_path(
            "patch-validate",
            OperationFamily::Patch,
            None,
            &input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-validate", report);
        }
        for patch_path in &patches {
            if let Some(report) = self.require_existing_path(
                "patch-validate",
                OperationFamily::Patch,
                None,
                patch_path,
                probe_threads.clone(),
            ) {
                return self.finish("patch-validate", report);
            }
        }

        let resolved_input = match self.resolve_source_with_auto_extract(
            &input,
            &select,
            &context,
            AutoExtractResolutionLabels {
                command: "patch-validate",
                family: OperationFamily::Patch,
                format: None,
                source_label: "patch validate input",
                temp_prefix: "patch-validate-input-extract",
            },
            AutoExtractResolutionFlags {
                no_extract,
                no_ignore,
                kind_filter: input_kind_filter,
            },
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish(
                    "patch-validate",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "prepare",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        let ResolvedChecksumSource {
            source: resolved_input,
            extracted_archives,
            cleanup_paths,
        } = resolved_input;
        let mut temp_paths = cleanup_paths;
        let mut resolved_patches = Vec::with_capacity(patches.len());
        let mut extracted_patch_notes = Vec::new();
        for (index, patch_path) in patches.iter().enumerate() {
            let patch_source_label = if patches.len() == 1 {
                "patch validate patch source".to_string()
            } else {
                format!("patch validate patch {}/{} source", index + 1, patches.len())
            };
            let resolved_patch = match self.resolve_source_with_auto_extract(
                patch_path,
                &select,
                &context,
                AutoExtractResolutionLabels {
                    command: "patch-validate",
                    family: OperationFamily::Patch,
                    format: None,
                    source_label: patch_source_label.as_str(),
                    temp_prefix: "patch-validate-patch-extract",
                },
                AutoExtractResolutionFlags {
                    no_extract,
                    no_ignore,
                    kind_filter: patch_kind_filter,
                },
            ) {
                Ok(resolved) => resolved,
                Err(error) => {
                    return self.finish(
                        "patch-validate",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "prepare",
                            error.to_string(),
                            probe_threads.clone(),
                        ),
                    );
                }
            };
            let ResolvedChecksumSource {
                source: resolved_patch_source,
                extracted_archives: resolved_patch_extracted_archives,
                cleanup_paths: resolved_patch_cleanup_paths,
            } = resolved_patch;
            if resolved_patch_extracted_archives > 0 {
                let note = if patches.len() == 1 {
                    format!(
                        "patch validate patch source resolved via {} container extract step(s)",
                        resolved_patch_extracted_archives
                    )
                } else {
                    format!(
                        "patch {}/{} source resolved via {} container extract step(s)",
                        index + 1,
                        patches.len(),
                        resolved_patch_extracted_archives
                    )
                };
                extracted_patch_notes.push(note);
            }
            temp_paths.extend(resolved_patch_cleanup_paths);
            resolved_patches.push((patch_path.clone(), resolved_patch_source));
        }

        let report = (|| {
            if patches.is_empty() {
                return OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    "at least one --patch value is required",
                    probe_threads.clone(),
                );
            }

            let mut validation_labels = Vec::new();
            let validate_input = if strip_header {
                self.emit_running(
                    OperationLabel {
                        command: "patch-validate",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "prepare",
                    "stripping ROM header before patch validation",
                    None,
                    None,
                );
                let stripped_path = context
                    .temp_paths()
                    .next_path("patch-validate-input-noheader", Some("bin"));
                match Self::strip_header_to_temp(&resolved_input, &stripped_path) {
                    Ok(_result) => {
                        temp_paths.push(stripped_path.clone());
                        stripped_path
                    }
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "compat",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            } else {
                resolved_input.clone()
            };
            if validate_with_size.is_some() || validate_with_min_size.is_some() {
                match Self::validate_patch_input_size(
                    &validate_input,
                    validate_with_size,
                    validate_with_min_size,
                ) {
                    Ok(label) => validation_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            }
            if !expected_input_checksums.is_empty() {
                self.emit_running(
                    OperationLabel {
                        command: "patch-validate",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "validate",
                    format!(
                        "validating {} requested input checksum(s)",
                        expected_input_checksums.len()
                    ),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                match Self::validate_patch_apply_expected_checksums(
                    &validate_input,
                    &expected_input_checksums,
                    &cached_input_checksums,
                    "input",
                    &context,
                ) {
                    Ok(label) => validation_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            }

            let patch_count = resolved_patches.len();
            let mut current_input = validate_input;
            let mut formats = Vec::with_capacity(patch_count);
            for (index, (patch_path, resolved_patch_path)) in resolved_patches.iter().enumerate() {
                let Some(handler) = self.patches.probe(resolved_patch_path) else {
                    let patch_label = if patch_path == resolved_patch_path {
                        format!("`{}`", patch_path.display())
                    } else {
                        format!(
                            "`{}` (resolved from `{}`)",
                            resolved_patch_path.display(),
                            patch_path.display()
                        )
                    };
                    let unsupported_reason =
                        explicitly_unsupported_patch_reason_for_path(resolved_patch_path);
                    let (format_name, label) = match unsupported_reason {
                        Some(reason) => (
                            Some("PDS".to_string()),
                            format!(
                                "patch {}/{}: {} is explicitly not supported: {reason}",
                                index + 1,
                                patch_count,
                                patch_label
                            ),
                        ),
                        None => (
                            None,
                            format!(
                                "patch {}/{}: no registered patch handler matched {}",
                                index + 1,
                                patch_count,
                                patch_label
                            ),
                        ),
                    };
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        format_name,
                        "probe",
                        label,
                        probe_threads.clone(),
                    );
                };
                if !handler.capabilities().apply {
                    return OperationReport::unsupported(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "validate",
                        format!(
                            "{} does not support dry-run validation",
                            handler.descriptor().name
                        ),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                }
                formats.push(handler.descriptor().name.to_string());

                self.emit_running(
                    OperationLabel {
                        command: "patch-validate",
                        family: OperationFamily::Patch,
                        format: Some(handler.descriptor().name),
                    },
                    "validate",
                    if patch_count == 1 {
                        format!("validating patch using {}", handler.descriptor().name)
                    } else {
                        format!(
                            "validating patch {}/{} using {} (`{}`)",
                            index + 1,
                            patch_count,
                            handler.descriptor().name,
                            patch_path.display()
                        )
                    },
                    Some(patch_progress_segment_start(index, patch_count)),
                    None,
                );

                let progress_tracker = Arc::new(PatchApplyProgressTracker::default());
                let patch_context = context.clone().with_progress_sink(Arc::new(
                    PatchApplyProgressSink::new_for_command(
                        context.progress_sink(),
                        index,
                        patch_count,
                        progress_tracker.clone(),
                        "patch-validate",
                        "validate",
                    ),
                ));

                let mut validate_output = None;
                let report = if patch_count == 1 {
                    let request = PatchValidateRequest {
                        input: current_input.clone(),
                        patches: vec![resolved_patch_path.clone()],
                    };
                    match handler.validate(&request, &patch_context) {
                        Ok(report) => report,
                        Err(RomWeaverError::Unsupported(label)) => {
                            return OperationReport::unsupported(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                label,
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                error.to_string(),
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                    }
                } else {
                    let output = context
                        .temp_paths()
                        .next_path("patch-validate-output-step", Some("bin"));
                    temp_paths.push(output.clone());
                    if let Some(parent) = output.parent()
                        && !parent.exists()
                        && let Err(error) = fs::create_dir_all(parent)
                    {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            Some(handler.descriptor().name.to_string()),
                            "prepare",
                            format!(
                                "failed to prepare validation output path `{}`: {error}",
                                output.display()
                            ),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }

                    let request = PatchApplyRequest {
                        input: current_input.clone(),
                        patches: vec![resolved_patch_path.clone()],
                        output: output.clone(),
                    };
                    let report = match handler.apply(&request, &patch_context) {
                        Ok(report) => report,
                        Err(RomWeaverError::Unsupported(label)) => {
                            return OperationReport::unsupported(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                label,
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                error.to_string(),
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                    };
                    validate_output = Some(output);
                    report
                };
                if report.status != OperationStatus::Succeeded {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "validate",
                        report.label,
                        report.thread_execution
                            .or_else(|| Some(context.plan_threads(ThreadCapability::single_threaded()))),
                    );
                }
                if !progress_tracker.saw_meaningful_running_progress() {
                    self.emit_running(
                        OperationLabel {
                            command: "patch-validate",
                            family: OperationFamily::Patch,
                            format: Some(handler.descriptor().name),
                        },
                        "validate",
                        if patch_count == 1 {
                            format!("validated patch using {}", handler.descriptor().name)
                        } else {
                            format!(
                                "validated patch {}/{} using {} (`{}`)",
                                index + 1,
                                patch_count,
                                handler.descriptor().name,
                                patch_path.display()
                            )
                        },
                        None,
                        report.thread_execution.clone(),
                    );
                }
                if let Some(output) = validate_output {
                    current_input = output;
                }
            }

            if extracted_archives > 0 {
                validation_labels.push(format!(
                    "input resolved via {extracted_archives} container extract step(s)"
                ));
            }
            validation_labels.extend(extracted_patch_notes);
            let format_label = if formats.is_empty() {
                "patch".to_string()
            } else {
                formats.join(", ")
            };
            let suffix = if validation_labels.is_empty() {
                String::new()
            } else {
                format!("; {}", validation_labels.join("; "))
            };
            let final_format = formats.last().cloned();
            let mut report = OperationReport::succeeded(
                OperationFamily::Patch,
                final_format.clone(),
                "validate",
                format!(
                    "patch validation passed for {} patch(es) ({format_label}){suffix}",
                    patch_count
                ),
                Some(100.0),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            report.details = Some(json!({
                "patch_validation": {
                    "dry_run": true,
                    "format": final_format,
                    "formats": formats,
                    "patch_count": patch_count,
                    "source_values": {
                        "minimum_size": validate_with_min_size,
                        "size": validate_with_size,
                        "checksums": expected_input_checksums,
                    },
                    "status": "passed",
                }
            }));
            report
        })();

        Self::cleanup_temp_paths(temp_paths);
        self.finish("patch-validate", report)
    }

    fn run_patch_create_candidates(&self, args: PatchCreateCandidatesCommand) -> AppRunOutcome {
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
    fn resolve_patch_create_format(
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

    fn run_patch_create(&self, args: PatchCreateCommand) -> AppRunOutcome {
        trace!(
            original = %args.original.display(),
            modified = %args.modified.display(),
            output = %args.output.display(),
            format = ?args.format,
            ignore_checksum_validation = args.ignore_checksum_validation,
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
        let resolution = match self.resolve_patch_create_format(args.format.as_deref(), &args.output)
        {
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

        let request = PatchCreateRequest {
            original: args.original,
            modified: args.modified,
            output: args.output,
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
        self.finish("patch-create", report)
    }

    fn parse_patch_apply_checksum_values(
        values: &[String],
        flag_name: &str,
    ) -> Result<BTreeMap<String, String>> {
        let mut parsed = BTreeMap::new();
        for raw in values {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value cannot be empty; expected ALGO=HEX"
                )));
            }
            let (algorithm_raw, checksum_raw) = trimmed.split_once('=').ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; expected ALGO=HEX"
                ))
            })?;

            let algorithm = algorithm_raw.trim().to_ascii_lowercase();
            if algorithm.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; checksum algorithm is missing before `=`"
                )));
            }
            if !supported_algorithms()
                .iter()
                .any(|supported| supported.eq_ignore_ascii_case(&algorithm))
            {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} uses unsupported checksum algorithm `{}`",
                    algorithm_raw.trim()
                )));
            }

            let checksum = checksum_raw.trim();
            if checksum.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; checksum value is missing after `=`"
                )));
            }
            let checksum = checksum
                .strip_prefix("0x")
                .or_else(|| checksum.strip_prefix("0X"))
                .unwrap_or(checksum)
                .to_ascii_lowercase();
            if !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; checksum must be hexadecimal"
                )));
            }
            let Some(expected_hex_len) = Self::checksum_hex_len(&algorithm) else {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} uses unsupported checksum algorithm `{}`",
                    algorithm_raw.trim()
                )));
            };
            if checksum.len() != expected_hex_len {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; `{}` expects {expected_hex_len} hex characters, got {}",
                    algorithm,
                    checksum.len()
                )));
            }

            match parsed.get(&algorithm) {
                Some(existing) if existing != &checksum => {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} provides conflicting values for `{algorithm}`"
                    )));
                }
                Some(_) => {}
                None => {
                    parsed.insert(algorithm, checksum);
                }
            }
        }
        Ok(parsed)
    }

    fn validate_patch_apply_expected_checksums(
        source: &Path,
        expected: &BTreeMap<String, String>,
        checksum_hints: &BTreeMap<String, String>,
        scope: &str,
        context: &OperationContext,
    ) -> Result<String> {
        if expected.is_empty() {
            return Ok(String::new());
        }

        let algorithms = expected
            .keys()
            .filter(|algorithm| !checksum_hints.contains_key(*algorithm))
            .map(String::as_str)
            .collect::<Vec<&str>>();
        let actual = if algorithms.is_empty() {
            BTreeMap::new()
        } else {
            checksum_file_values(source, &algorithms, context)?
        };
        for (algorithm, expected_value) in expected {
            let Some(actual_value) = checksum_hints.get(algorithm).or_else(|| actual.get(algorithm))
            else {
                return Err(RomWeaverError::Validation(format!(
                    "checksum engine did not return `{algorithm}` while validating {scope} checksums"
                )));
            };
            if actual_value != expected_value {
                return Err(RomWeaverError::Validation(format!(
                    "{scope} checksum mismatch for {algorithm}; expected {expected_value}, actual {actual_value}"
                )));
            }
        }

        let rendered = expected
            .iter()
            .map(|(algorithm, value)| format!("{algorithm}={value}"))
            .collect::<Vec<_>>()
            .join(", ");
        Ok(format!("{scope} checksum(s) verified ({rendered})"))
    }

    fn validate_patch_input_size(
        source: &Path,
        expected_size: Option<u64>,
        minimum_size: Option<u64>,
    ) -> Result<String> {
        let actual_size = fs::metadata(source)?.len();
        if let Some(expected) = expected_size
            && actual_size != expected
        {
            return Err(RomWeaverError::Validation(format!(
                "input size mismatch; expected {expected} byte(s), actual {actual_size}"
            )));
        }
        if let Some(minimum) = minimum_size
            && actual_size < minimum
        {
            return Err(RomWeaverError::Validation(format!(
                "input size is below required minimum; expected at least {minimum} byte(s), actual {actual_size}"
            )));
        }

        let mut labels = Vec::new();
        if let Some(expected) = expected_size {
            labels.push(format!("size={expected}"));
        }
        if let Some(minimum) = minimum_size {
            labels.push(format!("min_size={minimum}"));
        }
        if labels.is_empty() {
            Ok(format!("input size verified ({actual_size} byte(s))"))
        } else {
            Ok(format!("input size verified ({})", labels.join(", ")))
        }
    }

    fn checksum_hex_len(algorithm: &str) -> Option<usize> {
        match algorithm {
            "crc16" => Some(4),
            "crc32" | "crc32c" | "adler32" => Some(8),
            "md5" => Some(32),
            "sha1" => Some(40),
            "sha256" | "blake3" => Some(64),
            _ => None,
        }
    }
}

#[derive(Debug, Default)]
struct PatchApplyProgressTracker {
    saw_meaningful_running_progress: std::sync::atomic::AtomicBool,
}

impl PatchApplyProgressTracker {
    fn mark_meaningful_running_progress(&self) {
        self.saw_meaningful_running_progress
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    fn saw_meaningful_running_progress(&self) -> bool {
        self.saw_meaningful_running_progress
            .load(std::sync::atomic::Ordering::Relaxed)
    }
}

struct PatchApplyProgressSink {
    inner: Arc<dyn ProgressSink>,
    output_command: &'static str,
    output_stage: &'static str,
    segment_start_percent: f32,
    segment_end_percent: f32,
    tracker: Arc<PatchApplyProgressTracker>,
}

impl PatchApplyProgressSink {
    fn new(
        inner: Arc<dyn ProgressSink>,
        patch_index: usize,
        patch_count: usize,
        tracker: Arc<PatchApplyProgressTracker>,
    ) -> Self {
        Self::new_for_command(inner, patch_index, patch_count, tracker, "patch-apply", "apply")
    }

    fn new_for_command(
        inner: Arc<dyn ProgressSink>,
        patch_index: usize,
        patch_count: usize,
        tracker: Arc<PatchApplyProgressTracker>,
        output_command: &'static str,
        output_stage: &'static str,
    ) -> Self {
        Self {
            inner,
            output_command,
            output_stage,
            segment_start_percent: patch_progress_segment_start(patch_index, patch_count),
            segment_end_percent: patch_progress_segment_end(patch_index, patch_count),
            tracker,
        }
    }
}

impl ProgressSink for PatchApplyProgressSink {
    fn emit(&self, mut event: ProgressEvent) {
        if event.command == "patch-apply" && event.status == OperationStatus::Running && event.stage == "apply" {
            event.command = self.output_command.to_string();
            event.stage = self.output_stage.to_string();
            if let Some(percent) = event.percent
                && percent.is_finite()
            {
                let clamped = percent.clamp(0.0, 100.0);
                let scaled = if self.segment_end_percent > self.segment_start_percent {
                    self.segment_start_percent
                        + (clamped / 100.0) * (self.segment_end_percent - self.segment_start_percent)
                } else {
                    self.segment_end_percent
                };
                if scaled > self.segment_start_percent {
                    self.tracker.mark_meaningful_running_progress();
                }
                event.percent = Some(scaled);
            } else {
                self.tracker.mark_meaningful_running_progress();
            }
        }
        self.inner.emit(event);
    }
}

fn patch_progress_segment_start(index: usize, patch_count: usize) -> f32 {
    if patch_count <= 1 {
        0.0
    } else {
        ((index as f32) * 100.0) / (patch_count as f32)
    }
}

fn patch_progress_segment_end(index: usize, patch_count: usize) -> f32 {
    if patch_count <= 1 {
        100.0
    } else {
        (((index + 1) as f32) * 100.0) / (patch_count as f32)
    }
}

/* jscpd:ignore-end */
