use super::*;

pub(super) const CREATE_PATCH_IPS_SIZE_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
pub(super) const CREATE_PATCH_ARCHIVE_DEFAULT_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
pub(super) const CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES: u64 = 128 * 1024 * 1024;
pub(super) const CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES: u64 = 256 * 1024 * 1024;
pub(super) const CREATE_PATCH_DEFAULT_FORMAT: &str = "bps";
pub(super) const CREATE_PATCH_LARGE_DEFAULT_FORMAT: &str = "xdelta";

pub(super) const SMALL_CREATE_PATCH_FORMATS: &[&str] = &[
    "bps", "xdelta", "aps", "bdf", "ebp", "ips", "pmsr", "ppf", "rup", "ups",
];
pub(super) const MEDIUM_CREATE_PATCH_FORMATS: &[&str] =
    &["bps", "xdelta", "aps", "bdf", "pmsr", "ppf", "rup", "ups"];
pub(super) const MID_LARGE_CREATE_PATCH_FORMATS: &[&str] =
    &["xdelta", "bps", "aps", "bdf", "pmsr", "ppf", "rup", "ups"];
pub(super) const LARGE_CREATE_PATCH_FORMATS: &[&str] = &["xdelta", "ppf"];
pub(super) const CREATE_PATCH_ARCHIVE_DEFAULT_EXTENSIONS: &[&str] = &[
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
pub(super) const CREATE_PATCH_SPECIAL_COMPRESSION_EXTENSIONS: &[&str] = &[
    ".chd", ".rvz", ".gcz", ".wia", ".z3ds", ".z3dsx", ".zcci", ".zcia", ".zcxi",
];
pub(super) const LIBRETRO_PATCH_ORDER_EXTENSIONS: &[&str] = &[
    ".ips", ".ups", ".bps", ".aps", ".rup", ".ppf", ".ebp", ".bdf", ".bsp", ".bspatch", ".mod",
    ".xdelta", ".delta", ".dat", ".vcdiff",
];
pub(super) const CREATE_PATCH_FORMAT_ALIASES: &[(&str, &str)] = &[
    ("vcdiff", "xdelta"),
    ("xdelta3", "xdelta"),
    ("mod", "pmsr"),
    ("bdf/bsdiff40", "bdf"),
    ("bsdiff", "bdf"),
    ("bsdiff40", "bdf"),
];

pub struct PatchCreateFormatPolicyMetadata {
    pub archive_default_size_limit_bytes: u64,
    pub bps_default_size_limit_bytes: u64,
    pub default_format: &'static str,
    pub ips_size_limit_bytes: u64,
    pub large_default_format: &'static str,
    pub legacy_size_limit_bytes: u64,
    pub aliases: &'static [(&'static str, &'static str)],
    pub small_formats: &'static [&'static str],
    pub medium_formats: &'static [&'static str],
    pub mid_large_formats: &'static [&'static str],
    pub large_formats: &'static [&'static str],
}

pub fn patch_create_format_policy_metadata() -> PatchCreateFormatPolicyMetadata {
    PatchCreateFormatPolicyMetadata {
        archive_default_size_limit_bytes: CREATE_PATCH_ARCHIVE_DEFAULT_LIMIT_BYTES,
        bps_default_size_limit_bytes: CREATE_PATCH_BPS_DEFAULT_LIMIT_BYTES,
        default_format: CREATE_PATCH_DEFAULT_FORMAT,
        ips_size_limit_bytes: CREATE_PATCH_IPS_SIZE_LIMIT_BYTES,
        large_default_format: CREATE_PATCH_LARGE_DEFAULT_FORMAT,
        legacy_size_limit_bytes: CREATE_PATCH_LEGACY_SIZE_LIMIT_BYTES,
        aliases: CREATE_PATCH_FORMAT_ALIASES,
        small_formats: SMALL_CREATE_PATCH_FORMATS,
        medium_formats: MEDIUM_CREATE_PATCH_FORMATS,
        mid_large_formats: MID_LARGE_CREATE_PATCH_FORMATS,
        large_formats: LARGE_CREATE_PATCH_FORMATS,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct PatchCreateInputSizes {
    pub(super) original: u64,
    pub(super) modified: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PatchCreateSourceInfo {
    pub(super) archive: bool,
    pub(super) size: u64,
    pub(super) special_compression: bool,
}

#[derive(Debug, Default)]
pub(super) struct DiscoveredPatchApplySidecars {
    pub(super) patches: Vec<PathBuf>,
    pub(super) cleanup_paths: Vec<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ResolvedSidecarPatchEntry {
    entry: ContainerListEntry,
    order: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PatchCreateInputInfo {
    pub(super) original: PatchCreateSourceInfo,
    pub(super) modified: PatchCreateSourceInfo,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct PatchCreateFormatCandidates {
    pub(super) formats: &'static [&'static str],
    pub(super) default_format: &'static str,
}

impl CliApp {
    pub(super) fn archive_entry_directory(entry_name: &str) -> &str {
        entry_name
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or("")
    }

    pub(super) fn archive_entry_file_name(entry_name: &str) -> &str {
        entry_name.rsplit('/').next().unwrap_or(entry_name)
    }

    pub(super) fn archive_entry_stem(entry_name: &str) -> &str {
        let file_name = Self::archive_entry_file_name(entry_name);
        file_name
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .unwrap_or(file_name)
    }

    pub(super) fn strip_bracket_label_suffix(value: &str) -> &str {
        let Some(end) = value.strip_suffix(']') else {
            return value.trim();
        };
        let Some((base, _label)) = end.rsplit_once('[') else {
            return value.trim();
        };
        base.trim_end()
    }

    pub(super) fn parse_libretro_patch_file_name(file_name: &str) -> Option<(&str, u32)> {
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
        Some((
            Self::strip_bracket_label_suffix(&file_name[..extension_start]),
            order,
        ))
    }

    pub(super) fn entry_matches_libretro_sidecar(
        rom_entry: &str,
        patch_entry: &str,
    ) -> Option<u32> {
        if Self::archive_entry_directory(rom_entry) != Self::archive_entry_directory(patch_entry) {
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

    pub(super) fn run_match_sidecars(&self, args: MatchSidecarsCommand) -> AppRunOutcome {
        let MatchSidecarsCommand {
            rom_name,
            patch_names,
        } = args;
        trace!(
            rom = %rom_name,
            patch_count = patch_names.len(),
            "starting match-sidecars command"
        );
        // Index ties keep input order stable; mirror the host's order → name → index sort so native and
        // browser agree on the apply sequence for numbered soft-patches.
        let mut matches: Vec<(String, u32, usize)> = patch_names
            .iter()
            .enumerate()
            .filter_map(|(index, patch)| {
                Self::entry_matches_libretro_sidecar(&rom_name, patch)
                    .map(|order| (patch.clone(), order, index))
            })
            .collect();
        matches.sort_by(|left, right| {
            left.1
                .cmp(&right.1)
                .then_with(|| left.0.cmp(&right.0))
                .then_with(|| left.2.cmp(&right.2))
        });
        let sidecar_matches = matches
            .iter()
            .map(|(name, order, _)| serde_json::json!({ "name": name, "order": order }))
            .collect::<Vec<_>>();
        let context = self.context(ThreadBudget::Fixed(1));
        let mut report = OperationReport::succeeded(
            OperationFamily::Command,
            Some("match-sidecars".to_string()),
            "match-sidecars",
            format!(
                "matched {} sidecar patch file(s) for `{}`",
                matches.len(),
                rom_name
            ),
            Some(100.0),
            context.single_thread_execution(),
        );
        report.details = Some(serde_json::json!({ "sidecar_matches": sidecar_matches }));
        self.finish("match-sidecars", report)
    }

    pub(super) fn selected_libretro_rom_entry(
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

    pub(super) fn discover_patch_apply_sidecars(
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
            split_bin: false,
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
            containing_archive: None,
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

    pub(super) fn patch_apply_raw_output_path(
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

    pub(super) fn stage_patch_apply_archive_input(
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

    pub(super) fn patch_apply_archive_entry_file_name(
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

    pub(super) fn strip_archive_extension(file_name: &str) -> String {
        let lower = file_name.to_ascii_lowercase();
        for extension in [".zipx", ".zip", ".7z"] {
            if lower.ends_with(extension) {
                let stripped_len = file_name.len().saturating_sub(extension.len());
                return file_name[..stripped_len].to_string();
            }
        }
        file_name.to_string()
    }

    /// Merge input requirements parsed from a patch file name (`<algo>:<hex>`
    /// checksum tokens, bracket-enclosed bare checksums, and `bytes:`/`size:`
    /// size tokens) into the caller's expected requirements. Returns a failure
    /// report when a parsed value conflicts with one the caller already
    /// requested explicitly.
    pub(super) fn merge_filename_requirements(
        &self,
        command: &'static str,
        patch_path: &Path,
        patch_name: &str,
        expected_input_checksums: &mut BTreeMap<String, String>,
        expected_input_size: &mut Option<u64>,
        probe_threads: Option<ThreadExecution>,
    ) -> Option<OperationReport> {
        let requirements = parse_filename_requirements(patch_name);
        for (algorithm, hex) in requirements.checksums {
            match expected_input_checksums.get(&algorithm) {
                Some(existing) if existing != &hex => {
                    return Some(OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        format!(
                            "patch file name requires input {algorithm} {hex} but --validate-with-checksum expects {existing}"
                        ),
                        probe_threads,
                    ));
                }
                Some(_) => {}
                None => {
                    trace!(
                        command,
                        patch = %patch_path.display(),
                        algorithm = %algorithm,
                        checksum = %hex,
                        "parsed input checksum requirement from patch file name"
                    );
                    expected_input_checksums.insert(algorithm, hex);
                }
            }
        }
        if let Some(size) = requirements.size {
            match expected_input_size {
                Some(existing) if *existing != size => {
                    return Some(OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        format!(
                            "patch file name requires input size {size} byte(s) but {existing} byte(s) was already requested"
                        ),
                        probe_threads,
                    ));
                }
                Some(_) => {}
                None => {
                    trace!(
                        command,
                        patch = %patch_path.display(),
                        size,
                        "parsed input size requirement from patch file name"
                    );
                    *expected_input_size = Some(size);
                }
            }
        }
        None
    }

    pub(super) fn parse_patch_apply_checksum_values(
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

    pub(super) fn validate_patch_apply_expected_checksums(
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
            let Some(actual_value) = checksum_hints
                .get(algorithm)
                .or_else(|| actual.get(algorithm))
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

    pub(super) fn validate_patch_input_size(
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

    pub(super) fn checksum_hex_len(algorithm: &str) -> Option<usize> {
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
pub(super) struct PatchApplyProgressTracker {
    saw_meaningful_running_progress: std::sync::atomic::AtomicBool,
}

impl PatchApplyProgressTracker {
    pub(super) fn mark_meaningful_running_progress(&self) {
        self.saw_meaningful_running_progress
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    pub(super) fn saw_meaningful_running_progress(&self) -> bool {
        self.saw_meaningful_running_progress
            .load(std::sync::atomic::Ordering::Relaxed)
    }
}

pub(super) struct PatchApplyProgressSink {
    inner: Arc<dyn ProgressSink>,
    output_command: &'static str,
    output_stage: &'static str,
    segment_start_percent: f32,
    segment_end_percent: f32,
    tracker: Arc<PatchApplyProgressTracker>,
}

impl PatchApplyProgressSink {
    pub(super) fn new(
        inner: Arc<dyn ProgressSink>,
        patch_index: usize,
        patch_count: usize,
        tracker: Arc<PatchApplyProgressTracker>,
    ) -> Self {
        Self::new_for_command(
            inner,
            patch_index,
            patch_count,
            tracker,
            "patch-apply",
            "apply",
        )
    }

    pub(super) fn new_for_command(
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
        if event.command == "patch-apply"
            && event.status == OperationStatus::Running
            && event.stage == "apply"
        {
            event.command = self.output_command.to_string();
            event.stage = self.output_stage.to_string();
            if let Some(percent) = event.percent
                && percent.is_finite()
            {
                let clamped = percent.clamp(0.0, 100.0);
                let scaled = if self.segment_end_percent > self.segment_start_percent {
                    self.segment_start_percent
                        + (clamped / 100.0)
                            * (self.segment_end_percent - self.segment_start_percent)
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

pub(super) fn patch_progress_segment_start(index: usize, patch_count: usize) -> f32 {
    if patch_count <= 1 {
        0.0
    } else {
        ((index as f32) * 100.0) / (patch_count as f32)
    }
}

pub(super) fn patch_progress_segment_end(index: usize, patch_count: usize) -> f32 {
    if patch_count <= 1 {
        100.0
    } else {
        (((index + 1) as f32) * 100.0) / (patch_count as f32)
    }
}
