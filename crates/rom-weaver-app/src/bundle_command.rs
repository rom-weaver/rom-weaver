use super::bundle_load::LoadedBundleSource;
use super::bundle_parse::parse_bundle_bytes;
use super::*;

/// How the bundle source was packaged.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript-types", ts(rename_all = "kebab-case"))]
pub enum BundleSourceKind {
    Json,
    CompressedJson,
    Archive,
}

/// Where a bundle entry's bytes come from, as resolved by `bundle parse`:
/// a download URL (returned verbatim - the caller resolves relative URLs
/// against the bundle's own location), an archive member already extracted
/// to disk, or a still-relative path the caller resolves itself.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(untagged)]
pub enum BundleSourceRef {
    Url { url: String },
    ExtractedPath { extracted_path: String },
    Path { path: String },
}

/// Resolution for one patch entry, index-aligned with `bundle.patches`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct BundlePatchSource {
    pub source: BundleSourceRef,
    /// Ingest-grade descriptor for entries extracted from the bundle
    /// archive (spares the host a second describe round-trip). `None` for
    /// URL / unresolved-path entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub descriptor: Option<PatchDescriptor>,
}

/// The consolidated result of one `bundle parse` command, returned under
/// `details.bundle`. Same envelope pattern as `details.ingest`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct BundleParseResult {
    /// The validated bundle, checksum values normalized.
    pub bundle: RomWeaverBundle,
    pub source_kind: BundleSourceKind,
    /// Entry name of the bundle member when the source was an archive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub archive_member: Option<String>,
    /// Resolved ROM source; `None` when the bundle defines no ROM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub rom_source: Option<BundleSourceRef>,
    /// Index-aligned with `bundle.patches`.
    pub patch_sources: Vec<BundlePatchSource>,
    /// Non-fatal issues (ignored members, extra bundles, …).
    pub warnings: Vec<String>,
}

impl CliApp {
    pub(super) fn run_bundle_parse(&self, args: BundleParseCommand) -> AppRunOutcome {
        trace!(
            source = %args.input.display(),
            extract_dir = ?args.output,
            select = args.select.len(),
            no_extract = args.no_extract,
            threads = %args.threads,
            "starting bundle parse command"
        );
        let context = self.context(args.threads);
        let thread_execution = context.single_thread_execution();
        let report = match self.bundle_parse_inner(&args, &context) {
            Ok(result) => {
                let label = format!(
                    "parsed bundle `{}` ({} patch entr{})",
                    args.input.display(),
                    result.bundle.patches.len(),
                    if result.bundle.patches.len() == 1 {
                        "y"
                    } else {
                        "ies"
                    }
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
                    Ok(value) => {
                        report.details = Some(json!({ "bundle": value }));
                        report
                    }
                    Err(error) => OperationReport::failed(
                        OperationFamily::Command,
                        Some("bundle-parse".to_string()),
                        "bundle-parse",
                        format!("failed to serialize bundle parse result: {error}"),
                        thread_execution,
                    ),
                }
            }
            Err(error) => OperationReport::failed(
                OperationFamily::Command,
                Some("bundle-parse".to_string()),
                "bundle-parse",
                error.to_string(),
                thread_execution,
            ),
        };
        self.finish("bundle-parse", report)
    }

    pub(super) fn run_bundle_schema(&self) -> AppRunOutcome {
        let context = self.context(ThreadBudget::default());
        let thread_execution = context.single_thread_execution();
        let mut report = OperationReport::succeeded(
            OperationFamily::Command,
            Some("bundle-schema".to_string()),
            "bundle-schema",
            "rom-weaver-bundle.json schema".to_string(),
            Some(100.0),
            thread_execution,
        );
        // The CLI prints the raw schema to stdout; the details carry it for the
        // wasm/JSON path.
        report.details = Some(json!({ "schema": BUNDLE_JSON_SCHEMA }));
        self.finish("bundle-schema", report)
    }

    fn bundle_parse_inner(
        &self,
        args: &BundleParseCommand,
        context: &OperationContext,
    ) -> Result<BundleParseResult> {
        let source = args.input.as_path();
        if !source.exists() {
            return Err(RomWeaverError::Validation(format!(
                "input path does not exist: `{}`",
                source.display()
            )));
        }
        let loaded = self.load_bundle_source(source)?;
        let bundle = parse_bundle_bytes(&loaded.bytes)?;
        // Extraction targeting (mirrors extract/checksum): --no-extract
        // suppresses all extraction, --filter limits it to the rom/patch
        // class, --select limits it to matching file names. Entries that are
        // not extracted still appear in the result (as unresolved paths / urls)
        // so patch_sources stays index-aligned with bundle.patches.
        let extract_dir = if args.no_extract {
            None
        } else {
            args.output.as_deref()
        };
        let rom_extractable = args.filter.is_empty() || args.rom_filter();
        let patch_extractable = args.filter.is_empty() || args.patch_filter();
        let mut selector = SelectionMatcher::new(&args.select);
        // A sourceless (checks-only) rom entry resolves to no source at all:
        // the applying user supplies the ROM.
        let rom_source = match &bundle.rom {
            Some(rom) if rom.url.is_some() || rom.path.is_some() => {
                let name = entry_basename(rom.path.as_deref(), rom.url.as_deref());
                let entry_extract_dir = (rom_extractable && selector.matches(&name))
                    .then_some(extract_dir)
                    .flatten();
                Some(self.resolve_bundle_entry_source(
                    rom.url.as_deref(),
                    rom.path.as_deref(),
                    source,
                    &loaded,
                    entry_extract_dir,
                    "rom",
                )?)
            }
            _ => None,
        };
        let mut patch_sources = Vec::with_capacity(bundle.patches.len());
        for (index, patch) in bundle.patches.iter().enumerate() {
            let entry_label = format!("patches[{index}]");
            let name = entry_basename(patch.path.as_deref(), patch.url.as_deref());
            let entry_extract_dir = (patch_extractable && selector.matches(&name))
                .then_some(extract_dir)
                .flatten();
            let source_ref = self.resolve_bundle_entry_source(
                patch.url.as_deref(),
                patch.path.as_deref(),
                source,
                &loaded,
                entry_extract_dir,
                &entry_label,
            )?;
            let descriptor = match &source_ref {
                BundleSourceRef::ExtractedPath { extracted_path } => {
                    Some(self.build_patch_descriptor(Path::new(extracted_path), None, context)?)
                }
                _ => None,
            };
            patch_sources.push(BundlePatchSource {
                source: source_ref,
                descriptor,
            });
        }
        Ok(BundleParseResult {
            bundle,
            source_kind: loaded.kind,
            archive_member: loaded.archive_member,
            rom_source,
            patch_sources,
            warnings: loaded.warnings,
        })
    }

    /// Resolve one bundle entry source. URL entries pass through verbatim.
    /// `path` entries resolve against the bundle's packaging: extracted from
    /// the archive when the source is one and `extract_dir` was supplied,
    /// passed through as a relative path otherwise (the caller resolves it
    /// against the bundle's own location).
    fn resolve_bundle_entry_source(
        &self,
        url: Option<&str>,
        path: Option<&str>,
        source: &Path,
        loaded: &LoadedBundleSource,
        extract_dir: Option<&Path>,
        entry_label: &str,
    ) -> Result<BundleSourceRef> {
        if let Some(url) = url.map(str::trim).filter(|value| !value.is_empty()) {
            return Ok(BundleSourceRef::Url {
                url: url.to_owned(),
            });
        }
        // Parse validation guarantees exactly one of url/path is set.
        let path = path.map(str::trim).unwrap_or_default();
        if loaded.kind != BundleSourceKind::Archive {
            return Ok(BundleSourceRef::Path {
                path: path.to_owned(),
            });
        }
        let Some(entry) = Self::find_bundle_archive_entry(&loaded.archive_entries, path) else {
            return Err(RomWeaverError::ValidationCode(
                rom_weaver_core::ValidationCodeError::new("bundle.path.unresolved")
                    .with_message("bundle path entry matches no archive member")
                    .with_field("entry", entry_label.to_owned())
                    .with_field("path", path.to_owned()),
            ));
        };
        let Some(extract_dir) = extract_dir else {
            return Ok(BundleSourceRef::Path {
                path: path.to_owned(),
            });
        };
        let format_name = loaded
            .archive_format
            .expect("archive kind always carries a format name");
        let target = Self::extract_bundle_archive_member(source, format_name, entry, extract_dir)?;
        Ok(BundleSourceRef::ExtractedPath {
            extracted_path: Self::normalize_emitted_path_string(&target.to_string_lossy()),
        })
    }
}

/// File name a `--select` pattern matches a bundle entry against: the base name
/// of its `path` (or `url` when it is a URL-only entry).
fn entry_basename(path: Option<&str>, url: Option<&str>) -> String {
    let raw = path.or(url).map(str::trim).unwrap_or_default();
    raw.rsplit(['/', '\\']).next().unwrap_or(raw).to_owned()
}
