impl CliApp {
    fn require_existing_path(
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

    fn finish(&self, command: &str, report: OperationReport) -> ExitCode {
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
        ExitCode::from(status.exit_code())
    }

    fn extract_nested_archives(
        &self,
        root_source: &Path,
        root_out_dir: &Path,
        context: &OperationContext,
    ) -> Result<usize> {
        trace!(
            root_source = %root_source.display(),
            root_out_dir = %root_out_dir.display(),
            "starting nested archive extraction scan"
        );
        let root_source =
            fs::canonicalize(root_source).unwrap_or_else(|_| root_source.to_path_buf());
        let mut nested_count = 0usize;
        let mut processed = HashSet::new();
        processed.insert(root_source);

        let mut queue = VecDeque::new();
        self.enqueue_nested_candidates(root_out_dir, 1, &processed, &mut queue)?;
        trace!(
            initial_queue_len = queue.len(),
            "nested archive extraction initial queue prepared"
        );

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

            // Only recurse into containers that successfully inspect, so extension-only matches
            // do not fail nested extraction on non-container payload files.
            let inspect_request = ContainerInspectRequest {
                source: source.clone(),
            };
            if let Err(error) = handler.inspect(&inspect_request, context) {
                trace!(
                    source = %source.display(),
                    format = handler.descriptor().name,
                    error = %error,
                    "skipping nested archive candidate because inspect failed"
                );
                continue;
            }

            let nested_out_dir = self.next_nested_out_dir(&source);
            trace!(
                source = %source.display(),
                format = handler.descriptor().name,
                nested_out_dir = %nested_out_dir.display(),
                "extracting nested archive candidate"
            );
            let nested_request = ContainerExtractRequest {
                source: source.clone(),
                selections: Vec::new(),
                out_dir: nested_out_dir.clone(),
                split_bin: false,
                parent: None,
            };
            self.emit_running(
                "extract",
                OperationFamily::Container,
                Some(handler.descriptor().name),
                "nested-extract",
                format!("extracting nested archive `{}`", source.display()),
                None,
                Some(context.plan_threads(handler.capabilities().extract_threads)),
            );
            handler.extract(&nested_request, context).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "nested extract failed for `{}` ({}): {error}",
                    source.display(),
                    handler.descriptor().name
                ))
            })?;
            nested_count = nested_count.saturating_add(1);
            trace!(
                source = %source.display(),
                nested_out_dir = %nested_out_dir.display(),
                format = handler.descriptor().name,
                extracted_nested_archives = nested_count,
                "nested archive extraction completed"
            );

            self.enqueue_nested_candidates(&nested_out_dir, depth + 1, &processed, &mut queue)?;
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
            "completed nested archive extraction scan"
        );
        Ok(nested_count)
    }

    fn enqueue_nested_candidates(
        &self,
        root: &Path,
        depth: usize,
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
                if !file_type.is_file() || self.containers.probe(&path).is_none() {
                    continue;
                }
                let canonical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
                if processed.contains(&canonical)
                    || queue
                        .iter()
                        .any(|(queued_path, _)| queued_path.as_path() == path)
                {
                    continue;
                }
                queue.push_back((path, depth));
                queued_count = queued_count.saturating_add(1);
                if let Some((queued_path, queued_depth)) = queue.back() {
                    trace!(
                        source = %queued_path.display(),
                        depth = *queued_depth,
                        queue_len = queue.len(),
                        "queued nested extract candidate"
                    );
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

    fn next_nested_out_dir(&self, source: &Path) -> PathBuf {
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

    fn nested_base_name(&self, file_name: &str) -> String {
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
