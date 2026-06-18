use super::*;

pub(super) struct ExtractStepEvent<'a> {
    pub(super) format: &'a str,
    pub(super) depth: usize,
    pub(super) source: &'a Path,
    pub(super) out_dir: &'a Path,
    pub(super) step_status: &'a str,
    pub(super) outputs: &'a [Value],
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
        // source itself. For an archive that read sees only the container header, so when it comes
        // back empty, fall back to reading a bounded prefix of the single ROM payload INSIDE the
        // archive — giving the same early platform tag without waiting for the full extract.
        let mut identity = rom_weaver_checksum::detect_rom_identity_for_path(source);
        if identity.is_empty() {
            identity = self.detect_archive_payload_identity(source, format, ignore_common_files);
        }
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

    /// Detect the platform identity of the single ROM payload inside a libarchive-backed container
    /// (zip/7z/rar/tar/…) by reading a bounded prefix of just that entry — no full extraction. Used
    /// for the early `probe-manifest` so an archived ROM/disc shows its platform tag immediately,
    /// matching a bare dropped image. Returns an empty identity (handled at completion as before)
    /// when the container is not libarchive-backed (chd/rvz/… error on listing), the payload is
    /// ambiguous (more than one ROM entry → a later selection prompt owns it), or the read fails.
    fn detect_archive_payload_identity(
        &self,
        source: &Path,
        format_name: &str,
        ignore_common_files: bool,
    ) -> rom_weaver_checksum::RomIdentity {
        use std::io::Read;
        let entries = match list_regular_archive_file_entries(source, format_name) {
            Ok(entries) => entries,
            Err(error) => {
                trace!(
                    source = %source.display(),
                    %error,
                    "probe manifest: payload listing unavailable; leaving identity for completion"
                );
                return rom_weaver_checksum::RomIdentity::default();
            }
        };
        let mut rom_payloads = entries.into_iter().filter(|entry| {
            !(ignore_common_files && should_ignore_common_container_file(&entry.name))
                && is_rom_filter_candidate_name(&entry.name)
        });
        // Only a single unambiguous ROM payload gets early identity; multiple candidates are left
        // for the interactive selection that resolves which ROM the user keeps.
        let Some(payload) = rom_payloads.next() else {
            return rom_weaver_checksum::RomIdentity::default();
        };
        if rom_payloads.next().is_some() {
            return rom_weaver_checksum::RomIdentity::default();
        }
        let extension = std::path::Path::new(&payload.name)
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()));
        // `total_len` only steers the CD-vs-DVD medium label, so the entry's full size matters even
        // though we read only the leading prefix.
        let total_len = payload.size.unwrap_or(0);
        let prefix = with_regular_archive_file_entry_reader(
            source,
            format_name,
            payload.index,
            &payload.name,
            |reader| {
                let mut prefix = Vec::new();
                reader
                    .take(rom_weaver_checksum::DETECT_PREFIX_BYTES as u64)
                    .read_to_end(&mut prefix)?;
                Ok(prefix)
            },
        );
        match prefix {
            Ok(prefix) => {
                rom_weaver_checksum::detect_rom_identity(&prefix, total_len, extension.as_deref())
            }
            Err(error) => {
                trace!(
                    source = %source.display(),
                    payload = %payload.name,
                    %error,
                    "probe manifest: payload prefix read failed; leaving identity for completion"
                );
                rom_weaver_checksum::RomIdentity::default()
            }
        }
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
