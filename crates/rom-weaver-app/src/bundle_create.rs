//! `bundle create`: build, validate, and emit a rom-weaver-bundle.json bundle from
//! local sources (native + wasm; the webapp export drives this command).

use flate2::{Compression as GzCompression, write::GzEncoder};

use super::bundle_parse::{bundle_file_name_codec, parse_bundle_bytes};
use super::*;

const BUNDLE_CREATE_DEFAULT_ALGORITHMS: [&str; 3] = ["crc32", "md5", "sha1"];

const BUNDLE_CREATE_OP: OperationLabel<'static> = OperationLabel {
    command: "bundle-create",
    family: OperationFamily::Command,
    format: None,
};

/// Emit a hash-progress event at most once per this many processed bytes.
const BUNDLE_CREATE_PROGRESS_INTERVAL: u64 = 8 * 1024 * 1024;

/// The result of one `bundle create`, returned under
/// `details.bundle_create`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct BundleCreateResult {
    pub bundle_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub archive_path: Option<String>,
    /// The canonical bundle as written (checksums computed and normalized).
    pub bundle: RomWeaverBundle,
    pub warnings: Vec<String>,
}

impl CliApp {
    pub(super) fn run_bundle_create(&self, mut args: BundleCreateCommand) -> AppRunOutcome {
        let context = self.context(args.threads);
        let thread_execution = context.single_thread_execution();
        // --from hydrates the command from a hand-authored spec before anything
        // else, so explicit flags still override and the rest of create is
        // unchanged.
        if let Err(error) = self.apply_bundle_create_spec(&mut args) {
            return self.finish(
                "bundle-create",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("bundle-create".to_string()),
                    "bundle-create",
                    error.to_string(),
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
            bundle = ?args.bundle,
            checksum_algorithms = args.checksum.len(),
            threads = %args.threads,
            "starting bundle create command"
        );
        let report = match self.bundle_create_inner(&args, &context) {
            Ok(result) => {
                let label = format!(
                    "wrote bundle `{}` ({} patch entr{}{})",
                    result.bundle_path,
                    result.bundle.patches.len(),
                    if result.bundle.patches.len() == 1 {
                        "y"
                    } else {
                        "ies"
                    },
                    result
                        .archive_path
                        .as_deref()
                        .map(|bundle| format!("; bundled into `{bundle}`"))
                        .unwrap_or_default(),
                );
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("bundle-create".to_string()),
                    "bundle-create",
                    label,
                    Some(100.0),
                    thread_execution.clone(),
                );
                match serde_json::to_value(&result) {
                    Ok(value) => {
                        report.details = Some(json!({ "bundle_create": value }));
                        report
                    }
                    Err(error) => OperationReport::failed(
                        OperationFamily::Command,
                        Some("bundle-create".to_string()),
                        "bundle-create",
                        format!("failed to serialize bundle create result: {error}"),
                        thread_execution,
                    ),
                }
            }
            Err(error) => OperationReport::failed(
                OperationFamily::Command,
                Some("bundle-create".to_string()),
                "bundle-create",
                error.to_string(),
                thread_execution,
            ),
        };
        self.finish("bundle-create", report)
    }

    /// Hydrate a `bundle create` command from a `--from` spec: read the file
    /// (or stdin for `-`), parse it as a `RomWeaverBundle`, and fill any field
    /// the CLI did not set. Local `path` entries resolve relative to the spec
    /// file; create then hashes the ROM and normalizes as usual. Explicit flags
    /// win over the spec. Native-only (reads a local file / stdin); on wasm the
    /// webapp builds the command directly, so this is a no-op.
    #[cfg(not(target_arch = "wasm32"))]
    fn apply_bundle_create_spec(&self, args: &mut BundleCreateCommand) -> Result<()> {
        let Some(from) = args.from.clone() else {
            return Ok(());
        };
        let is_stdin = from.as_os_str() == "-";
        let bytes = if is_stdin {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut std::io::stdin().lock(), &mut buf).map_err(
                |error| {
                    RomWeaverError::Validation(format!(
                        "failed to read bundle spec from stdin: {error}"
                    ))
                },
            )?;
            buf
        } else {
            fs::read(&from).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read bundle spec `{}`: {error}",
                    from.display()
                ))
            })?
        };
        let spec = parse_bundle_bytes(&bytes)?;
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
            args.schema_ref = spec.schema.clone();
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
        }

        if let Some(output) = &spec.output {
            if args.output_name.is_none() {
                args.output_name = output.name.clone();
            }
            if args.output_header.is_none() {
                args.output_header = output.header;
            }
            if args.output_check.is_empty()
                && let Some(checks) = &output.checks
            {
                args.output_check = checks_tokens(checks);
            }
        }

        // Explicit --patch flags win wholesale over the spec's patch chain.
        if args.patch_specs.is_empty() && args.patch.is_empty() {
            let mut specs = Vec::with_capacity(spec.patches.len());
            for (index, entry) in spec.patches.iter().enumerate() {
                let (path, source_url) = match (entry.path.as_deref(), entry.url.as_deref()) {
                    (Some(path), _) => (resolve(path), None),
                    (None, Some(url)) => {
                        return Err(RomWeaverError::Validation(format!(
                            "--from: patches[{index}] is a url-only entry (`{url}`); bundle create bakes local files, so give it a local `path`"
                        )));
                    }
                    (None, None) => {
                        return Err(RomWeaverError::Validation(format!(
                            "--from: patches[{index}] has neither `path` nor `url`"
                        )));
                    }
                };
                specs.push(BundleCreatePatchSpec {
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
                    input_checks: entry
                        .input_checks
                        .as_ref()
                        .map(checks_tokens)
                        .unwrap_or_default(),
                    output_checks: entry
                        .output_checks
                        .as_ref()
                        .map(checks_tokens)
                        .unwrap_or_default(),
                });
            }
            args.patch_specs = specs;
        }
        Ok(())
    }

    #[cfg(target_arch = "wasm32")]
    fn apply_bundle_create_spec(&self, _args: &mut BundleCreateCommand) -> Result<()> {
        Ok(())
    }

    pub(super) fn bundle_create_inner(
        &self,
        args: &BundleCreateCommand,
        context: &OperationContext,
    ) -> Result<BundleCreateResult> {
        let specs = bundle_create_patch_specs(args)?;
        if specs.is_empty() {
            return Err(RomWeaverError::Validation(
                "bundle create requires at least one --patch".to_string(),
            ));
        }
        let algorithms: Vec<String> = if args.checksum.is_empty() {
            BUNDLE_CREATE_DEFAULT_ALGORITHMS
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
            return Err(RomWeaverError::Validation(format!(
                "unsupported checksum algorithm `{invalid}`"
            )));
        }
        let mut warnings = Vec::new();

        if args.bundle_rom.is_some() && args.rom.is_none() {
            return Err(RomWeaverError::Validation(
                "--bundle-rom requires --rom so checks describe the logical ROM bytes".to_string(),
            ));
        }

        if args.no_bundle_rom && args.rom.is_none() {
            warnings.push("--no-bundle-rom ignored: no local --rom given".to_string());
        }
        // Trusted rom checksums/size from a prior staging pass, so export skips
        // re-hashing the prepared leaf. `algo=hex` tokens seed the rom checks; a
        // `size=N` token seeds the prepared size.
        let rom_assume = parse_expect_tokens(&args.assume_in, "--assume-in", true)?;
        let cached_rom_checks = (!rom_assume.checksums.is_empty()).then(|| BundleChecks {
            checksums: rom_assume.checksums.clone(),
            size: rom_assume.size,
        });
        // Overall hash-progress denominator: only the rom is hashed when the
        // caller did not provide the staged checks; patch files carry no
        // checksums in the bundle.
        let total_hash_bytes: u64 = args
            .rom
            .as_deref()
            .filter(|path| path.is_file())
            .filter(|_| cached_rom_checks.is_none())
            .map(|path| fs::metadata(path).map(|meta| meta.len()).unwrap_or(0))
            .unwrap_or(0);
        let mut hashed_bytes: u64 = 0;

        let rom = match (&args.rom, &args.rom_url) {
            (None, None) => {
                if args.rom_name.is_some() {
                    warnings.push("--rom-name ignored: no rom source given".to_string());
                }
                None
            }
            (Some(path), url_override) => {
                if !path.is_file() {
                    return Err(RomWeaverError::Validation(format!(
                        "rom path does not exist: `{}`",
                        path.display()
                    )));
                }
                let checksums = if let Some(cached) = cached_rom_checks.as_ref() {
                    cached.checksums.clone()
                } else {
                    self.bundle_checksum_with_progress(
                        path,
                        &algorithms,
                        context,
                        &mut hashed_bytes,
                        total_hash_bytes,
                    )?
                };
                let size = rom_assume.size.unwrap_or(fs::metadata(path)?.len());
                let bundle_source = args.bundle_rom.as_deref().unwrap_or(path);
                if !bundle_source.is_file() {
                    return Err(RomWeaverError::Validation(format!(
                        "bundle rom path does not exist: `{}`",
                        bundle_source.display()
                    )));
                }
                let base_name = required_base_name(bundle_source, "rom")?;
                // A no-bundle-rom entry keeps its checks but carries no
                // source: the applying user supplies the ROM themselves. A
                // sourceless entry always gets a name (the local file's base
                // name) so consumers can tell the user WHICH ROM to supply.
                let distribute_path = url_override.is_none() && !args.no_bundle_rom;
                let sourceless_name = (url_override.is_none() && !distribute_path)
                    .then(|| required_base_name(path, "rom"))
                    .transpose()?;
                Some(BundleRom {
                    name: args.rom_name.clone().or(sourceless_name),
                    url: url_override.clone(),
                    path: distribute_path.then_some(base_name),
                    checks: Some(BundleChecks {
                        checksums,
                        size: Some(size),
                    }),
                })
            }
            (None, Some(url)) => Some(BundleRom {
                name: args.rom_name.clone(),
                url: Some(url.clone()),
                path: None,
                checks: None,
            }),
        };

        let output_checks = bundle_entry_checks(&args.output_check, "--expect-out")?;

        let mut patches = Vec::with_capacity(specs.len());
        for spec in &specs {
            if !spec.path.is_file() {
                return Err(RomWeaverError::Validation(format!(
                    "patch path does not exist: `{}`",
                    spec.path.display()
                )));
            }
            let base_name = required_base_name(&spec.path, "patch")?;
            // Patches rely on the bundle's endpoint checks unless they
            // differ: an inputChecks equal to rom.checks (the chain start) or
            // an outputChecks equal to output.checks (the chain end) is
            // implied and stays out of the entry.
            let entry_input_checks = bundle_entry_checks(&spec.input_checks, "--patch-expect-in")?
                .filter(|checks| {
                    !checks_implied_by(checks, rom.as_ref().and_then(|rom| rom.checks.as_ref()))
                });
            let entry_output_checks =
                bundle_entry_checks(&spec.output_checks, "--patch-expect-out")?
                    .filter(|checks| !checks_implied_by(checks, output_checks.as_ref()));
            patches.push(BundlePatchEntry {
                id: spec.id.clone(),
                version: spec.version.clone(),
                author: spec.author.clone(),
                name: spec.name.clone(),
                description: spec.description.clone(),
                optional: spec.optional.unwrap_or(false),
                label: spec.label.clone(),
                url: spec.source_url.clone(),
                path: spec.source_url.is_none().then_some(base_name),
                input_checks: entry_input_checks,
                output_checks: entry_output_checks,
                header: spec.header,
                basis: spec.basis,
            });
        }

        // Path entries reference files by base name (next to the bundle, or
        // as flat bundle members) - duplicates would alias each other.
        let mut seen_names = BTreeSet::new();
        let path_names = rom
            .iter()
            .filter_map(|rom| rom.path.clone())
            .chain(patches.iter().filter_map(|patch| patch.path.clone()));
        for name in path_names {
            if !seen_names.insert(name.clone()) {
                return Err(RomWeaverError::Validation(format!(
                    "duplicate source file name `{name}`; bundle path entries reference files by name, so rename one of the inputs"
                )));
            }
        }

        let output =
            (args.output_name.is_some() || args.output_header.is_some() || output_checks.is_some())
                .then(|| BundleOutput {
                    name: args.output_name.clone(),
                    header: args.output_header,
                    checks: output_checks,
                });

        let bundle = RomWeaverBundle {
            // Only stamped when explicitly requested (--schema-ref) or carried
            // over from a --from spec; never auto-injected, so plain create
            // stays byte-identical.
            schema: args.schema_ref.clone(),
            version: BUNDLE_VERSION,
            rom,
            patches,
            output,
        };
        let mut bytes = serde_json::to_vec_pretty(&bundle).map_err(|error| {
            RomWeaverError::Validation(format!("failed to serialize bundle: {error}"))
        })?;
        bytes.push(b'\n');
        // Round-trip validation: create can never emit what parse rejects.
        parse_bundle_bytes(&bytes)?;

        let output_base_name = args
            .output
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if bundle_file_name_codec(output_base_name).is_none() {
            warnings.push(format!(
                "bundle written as `{output_base_name}`: apply auto-detection only recognizes rom-weaver-bundle.json / rom-weaver-bundle.json.<codec> names"
            ));
        }
        write_bundle_bytes(&args.output, &bytes)?;
        trace!(output = %args.output.display(), bytes = bytes.len(), "bundle written");

        let bundle_path = match &args.bundle {
            Some(bundle) => Some(
                self.create_bundle_bundle(
                    bundle,
                    &bytes,
                    args.bundle_rom
                        .as_deref()
                        .or(args.rom.as_deref())
                        .filter(|_| args.rom_url.is_none() && !args.no_bundle_rom),
                    &specs,
                    context,
                )?,
            ),
            None => None,
        };

        Ok(BundleCreateResult {
            bundle_path: Self::normalize_emitted_path_string(&args.output.to_string_lossy()),
            archive_path: bundle_path
                .map(|path| Self::normalize_emitted_path_string(&path.to_string_lossy())),
            bundle,
            warnings,
        })
    }

    /// Checksum one create source, emitting overall hash progress across the
    /// whole file set (`hashed_bytes` accumulates; `total_bytes` is the fixed
    /// denominator). Without progress events the plain fast path is used.
    fn bundle_checksum_with_progress(
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
            BUNDLE_CREATE_OP,
            "checksum",
            label.clone(),
            Some(overall_percent(*hashed_bytes)),
            None,
        );
        let hashed_before = *hashed_bytes;
        let mut last_emitted = 0u64;
        let mut file = File::open(path)?;
        let mut on_progress = |progress: ChecksumProgress| {
            if progress.processed_bytes < last_emitted + BUNDLE_CREATE_PROGRESS_INTERVAL {
                return;
            }
            last_emitted = progress.processed_bytes;
            self.emit_running(
                BUNDLE_CREATE_OP,
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

    /// Stage `rom-weaver-bundle.json` + the local sources flat into a temp dir and pack them
    /// with the requested creatable container format.
    fn create_bundle_bundle(
        &self,
        bundle: &Path,
        bundle_bytes: &[u8],
        rom: Option<&Path>,
        specs: &[BundleCreatePatchSpec],
        context: &OperationContext,
    ) -> Result<PathBuf> {
        let staging = context.temp_paths().next_path("bundle-bundle", None);
        fs::create_dir_all(&staging)?;
        let bundle_path = staging.join("rom-weaver-bundle.json");
        fs::write(&bundle_path, bundle_bytes)?;
        let mut inputs = vec![bundle_path];
        if let Some(rom) = rom {
            let target = staging.join(required_base_name(rom, "rom")?);
            fs::copy(rom, &target)?;
            inputs.push(target);
        }
        for spec in specs {
            if spec.source_url.is_some() {
                continue;
            }
            let target = staging.join(required_base_name(&spec.path, "patch")?);
            fs::copy(&spec.path, &target)?;
            inputs.push(target);
        }
        let format = bundle
            .extension()
            .and_then(|extension| extension.to_str())
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "--bundle path needs a creatable archive extension (for example .zip)"
                        .to_string(),
                )
            })?;
        let handler = self.containers.find_creatable_by_name(format)?;
        // Archive creation reports no incremental progress here, so surface
        // the stage as indeterminate rather than sitting on the last percent.
        self.emit_running(
            BUNDLE_CREATE_OP,
            "bundle",
            format!(
                "bundling {} file(s) into `{}`",
                inputs.len(),
                bundle.display()
            ),
            None,
            None,
        );
        trace!(
            bundle = %bundle.display(),
            format = handler.descriptor().name,
            inputs = inputs.len(),
            "creating bundle bundle archive"
        );
        let request = ContainerCreateRequest {
            inputs,
            output: bundle.to_path_buf(),
            format: handler.descriptor().name.to_string(),
            codec: None,
            level: None,
            parent: None,
        };
        handler.create(&request, context)?;
        Ok(bundle.to_path_buf())
    }
}

/// Normalize per-patch specs for the wasm JSON path: metadata vectors must be
/// index-aligned with `patch` (same length) or omitted entirely.
fn bundle_create_patch_specs(args: &BundleCreateCommand) -> Result<Vec<BundleCreatePatchSpec>> {
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
    let input_checks = aligned_metadata(&args.patch_input_check, count, "--patch-expect-in")?;
    let output_checks = aligned_metadata(&args.patch_output_check, count, "--patch-expect-out")?;
    Ok(args
        .patch
        .iter()
        .enumerate()
        .map(|(index, path)| BundleCreatePatchSpec {
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
            input_checks: input_checks[index]
                .clone()
                .map(|value| vec![value])
                .unwrap_or_default(),
            output_checks: output_checks[index]
                .clone()
                .map(|value| vec![value])
                .unwrap_or_default(),
        })
        .collect())
}

/// Parse check-flag tokens (`algo=hex`, comma-separable) into an emitted
/// checks value.
fn bundle_entry_checks(values: &[String], flag: &str) -> Result<Option<BundleChecks>> {
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
    let checksums = CliApp::parse_patch_apply_checksum_values(&tokens, flag)?;
    Ok(Some(BundleChecks {
        checksums,
        size: None,
    }))
}

/// Render a `BundleChecks` back into `algo=hex` check-flag tokens for `--from`
/// hydration. Size is dropped (per-patch/output check flags carry only
/// checksums), matching the flag path.
#[cfg(not(target_arch = "wasm32"))]
fn checks_tokens(checks: &BundleChecks) -> Vec<String> {
    checks
        .checksums
        .iter()
        .map(|(algorithm, hex)| format!("{algorithm}={hex}"))
        .collect()
}

/// Whether `checks` adds nothing over `baseline`: every checksum it pins has
/// the same value in the baseline (and its size, when set, matches). Such an
/// entry is implied and gets omitted from the bundle.
fn checks_implied_by(checks: &BundleChecks, baseline: Option<&BundleChecks>) -> bool {
    let Some(baseline) = baseline else {
        return false;
    };
    if checks.checksums.is_empty() && checks.size.is_none() {
        return true;
    }
    let checksums_covered = checks.checksums.iter().all(|(algorithm, value)| {
        baseline
            .checksums
            .get(algorithm)
            .is_some_and(|expected| expected.eq_ignore_ascii_case(value))
    });
    let size_covered = match checks.size {
        Some(size) => baseline.size == Some(size),
        None => true,
    };
    checksums_covered && size_covered
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
    Err(RomWeaverError::Validation(format!(
        "{flag} must be given once per --patch (or not at all); got {} value(s) for {count} patch(es)",
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

/// Write bundle bytes honoring the output name's codec extension: plain
/// JSON, `.gz`, or `.zst` (parse additionally reads `.bz2`/`.xz`, but create
/// keeps to the two codecs with in-tree encoders).
fn write_bundle_bytes(output: &Path, bytes: &[u8]) -> Result<()> {
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
    let codec = bundle_file_name_codec(base_name).flatten().or_else(|| {
        // A non-rom-weaver-bundle.json name still honors a trailing codec extension.
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
                RomWeaverError::Validation(format!("zstd bundle encoding failed: {error}"))
            })?;
            Ok(())
        }
        Some(extension)
            if extension.eq_ignore_ascii_case("bz2") || extension.eq_ignore_ascii_case("xz") =>
        {
            Err(RomWeaverError::Validation(format!(
                "bundle create emits .gz or .zst compressed bundles; `.{extension}` is read-only"
            )))
        }
        _ => {
            fs::write(output, bytes)?;
            Ok(())
        }
    }
}
