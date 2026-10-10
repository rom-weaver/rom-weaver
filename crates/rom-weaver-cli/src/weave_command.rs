use rom_weaver_containers::libarchive::RegularArchiveFileEntry;

use super::weave_load::{LoadedWeaveSource, WeaveOutputGuard, weave_archive_target};
use super::weave_parse::parse_weave_bytes;
use super::*;

/// How the weave source was packaged.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript-types", ts(rename_all = "kebab-case"))]
pub enum WeaveSourceKind {
    Json,
    CompressedJson,
    Archive,
}

/// Where a weave entry's bytes come from, as resolved by `weave parse`:
/// a download URL (returned verbatim - the caller resolves relative URLs
/// against the weave's own location), an archive member already extracted
/// to disk, or a still-relative path the caller resolves itself.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(untagged)]
pub enum WeaveSourceRef {
    Url { url: String },
    ExtractedPath { extracted_path: String },
    Path { path: String },
}

/// Resolution for one patch entry, index-aligned with `weave.patches`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct WeavePatchSource {
    pub source: WeaveSourceRef,
    /// Ingest-grade descriptor for entries extracted from the weave
    /// archive (spares the host a second describe round-trip). `None` for
    /// URL / unresolved-path entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub descriptor: Option<PatchDescriptor>,
}

/// The consolidated result of one `weave parse` command, returned under
/// `details.bundle`. Same envelope pattern as `details.ingest`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct WeaveParseResult {
    /// The validated weave, checksum values normalized.
    #[cfg_attr(feature = "typescript-types", ts(rename = "weave"))]
    pub bundle: RomWeaverWeave,
    pub source_kind: WeaveSourceKind,
    /// Entry name of the weave member when the source was an archive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub archive_member: Option<String>,
    /// Resolved ROM source; `None` when the weave defines no ROM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub rom_source: Option<WeaveSourceRef>,
    /// Index-aligned with `weave.patches`.
    pub patch_sources: Vec<WeavePatchSource>,
    /// Non-fatal issues (ignored members, extra weaves, …).
    pub warnings: Vec<String>,
}

/// The cheat clause of the parse label: how many entries, how they are
/// delivered, and which cheats they name.
fn cheat_entry_summary(cheats: &[WeaveCheatEntry]) -> String {
    if cheats.is_empty() {
        return String::new();
    }
    let named = cheats
        .iter()
        .map(|cheat| {
            format!(
                "{}{}",
                cheat.description.as_deref().unwrap_or(&cheat.id),
                if cheat.optional { " [optional]" } else { "" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "; {} cheat entr{}: {named}",
        cheats.len(),
        if cheats.len() == 1 { "y" } else { "ies" }
    )
}

impl CliApp {
    pub(super) fn run_weave_parse(&self, args: WeaveParseCommand) -> AppRunOutcome {
        trace!(
            source = %args.input.display(),
            extract_dir = ?args.output,
            select = args.select.len(),
            no_extract = args.no_extract,
            threads = %args.threads,
            "starting weave parse command"
        );
        let context = self.context(args.threads);
        let thread_execution = context.single_thread_execution();
        let report = match self.weave_parse_inner(&args, &context) {
            Ok(result) => {
                let label = format!(
                    "parsed weave `{}` ({} patch entr{}{})",
                    args.input.display(),
                    result.bundle.patches.len(),
                    if result.bundle.patches.len() == 1 {
                        "y"
                    } else {
                        "ies"
                    },
                    cheat_entry_summary(&result.bundle.cheats)
                );
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("bundle-parse".to_string()),
                    "bundle-parse",
                    label,
                    Some(100.0),
                    thread_execution.clone(),
                );
                match serde_json::to_value(&result) {
                    Ok(mut value) => {
                        value["weave"] = value["bundle"].clone();
                        report.details = Some(json!({ "bundle": value, "weave": value }));
                        Self::append_report_warnings(&mut report, result.warnings);
                        let paths = result
                            .rom_source
                            .iter()
                            .chain(result.patch_sources.iter().map(|patch| &patch.source))
                            .filter_map(|source| match source {
                                WeaveSourceRef::ExtractedPath { extracted_path } => {
                                    Some(PathBuf::from(extracted_path))
                                }
                                _ => None,
                            })
                            .collect();
                        Self::attach_emitted_files_details(report, paths, None)
                    }
                    Err(error) => OperationReport::failed(
                        OperationFamily::Command,
                        Some("bundle-parse".to_string()),
                        "bundle-parse",
                        format!("failed to serialize weave parse result: {error}"),
                        thread_execution,
                    ),
                }
            }
            Err(error) => OperationReport::failed_with_error(
                OperationFamily::Command,
                Some("bundle-parse".to_string()),
                "bundle-parse",
                error,
                thread_execution,
            ),
        };
        self.finish("bundle-parse", report)
    }

    pub(super) fn run_weave_schema(&self) -> AppRunOutcome {
        let context = self.context(ThreadBudget::default());
        let thread_execution = context.single_thread_execution();
        let mut report = OperationReport::succeeded(
            OperationFamily::Command,
            Some("bundle-schema".to_string()),
            "bundle-schema",
            "rom-weaver-weave.json schema".to_string(),
            Some(100.0),
            thread_execution,
        );
        // The CLI prints the raw schema to stdout; the details carry it for the
        // wasm/JSON path.
        report.details = Some(json!({ "schema": WEAVE_JSON_SCHEMA }));
        self.finish("bundle-schema", report)
    }

    fn weave_parse_inner(
        &self,
        args: &WeaveParseCommand,
        context: &OperationContext,
    ) -> Result<WeaveParseResult> {
        let source = args.input.as_path();
        if !source.exists() {
            return Err(RomWeaverError::Validation(format!(
                "input path does not exist: `{}`",
                source.display()
            )));
        }
        let loaded = self.load_weave_source(source)?;
        let weave = parse_weave_bytes(&loaded.bytes)?;
        // Extraction targeting (mirrors extract/checksum): --no-extract
        // suppresses all extraction, --filter limits it to the rom/patch
        // class, --select limits it to matching file names. Entries that are
        // not extracted still appear in the result (as unresolved paths / urls)
        // so patch_sources stays index-aligned with weave.patches.
        let extract_dir = if args.no_extract {
            None
        } else {
            args.output.as_deref()
        };
        let rom_extractable = args.filter.is_empty() || args.rom_filter();
        let patch_extractable = args.filter.is_empty() || args.patch_filter();
        let mut selector = SelectionMatcher::new(&args.select);
        let mut planned = BTreeMap::new();
        // A sourceless (checks-only) rom entry resolves to no source at all:
        // the applying user supplies the ROM.
        let rom_source = match &weave.rom {
            Some(rom) if rom.url.is_some() || rom.path.is_some() => {
                let name = entry_basename(rom.path.as_deref(), rom.url.as_deref());
                let entry_extract_dir = (rom_extractable && selector.matches(&name))
                    .then_some(extract_dir)
                    .flatten();
                Some(self.resolve_weave_entry_source(
                    rom.url.as_deref(),
                    rom.path.as_deref(),
                    &mut planned,
                    &loaded,
                    entry_extract_dir,
                    "rom",
                )?)
            }
            _ => None,
        };
        let mut patch_sources = Vec::with_capacity(weave.patches.len());
        for (index, patch) in weave.patches.iter().enumerate() {
            let entry_label = format!("patches[{index}]");
            let name = entry_basename(patch.path.as_deref(), patch.url.as_deref());
            let entry_extract_dir = (patch_extractable && selector.matches(&name))
                .then_some(extract_dir)
                .flatten();
            let source_ref = self.resolve_weave_entry_source(
                patch.url.as_deref(),
                patch.path.as_deref(),
                &mut planned,
                &loaded,
                entry_extract_dir,
                &entry_label,
            )?;
            patch_sources.push(WeavePatchSource {
                source: source_ref,
                descriptor: None,
            });
        }
        // Resolve and validate every destination before extracting anything.
        // Stage all archive reads before publishing, so a corrupt later member
        // cannot leave earlier output files behind.
        let mut outputs = WeaveOutputGuard::default();
        if let Some(extract_dir) = extract_dir.filter(|_| loaded.kind == WeaveSourceKind::Archive) {
            for target in planned.keys() {
                if target
                    .ancestors()
                    .skip(1)
                    .any(|parent| planned.contains_key(parent))
                {
                    return Err(RomWeaverError::Validation(
                        "weave output paths conflict as file and directory".to_owned(),
                    ));
                }
            }
            let staging = context.temp_paths().next_path("weave-parse", None);
            let format_name = loaded.archive_format.expect("archive format");
            let mut staged = Vec::new();
            for (target, entry) in &planned {
                let path =
                    Self::extract_weave_archive_member(source, format_name, entry, &staging)?;
                staged.push((target, entry, path));
            }
            for (target, entry, staged_path) in staged {
                weave_archive_target(entry, extract_dir)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                weave_archive_target(entry, extract_dir)?;
                let mut file = outputs.create(target)?;
                io::copy(&mut File::open(staged_path)?, &mut file)?;
                file.flush()?;
            }
            for patch in &mut patch_sources {
                if let WeaveSourceRef::ExtractedPath { extracted_path } = &patch.source {
                    patch.descriptor = Some(self.build_patch_descriptor(
                        Path::new(extracted_path),
                        None,
                        context,
                    )?);
                }
            }
        }
        outputs.commit();
        Ok(WeaveParseResult {
            bundle: weave,
            source_kind: loaded.kind,
            archive_member: loaded.archive_member,
            rom_source,
            patch_sources,
            warnings: loaded.warnings,
        })
    }

    /// Resolve one weave entry source. URL entries pass through verbatim.
    /// `path` entries resolve against the weave's packaging: planned for
    /// extraction when the source is an archive and `extract_dir` was supplied,
    /// passed through as a relative path otherwise. Planning is read-only;
    /// publication starts only after every reference has been resolved.
    fn resolve_weave_entry_source(
        &self,
        url: Option<&str>,
        path: Option<&str>,
        planned: &mut BTreeMap<PathBuf, RegularArchiveFileEntry>,
        loaded: &LoadedWeaveSource,
        extract_dir: Option<&Path>,
        entry_label: &str,
    ) -> Result<WeaveSourceRef> {
        if let Some(url) = url.map(str::trim).filter(|value| !value.is_empty()) {
            return Ok(WeaveSourceRef::Url {
                url: url.to_owned(),
            });
        }
        // Parse validation guarantees exactly one of url/path is set.
        let path = path.map(str::trim).unwrap_or_default();
        if loaded.kind != WeaveSourceKind::Archive {
            return Ok(WeaveSourceRef::Path {
                path: path.to_owned(),
            });
        }
        let Some(entry) = Self::find_weave_archive_entry(&loaded.archive_entries, path) else {
            return Err(RomWeaverError::ValidationCode(
                rom_weaver_core::ValidationCodeError::new("bundle.path.unresolved")
                    .with_message("weave path entry matches no archive member")
                    .with_field("entry", entry_label.to_owned())
                    .with_field("path", path.to_owned()),
            ));
        };
        let Some(extract_dir) = extract_dir else {
            return Ok(WeaveSourceRef::Path {
                path: path.to_owned(),
            });
        };
        let target = weave_archive_target(entry, extract_dir)?;
        planned.insert(target.clone(), entry.clone());
        Ok(WeaveSourceRef::ExtractedPath {
            extracted_path: Self::normalize_emitted_path_string(&target.to_string_lossy()),
        })
    }
}

/// File name a `--select` pattern matches a weave entry against: the base name
/// of its `path` (or `url` when it is a URL-only entry).
fn entry_basename(path: Option<&str>, url: Option<&str>) -> String {
    let raw = path.or(url).map(str::trim).unwrap_or_default();
    raw.rsplit(['/', '\\']).next().unwrap_or(raw).to_owned()
}
