use super::selection_resolution::{SelectionExtract, SelectionResolutionOptions};
use super::*;

/// Which input bucket the dropped source classified into. `rom` sources still carry their ROM
/// `assets`; a `rom` source that *also* bundled sidecar patches additionally carries them in
/// `patches` (mixed ROM+patch archive surfacing). `patch` sources carry only `patches`.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript-types", ts(rename_all = "snake_case"))]
pub enum IngestKind {
    Rom,
    Patch,
}

/// The consolidated result of one `ingest` command, returned under `details.ingest`. One wasm call
/// per dropped source replaces the webapp's separate classify → nested-extract → checksum (ROM) and
/// classify → describe (patch) round-trips. Rides the standard `OperationReport.details` envelope so
/// the existing terminal-event parse layer keeps working, while staying a compile-checked Rust⇄TS
/// shape via `#[derive(TS)]`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IngestResult {
    /// Primary bucket the host routes the source into.
    pub kind: IngestKind,
    /// File name of the dropped source (no directory).
    pub source_file_name: String,
    /// Mirrors the probe-manifest routing signal (`has_rom || !has_patch`); `true` for `kind: rom`.
    pub is_rom: bool,
    /// ROM leaves (checksummed, with variants + platform identity). Empty for a pure patch source.
    pub assets: Vec<IngestRomAsset>,
    /// Patch descriptors. Non-empty for a patch source, and for a ROM source that also bundled
    /// sidecar patches.
    pub patches: Vec<PatchDescriptor>,
}

/// One checksummed ROM payload the ingest produced: a bare ROM checksummed in place, or an
/// archive/codec leaf extracted to `out_dir`. Carries the same checksum/variant/identity shape the
/// `checksum` command emits, plus disc-group structure for multi-track discs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IngestRomAsset {
    /// Absolute path of the asset (forward-slash normalized). For a bare ROM this is the source
    /// itself (checksummed in place, never copied); for an extracted leaf it is the `out_dir` output.
    pub path: String,
    /// File name component of `path`.
    pub file_name: String,
    /// Size of the asset in bytes. Emitted as a JSON `number` on the wasm wire,
    /// so override the default ts-rs `bigint` mapping to `number`.
    #[cfg_attr(feature = "typescript-types", ts(type = "number"))]
    pub size_bytes: u64,
    /// Coarse kind (`rom`/`bin`/`cue`/…) when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub kind: Option<String>,
    /// The `raw` variant's checksums keyed by algorithm.
    pub checksums: BTreeMap<String, String>,
    /// Every applicable checksum variant (raw, remove-header, fix-header, byte-order), as the
    /// `checksum` command's `checksum_variants` rows.
    pub checksum_variants: Vec<Value>,
    /// Console/platform identity from the decoded prefix, when detected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub platform: Option<String>,
    /// Optical medium (CD/GD-ROM/DVD) for disc images, when detected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub disc_format: Option<String>,
    /// Disc-group id shared by a `.cue`/`.gdi` sheet and its tracks (multi-track disc grouping).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub disc_group_id: Option<String>,
    /// 1-based track number for a disc track asset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub track_number: Option<u32>,
    /// Full `.cue` text for a cue-sheet asset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub cue_text: Option<String>,
    /// Full `.gdi` text for a gdi-sheet asset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub gdi_text: Option<String>,
    /// Wall-clock milliseconds the extract step that produced this leaf took. Carried only for
    /// nested leaves (the archive level that emitted them); a depth-0 / single-level leaf leaves
    /// this `None` and the host falls back to the run-level timing — matching the `extract`
    /// command's per-file timing semantics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub extract_time_ms: Option<u32>,
    /// `true` when this was a bare ROM checksummed in place (no extraction, no OPFS copy).
    pub copied_in_place: bool,
    /// Wall-clock milliseconds spent hashing a bare ROM in place (the checksum compute itself,
    /// excluding wasm/host setup). Set only for `copied_in_place` assets; an extracted leaf folds its
    /// hashing into the extract timing instead. Lets the host show a real checksum duration rather than
    /// the "from extract" sentinel an extracted leaf uses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub checksum_ms: Option<u32>,
}

/// A consolidated patch descriptor: format + embedded source/target metadata (where the format
/// carries it) + checksum/size requirements parsed from the file name + libretro sidecar order.
/// Aggregates what the webapp previously assembled across several TS modules.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PatchDescriptor {
    /// Absolute path of the patch (forward-slash normalized) — the bare source or an extracted leaf.
    pub leaf_path: String,
    /// File name component of `leaf_path`.
    pub file_name: String,
    /// Size of the patch file in bytes (the bare source or extracted leaf).
    /// Emitted as a JSON `number` on the wasm wire, so override the default
    /// ts-rs `bigint` mapping to `number`.
    #[cfg_attr(feature = "typescript-types", ts(type = "number"))]
    pub size_bytes: u64,
    /// Patch format name (handler descriptor, else the file extension when unsupported).
    pub format: String,
    /// CRC32 of the patch file itself (byuu formats).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub patch_crc32: Option<u32>,
    /// Embedded expected source size in bytes (byuu formats). Emitted as a JSON
    /// `number` on the wasm wire, so override the default ts-rs `bigint` mapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, type = "number | null"))]
    pub source_size: Option<u64>,
    /// Embedded produced target size in bytes (byuu + xdelta). Emitted as a JSON
    /// `number` on the wasm wire, so override the default ts-rs `bigint` mapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, type = "number | null"))]
    pub target_size: Option<u64>,
    /// Embedded expected source CRC32 (byuu formats).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub source_crc32: Option<u32>,
    /// Embedded produced target CRC32 (byuu formats).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub target_crc32: Option<u32>,
    /// Embedded minimum required source size (xdelta). Emitted as a JSON
    /// `number` on the wasm wire, so override the default ts-rs `bigint` mapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, type = "number | null"))]
    pub minimum_source_size: Option<u64>,
    /// Record/window/command count when the format reports one. Emitted as a JSON
    /// `number` on the wasm wire, so override the default ts-rs `bigint` mapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, type = "number | null"))]
    pub record_count: Option<u64>,
    /// Expected input checksums parsed from the file name, keyed by algorithm.
    pub filename_checksums: BTreeMap<String, String>,
    /// Expected exact input size parsed from the file name. Emitted as a JSON
    /// `number` on the wasm wire, so override the default ts-rs `bigint` mapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, type = "number | null"))]
    pub filename_size: Option<u64>,
    /// Libretro sidecar apply order, set only when matched against a known ROM in the same source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub sidecar_order: Option<u32>,
    /// `true` when a registered patch handler recognized the leaf's format and parsed it (valid patch
    /// magic). The host trusts this instead of re-extracting + re-reading the magic. `false` for an
    /// unsupported extension or a recognized-but-unparseable file (bad/truncated magic).
    pub is_valid_patch: bool,
}

/// Internal carrier of the classified branch result before it is wrapped into a report.
struct IngestOutcome {
    kind: IngestKind,
    is_rom: bool,
    assets: Vec<IngestRomAsset>,
    patches: Vec<PatchDescriptor>,
}

const INGEST_DEFAULT_CHECKSUM_ALGORITHMS: [&str; 3] = ["crc32", "md5", "sha1"];

impl CliApp {
    pub(super) fn run_ingest(&self, args: IngestCommand) -> AppRunOutcome {
        trace!(
            source = %args.source.display(),
            out_dir = %args.out_dir.display(),
            selections = args.select.len(),
            no_ignore = args.no_ignore,
            no_nested_extract = args.no_nested_extract,
            checksum_algorithms = args.checksum.len(),
            threads = %args.threads,
            "starting ingest command"
        );
        let IngestCommand {
            source,
            out_dir,
            select,
            no_ignore,
            no_nested_extract,
            split_bin,
            checksum,
            threads,
        } = args;
        let algorithms: Vec<String> = if checksum.is_empty() {
            INGEST_DEFAULT_CHECKSUM_ALGORITHMS
                .iter()
                .map(|algorithm| (*algorithm).to_string())
                .collect()
        } else {
            checksum
                .iter()
                .map(|algorithm| algorithm.to_ascii_lowercase())
                .collect()
        };
        // Hash ROM leaves INLINE during extraction with the shared variant engine (rom-only, so patch
        // leaves and disc sheets are not hashed), so a fully-extracted ROM leaf carries its checksums +
        // variants + identity in a single decode pass. `ingest_rom_leaves` reuses those; whatever the
        // inline pass skipped (sheets, or a handler with no known output length) still falls back to a
        // single checksum read — never the two reads (decode-write then re-hash) this used to do.
        let context = self
            .context(threads)
            .with_extract_checksum_algorithms(algorithms.clone())
            .with_extract_checksum_rom_only(true);
        let thread_execution = context.single_thread_execution();
        if let Some(invalid) = algorithms.iter().find(|algorithm| {
            !supported_algorithms()
                .iter()
                .any(|supported| supported.eq_ignore_ascii_case(algorithm))
        }) {
            return self.finish(
                "ingest",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("ingest".to_string()),
                    "validate",
                    format!("unsupported checksum algorithm `{invalid}`"),
                    thread_execution,
                ),
            );
        }

        let report = match self.run_ingest_inner(
            &source,
            &out_dir,
            select,
            no_ignore,
            no_nested_extract,
            split_bin,
            &algorithms,
            &context,
        ) {
            Ok(outcome) => self.ingest_success_report(&source, outcome, thread_execution.clone()),
            Err(error) => OperationReport::failed(
                OperationFamily::Command,
                Some("ingest".to_string()),
                "ingest",
                error.to_string(),
                thread_execution,
            ),
        };
        self.finish("ingest", report)
    }

    #[allow(clippy::too_many_arguments)]
    fn run_ingest_inner(
        &self,
        source: &Path,
        out_dir: &Path,
        raw_selections: Vec<String>,
        no_ignore: bool,
        no_nested_extract: bool,
        split_bin: Option<bool>,
        algorithms: &[String],
        context: &OperationContext,
    ) -> Result<IngestOutcome> {
        if !source.exists() {
            return Err(RomWeaverError::Validation(format!(
                "input path does not exist: `{}`",
                source.display()
            )));
        }
        self.emit_running(
            OperationLabel {
                command: "ingest",
                family: OperationFamily::Command,
                format: None,
            },
            "ingest",
            format!("ingesting `{}`", source.display()),
            Some(0.0),
            context.single_thread_execution(),
        );

        // A container handler matching means the source is an archive or disc-image codec: classify
        // its entries and extract. No handler means a bare file (cartridge ROM or loose patch) that
        // is classified by name and checksummed in place / described directly.
        if let Some(handler) = self.containers.probe(source) {
            return self.ingest_container(
                handler.as_ref(),
                source,
                out_dir,
                raw_selections,
                no_ignore,
                no_nested_extract,
                split_bin,
                algorithms,
                context,
            );
        }
        self.ingest_bare_source(source, algorithms, context)
    }

    #[allow(clippy::too_many_arguments)]
    fn ingest_container(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        out_dir: &Path,
        raw_selections: Vec<String>,
        no_ignore: bool,
        no_nested_extract: bool,
        split_bin: Option<bool>,
        algorithms: &[String],
        context: &OperationContext,
    ) -> Result<IngestOutcome> {
        // Stream the early identity/type manifest so the host can route the drop and render its card
        // immediately, exactly as `extract` does (best-effort, streaming-only).
        self.emit_probe_manifest(handler, source, false, !no_ignore, context);
        let entries = handler.list_entry_records(
            &ContainerProbeRequest {
                source: source.to_path_buf(),
                split_bin: false,
            },
            context,
        )?;
        let (is_rom, _summaries, _has_rom, has_patch) =
            Self::classify_container_entries(&entries, !no_ignore);
        trace!(
            source = %source.display(),
            format = handler.descriptor().name,
            is_rom,
            has_patch,
            entry_count = entries.len(),
            "classified ingest container"
        );

        if !is_rom {
            // Patch-only bundle: describe every patch leaf, no ROM checksumming. An explicit `--select`
            // still pins specific leaves; interactive resolution stays driven by the global flag.
            let patches = self.ingest_patch_leaves(
                handler,
                source,
                out_dir,
                &raw_selections,
                no_ignore,
                no_nested_extract,
                true,
                None,
                context,
            )?;
            return Ok(IngestOutcome {
                kind: IngestKind::Patch,
                is_rom,
                assets: Vec::new(),
                patches,
            });
        }

        // Resolve split-bin only for the ROM branch: explicit arg wins; otherwise a multi-track CD
        // CHD prompts the host (per-track vs single BIN), defaulting to per-track split when the host
        // cannot be asked (matches the prior auto-split behavior).
        let resolved_split_bin =
            self.resolve_ingest_split_bin(handler, source, split_bin, context)?;
        let assets = match self.ingest_rom_leaves(
            handler,
            source,
            out_dir,
            &raw_selections,
            no_ignore,
            no_nested_extract,
            resolved_split_bin,
            algorithms,
            context,
        ) {
            Ok(assets) => assets,
            Err(rom_error) => {
                // `classify_container_entries` only inspects TOP-LEVEL names, so an archive whose only
                // entries are nested containers carries no patch names and defaults to `is_rom = true`.
                // When the patches actually live a level down, the rom-filtered descent finds no ROM and
                // errors. Re-ingest as patches before surfacing that error: a bundle that is patches all
                // the way down routes as a patch source; anything else keeps the original ROM failure.
                let patches = self
                    .ingest_patch_leaves(
                        handler,
                        source,
                        out_dir,
                        &raw_selections,
                        no_ignore,
                        no_nested_extract,
                        true,
                        None,
                        context,
                    )
                    .unwrap_or_default();
                if patches.is_empty() {
                    return Err(rom_error);
                }
                trace!(
                    source = %source.display(),
                    patch_count = patches.len(),
                    "ingest ROM branch found no ROM; re-routed nested bundle as patch source"
                );
                return Ok(IngestOutcome {
                    kind: IngestKind::Patch,
                    is_rom: false,
                    assets: Vec::new(),
                    patches,
                });
            }
        };
        // A mixed archive (ROM + sidecar patches) surfaces both so the host can offer applying the
        // bundled patches without losing the ROM checksum. The sidecar patches are enumerated
        // independently of the ROM keep-one `select` (a chosen ROM must not hide the bundle's patches)
        // and never prompt — every patch leaf is returned so the host drives the patch choice.
        let patches = if has_patch {
            let rom_hint = assets.first().map(|asset| asset.file_name.clone());
            self.ingest_patch_leaves(
                handler,
                source,
                out_dir,
                &[],
                no_ignore,
                no_nested_extract,
                false,
                rom_hint.as_deref(),
                context,
            )?
        } else {
            Vec::new()
        };
        Ok(IngestOutcome {
            kind: IngestKind::Rom,
            is_rom,
            assets,
            patches,
        })
    }

    fn ingest_bare_source(
        &self,
        source: &Path,
        algorithms: &[String],
        context: &OperationContext,
    ) -> Result<IngestOutcome> {
        if is_patch_filter_candidate_name(&source.to_string_lossy()) {
            let descriptor = self.build_patch_descriptor(source, None, context)?;
            return Ok(IngestOutcome {
                kind: IngestKind::Patch,
                is_rom: false,
                assets: Vec::new(),
                patches: vec![descriptor],
            });
        }
        // Bare ROM: checksum the source bytes in a single pass — no extraction, no copy.
        let canonical = fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
        let file_name = canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let asset = IngestRomAsset {
            path: Self::normalize_emitted_path_string(&canonical.to_string_lossy()),
            file_name,
            size_bytes: fs::metadata(source)?.len(),
            kind: Self::infer_emitted_file_kind(&canonical).map(str::to_string),
            checksums: BTreeMap::new(),
            checksum_variants: Vec::new(),
            platform: None,
            disc_format: None,
            disc_group_id: None,
            track_number: None,
            cue_text: None,
            gdi_text: None,
            extract_time_ms: None,
            copied_in_place: true,
            checksum_ms: None,
        };
        let asset = self.fill_asset_checksums(asset, source, algorithms, context)?;
        Ok(IngestOutcome {
            kind: IngestKind::Rom,
            is_rom: true,
            assets: vec![asset],
            patches: Vec::new(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn ingest_rom_leaves(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        out_dir: &Path,
        raw_selections: &[String],
        no_ignore: bool,
        no_nested_extract: bool,
        split_bin: bool,
        algorithms: &[String],
        context: &OperationContext,
    ) -> Result<Vec<IngestRomAsset>> {
        let kind_filter = Self::archive_entry_kind_filter(true, false);
        let leaves = self.ingest_extract_leaves(
            handler,
            source,
            out_dir,
            raw_selections,
            kind_filter,
            no_ignore,
            no_nested_extract,
            split_bin,
            true,
            "ingest input",
            context,
        )?;
        let mut assets = Vec::with_capacity(leaves.len());
        for leaf in &leaves {
            let Some(map) = leaf.as_object() else {
                continue;
            };
            let Some(path) = map.get("path").and_then(Value::as_str) else {
                continue;
            };
            let mut asset = IngestRomAsset {
                path: path.to_string(),
                file_name: map
                    .get("file_name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                size_bytes: map.get("size_bytes").and_then(Value::as_u64).unwrap_or(0),
                kind: map.get("kind").and_then(Value::as_str).map(str::to_string),
                checksums: BTreeMap::new(),
                checksum_variants: Vec::new(),
                platform: map
                    .get("platform")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                disc_format: map
                    .get("disc_format")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                disc_group_id: map
                    .get("disc_group_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                track_number: map
                    .get("track_number")
                    .and_then(Value::as_u64)
                    .map(|value| value as u32),
                cue_text: map
                    .get("cue_text")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                gdi_text: map
                    .get("gdi_text")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                extract_time_ms: map
                    .get("extract_time_ms")
                    .and_then(Value::as_u64)
                    .map(|value| value as u32),
                copied_in_place: false,
                checksum_ms: None,
            };
            // Reuse the checksums the extract already streamed for this leaf instead of re-reading it.
            // libarchive emits the full variant set (`checksum_variants`); the disc-image codecs
            // (CHD/RVZ) emit only the raw `checksums`, so synthesize the single "raw" variant row the
            // `checksum` command produces for a disc — no header transforms apply to disc data, so that
            // row is byte-identical to a re-read.
            let inline_variants = map
                .get("checksum_variants")
                .and_then(Value::as_array)
                .filter(|rows| !rows.is_empty());
            let inline_checksums = map
                .get("checksums")
                .and_then(|value| {
                    serde_json::from_value::<BTreeMap<String, String>>(value.clone()).ok()
                })
                .filter(|checksums| !checksums.is_empty());
            let asset = if let Some(checksums) = inline_checksums {
                asset.checksum_variants = match inline_variants {
                    Some(variants) => variants.clone(),
                    None => vec![json!({
                        "id": "raw",
                        "label": "Raw",
                        "checksums": checksums.clone(),
                        "applyCompatibility": {},
                        "transforms": {},
                    })],
                };
                asset.checksums = checksums;
                asset
            } else if Self::is_disc_sheet_file_name(&asset.file_name) {
                // A `.cue`/`.gdi` sheet is a text sidecar, not ROM data — never hashed (the rom-only
                // extract and the webapp both skip sheets). Leaving it unhashed avoids re-reading it, so
                // a disc extract (track reused inline + sheet skipped) does NO post-extract checksum pass.
                asset
            } else {
                self.fill_asset_checksums(asset, Path::new(path), algorithms, context)?
            };
            assets.push(asset);
        }
        Ok(assets)
    }

    #[allow(clippy::too_many_arguments)]
    fn ingest_patch_leaves(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        out_dir: &Path,
        raw_selections: &[String],
        no_ignore: bool,
        no_nested_extract: bool,
        interactive: bool,
        rom_hint: Option<&str>,
        context: &OperationContext,
    ) -> Result<Vec<PatchDescriptor>> {
        let kind_filter = Self::archive_entry_kind_filter(false, true);
        let leaves = self.ingest_extract_leaves(
            handler,
            source,
            out_dir,
            raw_selections,
            kind_filter,
            no_ignore,
            no_nested_extract,
            false,
            interactive,
            "ingest patch input",
            context,
        )?;
        let mut patches = Vec::new();
        for leaf in &leaves {
            let Some(path) = leaf
                .as_object()
                .and_then(|map| map.get("path"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let leaf_path = Path::new(path);
            if !is_patch_filter_candidate_name(path) {
                continue;
            }
            patches.push(self.build_patch_descriptor(leaf_path, rom_hint, context)?);
        }
        Ok(patches)
    }

    /// Extract `source` (and any nested containers) to `out_dir`, returning the bottom/leaf
    /// `emitted_files` detail objects. Shares the exact selection-resolution and nested-leaf
    /// assembly the `extract` command uses.
    #[allow(clippy::too_many_arguments)]
    fn ingest_extract_leaves(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        out_dir: &Path,
        raw_selections: &[String],
        kind_filter: ArchiveEntryKindFilter,
        no_ignore: bool,
        no_nested_extract: bool,
        split_bin: bool,
        interactive: bool,
        source_label: &'static str,
        context: &OperationContext,
    ) -> Result<Vec<Value>> {
        // The sidecar-patch sub-pass runs non-interactively: empty `raw_selections` then extract every
        // patch leaf rather than resolving/prompting a payload choice. The ROM pass keeps interactive
        // resolution (keep-one disambiguation).
        let selections = if interactive {
            self.resolved_extract_selections(
                handler,
                source,
                raw_selections.to_vec(),
                SelectionResolutionOptions {
                    kind_filter,
                    split_bin,
                    ignore_common_files: !no_ignore,
                    source_label,
                },
                context,
            )?
        } else {
            raw_selections.to_vec()
        };
        self.emit_running(
            OperationLabel {
                command: "ingest",
                family: OperationFamily::Container,
                format: Some(handler.descriptor().name),
            },
            "extract",
            format!("extracting `{}`", source.display()),
            None,
            Some(context.plan_threads(handler.capabilities().extract_threads)),
        );
        let started = std::time::Instant::now();
        let report = self.extract_with_selection_fallback(
            handler,
            source,
            SelectionExtract {
                out_dir,
                selections: &selections,
                kind_filter,
                split_bin,
                ignore_common_files: !no_ignore,
                overwrite: true,
                source_label,
                allow_multi_select: true,
            },
            context,
        )?;
        if report.status != OperationStatus::Succeeded {
            return Err(RomWeaverError::Validation(report.label));
        }
        let elapsed_ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
        let (leaves, _nested_count) = self.assemble_extracted_leaves(
            handler.descriptor().name,
            source,
            out_dir,
            &report,
            elapsed_ms,
            kind_filter,
            !no_ignore,
            true,
            no_nested_extract,
            context,
        )?;
        Ok(leaves)
    }

    /// Resolve whether a CHD CD extracts per-track split BINs. An explicit `requested` value wins.
    /// Otherwise, when the source is a multi-track CD CHD that offers the choice (merged → one BIN,
    /// split → many), prompt the host (single vs per-track); default to per-track split when the host
    /// declines or cannot be asked (matches the prior auto-split behavior). Non-eligible sources
    /// (non-CHD, single-track, GD-ROM, DVD) never split.
    fn resolve_ingest_split_bin(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        requested: Option<bool>,
        context: &OperationContext,
    ) -> Result<bool> {
        if let Some(value) = requested {
            return Ok(value);
        }
        if !handler.descriptor().matches_name("chd") {
            return Ok(false);
        }
        let bin_count = |split_bin: bool| -> usize {
            handler
                .list_entry_records(
                    &ContainerProbeRequest {
                        source: source.to_path_buf(),
                        split_bin,
                    },
                    context,
                )
                .map(|entries| {
                    entries
                        .iter()
                        .filter(|entry| entry.path.to_ascii_lowercase().ends_with(".bin"))
                        .count()
                })
                .unwrap_or(0)
        };
        // Merged-single vs split-many is only a real choice for a uniform multi-track CD.
        if !(bin_count(false) == 1 && bin_count(true) > 1) {
            return Ok(false);
        }
        let candidates = vec![
            PromptCandidate {
                value: "merged".to_string(),
                label: "Single .bin file (one combined track)".to_string(),
                size: None,
            },
            PromptCandidate {
                value: "split".to_string(),
                label: "Split into per-track .bin files".to_string(),
                size: None,
            },
        ];
        let heading = format!(
            "`{}` is a multi-track CD image. How should its tracks be extracted?",
            source.display()
        );
        // Host declined / non-interactive keeps the prior per-track auto-split (only "merged" opts out).
        Ok(self.prompt_for_selection(&heading, &candidates)? != Some(0))
    }

    /// Compute the asset's checksums/variants/identity with the shared streaming variant engine
    /// (the same single-pass engine the `checksum` command uses), filling them into `asset`.
    fn fill_asset_checksums(
        &self,
        mut asset: IngestRomAsset,
        hash_path: &Path,
        algorithms: &[String],
        context: &OperationContext,
    ) -> Result<IngestRomAsset> {
        let request = ChecksumRequest {
            source: hash_path.to_path_buf(),
            algorithms: algorithms.to_vec(),
            start: None,
            length: None,
        };
        let thread_execution =
            Some(context.plan_threads(ThreadCapability::parallel(Some(algorithms.len().max(1)))));
        let file_name = asset.file_name.clone();
        let hash_started = std::time::SystemTime::now();
        let report = self.run_checksum_variants_with_progress(
            &request,
            context,
            "checksum",
            &mut |progress| {
                self.emit_running(
                    OperationLabel {
                        command: "ingest",
                        family: OperationFamily::Checksum,
                        format: Some(self.checksum.name()),
                    },
                    "checksum",
                    format!("checksumming `{file_name}`"),
                    Some(progress.percent()),
                    thread_execution.clone(),
                );
            },
        )?;
        // Record the hashing wall time from Rust so the host shows a real checksum duration (a bare ROM
        // is checksummed in place; an extracted leaf folds this into its extract timing instead).
        asset.checksum_ms = hash_started
            .elapsed()
            .ok()
            .map(|elapsed| elapsed.as_millis().min(u128::from(u32::MAX)) as u32);
        if let Some(details) = report.details.as_ref().and_then(Value::as_object) {
            if let Some(checksums) = details.get("checksums").and_then(|value| {
                serde_json::from_value::<BTreeMap<String, String>>(value.clone()).ok()
            }) {
                asset.checksums = checksums;
            }
            if let Some(variants) = details.get("checksum_variants").and_then(Value::as_array) {
                asset.checksum_variants = variants.clone();
            }
            if asset.platform.is_none() {
                asset.platform = details
                    .get("platform")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            if asset.disc_format.is_none() {
                asset.disc_format = details
                    .get("disc_format")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
        Ok(asset)
    }

    /// Aggregate one patch's consolidated descriptor: format + embedded metadata (`handler.parse`),
    /// file-name requirements (`parse_filename_requirements`), and libretro sidecar order.
    fn build_patch_descriptor(
        &self,
        leaf_path: &Path,
        rom_hint: Option<&str>,
        context: &OperationContext,
    ) -> Result<PatchDescriptor> {
        let canonical = fs::canonicalize(leaf_path).unwrap_or_else(|_| leaf_path.to_path_buf());
        let file_name = canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let requirements = parse_filename_requirements(&file_name);
        let sidecar_order =
            rom_hint.and_then(|rom| Self::entry_matches_libretro_sidecar(rom, &file_name));

        let size_bytes = fs::metadata(&canonical)
            .or_else(|_| fs::metadata(leaf_path))
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let mut descriptor = PatchDescriptor {
            leaf_path: Self::normalize_emitted_path_string(&canonical.to_string_lossy()),
            file_name: file_name.clone(),
            size_bytes,
            format: Self::patch_format_from_extension(&canonical),
            patch_crc32: None,
            source_size: None,
            target_size: None,
            source_crc32: None,
            target_crc32: None,
            minimum_source_size: None,
            record_count: None,
            filename_checksums: requirements.checksums,
            filename_size: requirements.size,
            sidecar_order,
            is_valid_patch: false,
        };

        let Some(handler) = self.patches.probe(leaf_path) else {
            // Unsupported/unknown patch: keep the file-name-derived requirements and the extension
            // format so the host can still surface it; no embedded metadata to read, not a valid patch.
            return Ok(descriptor);
        };
        // A recognized handler that confirms the leaf's metadata confirms the patch magic — the same
        // fact the host re-derived by re-extracting + re-reading the header. `describe_metadata` reads
        // just the embedded requirements (skipping a full structural scan where the format allows) and
        // still rejects a structurally-invalid/truncated file: surface that (with file-name
        // requirements + format) but mark it not a valid patch rather than failing the whole ingest.
        let report = match handler.describe_metadata(leaf_path, context) {
            Ok(report) => {
                descriptor.is_valid_patch = true;
                Self::attach_patch_probe_details(report)
            }
            Err(error) => {
                trace!(
                    leaf = %leaf_path.display(),
                    %error,
                    "patch leaf recognized by handler but failed to describe; marking invalid"
                );
                return Ok(descriptor);
            }
        };
        if let Some(patch) = report
            .details
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|map| map.get("patch"))
            .and_then(Value::as_object)
        {
            if let Some(format) = patch.get("format").and_then(Value::as_str) {
                descriptor.format = format.to_string();
            } else if let Some(format) = report.format.clone() {
                descriptor.format = format;
            }
            descriptor.patch_crc32 = patch.get("patch_crc32").and_then(Self::json_u32);
            descriptor.source_size = patch.get("source_size").and_then(Value::as_u64);
            descriptor.target_size = patch.get("target_size").and_then(Value::as_u64);
            descriptor.source_crc32 = patch.get("source_crc32").and_then(Self::json_u32);
            descriptor.target_crc32 = patch.get("target_crc32").and_then(Self::json_u32);
            descriptor.minimum_source_size =
                patch.get("minimum_source_size").and_then(Value::as_u64);
            descriptor.record_count = patch.get("record_count").and_then(Value::as_u64);
        } else if let Some(format) = report.format.clone() {
            descriptor.format = format;
        }
        Ok(descriptor)
    }

    fn json_u32(value: &Value) -> Option<u32> {
        value.as_u64().and_then(|number| u32::try_from(number).ok())
    }

    fn is_disc_sheet_file_name(file_name: &str) -> bool {
        let lower = file_name.to_ascii_lowercase();
        lower.ends_with(".cue") || lower.ends_with(".gdi")
    }

    fn patch_format_from_extension(path: &Path) -> String {
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .unwrap_or_else(|| "unknown".to_string())
    }

    fn ingest_success_report(
        &self,
        source: &Path,
        outcome: IngestOutcome,
        thread_execution: Option<ThreadExecution>,
    ) -> OperationReport {
        let source_file_name = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let kind_label = match outcome.kind {
            IngestKind::Rom => "rom",
            IngestKind::Patch => "patch",
        };
        let label = format!(
            "ingested `{}` ({kind_label}; {} asset(s); {} patch(es))",
            source.display(),
            outcome.assets.len(),
            outcome.patches.len()
        );
        let result = IngestResult {
            kind: outcome.kind,
            source_file_name,
            is_rom: outcome.is_rom,
            assets: outcome.assets,
            patches: outcome.patches,
        };
        let mut report = OperationReport::succeeded(
            OperationFamily::Command,
            Some("ingest".to_string()),
            "ingest",
            label,
            Some(100.0),
            thread_execution,
        );
        match serde_json::to_value(&result) {
            Ok(value) => report.details = Some(json!({ "ingest": value })),
            Err(error) => {
                return OperationReport::failed(
                    OperationFamily::Command,
                    Some("ingest".to_string()),
                    "ingest",
                    format!("failed to serialize ingest result: {error}"),
                    report.thread_execution.clone(),
                );
            }
        }
        report
    }
}
