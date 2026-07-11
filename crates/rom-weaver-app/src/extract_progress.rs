use super::*;

/// One extracted entry as it appears in a progress event's `details` - both the
/// early `probe-manifest` listing (`probe_manifest.entries`) and each per-level
/// `extract-step` (`extract_step.outputs`) carry this exact three-field shape.
/// The webapp reads these to size/name nested archive payloads; typing it here
/// makes that Rust⇄TS contract compile-checked on both sides. The
/// `extract-step` form is a projection of the richer emitted-file detail (which
/// also carries checksums/platform/timing) down to just these keys.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ExtractedFileEntry {
    /// Entry name as reported by the container handler (path inside the archive,
    /// forward-slash normalized for nested sources).
    pub file_name: String,
    /// Uncompressed size of this entry in bytes. Serialized as `null` (not
    /// omitted) when the container handler does not report a size - the default
    /// `list_entry_records` impl reports `None` for libarchive-backed formats, so
    /// preserving the explicit `null` keeps the emitted JSON byte-identical.
    ///
    /// Emitted as a JSON `number` on the wasm wire, so override the default
    /// ts-rs `bigint` mapping to `number | null` to match the runtime payload.
    #[cfg_attr(feature = "typescript-types", ts(type = "number | null"))]
    pub size_bytes: Option<u64>,
    /// Coarse classification: `rom`, `patch`, `common` (ignored sidecar), or
    /// `other`. Present on probe-manifest entries; carried through verbatim on
    /// extract-step outputs when the emitted file recorded one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub kind: Option<String>,
}

impl ExtractedFileEntry {
    /// Project a richer emitted-file detail object (which also carries
    /// checksums/platform/timing) down to just the `file_name`/`size_bytes`/
    /// `kind` keys the extract-step output shape exposes. Returns `None` for a
    /// non-object value (mirrors the previous `value.as_object()?` guard).
    fn from_emitted_detail(value: &Value) -> Option<Self> {
        let map = value.as_object()?;
        Some(Self {
            file_name: map
                .get("file_name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            // Every `emitted_files` detail producer inserts `size_bytes` as a number, so this
            // resolves to `Some(n)` in practice; `as_u64` yields `None` only for a non-numeric value.
            size_bytes: map.get("size_bytes").and_then(Value::as_u64),
            kind: map.get("kind").and_then(Value::as_str).map(str::to_string),
        })
    }
}

/// The `extract_step` payload nested under a per-level `extract-step` progress
/// event's `details`. The host renders one extraction-tree row per level from
/// this; the leaf level carries the final output entries. Status is the
/// per-level lifecycle (`running`/`succeeded`/`failed`) - distinct from the
/// command-terminal status on the event itself.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ExtractStepDetails {
    /// Nesting depth of this level (0 = the input container).
    pub depth: usize,
    /// Full source path this level extracted from (forward-slash normalized).
    pub source: String,
    /// File name component of `source` (no directory).
    pub source_name: String,
    /// Directory this level extracted into (forward-slash normalized). The host
    /// relativizes each level's source against the longest matching `out_dir`.
    pub out_dir: String,
    /// Container format name for this level.
    pub format: String,
    /// Per-level lifecycle: `running` before the work, then `succeeded`/`failed`.
    pub status: String,
    /// Wall-clock ms this level took; only set on the `succeeded` step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub extract_time_ms: Option<u32>,
    /// Entries this level produced (leaf level only; intermediate levels are empty).
    pub outputs: Vec<ExtractedFileEntry>,
}

pub(super) struct ExtractStepEvent<'a> {
    pub(super) format: &'a str,
    pub(super) depth: usize,
    pub(super) source: &'a Path,
    pub(super) out_dir: &'a Path,
    pub(super) step_status: &'a str,
    pub(super) outputs: &'a [Value],
    /// Wall-clock time this level took to extract, in ms. Set on the `succeeded` step so the host can
    /// render a per-level extract time in the extraction tree; `None` on the `running` step (which
    /// fires before the work) and whenever timing was not measured.
    pub(super) elapsed_ms: Option<u32>,
    pub(super) thread_execution: Option<ThreadExecution>,
}

impl CliApp {
    /// Classify a container's listed entries into the early-routing signal the host (and the
    /// `ingest` command) consume: whether the bundle routes to the ROM input bucket
    /// (`is_rom = has_rom || !has_patch`), the per-entry `rom`/`patch`/`common`/`other` summaries,
    /// and the raw `has_rom`/`has_patch` flags (the latter two let a caller detect a *mixed*
    /// archive that carries both a ROM and sidecar patches). Pure (no I/O, no events) so it is
    /// shared by `emit_probe_manifest` and `run_ingest` without re-listing the container.
    pub(super) fn classify_container_entries(
        entries: &[ContainerListEntry],
        ignore_common_files: bool,
    ) -> (bool, Vec<ExtractedFileEntry>, bool, bool) {
        let mut has_rom = false;
        let mut has_patch = false;
        let entry_summaries = entries
            .iter()
            .map(|entry| {
                // Common sidecar files only count as "ignored" when the run honors the ignore list;
                // with `--no-ignore` they are real extractable payloads and classify normally.
                let is_common =
                    ignore_common_files && should_ignore_common_container_file(&entry.path);
                let kind = if is_common {
                    "common"
                } else if is_rom_filter_candidate_name(&entry.path) {
                    has_rom = true;
                    "rom"
                } else if is_patch_filter_candidate_name(&entry.path) {
                    has_patch = true;
                    "patch"
                } else {
                    "other"
                };
                ExtractedFileEntry {
                    file_name: entry.path.clone(),
                    size_bytes: entry.size,
                    kind: Some(kind.to_string()),
                }
            })
            .collect::<Vec<_>>();
        // Mirror the host's default-to-ROM routing: only a bundle that carries patches and no ROM
        // payload is a patch source; everything else (unclassifiable, mixed, or empty) routes to the
        // ROM input bucket so an ambiguous drop still lands somewhere sensible.
        let is_rom = has_rom || !has_patch;
        (is_rom, entry_summaries, has_rom, has_patch)
    }

    /// Emit an early `probe-manifest` event the instant the container is listed - before any
    /// heavy extraction - so the host can route a dropped file (ROM input vs patch bundle) and
    /// render its identity card right away instead of awaiting a separate probe roundtrip. The
    /// event is purely additive: it is gated on streaming output (`emit_progress_events`), so the
    /// CLI report bytes are unchanged. Status stays `Running` because extraction continues; the
    /// payload rides in `details.probe_manifest` alongside the later `extract-step`/finish events.
    pub(super) fn emit_probe_manifest(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        split_bin: bool,
        ignore_common_files: bool,
        context: &OperationContext,
    ) {
        if !self.emit_progress_events {
            return;
        }
        let format = handler.descriptor().name;
        let entries = match handler.list_entry_records(
            &ContainerProbeRequest {
                source: source.to_path_buf(),
                split_bin,
            },
            context,
        ) {
            Ok(entries) => entries,
            Err(error) => {
                // A listing failure here is non-fatal: the manifest is best-effort, and the real
                // extraction below surfaces the same error through the terminal report.
                trace!(
                    source = %source.display(),
                    %error,
                    "probe manifest listing failed; skipping early manifest"
                );
                return;
            }
        };
        let (is_rom, entry_summaries, _has_rom, _has_patch) =
            Self::classify_container_entries(&entries, ignore_common_files);
        // A bare disc image / ROM source resolves its platform from a bounded prefix read of the
        // source itself - cheap, no decode. We deliberately do NOT decode a prefix of the inner ROM
        // payload for archives here: that duplicated decode work ahead of the real extraction and
        // measurably slowed every extract, for only a slightly-earlier platform tag (archives get
        // their identity at completion as before).
        let identity = rom_weaver_checksum::detect_rom_identity_for_path(source);
        let mut manifest = Map::new();
        manifest.insert("format".to_string(), json!(format));
        manifest.insert("is_rom".to_string(), json!(is_rom));
        manifest.insert("entries".to_string(), json!(entry_summaries));
        identity.write_into(&mut manifest);
        let mut details = Map::new();
        details.insert("probe_manifest".to_string(), Value::Object(manifest));
        trace!(
            format,
            source = %source.display(),
            entry_count = entries.len(),
            is_rom,
            platform = ?identity.platform,
            "emitting probe manifest event"
        );
        self.reporter.emit(ProgressEvent {
            command: "extract".to_string(),
            family: OperationFamily::Container,
            format: Some(format.to_string()),
            stage: "probe-manifest".to_string(),
            label: format!("identified `{}`", source.display()),
            details: Some(Value::Object(details)),
            percent: None,
            elapsed_ms: None,
            status: OperationStatus::Running,
            ..ProgressEvent::from_thread_execution(None)
        });
    }

    /// Emits a structured per-level extract "step" event so the UI can render each descended level
    /// (its source, format, and output names + sizes) as a discrete extraction while still ending
    /// the whole command with a single terminal finish. The event status stays `Running` because
    /// the host treats `succeeded`/`failed` as the command terminal; the per-level lifecycle is
    /// carried in `details.extract_step.status` instead.
    pub(super) fn emit_extract_step(&self, event: ExtractStepEvent<'_>) {
        if !self.emit_progress_events {
            return;
        }
        let ExtractStepEvent {
            format,
            depth,
            source,
            out_dir,
            step_status,
            outputs,
            elapsed_ms,
            thread_execution,
        } = event;
        let source_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        // Project each richer emitted-file detail down to the leaf entry shape; non-object values are
        // dropped (matching the previous `as_object()?` guard).
        let output_summaries = outputs
            .iter()
            .filter_map(ExtractedFileEntry::from_emitted_detail)
            .collect::<Vec<_>>();
        // The `out_dir` field below is the directory this level extracted into. The UI relativizes
        // each level's source (and the final leaf) against the longest matching `out_dir` to show the
        // path *inside* its immediate parent archive, rather than the accumulated full nested path.
        let step = ExtractStepDetails {
            depth,
            source: source.to_string_lossy().replace('\\', "/"),
            source_name,
            out_dir: out_dir.to_string_lossy().replace('\\', "/"),
            format: format.to_string(),
            status: step_status.to_string(),
            extract_time_ms: elapsed_ms,
            outputs: output_summaries,
        };
        let mut details = Map::new();
        details.insert("extract_step".to_string(), json!(step));
        let label = if step_status == "running" {
            format!("extracting `{}`", source.display())
        } else {
            format!("extracted `{}`", source.display())
        };
        trace!(
            format,
            depth,
            source = %source.display(),
            step_status,
            output_count = outputs.len(),
            "emitting extract step event"
        );
        let thread_execution = thread_execution.as_ref();
        self.reporter.emit(ProgressEvent {
            command: "extract".to_string(),
            family: OperationFamily::Container,
            format: Some(format.to_string()),
            stage: "extract-step".to_string(),
            label,
            details: Some(Value::Object(details)),
            percent: None,
            elapsed_ms: None,
            status: OperationStatus::Running,
            ..ProgressEvent::from_thread_execution(thread_execution)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // These tests pin the exact JSON shape the typed detail structs emit. The keys and
    // null/omit semantics must reproduce the previous hand-built `json!`/`Map` output byte-for-byte
    // so existing webapp consumers and cli_smoke snapshots keep parsing - see the `extract-step`
    // assertions in `compress.rs` and the `probe-manifest` assertions in `probe_extract.rs`.

    #[test]
    fn extracted_file_entry_serializes_all_keys() {
        let entry = ExtractedFileEntry {
            file_name: "game.nes".to_string(),
            size_bytes: Some(524_288),
            kind: Some("rom".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            json!({ "file_name": "game.nes", "size_bytes": 524_288, "kind": "rom" })
        );
    }

    #[test]
    fn extracted_file_entry_emits_null_size_and_omits_kind() {
        // Mirrors a probe-manifest entry for a libarchive-backed format whose default
        // `list_entry_records` reports `size: None` (serialized as `null`, never omitted), with no
        // classification recorded (`kind` omitted).
        let entry = ExtractedFileEntry {
            file_name: "inner.zip".to_string(),
            size_bytes: None,
            kind: None,
        };
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(
            value,
            json!({ "file_name": "inner.zip", "size_bytes": Value::Null })
        );
        let object = value.as_object().unwrap();
        assert!(
            object.contains_key("size_bytes"),
            "size_bytes stays present as null"
        );
        assert!(
            !object.contains_key("kind"),
            "absent kind is omitted, not null"
        );
    }

    #[test]
    fn extracted_file_entry_round_trips_through_value() {
        let entry = ExtractedFileEntry {
            file_name: "leaf.bin".to_string(),
            size_bytes: Some(42),
            kind: None,
        };
        let value = serde_json::to_value(&entry).unwrap();
        let parsed: ExtractedFileEntry = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, entry);
    }

    #[test]
    fn from_emitted_detail_projects_three_keys_and_drops_extras() {
        // A richer emitted-file detail (path/checksums/platform/timing) projects down to exactly the
        // three leaf keys; sibling keys are not carried into the extract-step output shape.
        let detail = json!({
            "path": "/out/leaf.bin",
            "file_name": "leaf.bin",
            "size_bytes": 1024,
            "kind": "rom",
            "checksums": { "sha1": "abc" },
            "platform": "Nintendo Entertainment System",
        });
        let entry = ExtractedFileEntry::from_emitted_detail(&detail).unwrap();
        assert_eq!(
            entry,
            ExtractedFileEntry {
                file_name: "leaf.bin".to_string(),
                size_bytes: Some(1024),
                kind: Some("rom".to_string()),
            }
        );
    }

    #[test]
    fn from_emitted_detail_rejects_non_object() {
        assert!(ExtractedFileEntry::from_emitted_detail(&json!("not-an-object")).is_none());
        assert!(ExtractedFileEntry::from_emitted_detail(&json!([1, 2, 3])).is_none());
    }

    #[test]
    fn extract_step_details_serializes_expected_keys() {
        let step = ExtractStepDetails {
            depth: 0,
            source: "/in/outer.zip".to_string(),
            source_name: "outer.zip".to_string(),
            out_dir: "/out".to_string(),
            format: "zip".to_string(),
            status: "succeeded".to_string(),
            extract_time_ms: Some(7),
            outputs: vec![ExtractedFileEntry {
                file_name: "leaf.bin".to_string(),
                size_bytes: Some(1024),
                kind: Some("rom".to_string()),
            }],
        };
        assert_eq!(
            serde_json::to_value(&step).unwrap(),
            json!({
                "depth": 0,
                "source": "/in/outer.zip",
                "source_name": "outer.zip",
                "out_dir": "/out",
                "format": "zip",
                "status": "succeeded",
                "extract_time_ms": 7,
                "outputs": [
                    { "file_name": "leaf.bin", "size_bytes": 1024, "kind": "rom" }
                ],
            })
        );
    }

    #[test]
    fn extract_step_details_omits_absent_extract_time() {
        // The `running` step fires before the work and carries no time; the key must be omitted
        // (not `null`) so a `succeeded` step is the only one with `extract_time_ms`.
        let step = ExtractStepDetails {
            depth: 1,
            source: "/in/outer.zip/inner.zip".to_string(),
            source_name: "inner.zip".to_string(),
            out_dir: "/out/inner".to_string(),
            format: "zip".to_string(),
            status: "running".to_string(),
            extract_time_ms: None,
            outputs: Vec::new(),
        };
        let value = serde_json::to_value(&step).unwrap();
        assert!(
            !value.as_object().unwrap().contains_key("extract_time_ms"),
            "running step must omit extract_time_ms"
        );
        let parsed: ExtractStepDetails = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, step);
    }
}
