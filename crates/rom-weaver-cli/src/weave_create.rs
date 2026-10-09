//! `weave create`: build, validate, and emit a rom-weaver-weave.json weave from
//! local sources (native + wasm; the webapp export drives this command).

use flate2::{Compression as GzCompression, write::GzEncoder};

use super::weave_parse::{is_weave_json_candidate, parse_weave_bytes, weave_file_name_codec};
#[cfg(not(target_arch = "wasm32"))]
use super::weave_schema::WEAVE_JSON_SCHEMA_V1_URL;
use super::*;

const WEAVE_CREATE_DEFAULT_ALGORITHMS: [&str; 3] = ["crc32", "md5", "sha1"];

const WEAVE_CREATE_OP: OperationLabel<'static> = OperationLabel {
    command: "weave-create",
    family: OperationFamily::Command,
    format: None,
};

/// Emit a hash-progress event at most once per this many processed bytes.
const WEAVE_CREATE_PROGRESS_INTERVAL: u64 = 8 * 1024 * 1024;

/// The result of one `weave create`, returned under
/// `details.weave_create`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct WeaveCreateResult {
    pub weave_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub archive_path: Option<String>,
    /// The canonical weave as written (checksums computed and normalized).
    pub weave: RomWeaverWeave,
    pub warnings: Vec<String>,
}

/// The `; N cheat entr(y|ies)` clause of the create label; empty when the
/// weave records none.
fn cheat_entry_summary(count: usize) -> String {
    match count {
        0 => String::new(),
        1 => "; 1 cheat entry".to_string(),
        many => format!("; {many} cheat entries"),
    }
}

impl CliApp {
    pub(super) fn run_weave_create(&self, mut args: WeaveCreateCommand) -> AppRunOutcome {
        let context = self.context(args.threads);
        let thread_execution = context.single_thread_execution();
        // --from hydrates the command from a hand-authored spec before anything
        // else, so explicit flags still override and the rest of create is
        // unchanged.
        if let Err(error) = self.apply_weave_create_spec(&mut args) {
            return self.finish(
                "weave-create",
                OperationReport::failed_with_error(
                    OperationFamily::Command,
                    Some("weave-create".to_string()),
                    "weave-create",
                    error,
                    thread_execution,
                ),
            );
        }
        trace!(
            from = ?args.from,
            rom = ?args.rom,
            rom_url = ?args.rom_url,
            patches = args.patch.len(),
            patch_specs = args.patch_specs.len(),
            output = %args.output.display(),
            weave = ?args.weave,
            checksum_algorithms = args.checksum.len(),
            threads = %args.threads,
            "starting weave create command"
        );
        let report = match self.weave_create_inner(&args, &context) {
            Ok(result) => {
                let label = format!(
                    "wrote weave `{}` ({} patch entr{}{}{})",
                    result.weave_path,
                    result.weave.patches.len(),
                    if result.weave.patches.len() == 1 {
                        "y"
                    } else {
                        "ies"
                    },
                    cheat_entry_summary(result.weave.cheats.len()),
                    result
                        .archive_path
                        .as_deref()
                        .map(|weave| format!("; bundled into `{weave}`"))
                        .unwrap_or_default(),
                );
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("weave-create".to_string()),
                    "weave-create",
                    label,
                    Some(100.0),
                    thread_execution.clone(),
                );
                match serde_json::to_value(&result) {
                    Ok(value) => {
                        report.details = Some(json!({ "weave_create": value }));
                        Self::append_report_warnings(&mut report, result.warnings);
                        let mut paths = vec![PathBuf::from(result.weave_path)];
                        paths.extend(result.archive_path.map(PathBuf::from));
                        Self::attach_emitted_files_details(report, paths, None)
                    }
                    Err(error) => OperationReport::failed(
                        OperationFamily::Command,
                        Some("weave-create".to_string()),
                        "weave-create",
                        format!("failed to serialize weave create result: {error}"),
                        thread_execution,
                    ),
                }
            }
            Err(error) => OperationReport::failed_with_error(
                OperationFamily::Command,
                Some("weave-create".to_string()),
                "weave-create",
                error,
                thread_execution,
            ),
        };
        self.finish("weave-create", report)
    }

    /// Hydrate a `weave create` command from a `--from` spec: read the file
    /// (or stdin for `-`), parse it as a `RomWeaverWeave`, and fill any field
    /// the CLI did not set. Local `path` entries resolve relative to the spec
    /// file; create then hashes the ROM and normalizes as usual. Explicit flags
    /// win over the spec. Native-only (reads a local file / stdin); on wasm the
    /// webapp builds the command directly, so this is a no-op.
    #[cfg(not(target_arch = "wasm32"))]
    fn apply_weave_create_spec(&self, args: &mut WeaveCreateCommand) -> Result<()> {
        let Some(from) = args.from.clone() else {
            return Ok(());
        };
        let is_stdin = from.as_os_str() == "-";
        let bytes = if is_stdin {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut std::io::stdin().lock(), &mut buf).map_err(
                |error| {
                    RomWeaverError::Validation(format!(
                        "failed to read weave spec from stdin: {error}"
                    ))
                },
            )?;
            buf
        } else {
            fs::read(&from).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read weave spec `{}`: {error}",
                    from.display()
                ))
            })?
        };
        let spec = parse_weave_bytes(&bytes)?;
        let base_dir = if is_stdin {
            PathBuf::new()
        } else {
            from.parent().map(Path::to_path_buf).unwrap_or_default()
        };
        let resolve = |relative: &str| -> PathBuf {
            let path = Path::new(relative);
            if path.is_absolute() || base_dir.as_os_str().is_empty() {
                path.to_path_buf()
            } else {
                base_dir.join(path)
            }
        };

        // Preserve the authored $schema unless --schema-ref overrides it.
        if args.schema_ref.is_none() {
            args.schema_ref = upgraded_schema_ref(spec.version, spec.schema.as_deref());
        }
        if args.default_patch_basis.is_none() {
            args.default_patch_basis = Some(spec.patch_basis.unwrap_or(PatchBasisMode::Auto));
        }

        if let Some(rom) = &spec.rom {
            match (rom.path.as_deref(), rom.url.as_deref()) {
                (Some(path), _) => {
                    if args.rom.is_none() {
                        args.rom = Some(resolve(path));
                    }
                }
                (None, Some(url)) => {
                    if args.rom_url.is_none() {
                        args.rom_url = Some(url.to_owned());
                    }
                }
                (None, None) => {
                    return Err(RomWeaverError::Validation(
                        "--from: a checks-only rom (no `path`/`url`) can't be baked from a spec; give rom.path or drop the rom entry".to_string(),
                    ));
                }
            }
            if args.rom_name.is_none() {
                args.rom_name = rom.name.clone();
            }
            if args.rom_member.is_none() {
                args.rom_member = rom.member.clone();
            }
            if args.assume_in.is_empty()
                && let Some(checks) =
                    resolve_spec_checks(&spec, rom.checks.as_ref(), rom.checks_ref.as_deref())?
            {
                args.assume_in = checks_tokens(&checks);
            }
        }

        if let Some(output) = &spec.output {
            if args.output_name.is_none() {
                args.output_name = output.name.clone();
            }
            if args.output_header.is_none() {
                args.output_header = output.header;
            }
            if args.output_check.is_empty()
                && let Some(checks) = resolve_spec_checks(
                    &spec,
                    output.checks.as_ref(),
                    output.checks_ref.as_deref(),
                )?
            {
                args.output_check = checks_tokens(&checks);
            }
        }

        // An explicit --cheat selection replaces the spec's cheats wholesale,
        // the way explicit --patch flags replace its patch chain; otherwise the
        // spec's own entries carry through.
        if args.cheats.is_empty() && args.cheat_selection.cheats.is_empty() {
            args.cheats = spec.cheats.clone();
        }

        // Explicit --patch flags win wholesale over the spec's patch chain.
        if args.patch_specs.is_empty() && args.patch.is_empty() {
            let mut specs = Vec::with_capacity(spec.patches.len());
            for (index, entry) in spec.patches.iter().enumerate() {
                let (path, source_url) = match (entry.path.as_deref(), entry.url.as_deref()) {
                    (Some(path), _) => (resolve(path), None),
                    (None, Some(url)) => {
                        return Err(RomWeaverError::Validation(format!(
                            "--from: patches[{index}] is a url-only entry (`{url}`); weave create bakes local files, so give it a local `path`"
                        )));
                    }
                    (None, None) => {
                        return Err(RomWeaverError::Validation(format!(
                            "--from: patches[{index}] has neither `path` nor `url`"
                        )));
                    }
                };
                specs.push(WeaveCreatePatchSpec {
                    path,
                    id: entry.id.clone(),
                    version: entry.version.clone(),
                    author: entry.author.clone(),
                    name: entry.name.clone(),
                    description: entry.description.clone(),
                    label: entry.label.clone(),
                    optional: entry.optional.then_some(true),
                    source_url,
                    header: entry.header,
                    basis: entry.basis,
                    input: entry.input.clone(),
                    target: entry.target.clone(),
                    input_checks: resolve_spec_checks(
                        &spec,
                        entry.input_checks.as_ref(),
                        entry.input_checks_ref.as_deref(),
                    )?
                    .as_ref()
                    .map(checks_tokens)
                    .unwrap_or_default(),
                    input_checks_ref: entry.input_checks_ref.clone(),
                    output_checks: resolve_spec_checks(
                        &spec,
                        entry.output_checks.as_ref(),
                        entry.output_checks_ref.as_deref(),
                    )?
                    .as_ref()
                    .map(checks_tokens)
                    .unwrap_or_default(),
                    output_checks_ref: entry.output_checks_ref.clone(),
                });
            }
            args.patch_specs = specs;
        }
        Ok(())
    }

    #[cfg(target_arch = "wasm32")]
    fn apply_weave_create_spec(&self, _args: &mut WeaveCreateCommand) -> Result<()> {
        Ok(())
    }

    /// The weave's cheat entries: whatever the caller supplied, plus the
    /// `--cheat` selection resolved against the ROM. Native-only
    /// (reads the local cheat database); on wasm the webapp supplies entries
    /// directly.
    #[cfg(not(target_arch = "wasm32"))]
    fn weave_create_cheat_entries(
        &self,
        args: &WeaveCreateCommand,
        context: &OperationContext,
    ) -> Result<Vec<WeaveCheatEntry>> {
        let mut cheats = args.cheats.clone();
        let selection = &args.cheat_selection;
        if selection.cheats.is_empty() {
            return Ok(cheats);
        }
        let Some(rom) = args.rom.as_deref() else {
            return Err(RomWeaverError::Validation(
                "--cheat needs --input so the selection can be classified against the ROM"
                    .to_string(),
            ));
        };
        let resolved = self.resolve_cheat_selection(rom, selection, context)?;
        if let Some(entry) = resolved.selected_unusable().first() {
            return Err(RomWeaverError::Validation(format!(
                "cheat `{}` cannot be recorded: it cannot be baked into the ROM",
                entry.record.description
            )));
        }
        cheats.extend(resolved.weave_cheat_entries(&selection.cheats));
        trace!(
            cheats = cheats.len(),
            "recorded cheat selections in a weave"
        );
        Ok(cheats)
    }

    #[cfg(target_arch = "wasm32")]
    fn weave_create_cheat_entries(
        &self,
        args: &WeaveCreateCommand,
        _context: &OperationContext,
    ) -> Result<Vec<WeaveCheatEntry>> {
        Ok(args.cheats.clone())
    }

    pub(super) fn weave_create_inner(
        &self,
        args: &WeaveCreateCommand,
        context: &OperationContext,
    ) -> Result<WeaveCreateResult> {
        let specs = weave_create_patch_specs(args)?;
        self.preflight_weave_create_outputs(args)?;
        let patch_basis = args.default_patch_basis.unwrap_or(PatchBasisMode::Auto);
        let cheats = self.weave_create_cheat_entries(args, context)?;
        if specs.is_empty() && cheats.is_empty() {
            return Err(RomWeaverError::Validation(
                "weave create requires at least one --patch or --cheat".to_string(),
            ));
        }
        let algorithms = weave_create_algorithms(args)?;
        let mut warnings = Vec::new();
        let mut rom = self.weave_create_rom_entry(args, &algorithms, context, &mut warnings)?;

        let output_checks = weave_entry_checks(&args.output_check, "--expect-out")?;

        let mut patches = weave_create_patch_entries(&specs, patch_basis)?;

        let packaged_rom_source = args
            .weave_rom
            .as_deref()
            .or(args.rom.as_deref())
            .filter(|_| args.rom_url.is_none() && !args.no_weave_rom);
        if args.weave.is_some() {
            assign_weave_member_paths(&mut rom, packaged_rom_source, &mut patches, &specs)?;
        } else {
            require_unique_weave_source_names(rom.as_ref(), &patches)?;
        }

        let mut output =
            (args.output_name.is_some() || args.output_header.is_some() || output_checks.is_some())
                .then(|| WeaveOutput {
                    name: args.output_name.clone(),
                    header: args.output_header,
                    checks: output_checks,
                    checks_ref: None,
                });

        let check_states = canonicalize_weave_check_states(
            &mut rom,
            &mut patches,
            &mut output,
            patch_basis.declared(),
        );

        let weave = RomWeaverWeave {
            // Only stamped when explicitly requested (--schema-ref) or carried
            // over from a --from spec; never auto-injected, so plain create
            // stays byte-identical.
            schema: args.schema_ref.clone(),
            version: WEAVE_VERSION,
            patch_basis: Some(patch_basis),
            check_states,
            rom,
            patches,
            cheats,
            output,
        };
        let bytes = write_weave_create_output(args, &weave, &mut warnings)?;

        let weave_path = match &args.weave {
            Some(weave_archive) => Some(self.create_weave_weave(
                weave_archive,
                &bytes,
                packaged_rom_source,
                &specs,
                &weave,
                context,
            )?),
            None => None,
        };

        Ok(WeaveCreateResult {
            weave_path: Self::normalize_emitted_path_string(&args.output.to_string_lossy()),
            archive_path: weave_path
                .map(|path| Self::normalize_emitted_path_string(&path.to_string_lossy())),
            weave,
            warnings,
        })
    }

    /// Builds the weave's `rom` entry from `--input`, `--rom-url`, and the ROM flags.
    fn weave_create_rom_entry(
        &self,
        args: &WeaveCreateCommand,
        algorithms: &[String],
        context: &OperationContext,
        warnings: &mut Vec<String>,
    ) -> Result<Option<WeaveRom>> {
        if args.weave_rom.is_some() && args.rom.is_none() {
            return Err(RomWeaverError::Validation(
                "--weave-rom requires --input so the recorded checksums describe the real ROM"
                    .to_string(),
            ));
        }

        if args.no_weave_rom && args.rom.is_none() {
            warnings.push("--no-weave-rom ignored: no local ROM given with --input".to_string());
        }
        // Trusted rom checksums/size from a prior staging pass, so export skips
        // re-hashing the prepared leaf. `algo=hex` tokens seed the rom checks; a
        // `size=N` token seeds the prepared size.
        let rom_assume = parse_expect_tokens(&args.assume_in, "--assume-in", true)?;
        // Presence matters: an explicit empty --rom-name suppresses the
        // sourceless-ROM default, which lets the web authoring field be cleared.
        let rom_name = args.rom_name.as_deref().and_then(|name| {
            let name = name.trim();
            (!name.is_empty()).then(|| name.to_owned())
        });

        match (&args.rom, &args.rom_url) {
            (None, None) => {
                if rom_name.is_some() {
                    warnings.push(
                        "--rom-name ignored: no ROM given with --input or --rom-url".to_string(),
                    );
                }
                Ok(None)
            }
            (Some(path), _) => self
                .weave_create_local_rom(args, path, rom_name, &rom_assume, algorithms, context)
                .map(Some),
            (None, Some(url)) => Ok(Some(WeaveRom {
                name: rom_name,
                url: Some(url.clone()),
                path: None,
                member: args.rom_member.clone(),
                checks: None,
                checks_ref: None,
            })),
        }
    }

    /// Hashes a local `--input` ROM (or its `--rom-member`) and builds its weave entry.
    fn weave_create_local_rom(
        &self,
        args: &WeaveCreateCommand,
        path: &Path,
        rom_name: Option<String>,
        rom_assume: &ExpectSpec,
        algorithms: &[String],
        context: &OperationContext,
    ) -> Result<WeaveRom> {
        let url_override = &args.rom_url;
        let cached_rom_checks = (!rom_assume.checksums.is_empty() || rom_assume.size.is_some())
            .then(|| WeaveChecks {
                checksums: rom_assume.checksums.clone(),
                size: rom_assume.size,
            });
        if !path.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "rom path does not exist: `{}`",
                path.display()
            )));
        }
        let resolved_member = if let Some(member) = args.rom_member.as_ref()
            && args.weave_rom.is_none()
            && (cached_rom_checks.is_none() || rom_assume.size.is_none())
        {
            Some(self.resolve_weave_create_rom_member(path, member, context)?)
        } else {
            None
        };
        let logical_path = resolved_member
            .as_ref()
            .map_or(path, |resolved| resolved.source.as_path());
        let checks_result = (|| -> Result<WeaveChecks> {
            let logical_size = fs::metadata(logical_path)?.len();
            let mut hashed_bytes = 0;
            let checksums = if let Some(cached) = cached_rom_checks.as_ref() {
                cached.checksums.clone()
            } else {
                self.weave_checksum_with_progress(
                    logical_path,
                    algorithms,
                    context,
                    &mut hashed_bytes,
                    logical_size,
                )?
            };
            Ok(WeaveChecks {
                checksums,
                size: Some(rom_assume.size.unwrap_or(logical_size)),
            })
        })();
        if let Some(resolved) = resolved_member {
            Self::cleanup_temp_paths(&resolved.cleanup_paths);
        }
        let checks = checks_result?;
        let weave_source = args.weave_rom.as_deref().unwrap_or(path);
        if !weave_source.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "weave rom path does not exist: `{}`",
                weave_source.display()
            )));
        }
        let base_name = required_base_name(weave_source, "rom")?;
        // A no-weave-rom entry keeps its checks but carries no
        // source: the applying user supplies the ROM themselves. A
        // sourceless entry always gets a name (the local file's base
        // name) so consumers can tell the user WHICH ROM to supply.
        let distribute_path = url_override.is_none() && !args.no_weave_rom;
        let sourceless_name = (url_override.is_none() && !distribute_path)
            .then(|| required_base_name(path, "rom"))
            .transpose()?;
        Ok(WeaveRom {
            name: if args.rom_name.is_some() {
                rom_name
            } else {
                sourceless_name
            },
            url: url_override.clone(),
            path: distribute_path.then_some(base_name),
            member: args.rom_member.clone(),
            checks: Some(checks),
            checks_ref: None,
        })
    }

    fn resolve_weave_create_rom_member(
        &self,
        path: &Path,
        member: &str,
        context: &OperationContext,
    ) -> Result<ResolvedChecksumSource> {
        if let Some(disc) = self.build_disc_context(path, Some(member), None, context)? {
            return Ok(ResolvedChecksumSource {
                source: self.disc_member_path(&disc, member)?,
                extracted_archives: 0,
                cleanup_paths: Vec::new(),
            });
        }
        self.resolve_exact_member_source(
            path,
            member,
            context,
            AutoExtractResolutionLabels {
                command: "weave-create",
                family: OperationFamily::Command,
                format: None,
                source_label: "weave ROM member",
                temp_prefix: "weave-create-rom-member",
            },
            AutoExtractResolutionFlags {
                no_extract: false,
                no_ignore: true,
                kind_filter: Self::archive_entry_kind_filter(true, false),
                stop_on_single_payload_codec: false,
            },
        )
    }

    /// The definition and archive MUST name different files. Both destinations
    /// need validation before source hashing or either output is written.
    fn preflight_weave_create_outputs(&self, args: &WeaveCreateCommand) -> Result<()> {
        if let Some(weave) = args.weave.as_deref() {
            if weave_create_outputs_alias(&args.output, weave) {
                return Err(RomWeaverError::Validation(
                    "--output and --weave must name different files".to_string(),
                ));
            }
            ensure_output_available(weave, args.force)?;
            let format = weave
                .extension()
                .and_then(|extension| extension.to_str())
                .ok_or_else(|| {
                    RomWeaverError::Validation(
                        "--weave path needs a creatable archive extension (for example .zip)"
                            .to_string(),
                    )
                })?;
            self.containers.find_creatable_by_name(format)?;
        }
        ensure_output_available(&args.output, args.force)?;
        for output in
            std::iter::once(args.output.as_path()).chain(args.weave.iter().map(PathBuf::as_path))
        {
            if let Some(parent) = output
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                super::path_access::check_writable_dir(parent)?;
            }
        }
        if let Some(weave) = args.weave.as_deref()
            && weave_create_outputs_alias_after_parent_checks(&args.output, weave)
        {
            return Err(RomWeaverError::Validation(
                "--output and --weave must name different files".to_string(),
            ));
        }
        Ok(())
    }

    /// Checksum one create source, emitting overall hash progress across the
    /// whole file set (`hashed_bytes` accumulates; `total_bytes` is the fixed
    /// denominator). Without progress events the plain fast path is used.
    fn weave_checksum_with_progress(
        &self,
        path: &Path,
        algorithms: &[String],
        context: &OperationContext,
        hashed_bytes: &mut u64,
        total_bytes: u64,
    ) -> Result<BTreeMap<String, String>> {
        let size = fs::metadata(path)?.len();
        if !self.emit_progress_events {
            let algorithm_refs: Vec<&str> = algorithms.iter().map(String::as_str).collect();
            let values = checksum_file_values(path, &algorithm_refs, context)?;
            *hashed_bytes = hashed_bytes.saturating_add(size);
            return Ok(values);
        }
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        let label = format!("computing checksums for `{name}`");
        let overall_percent = |done: u64| -> f32 {
            if total_bytes == 0 {
                return 100.0;
            }
            ((done as f64 / total_bytes as f64) * 100.0).min(100.0) as f32
        };
        self.emit_running(
            WEAVE_CREATE_OP,
            "checksum",
            label.clone(),
            Some(overall_percent(*hashed_bytes)),
            None,
        );
        let hashed_before = *hashed_bytes;
        let mut last_emitted = 0u64;
        let mut file = File::open(path)?;
        let mut on_progress = |progress: ChecksumProgress| {
            if progress.processed_bytes < last_emitted + WEAVE_CREATE_PROGRESS_INTERVAL {
                return;
            }
            last_emitted = progress.processed_bytes;
            self.emit_running(
                WEAVE_CREATE_OP,
                "checksum",
                label.clone(),
                Some(overall_percent(
                    hashed_before.saturating_add(progress.processed_bytes),
                )),
                None,
            );
        };
        let computed =
            checksum_reader_values_with_progress(&mut file, algorithms, context, &mut on_progress)?;
        *hashed_bytes = hashed_before.saturating_add(size);
        Ok(computed.values)
    }

    /// Stage `rom-weaver-weave.json` + the local sources flat into a temp dir and pack them
    /// with the requested creatable container format.
    fn create_weave_weave(
        &self,
        weave: &Path,
        weave_bytes: &[u8],
        rom: Option<&Path>,
        specs: &[WeaveCreatePatchSpec],
        definition: &RomWeaverWeave,
        context: &OperationContext,
    ) -> Result<PathBuf> {
        let staging = context.temp_paths().next_path("weave-weave", None);
        fs::create_dir_all(&staging)?;
        let weave_path = staging.join("rom-weaver-weave.json");
        fs::write(&weave_path, weave_bytes)?;
        let mut inputs = vec![weave_path];
        if let (Some(rom), Some(member)) = (
            rom,
            definition.rom.as_ref().and_then(|rom| rom.path.as_deref()),
        ) {
            let target = staging.join(member);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(rom, &target)?;
            inputs.push(target);
        }
        for (spec, entry) in specs.iter().zip(&definition.patches) {
            let Some(member) = entry.path.as_deref() else {
                continue;
            };
            let target = staging.join(member);
            if inputs.iter().any(|input| input == &target) {
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&spec.path, &target)?;
            inputs.push(target);
        }
        let format = weave
            .extension()
            .and_then(|extension| extension.to_str())
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "--weave path needs a creatable archive extension (for example .zip)"
                        .to_string(),
                )
            })?;
        let handler = self.containers.find_creatable_by_name(format)?;
        // Archive creation reports no incremental progress here, so surface
        // the stage as indeterminate rather than sitting on the last percent.
        self.emit_running(
            WEAVE_CREATE_OP,
            "weave",
            format!(
                "bundling {} file(s) into `{}`",
                inputs.len(),
                weave.display()
            ),
            None,
            None,
        );
        trace!(
            weave = %weave.display(),
            format = handler.descriptor().name,
            inputs = inputs.len(),
            "creating weave weave archive"
        );
        let request = ContainerCreateRequest {
            archive_names: None,
            inputs,
            output: weave.to_path_buf(),
            format: handler.descriptor().name.to_string(),
            codec: None,
            level: None,
            parent: None,
        };
        handler.create(&request, context)?;
        Ok(weave.to_path_buf())
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn resolve_spec_checks(
    spec: &RomWeaverWeave,
    inline: Option<&WeaveChecks>,
    reference: Option<&str>,
) -> Result<Option<WeaveChecks>> {
    if let Some(checks) = inline {
        return Ok(Some(checks.clone()));
    }
    let Some(reference) = reference else {
        return Ok(None);
    };
    spec.check_states
        .iter()
        .find(|state| state.id == reference)
        .map(|state| state.checks.clone())
        .map(Some)
        .ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "--from: checks reference `{reference}` does not exist in checkStates"
            ))
        })
}

fn weave_create_algorithms(args: &WeaveCreateCommand) -> Result<Vec<String>> {
    let algorithms: Vec<String> = if args.checksum.is_empty() {
        WEAVE_CREATE_DEFAULT_ALGORITHMS
            .iter()
            .map(|algorithm| (*algorithm).to_string())
            .collect()
    } else {
        args.checksum
            .iter()
            .map(|algorithm| algorithm.to_ascii_lowercase())
            .collect()
    };
    if let Some(invalid) = algorithms.iter().find(|algorithm| {
        !supported_algorithms()
            .iter()
            .any(|supported| supported.eq_ignore_ascii_case(algorithm))
    }) {
        return Err(unsupported_checksum_algorithm(invalid));
    }
    Ok(algorithms)
}

fn weave_create_patch_entries(
    specs: &[WeaveCreatePatchSpec],
    patch_basis: PatchBasisMode,
) -> Result<Vec<WeavePatchEntry>> {
    let mut patches = Vec::with_capacity(specs.len());
    for spec in specs {
        if !spec.path.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "patch path does not exist: `{}`",
                spec.path.display()
            )));
        }
        let base_name = required_base_name(&spec.path, "patch")?;
        // Equal checksums do not prove the same byte state. Keep every
        // authored entry value until scope-aware reference canonicalization
        // proves it is the ROM, a selected producer, or the final output.
        let entry_input_checks = weave_entry_checks(&spec.input_checks, "--patch-expect-in")?;
        let entry_output_checks = weave_entry_checks(&spec.output_checks, "--patch-expect-out")?;
        patches.push(WeavePatchEntry {
            id: spec.id.clone(),
            version: spec.version.clone(),
            author: spec.author.clone(),
            name: spec.name.clone(),
            description: spec.description.clone(),
            optional: spec.optional.unwrap_or(false),
            label: spec.label.clone(),
            url: spec.source_url.clone(),
            path: spec.source_url.is_none().then_some(base_name),
            input: spec.input.clone(),
            target: spec.target.clone(),
            input_checks: entry_input_checks,
            input_checks_ref: spec.input_checks_ref.clone(),
            output_checks: entry_output_checks,
            output_checks_ref: spec.output_checks_ref.clone(),
            header: spec.header,
            basis: spec
                .basis
                .filter(|basis| Some(*basis) != patch_basis.declared()),
        });
    }
    Ok(patches)
}

fn require_unique_weave_source_names(
    rom: Option<&WeaveRom>,
    patches: &[WeavePatchEntry],
) -> Result<()> {
    let mut seen_names = BTreeSet::new();
    for name in rom
        .into_iter()
        .filter_map(|rom| rom.path.as_ref())
        .chain(patches.iter().filter_map(|patch| patch.path.as_ref()))
    {
        if !seen_names.insert(name) {
            return Err(RomWeaverError::Validation(format!(
                "duplicate source file name `{name}`; use --weave to disambiguate archive members"
            )));
        }
    }
    Ok(())
}

/// Serializes the weave, round-trip validates it, and writes it to `--output`.
fn write_weave_create_output(
    args: &WeaveCreateCommand,
    weave: &RomWeaverWeave,
    warnings: &mut Vec<String>,
) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(weave).map_err(|error| {
        RomWeaverError::Validation(format!("failed to serialize weave: {error}"))
    })?;
    bytes.push(b'\n');
    // Round-trip validation: create can never emit what parse rejects.
    parse_weave_bytes(&bytes)?;

    let output_base_name = args
        .output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if weave_file_name_codec(output_base_name).is_none()
        && !is_weave_json_candidate(output_base_name)
    {
        warnings.push(format!(
            "weave written as `{output_base_name}`: apply auto-detection requires a plain .json filename or rom-weaver-weave.json.<codec>; pass this file with --weave"
        ));
    }
    write_weave_bytes(&args.output, &bytes)?;
    trace!(output = %args.output.display(), bytes = bytes.len(), "weave written");
    Ok(bytes)
}

/// Normalize per-patch specs for the wasm JSON path: metadata vectors must be
/// index-aligned with `patch` (same length) or omitted entirely.
fn weave_create_patch_specs(args: &WeaveCreateCommand) -> Result<Vec<WeaveCreatePatchSpec>> {
    if !args.patch_specs.is_empty() {
        return Ok(args.patch_specs.clone());
    }
    let count = args.patch.len();
    let ids = aligned_metadata(&args.patch_id, count, "--patch-id")?;
    let versions = aligned_metadata(&args.patch_version, count, "--patch-version")?;
    let names = aligned_metadata(&args.patch_name, count, "--patch-name")?;
    let descriptions = aligned_metadata(&args.patch_description, count, "--patch-description")?;
    let authors = aligned_metadata(&args.patch_author, count, "--patch-author")?;
    let labels = aligned_metadata(&args.patch_label, count, "--patch-label")?;
    let optionals = aligned_metadata(&args.patch_optional, count, "--patch-optional")?;
    let source_urls = aligned_metadata(&args.patch_source_url, count, "--patch-source-url")?;
    let headers = aligned_metadata(&args.patch_header, count, "--patch-header")?;
    let bases = aligned_metadata(&args.patch_basis, count, "--patch-basis")?;
    let inputs = aligned_metadata(&args.patch_input, count, "patch_input")?;
    let targets = aligned_metadata(&args.patch_target, count, "patch_target")?;
    let input_checks = aligned_metadata(&args.patch_input_check, count, "--patch-expect-in")?;
    let output_checks = aligned_metadata(&args.patch_output_check, count, "--patch-expect-out")?;
    Ok(args
        .patch
        .iter()
        .enumerate()
        .map(|(index, path)| WeaveCreatePatchSpec {
            path: path.clone(),
            id: ids[index].clone(),
            version: versions[index].clone(),
            author: authors[index].clone(),
            name: names[index].clone(),
            description: descriptions[index].clone(),
            label: labels[index].clone(),
            optional: optionals[index],
            source_url: source_urls[index].clone(),
            header: headers[index],
            basis: bases[index].and_then(PatchBasisMode::declared),
            input: inputs[index].clone().flatten(),
            target: targets[index].clone().flatten(),
            input_checks: input_checks[index]
                .clone()
                .map(|value| vec![value])
                .unwrap_or_default(),
            input_checks_ref: None,
            output_checks: output_checks[index]
                .clone()
                .map(|value| vec![value])
                .unwrap_or_default(),
            output_checks_ref: None,
        })
        .collect())
}

/// Assign stable archive-relative member paths. Equal payload bytes reuse the
/// first path; same-name different bytes get a distinct deterministic member.
/// This makes an archive definition unambiguous without treating matching
/// checksums from unrelated authored states as the same thing.
fn assign_weave_member_paths(
    rom: &mut Option<WeaveRom>,
    rom_source: Option<&Path>,
    patches: &mut [WeavePatchEntry],
    specs: &[WeaveCreatePatchSpec],
) -> Result<()> {
    let mut members: Vec<(String, PathBuf)> = Vec::new();
    let mut assign = |source: &Path, preferred: String| -> Result<String> {
        if let Some((member, _)) = members
            .iter()
            .find(|(_, existing)| same_weave_payload(existing, source))
        {
            return Ok(member.clone());
        }
        let member = if members.iter().all(|(member, _)| member != &preferred) {
            preferred
        } else {
            let stem = Path::new(&preferred)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("payload");
            let extension = Path::new(&preferred)
                .extension()
                .and_then(|value| value.to_str())
                .map(|extension| format!(".{extension}"))
                .unwrap_or_default();
            let mut ordinal = 2usize;
            loop {
                let candidate = format!("payload-{stem}-{ordinal}{extension}");
                if members.iter().all(|(member, _)| member != &candidate) {
                    break candidate;
                }
                ordinal = ordinal.saturating_add(1);
            }
        };
        members.push((member.clone(), source.to_path_buf()));
        Ok(member)
    };
    if let (Some(rom), Some(source)) = (rom.as_mut(), rom_source)
        && rom.path.is_some()
    {
        rom.path = Some(assign(source, required_base_name(source, "rom")?)?);
    }
    for (entry, spec) in patches.iter_mut().zip(specs) {
        if entry.path.is_some() {
            entry.path = Some(assign(
                &spec.path,
                required_base_name(&spec.path, "patch")?,
            )?);
        }
    }
    Ok(())
}

fn same_weave_payload(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    let Ok(left_metadata) = fs::metadata(left) else {
        return false;
    };
    let Ok(right_metadata) = fs::metadata(right) else {
        return false;
    };
    if left_metadata.len() != right_metadata.len() {
        return false;
    }
    let (Ok(mut left), Ok(mut right)) = (File::open(left), File::open(right)) else {
        return false;
    };
    let mut left_buffer = [0u8; 64 * 1024];
    let mut right_buffer = [0u8; 64 * 1024];
    loop {
        let left_read = match left.read(&mut left_buffer) {
            Ok(read) => read,
            Err(_) => return false,
        };
        let right_read = match right.read(&mut right_buffer) {
            Ok(read) => read,
            Err(_) => return false,
        };
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return false;
        }
        if left_read == 0 {
            return true;
        }
    }
}

/// Move each authored check object into one named state. The function does not
/// compare digests: two equal values can describe different releases, and only
/// an explicit reference is allowed to state that they are the same target.
fn canonicalize_weave_check_states(
    rom: &mut Option<WeaveRom>,
    patches: &mut [WeavePatchEntry],
    output: &mut Option<WeaveOutput>,
    default_basis: Option<PatchInputBasis>,
) -> Vec<WeaveCheckState> {
    let mut states = Vec::new();
    let mut rom_state: Option<(String, WeaveChecks)> = None;
    let mut output_states: BTreeMap<String, (String, WeaveChecks)> = BTreeMap::new();
    let root_member = rom.as_ref().and_then(|rom| rom.member.clone());
    if let Some(rom) = rom
        && let Some(checks) = rom.checks.take()
    {
        let id = "rom".to_string();
        rom.checks_ref = Some(id.clone());
        rom_state = Some((id.clone(), checks.clone()));
        states.push(WeaveCheckState { id, checks });
    }
    for (index, patch) in patches.iter_mut().enumerate() {
        let stem = patch
            .id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{index}"));
        if let Some(checks) = patch.input_checks.take() {
            let basis = patch.basis.or(default_basis);
            let referenced =
                patch
                    .input_checks_ref
                    .clone()
                    .or_else(|| match (&patch.input, basis) {
                        (
                            Some(WeavePatchInput::Rom { member, .. }),
                            Some(PatchInputBasis::Base),
                        ) if member == &root_member => rom_state
                            .as_ref()
                            .filter(|(_, state_checks)| *state_checks == checks)
                            .map(|(id, _)| id.clone()),
                        (
                            Some(WeavePatchInput::Patch {
                                patch: producer,
                                member: None,
                            }),
                            Some(PatchInputBasis::Previous),
                        ) => output_states
                            .get(producer)
                            .filter(|(_, state_checks)| *state_checks == checks)
                            .map(|(id, _)| id.clone()),
                        _ => None,
                    });
            let id = referenced.unwrap_or_else(|| {
                let id = unique_check_state_id(&states, format!("patch:{stem}:input"));
                states.push(WeaveCheckState {
                    id: id.clone(),
                    checks: checks.clone(),
                });
                id
            });
            if states.iter().all(|state| state.id != id) {
                states.push(WeaveCheckState {
                    id: id.clone(),
                    checks: checks.clone(),
                });
            }
            patch.input_checks_ref = Some(id);
        }
        if let Some(checks) = patch.output_checks.take() {
            let id = patch
                .output_checks_ref
                .clone()
                .unwrap_or_else(|| unique_check_state_id(&states, format!("patch:{stem}:output")));
            patch.output_checks_ref = Some(id.clone());
            if states.iter().all(|state| state.id != id) {
                states.push(WeaveCheckState {
                    id: id.clone(),
                    checks: checks.clone(),
                });
            }
            if let Some(patch_id) = patch.id.as_ref() {
                output_states.insert(patch_id.clone(), (id, checks));
            }
        }
    }
    if let Some(output) = output
        && let Some(checks) = output.checks.take()
    {
        // The final output is the last patch's output by construction, so an
        // equal declared state on that patch is the same state, id or not.
        let last_output_state = patches
            .last()
            .and_then(|patch| patch.output_checks_ref.as_deref())
            .and_then(|reference| states.iter().find(|state| state.id == reference))
            .filter(|state| state.checks == checks)
            .map(|state| state.id.clone());
        output.checks_ref = Some(last_output_state.unwrap_or_else(|| {
            let id = unique_check_state_id(&states, "output".to_string());
            states.push(WeaveCheckState {
                id: id.clone(),
                checks,
            });
            id
        }));
    }
    states
}

fn unique_check_state_id(states: &[WeaveCheckState], preferred: String) -> String {
    if states.iter().all(|state| state.id != preferred) {
        return preferred;
    }
    let mut ordinal = 2usize;
    loop {
        let candidate = format!("{preferred}-{ordinal}");
        if states.iter().all(|state| state.id != candidate) {
            return candidate;
        }
        ordinal = ordinal.saturating_add(1);
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn upgraded_schema_ref(version: u32, schema: Option<&str>) -> Option<String> {
    schema.map(|schema| {
        if version == 1
            && (schema == WEAVE_JSON_SCHEMA_V1_URL
                || schema == "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-bundle-v1.schema.json") {
            WEAVE_JSON_SCHEMA_URL.to_string()
        } else {
            schema.to_string()
        }
    })
}

/// Parse check-flag tokens (`algo=hex`, comma-separable) into an emitted
/// checks value.
fn weave_entry_checks(values: &[String], flag: &str) -> Result<Option<WeaveChecks>> {
    let tokens: Vec<String> = values
        .iter()
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect();
    if tokens.is_empty() {
        return Ok(None);
    }
    let parsed = parse_expect_tokens(&tokens, flag, true)?;
    Ok(Some(WeaveChecks {
        checksums: parsed.checksums,
        size: parsed.size,
    }))
}

/// Render a `WeaveChecks` back into check-flag tokens for `--from` hydration.
/// Size stays explicit so a size-only shared state survives a round trip.
#[cfg(not(target_arch = "wasm32"))]
fn checks_tokens(checks: &WeaveChecks) -> Vec<String> {
    checks
        .checksums
        .iter()
        .map(|(algorithm, hex)| format!("{algorithm}={hex}"))
        .chain(checks.size.map(|size| format!("size={size}")))
        .collect()
}

pub(crate) fn aligned_metadata<T: Clone>(
    values: &[T],
    count: usize,
    flag: &str,
) -> Result<Vec<Option<T>>> {
    if values.is_empty() {
        return Ok(vec![None; count]);
    }
    if values.len() == count {
        return Ok(values.iter().cloned().map(Some).collect());
    }
    let positions = if values.len() < count {
        let missing = (values.len() + 1..=count)
            .map(|position| format!("#{position}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!("no value for --patch {missing}")
    } else {
        let extra = (count + 1..=values.len())
            .map(|position| format!("#{position}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!("value(s) {extra} have no matching --patch")
    };
    Err(RomWeaverError::Validation(format!(
        "{flag} must follow its --patch, once per --patch (or be left out entirely); got {} value(s) for {count} patch(es): {positions}",
        values.len()
    )))
}

fn required_base_name(path: &Path, what: &str) -> Result<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "{what} path has no usable file name: `{}`",
                path.display()
            ))
        })
}

fn weave_create_outputs_alias(left: &Path, right: &Path) -> bool {
    left == right || native_file_identity_matches(left, right)
}

fn weave_create_outputs_alias_after_parent_checks(left: &Path, right: &Path) -> bool {
    weave_create_outputs_alias(left, right)
        || matches!(
            (output_path_identity(left), output_path_identity(right)),
            (Some(left), Some(right)) if left == right
        )
}

fn output_path_identity(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::canonicalize(parent)
        .ok()
        .map(|parent| parent.join(name))
}

#[cfg(not(target_arch = "wasm32"))]
fn native_file_identity_matches(left: &Path, right: &Path) -> bool {
    same_file::is_same_file(left, right).unwrap_or(false)
}

#[cfg(target_arch = "wasm32")]
fn native_file_identity_matches(_left: &Path, _right: &Path) -> bool {
    false
}

/// Write weave bytes honoring the output name's codec extension: plain
/// JSON, `.gz`, or `.zst` (parse additionally reads `.bz2`/`.xz`, but create
/// keeps to the two codecs with in-tree encoders).
fn write_weave_bytes(output: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    let base_name = output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let codec = weave_file_name_codec(base_name).flatten().or_else(|| {
        // A non-rom-weaver-weave.json name still honors a trailing codec extension.
        base_name.rsplit_once('.').map(|(_, extension)| extension)
    });
    match codec {
        Some(extension) if extension.eq_ignore_ascii_case("gz") => {
            let file = File::create(output)?;
            let mut encoder = GzEncoder::new(file, GzCompression::best());
            encoder.write_all(bytes)?;
            encoder.finish()?;
            Ok(())
        }
        Some(extension) if extension.eq_ignore_ascii_case("zst") => {
            let file = File::create(output)?;
            zstd::stream::copy_encode(bytes, file, 19).map_err(|error| {
                RomWeaverError::Validation(format!("zstd weave encoding failed: {error}"))
            })?;
            Ok(())
        }
        Some(extension)
            if extension.eq_ignore_ascii_case("bz2") || extension.eq_ignore_ascii_case("xz") =>
        {
            Err(RomWeaverError::Validation(format!(
                "weave create emits .gz or .zst compressed weaves; `.{extension}` is read-only"
            )))
        }
        _ => {
            fs::write(output, bytes)?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod v1_schema_tests {
    use super::*;

    #[test]
    fn v1_official_schema_reference_upgrades_to_v2() {
        assert_eq!(
            upgraded_schema_ref(1, Some(WEAVE_JSON_SCHEMA_V1_URL)).as_deref(),
            Some(WEAVE_JSON_SCHEMA_URL)
        );
        assert_eq!(
            upgraded_schema_ref(1, Some("https://example.test/custom.json")).as_deref(),
            Some("https://example.test/custom.json")
        );
        assert_eq!(
            upgraded_schema_ref(2, Some(WEAVE_JSON_SCHEMA_V1_URL)).as_deref(),
            Some(WEAVE_JSON_SCHEMA_V1_URL)
        );
    }
}
#[cfg(test)]
#[path = "../tests/unit/weave_create.rs"]
mod tests;
