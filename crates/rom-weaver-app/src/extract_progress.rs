use super::*;

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
    /// Emit an early `probe-manifest` event the instant the container is listed — before any
    /// heavy extraction — so the host can route a dropped file (ROM input vs patch bundle) and
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
                let mut summary = Map::new();
                summary.insert("file_name".to_string(), json!(entry.path));
                summary.insert("size_bytes".to_string(), json!(entry.size));
                summary.insert("kind".to_string(), json!(kind));
                Value::Object(summary)
            })
            .collect::<Vec<_>>();
        // Mirror the host's default-to-ROM routing: only a bundle that carries patches and no ROM
        // payload is a patch source; everything else (unclassifiable, mixed, or empty) routes to the
        // ROM input bucket so an ambiguous drop still lands somewhere sensible.
        let is_rom = has_rom || !has_patch;
        // A bare disc image / ROM source resolves its platform from a bounded prefix read of the
        // source itself — cheap, no decode. We deliberately do NOT decode a prefix of the inner ROM
        // payload for archives here: that duplicated decode work ahead of the real extraction and
        // measurably slowed every extract, for only a slightly-earlier platform tag (archives get
        // their identity at completion as before).
        let identity = rom_weaver_checksum::detect_rom_identity_for_path(source);
        let mut manifest = Map::new();
        manifest.insert("format".to_string(), json!(format));
        manifest.insert("is_rom".to_string(), json!(is_rom));
        manifest.insert("entries".to_string(), Value::Array(entry_summaries));
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
        let output_summaries = outputs
            .iter()
            .filter_map(|value| {
                let map = value.as_object()?;
                let mut entry = Map::new();
                for key in ["file_name", "size_bytes", "kind"] {
                    if let Some(field) = map.get(key) {
                        entry.insert(key.to_string(), field.clone());
                    }
                }
                Some(Value::Object(entry))
            })
            .collect::<Vec<_>>();
        let mut step = Map::new();
        step.insert("depth".to_string(), json!(depth));
        step.insert(
            "source".to_string(),
            json!(source.to_string_lossy().replace('\\', "/")),
        );
        step.insert("source_name".to_string(), json!(source_name));
        // The directory this level extracted into. The UI relativizes each level's source (and the
        // final leaf) against the longest matching `out_dir` to show the path *inside* its immediate
        // parent archive, rather than the accumulated full nested path.
        step.insert(
            "out_dir".to_string(),
            json!(out_dir.to_string_lossy().replace('\\', "/")),
        );
        step.insert("format".to_string(), json!(format));
        step.insert("status".to_string(), json!(step_status));
        // Per-level extract time; the host attaches it to this level's row in the extraction tree.
        if let Some(elapsed_ms) = elapsed_ms {
            step.insert("extract_time_ms".to_string(), json!(elapsed_ms));
        }
        step.insert("outputs".to_string(), Value::Array(output_summaries));
        let mut details = Map::new();
        details.insert("extract_step".to_string(), Value::Object(step));
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
