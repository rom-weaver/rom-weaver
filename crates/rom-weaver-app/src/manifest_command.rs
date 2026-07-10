use super::manifest_load::LoadedManifestSource;
use super::manifest_parse::parse_manifest_bytes;
use super::*;

/// How the manifest source was packaged.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript-types", ts(rename_all = "kebab-case"))]
pub enum ManifestSourceKind {
    Json,
    CompressedJson,
    Archive,
}

/// Where a manifest entry's bytes come from, as resolved by `manifest parse`:
/// a download URL (returned verbatim — the caller resolves relative URLs
/// against the manifest's own location), an archive member already extracted
/// to disk, or a still-relative path the caller resolves itself.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(untagged)]
pub enum ManifestSourceRef {
    Url { url: String },
    ExtractedPath { extracted_path: String },
    Path { path: String },
}

/// Resolution for one patch entry, index-aligned with `manifest.patches`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ManifestPatchSource {
    pub source: ManifestSourceRef,
    /// Ingest-grade descriptor for entries extracted from the manifest
    /// archive (spares the host a second describe round-trip). `None` for
    /// URL / unresolved-path entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub descriptor: Option<PatchDescriptor>,
}

/// The consolidated result of one `manifest parse` command, returned under
/// `details.manifest`. Same envelope pattern as `details.ingest`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ManifestParseResult {
    /// The validated manifest, checksum values normalized.
    pub manifest: RomWeaverManifest,
    pub source_kind: ManifestSourceKind,
    /// Entry name of the manifest member when the source was an archive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub archive_member: Option<String>,
    /// Resolved ROM source; `None` when the manifest defines no ROM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub rom_source: Option<ManifestSourceRef>,
    /// Index-aligned with `manifest.patches`.
    pub patch_sources: Vec<ManifestPatchSource>,
    /// Non-fatal issues (ignored members, extra manifests, …).
    pub warnings: Vec<String>,
}

impl CliApp {
    pub(super) fn run_manifest_parse(&self, args: ManifestParseCommand) -> AppRunOutcome {
        trace!(
            source = %args.source.display(),
            extract_dir = ?args.extract_dir,
            threads = %args.threads,
            "starting manifest parse command"
        );
        let ManifestParseCommand {
            source,
            extract_dir,
            threads,
        } = args;
        let context = self.context(threads);
        let thread_execution = context.single_thread_execution();
        let report = match self.manifest_parse_inner(&source, extract_dir.as_deref(), &context) {
            Ok(result) => {
                let label = format!(
                    "parsed manifest `{}` ({} patch entr{})",
                    source.display(),
                    result.manifest.patches.len(),
                    if result.manifest.patches.len() == 1 {
                        "y"
                    } else {
                        "ies"
                    }
                );
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("manifest-parse".to_string()),
                    "manifest-parse",
                    label,
                    Some(100.0),
                    thread_execution.clone(),
                );
                match serde_json::to_value(&result) {
                    Ok(value) => {
                        report.details = Some(json!({ "manifest": value }));
                        report
                    }
                    Err(error) => OperationReport::failed(
                        OperationFamily::Command,
                        Some("manifest-parse".to_string()),
                        "manifest-parse",
                        format!("failed to serialize manifest parse result: {error}"),
                        thread_execution,
                    ),
                }
            }
            Err(error) => OperationReport::failed(
                OperationFamily::Command,
                Some("manifest-parse".to_string()),
                "manifest-parse",
                error.to_string(),
                thread_execution,
            ),
        };
        self.finish("manifest-parse", report)
    }

    fn manifest_parse_inner(
        &self,
        source: &Path,
        extract_dir: Option<&Path>,
        context: &OperationContext,
    ) -> Result<ManifestParseResult> {
        if !source.exists() {
            return Err(RomWeaverError::Validation(format!(
                "input path does not exist: `{}`",
                source.display()
            )));
        }
        let loaded = self.load_manifest_source(source)?;
        let manifest = parse_manifest_bytes(&loaded.bytes)?;
        // A sourceless (checks-only) rom entry resolves to no source at all:
        // the applying user supplies the ROM.
        let rom_source = match &manifest.rom {
            Some(rom) if rom.url.is_some() || rom.path.is_some() => {
                Some(self.resolve_manifest_entry_source(
                    rom.url.as_deref(),
                    rom.path.as_deref(),
                    source,
                    &loaded,
                    extract_dir,
                    "rom",
                )?)
            }
            _ => None,
        };
        let mut patch_sources = Vec::with_capacity(manifest.patches.len());
        for (index, patch) in manifest.patches.iter().enumerate() {
            let entry_label = format!("patches[{index}]");
            let source_ref = self.resolve_manifest_entry_source(
                patch.url.as_deref(),
                patch.path.as_deref(),
                source,
                &loaded,
                extract_dir,
                &entry_label,
            )?;
            let descriptor = match &source_ref {
                ManifestSourceRef::ExtractedPath { extracted_path } => {
                    Some(self.build_patch_descriptor(Path::new(extracted_path), None, context)?)
                }
                _ => None,
            };
            patch_sources.push(ManifestPatchSource {
                source: source_ref,
                descriptor,
            });
        }
        Ok(ManifestParseResult {
            manifest,
            source_kind: loaded.kind,
            archive_member: loaded.archive_member,
            rom_source,
            patch_sources,
            warnings: loaded.warnings,
        })
    }

    /// Resolve one manifest entry source. URL entries pass through verbatim.
    /// `path` entries resolve against the manifest's packaging: extracted from
    /// the archive when the source is one and `extract_dir` was supplied,
    /// passed through as a relative path otherwise (the caller resolves it
    /// against the manifest's own location).
    fn resolve_manifest_entry_source(
        &self,
        url: Option<&str>,
        path: Option<&str>,
        source: &Path,
        loaded: &LoadedManifestSource,
        extract_dir: Option<&Path>,
        entry_label: &str,
    ) -> Result<ManifestSourceRef> {
        if let Some(url) = url.map(str::trim).filter(|value| !value.is_empty()) {
            return Ok(ManifestSourceRef::Url {
                url: url.to_owned(),
            });
        }
        // Parse validation guarantees exactly one of url/path is set.
        let path = path.map(str::trim).unwrap_or_default();
        if loaded.kind != ManifestSourceKind::Archive {
            return Ok(ManifestSourceRef::Path {
                path: path.to_owned(),
            });
        }
        let Some(entry) = Self::find_manifest_archive_entry(&loaded.archive_entries, path) else {
            return Err(RomWeaverError::ValidationCode(
                rom_weaver_core::ValidationCodeError::new("manifest.path.unresolved")
                    .with_message("manifest path entry matches no archive member")
                    .with_field("entry", entry_label.to_owned())
                    .with_field("path", path.to_owned()),
            ));
        };
        let Some(extract_dir) = extract_dir else {
            return Ok(ManifestSourceRef::Path {
                path: path.to_owned(),
            });
        };
        let format_name = loaded
            .archive_format
            .expect("archive kind always carries a format name");
        let target =
            Self::extract_manifest_archive_member(source, format_name, entry, extract_dir)?;
        Ok(ManifestSourceRef::ExtractedPath {
            extracted_path: Self::normalize_emitted_path_string(&target.to_string_lossy()),
        })
    }
}
