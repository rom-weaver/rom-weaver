use super::selection_resolution::{SelectionExtract, SelectionResolutionOptions};
use super::*;

impl CliApp {
    pub(super) fn run_extract(&self, args: ExtractCommand) -> AppRunOutcome {
        trace!(
            source = %args.source.display(),
            selections = args.select.len(),
            out_dir = %args.out_dir.display(),
            split_bin = args.split_bin,
            rom_filter = args.rom_filter,
            patch_filter = args.patch_filter,
            no_ignore = args.no_ignore,
            no_nested_extract = args.no_nested_extract,
            no_overwrite = args.no_overwrite,
            threads = %args.threads,
            "starting extract command"
        );
        let ExtractCommand {
            source,
            select: selections,
            rom_filter,
            patch_filter,
            out_dir,
            split_bin,
            no_ignore,
            no_nested_extract,
            no_overwrite,
            checksum,
            checksum_rom,
            probe,
            threads,
        } = args;
        let kind_filter = Self::archive_entry_kind_filter(rom_filter, patch_filter);
        // `--checksum` hashes every output; `--checksum-rom` hashes only ROM-like outputs and is
        // safe to always pass. `--checksum` wins when both are set.
        let (checksum_algorithms, checksum_rom_only) = if checksum.is_empty() {
            (checksum_rom, true)
        } else {
            (checksum, false)
        };
        let context = self
            .context(threads)
            .with_extract_checksum_algorithms(checksum_algorithms)
            .with_extract_checksum_rom_only(checksum_rom_only);
        let probe_threads = context.single_thread_execution();
        if let Some(report) = self.require_existing_path(
            "extract",
            OperationFamily::Container,
            None,
            &source,
            probe_threads.clone(),
        ) {
            return self.finish("extract", report);
        }

        let Some(handler) = self.containers.probe(&source) else {
            return self.finish(
                "extract",
                OperationReport::failed(
                    OperationFamily::Container,
                    None,
                    "probe",
                    format!("no registered container matched `{}`", source.display()),
                    probe_threads,
                ),
            );
        };

        let (extract_split_bin, split_bin_warning) =
            if split_bin && !handler.descriptor().matches_name("chd") {
                (
                    false,
                    Some(format!(
                        "ignored --split-bin for non-CHD input; matched `{}`",
                        handler.descriptor().name
                    )),
                )
            } else {
                (split_bin, None)
            };
        let extract_threads = Some(context.plan_threads(handler.capabilities().extract_threads));
        // Stream an early identity/type manifest the moment the container is listed — before the
        // heavy descent below — so the host can route the drop and render its card immediately.
        // Best-effort and streaming-only; the authoritative identity still rides the terminal report.
        self.emit_probe_manifest(
            handler.as_ref(),
            &source,
            extract_split_bin,
            !no_ignore,
            &context,
        );
        // When interactive selection is enabled and the caller did not pin entries, extract selected
        // payload paths instead of every entry: keep unambiguous payloads whole, otherwise prompt the
        // host (the same resolution is applied per nested level during the descent below). This is
        // what lets the browser "just extract" with no separate `list` command.
        let selections = if self.interactive_selection_enabled && selections.is_empty() {
            match self.resolve_extract_payload_selections(
                handler.as_ref(),
                &source,
                SelectionResolutionOptions {
                    kind_filter,
                    split_bin: extract_split_bin,
                    ignore_common_files: !no_ignore,
                    source_label: "extract input",
                },
                &context,
            ) {
                Ok(entries) if entries.is_empty() => selections,
                Ok(entries) => entries,
                Err(error) => {
                    return self.finish(
                        "extract",
                        OperationReport::failed(
                            OperationFamily::Container,
                            Some(handler.descriptor().name.to_string()),
                            "extract",
                            error.to_string(),
                            extract_threads.clone(),
                        ),
                    );
                }
            }
        } else {
            selections
        };
        self.emit_running(
            OperationLabel {
                command: "extract",
                family: OperationFamily::Container,
                format: Some(handler.descriptor().name),
            },
            "extract",
            format!("extracting `{}`", source.display()),
            None,
            extract_threads.clone(),
        );
        self.emit_running(
            OperationLabel {
                command: "extract",
                family: OperationFamily::Container,
                format: Some(handler.descriptor().name),
            },
            "extract",
            format!("preparing extraction for `{}`", source.display()),
            None,
            extract_threads.clone(),
        );
        let primary_extract_started = std::time::Instant::now();
        let mut report = self
            .extract_with_selection_fallback(
                handler.as_ref(),
                &source,
                SelectionExtract {
                    out_dir: &out_dir,
                    selections: &selections,
                    kind_filter,
                    split_bin: extract_split_bin,
                    ignore_common_files: !no_ignore,
                    overwrite: !no_overwrite,
                    source_label: "extract input",
                    allow_multi_select: true,
                },
                &context,
            )
            .unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    "extract",
                    error.to_string(),
                    context.single_thread_execution(),
                )
            });
        let mut warnings = Vec::new();
        if let Some(split_bin_warning) = split_bin_warning {
            warnings.push(split_bin_warning);
        }
        if !warnings.is_empty() {
            report.label = format!("{}; warning={}", report.label, warnings.join("; "));
        }
        // Container handlers report their COMPLETE output set in `report.details["emitted_files"]`, so
        // that report is authoritative: it is exactly what THIS extract wrote. There is deliberately no
        // out_dir filesystem scan — a scan can't tell this op's outputs from a concurrent sibling op's
        // files written into a shared out_dir, so a blind diff would mis-claim a sibling's file as an
        // emitted output and feed it to the nested-extract candidate list. Trusting the handler report
        // removes that whole class (and the need for callers to isolate out_dirs to defend against it).
        let primary_emitted_files = if report.status == OperationStatus::Succeeded {
            Self::emitted_file_detail_paths(report.details.as_ref())
        } else {
            Vec::new()
        };
        if report.status == OperationStatus::Succeeded {
            let format_name = handler.descriptor().name;
            // Level 0 (the input container itself). Its outputs carry the inline checksums computed
            // by the handler when `--checksum` was requested.
            let primary_details = Self::build_or_existing_emitted_file_detail_values(
                report.details.as_ref(),
                &primary_emitted_files,
                None,
            );
            let primary_extract_elapsed_ms = primary_extract_started
                .elapsed()
                .as_millis()
                .min(u32::MAX as u128) as u32;
            self.emit_extract_step(ExtractStepEvent {
                format: format_name,
                depth: 0,
                source: &source,
                out_dir: &out_dir,
                step_status: "succeeded",
                outputs: &primary_details,
                elapsed_ms: Some(primary_extract_elapsed_ms),
                thread_execution: report.thread_execution.clone(),
            });
            let mut all_emitted_details = primary_details;
            // Canonical paths (normalized) of every container we descended into; these are the
            // intermediate archives, so they are excluded from the final leaf output set.
            let mut descended: HashSet<String> = HashSet::new();
            if !no_nested_extract {
                self.emit_running(
                    OperationLabel {
                        command: "extract",
                        family: OperationFamily::Container,
                        format: Some(format_name),
                    },
                    "nested-extract",
                    "checking nested archives in extracted outputs".to_string(),
                    None,
                    context.single_thread_execution(),
                );
                match self.extract_nested_archives(
                    &source,
                    &primary_emitted_files,
                    kind_filter,
                    !no_ignore,
                    !no_overwrite,
                    &context,
                ) {
                    Ok(outcome) => {
                        descended = outcome.descended;
                        all_emitted_details.extend(outcome.emitted_details);
                        if outcome.count > 0 {
                            report.label = format!(
                                "{}; recursively extracted {} nested container(s)",
                                report.label, outcome.count
                            );
                        }
                    }
                    Err(error) => {
                        report = OperationReport::failed(
                            OperationFamily::Container,
                            Some(format_name.to_string()),
                            "extract",
                            error.to_string(),
                            context.single_thread_execution(),
                        );
                    }
                }
            }
            if report.status == OperationStatus::Succeeded {
                // Report only the bottom/leaf outputs: any emitted file we did not further descend
                // into. For a non-nested extract `descended` is empty, so every primary output is a
                // leaf and the result is identical to the previous single-level behaviour.
                let leaves = all_emitted_details
                    .into_iter()
                    .filter(|value| {
                        match value
                            .as_object()
                            .and_then(|map| map.get("path"))
                            .and_then(Value::as_str)
                        {
                            Some(path) => !descended.contains(path),
                            None => true,
                        }
                    })
                    .collect::<Vec<_>>();
                // Fold disc structure (sheet text + per-track grouping) into the leaves so the host
                // renders a multi-track disc as one card without re-parsing the cue/gdi itself.
                let leaves = Self::attach_disc_group_details(leaves);
                report = Self::set_emitted_files_detail(report, leaves);
            }
        }
        if probe {
            // Fold the container/platform probe metadata into the extract result so the
            // caller does not need a separate probe roundtrip. `is_single_payload_disc_image`
            // gates the fail-on-unidentified rule to bare ROM/disc-image inputs (a single
            // decoded payload); multi-entry archives keep per-entry identity granularity and
            // are never failed here.
            report = Self::attach_container_probe_details(
                report,
                None,
                self.probe_compress_recommendation(&source).as_ref(),
            );
            report =
                self.attach_extract_probe_identity(report, handler.is_single_payload_disc_image());
        }
        self.finish("extract", report)
    }

    /// Ensure a `--probe` extract carries the decoded payload's platform identity and,
    /// for single-payload disc images, fails when nothing resolves. Identity already
    /// streamed in by `--checksum` is reused as-is (no extra read); otherwise a single
    /// bounded-prefix read of the emitted output backfills it — the same detection the
    /// checksum/probe surfaces use. Multi-entry archives are left untouched (per-entry
    /// identity granularity, never failed here).
    fn attach_extract_probe_identity(
        &self,
        mut report: OperationReport,
        single_payload: bool,
    ) -> OperationReport {
        if report.status != OperationStatus::Succeeded || !single_payload {
            return report;
        }
        let mut details = match report.details.take() {
            Some(serde_json::Value::Object(map)) => map,
            other => {
                report.details = other;
                return report;
            }
        };
        let mut emitted = match details.remove("emitted_files") {
            Some(serde_json::Value::Array(items)) => items,
            other => {
                if let Some(value) = other {
                    details.insert("emitted_files".to_string(), value);
                }
                report.details = Some(serde_json::Value::Object(details));
                return report;
            }
        };
        let mut resolved_identity = false;
        for entry in &mut emitted {
            let Some(map) = entry.as_object_mut() else {
                continue;
            };
            if map.contains_key("platform") || map.contains_key("disc_format") {
                resolved_identity = true;
                continue;
            }
            let path = map
                .get("path")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let Some(path) = path else {
                continue;
            };
            let identity =
                rom_weaver_checksum::detect_rom_identity_for_path(std::path::Path::new(&path));
            if !identity.is_empty() {
                identity.write_into(map);
                resolved_identity = true;
            }
        }
        details.insert(
            "emitted_files".to_string(),
            serde_json::Value::Array(emitted),
        );
        report.details = Some(serde_json::Value::Object(details));
        if resolved_identity {
            return report;
        }
        OperationReport::failed(
            report.family,
            report.format.clone(),
            "probe",
            "probe: source did not resolve to a known platform",
            report.thread_execution.clone(),
        )
    }
}
