use super::*;
/// The result of descending nested archives during a single `extract` command.
pub(super) struct NestedExtractOutcome {
    /// Number of nested containers that were extracted.
    pub(super) count: usize,
    /// Normalized canonical paths of every container we descended into (the intermediate archives).
    pub(super) descended: HashSet<String>,
    /// `emitted_files` detail objects (with checksums when requested) for every file produced by the
    /// nested levels, in extraction order.
    pub(super) emitted_details: Vec<Value>,
}

impl CliApp {
    pub(super) fn require_existing_path(
        &self,
        _command: &str,
        family: OperationFamily,
        format: Option<String>,
        path: &Path,
        thread_execution: Option<ThreadExecution>,
    ) -> Option<OperationReport> {
        if path.exists() {
            None
        } else {
            Some(OperationReport::failed(
                family,
                format,
                "validate",
                format!("input path does not exist: `{}`", path.display()),
                thread_execution,
            ))
        }
    }

    pub(super) fn finish(&self, command: &str, report: OperationReport) -> AppRunOutcome {
        trace!(
            command,
            family = ?report.family,
            format = ?report.format,
            stage = %report.stage,
            status = ?report.status,
            percent = ?report.percent,
            label = %report.label,
            "finishing command with terminal report"
        );
        let status = report.status;
        self.reporter.emit(report.into_event(command));
        AppRunOutcome {
            status,
            exit_code: status.exit_code(),
        }
    }

    pub(super) fn extract_nested_archives(
        &self,
        root_source: &Path,
        root_candidates: &[PathBuf],
        kind_filter: ArchiveEntryKindFilter,
        ignore_common_files: bool,
        overwrite: bool,
        context: &OperationContext,
    ) -> Result<NestedExtractOutcome> {
        trace!(
            root_source = %root_source.display(),
            candidate_count = root_candidates.len(),
            "starting nested archive extraction scan"
        );
        let root_source =
            fs::canonicalize(root_source).unwrap_or_else(|_| root_source.to_path_buf());
        let mut nested_count = 0usize;
        let mut descended: HashSet<String> = HashSet::new();
        let mut emitted_details: Vec<Value> = Vec::new();
        let mut processed = HashSet::new();
        processed.insert(root_source.clone());

        let mut queue = VecDeque::new();
        for candidate in root_candidates {
            self.enqueue_nested_candidate(candidate, 1, kind_filter, &processed, &mut queue);
        }

        while let Some((source, depth)) = queue.pop_front() {
            trace!(
                source = %source.display(),
                depth,
                queue_remaining = queue.len(),
                extracted_nested_archives = nested_count,
                "processing nested archive candidate"
            );
            if depth > MAX_NESTED_EXTRACT_DEPTH {
                trace!(
                    source = %source.display(),
                    depth,
                    max_depth = MAX_NESTED_EXTRACT_DEPTH,
                    "nested archive extraction failed: exceeded max depth"
                );
                return Err(RomWeaverError::Validation(format!(
                    "nested extract exceeded max depth of {MAX_NESTED_EXTRACT_DEPTH} at `{}`",
                    source.display()
                )));
            }
            if nested_count >= MAX_NESTED_EXTRACT_ARCHIVES {
                trace!(
                    source = %source.display(),
                    extracted_nested_archives = nested_count,
                    max_archives = MAX_NESTED_EXTRACT_ARCHIVES,
                    "nested archive extraction failed: exceeded max archive count"
                );
                return Err(RomWeaverError::Validation(format!(
                    "nested extract exceeded max archive count of {MAX_NESTED_EXTRACT_ARCHIVES}"
                )));
            }

            let canonical_source = fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
            let canonical_source_key =
                Self::normalize_emitted_path_string(&canonical_source.to_string_lossy());
            if !processed.insert(canonical_source) {
                trace!(
                    source = %source.display(),
                    "skipping nested archive candidate already processed"
                );
                continue;
            }

            let Some(handler) = self.containers.probe(&source) else {
                trace!(
                    source = %source.display(),
                    "skipping nested archive candidate with no container handler"
                );
                continue;
            };

            // Only recurse into containers that successfully probe, so extension-only matches
            // do not fail nested extraction on non-container payload files.
            let probe_request = ContainerProbeRequest {
                source: source.clone(),
                split_bin: false,
            };
            if let Err(error) = handler.probe_details(&probe_request, context) {
                trace!(
                    source = %source.display(),
                    format = handler.descriptor().name,
                    error = %error,
                    "skipping nested archive candidate because probe failed"
                );
                continue;
            }

            let nested_out_dir = self.next_nested_out_dir(&source);
            // Auto-extract every branch while descending: nested archives never prompt for a
            // payload selection, so an ambiguous multi-branch container fully unpacks instead of
            // pausing for input. The top-level `--select` still narrows the primary container
            // above; it intentionally does not propagate into nested levels.
            let nested_selections: Vec<String> = Vec::new();
            trace!(
                source = %source.display(),
                format = handler.descriptor().name,
                nested_out_dir = %nested_out_dir.display(),
                "extracting all branches of nested archive candidate"
            );
            let nested_request = ContainerExtractRequest {
                source: source.clone(),
                selections: nested_selections,
                kind_filter,
                out_dir: nested_out_dir.clone(),
                split_bin: false,
                ignore_common_files,
                overwrite,
                // A nested source is never a parented CHD here, so it has no parent CHD.
                parent: None,
                // This source is a run-local intermediate (written while descending `root_source`),
                // so flag its provenance: in the browser the handler must read it on the main thread.
                containing_archive: Some(root_source.clone()),
            };
            let format_name = handler.descriptor().name;
            let step_threads = Some(context.plan_threads(handler.capabilities().extract_threads));
            self.emit_extract_step(ExtractStepEvent {
                format: format_name,
                depth,
                source: &source,
                out_dir: &nested_out_dir,
                step_status: "running",
                outputs: &[],
                elapsed_ms: None,
                thread_execution: step_threads.clone(),
            });
            let step_started = std::time::Instant::now();
            let nested_report = handler.extract(&nested_request, context).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "nested extract failed for `{}` ({}): {error}",
                    source.display(),
                    format_name
                ))
            })?;
            let step_elapsed_ms = step_started.elapsed().as_millis().min(u32::MAX as u128) as u32;
            descended.insert(canonical_source_key);
            nested_count = nested_count.saturating_add(1);
            // Take this level's outputs from the handler's authoritative report (every container
            // handler records its full emitted set), then surface them as a succeeded step event and
            // accumulate them for leaf selection by the caller. Tag each output with this step's elapsed
            // time so the caller can report per-file extract timing (each leaf carries the time of the
            // archive level that produced it).
            let nested_emitted = Self::emitted_file_detail_paths(nested_report.details.as_ref());
            let mut nested_details = Self::build_emitted_file_detail_values(
                nested_report.details.as_ref(),
                &nested_emitted,
                None,
            );
            for detail in &mut nested_details {
                if let Value::Object(map) = detail {
                    map.entry("extract_time_ms".to_string())
                        .or_insert_with(|| json!(step_elapsed_ms));
                }
            }
            self.emit_extract_step(ExtractStepEvent {
                format: format_name,
                depth,
                source: &source,
                out_dir: &nested_out_dir,
                step_status: "succeeded",
                outputs: &nested_details,
                elapsed_ms: Some(step_elapsed_ms),
                thread_execution: step_threads,
            });
            emitted_details.extend(nested_details);
            trace!(
                source = %source.display(),
                nested_out_dir = %nested_out_dir.display(),
                format = format_name,
                extracted_nested_archives = nested_count,
                "nested archive extraction completed"
            );

            self.enqueue_nested_candidates(
                &nested_out_dir,
                depth + 1,
                kind_filter,
                &processed,
                &mut queue,
            )?;
            trace!(
                source = %source.display(),
                queue_len = queue.len(),
                next_depth = depth + 1,
                "queued additional nested archive candidates"
            );
        }

        trace!(
            extracted_nested_archives = nested_count,
            processed_sources = processed.len(),
            descended_containers = descended.len(),
            emitted_outputs = emitted_details.len(),
            "completed nested archive extraction scan"
        );
        Ok(NestedExtractOutcome {
            count: nested_count,
            descended,
            emitted_details,
        })
    }

    pub(super) fn enqueue_nested_candidate(
        &self,
        path: &Path,
        depth: usize,
        kind_filter: ArchiveEntryKindFilter,
        processed: &HashSet<PathBuf>,
        queue: &mut VecDeque<(PathBuf, usize)>,
    ) {
        if !path.is_file()
            || !Self::should_probe_nested_candidate(path, kind_filter)
            || self.nested_candidate_container(path).is_none()
        {
            return;
        }
        let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if processed.contains(&canonical)
            || queue
                .iter()
                .any(|(queued_path, _)| queued_path.as_path() == path)
        {
            return;
        }
        queue.push_back((path.to_path_buf(), depth));
        if let Some((queued_path, queued_depth)) = queue.back() {
            trace!(
                source = %queued_path.display(),
                depth = *queued_depth,
                queue_len = queue.len(),
                "queued nested extract candidate"
            );
        }
    }

    pub(super) fn enqueue_nested_candidates(
        &self,
        root: &Path,
        depth: usize,
        kind_filter: ArchiveEntryKindFilter,
        processed: &HashSet<PathBuf>,
        queue: &mut VecDeque<(PathBuf, usize)>,
    ) -> Result<()> {
        trace!(
            root = %root.display(),
            depth,
            processed_count = processed.len(),
            existing_queue_len = queue.len(),
            "scanning nested extract candidates"
        );
        let mut directories = vec![root.to_path_buf()];
        let mut queued_count = 0usize;
        while let Some(directory) = directories.pop() {
            let mut entries =
                fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path());

            for entry in entries {
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_dir() {
                    directories.push(path);
                    continue;
                }
                if !file_type.is_file()
                    || !Self::should_probe_nested_candidate(&path, kind_filter)
                    || self.nested_candidate_container(&path).is_none()
                {
                    continue;
                }
                let prior_len = queue.len();
                self.enqueue_nested_candidate(&path, depth, kind_filter, processed, queue);
                if queue.len() > prior_len {
                    queued_count = queued_count.saturating_add(1);
                }
            }
        }
        trace!(
            root = %root.display(),
            depth,
            queued_count,
            final_queue_len = queue.len(),
            "completed nested candidate scan"
        );
        Ok(())
    }

    /// Resolve the container handler for a nested-extract candidate, short-circuiting the
    /// container-probe cascade for files that are unambiguously patches.
    ///
    /// Nested-extract descends into nested *containers*; a patch leaf (e.g. an `.ips`/`.bps`/
    /// `.xdelta` extracted from a patch bundle) is never a container, yet the general
    /// [`ContainerRegistry::probe`] cascade would still signature-probe it against every registered
    /// container format (dozens of header reads per file - the dominant cost when a bundle holds
    /// many patch entries). When the file both carries a patch extension and positively matches a
    /// patch magic, we know it is a patch and skip the cascade. This is behavior-preserving: a file
    /// with patch magic has no container magic, so the cascade would have returned no handler
    /// anyway. Ambiguous patch-extension files without magic (e.g. a `.dcp` that is really a ZIP)
    /// fail the signature check and fall through to the normal container probe unchanged.
    fn nested_candidate_container(&self, path: &Path) -> Option<Arc<dyn ContainerHandler>> {
        if is_patch_filter_candidate_name(&path.to_string_lossy())
            && self.patches.probe_signature(path).is_some()
        {
            trace!(
                candidate = %path.display(),
                "skipping container probe for signature-confirmed patch leaf"
            );
            return None;
        }
        self.containers.probe(path)
    }

    pub(super) fn should_probe_nested_candidate(
        path: &Path,
        kind_filter: ArchiveEntryKindFilter,
    ) -> bool {
        if kind_filter.disabled() {
            return true;
        }
        match Self::infer_emitted_file_kind(path) {
            Some("archive") | None => true,
            Some(_) => false,
        }
    }

    pub(super) fn next_nested_out_dir(&self, source: &Path) -> PathBuf {
        let parent = source
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("archive");
        let base_name = self.nested_base_name(file_name);

        let mut candidate = parent.join(&base_name);
        if candidate != source && !candidate.exists() {
            return candidate;
        }

        for index in 1usize.. {
            candidate = parent.join(format!("{base_name}.nested-{index}"));
            if candidate != source && !candidate.exists() {
                return candidate;
            }
        }

        unreachable!("nested output directory search is unbounded");
    }

    pub(super) fn nested_base_name(&self, file_name: &str) -> String {
        let file_name_lower = file_name.to_ascii_lowercase();
        let mut longest_extension = 0usize;
        for handler in self.containers.handlers() {
            for extension in handler.descriptor().extensions {
                let extension_lower = extension.to_ascii_lowercase();
                if file_name_lower.ends_with(&extension_lower)
                    && extension_lower.len() > longest_extension
                {
                    longest_extension = extension_lower.len();
                }
            }
        }

        let mut base = if longest_extension == 0 || longest_extension >= file_name.len() {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("archive")
                .to_string()
        } else {
            file_name[..file_name.len() - longest_extension].to_string()
        };

        base = base.trim().trim_matches('.').to_string();
        if base.is_empty() {
            "archive".to_string()
        } else {
            base
        }
    }
}
