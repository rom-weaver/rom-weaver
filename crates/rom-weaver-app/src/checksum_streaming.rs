use super::*;

/// Identifies the inner payload selected from a tar stream for the streamed-checksum fast path.
#[derive(Clone, Copy)]
pub(super) struct TarStreamCandidate<'a> {
    tar_format: &'a str,
    candidate_name: &'a str,
    candidate_index: usize,
}

/// The checksum command's stream/auto-extract option flags, grouped so the streaming-checksum
/// helpers take one descriptor instead of threading eight individual arguments.
#[derive(Clone, Copy)]
pub(super) struct ChecksumStreamOptions<'a> {
    pub(super) algo: &'a [String],
    pub(super) select: &'a [String],
    pub(super) kind_filter: ArchiveEntryKindFilter,
    pub(super) no_extract: bool,
    pub(super) no_ignore: bool,
    pub(super) strip_header: bool,
    pub(super) no_trim_fix: bool,
    pub(super) start: Option<u64>,
    pub(super) length: Option<u64>,
}

impl CliApp {
    pub(super) fn try_run_checksum_chd_raw_sha1_fast_path(
        &self,
        source: &Path,
        options: &ChecksumStreamOptions,
        context: &OperationContext,
        thread_execution: Option<ThreadExecution>,
    ) -> Result<Option<OperationReport>> {
        let ChecksumStreamOptions {
            algo,
            select,
            kind_filter,
            no_extract,
            strip_header,
            no_trim_fix,
            start,
            length,
            ..
        } = *options;
        if self.interactive_selection_enabled
            || no_extract
            || strip_header
            || !no_trim_fix
            || !select.is_empty()
            || start.is_some()
            || length.is_some()
        {
            return Ok(None);
        }
        if algo.len() != 1 || !algo[0].eq_ignore_ascii_case("sha1") {
            return Ok(None);
        }

        let Some(handler) = self.containers.probe(source) else {
            return Ok(None);
        };
        if !handler.descriptor().matches_name("chd") {
            return Ok(None);
        }

        let request = ContainerProbeRequest {
            source: source.to_path_buf(),
            split_bin: false,
        };
        let entries = handler.list_entries(&request, context)?;
        if !Self::chd_raw_sha1_fast_path_entries_supported(&entries) {
            return Ok(None);
        }
        if kind_filter.enabled() && !kind_filter.matches_payload_name(&entries[0]) {
            return Ok(None);
        }

        let report = handler.probe_details(&request, context)?;
        if report.status != OperationStatus::Succeeded {
            return Ok(None);
        }
        let Some(raw_sha1) = Self::extract_chd_raw_sha1_from_probe_details(report.details.as_ref())
        else {
            return Ok(None);
        };
        if !Self::is_valid_sha1_hex(&raw_sha1) {
            return Ok(None);
        }

        Ok(Some(OperationReport::succeeded(
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            "checksum",
            format!("sha1={raw_sha1}; checksum source resolved via chd raw_sha1 fast path"),
            Some(100.0),
            thread_execution,
        )))
    }

    pub(super) fn chd_raw_sha1_fast_path_entries_supported(entries: &[String]) -> bool {
        if entries.len() != 1 {
            return false;
        }
        let entry = entries[0].to_ascii_lowercase();
        entry.ends_with(".bin") || entry.ends_with(".iso") || entry.ends_with(".img")
    }

    pub(super) fn extract_chd_raw_sha1_from_probe_details(
        details: Option<&Value>,
    ) -> Option<String> {
        let details = details?;
        let Value::Object(map) = details else {
            return None;
        };
        let Value::Object(chd) = map.get("chd")? else {
            return None;
        };
        let value = chd.get("raw_sha1")?.as_str()?.trim().to_ascii_lowercase();
        if value.is_empty() {
            return None;
        }
        Some(value)
    }

    pub(super) fn is_valid_sha1_hex(value: &str) -> bool {
        value.len() == 40 && value.chars().all(|ch| ch.is_ascii_hexdigit())
    }

    pub(super) fn try_run_checksum_tar_stream_auto_extract(
        &self,
        source: &Path,
        options: &ChecksumStreamOptions,
        context: &OperationContext,
        thread_execution: Option<ThreadExecution>,
    ) -> Result<Option<OperationReport>> {
        let ChecksumStreamOptions {
            algo,
            select,
            kind_filter,
            no_extract,
            no_ignore,
            strip_header,
            no_trim_fix,
            start,
            length,
        } = *options;
        if no_extract || strip_header || !select.is_empty() || start.is_some() || length.is_some() {
            return Ok(None);
        }

        let Some(handler) = self.containers.probe(source) else {
            return Ok(None);
        };
        let tar_format = handler.descriptor().name;
        if !matches!(tar_format, "tar" | "tar.gz" | "tar.bz2" | "tar.xz") {
            return Ok(None);
        }

        let Some((candidate_name, candidate_index)) =
            self.select_tar_stream_checksum_candidate(source, tar_format, no_ignore, kind_filter)?
        else {
            return Ok(None);
        };

        if let Some(next_handler) = self.containers.probe(Path::new(&candidate_name))
            && !next_handler.descriptor().matches_name("xiso")
            && next_handler.capabilities().extract
        {
            return Ok(None);
        }

        if !no_trim_fix {
            let candidate_lower = candidate_name.to_ascii_lowercase();
            if self
                .trim_eligible_kind_for_path(Path::new(&candidate_name))
                .is_some()
                || candidate_lower.ends_with(".iso")
            {
                return Ok(None);
            }
        }

        let report = self.run_checksum_tar_stream_auto_extract(
            source,
            TarStreamCandidate {
                tar_format,
                candidate_name: &candidate_name,
                candidate_index,
            },
            algo,
            context,
            thread_execution,
        )?;
        Ok(Some(report))
    }

    pub(super) fn run_checksum_tar_stream_auto_extract(
        &self,
        source: &Path,
        candidate: TarStreamCandidate,
        algo: &[String],
        context: &OperationContext,
        thread_execution: Option<ThreadExecution>,
    ) -> Result<OperationReport> {
        let TarStreamCandidate {
            tar_format,
            candidate_name,
            candidate_index,
        } = candidate;
        trace!(
            source = %source.display(),
            tar_format,
            candidate_name,
            candidate_index,
            algorithm_count = algo.len(),
            "running streamed tar checksum auto-extract fast path"
        );
        self.emit_running(
            OperationLabel {
                command: "checksum",
                family: OperationFamily::Checksum,
                format: Some(self.checksum.name()),
            },
            "prepare",
            format!(
                "streaming checksum payload `{candidate_name}` from `{}` ({tar_format})",
                source.display()
            ),
            None,
            thread_execution.clone(),
        );

        let algorithms = algo
            .iter()
            .map(|algorithm| algorithm.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let checksum_algorithm_count = algorithms.len();
        let values = with_regular_archive_file_entry_reader(
            source,
            tar_format,
            candidate_index,
            candidate_name,
            |entry_reader| {
                checksum_reader_values_with_progress(
                    entry_reader,
                    &algorithms,
                    context,
                    &mut |progress| {
                        self.emit_running(
                            OperationLabel {
                                command: "checksum",
                                family: OperationFamily::Checksum,
                                format: Some(self.checksum.name()),
                            },
                            "checksum",
                            format!(
                                "computing {} checksum algorithm(s)",
                                checksum_algorithm_count
                            ),
                            Some(progress.percent()),
                            thread_execution.clone(),
                        );
                    },
                )
            },
        )?;

        let mut label = Self::render_streamed_checksum_label(&algorithms, &values.values);
        label.push_str(&format!(
            "; checksum source streamed from {tar_format} container entry `{candidate_name}`"
        ));
        Ok(OperationReport::succeeded(
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            "checksum",
            label,
            Some(100.0),
            Some(values.execution),
        ))
    }

    pub(super) fn select_tar_stream_checksum_candidate(
        &self,
        source: &Path,
        tar_format: &str,
        no_ignore: bool,
        kind_filter: ArchiveEntryKindFilter,
    ) -> Result<Option<(String, usize)>> {
        let mut candidates = BTreeMap::new();
        for entry in list_regular_archive_file_entries(source, tar_format)? {
            let ignored = Self::should_ignore_checksum_candidate(&entry.name);
            candidates.insert(entry.name, (entry.index, ignored));
        }

        let selected = if no_ignore {
            candidates
                .into_iter()
                .map(|(name, (index, _ignored))| (name, index))
                .collect::<Vec<_>>()
        } else {
            candidates
                .into_iter()
                .filter_map(|(name, (index, ignored))| (!ignored).then_some((name, index)))
                .collect::<Vec<_>>()
        };
        let selected = if kind_filter.enabled() {
            let mut payload_matches = Vec::new();
            let mut container_fallback_matches = Vec::new();
            for (name, index) in selected {
                if kind_filter.matches_payload_name(&name) {
                    payload_matches.push((name, index));
                } else if kind_filter.matches_container_fallback_name(&name) {
                    container_fallback_matches.push((name, index));
                }
            }
            if payload_matches.is_empty() {
                container_fallback_matches
            } else {
                payload_matches
            }
        } else {
            selected
        };
        if selected.len() != 1 {
            return Ok(None);
        }

        Ok(selected.into_iter().next())
    }

    pub(super) fn select_streamed_checksum_auto_extract_format(
        &self,
        source: &Path,
        options: &ChecksumStreamOptions,
    ) -> Option<&'static str> {
        let ChecksumStreamOptions {
            select,
            kind_filter,
            no_extract,
            no_trim_fix,
            strip_header,
            start,
            length,
            ..
        } = *options;
        if no_extract || strip_header || !select.is_empty() || start.is_some() || length.is_some() {
            return None;
        }

        let handler = self.containers.probe(source)?;
        let stream_format = handler.descriptor().name;
        if !matches!(stream_format, "gz" | "bz2" | "xz" | "zst") {
            return None;
        }

        if let Some(inferred_output) =
            Self::inferred_stream_extract_output_path(source, stream_format)
        {
            if kind_filter.enabled()
                && !kind_filter.matches_payload_name(&inferred_output.to_string_lossy())
            {
                return None;
            }
            if let Some(next_handler) = self.containers.probe(&inferred_output)
                && !next_handler.descriptor().matches_name("xiso")
                && next_handler.capabilities().extract
            {
                return None;
            }

            if !no_trim_fix && self.trim_eligible_kind_for_path(&inferred_output).is_some() {
                return None;
            }
        } else if kind_filter.enabled() {
            return None;
        }

        Some(stream_format)
    }

    pub(super) fn run_checksum_stream_auto_extract(
        &self,
        source: &Path,
        stream_format: &str,
        algo: &[String],
        context: &OperationContext,
        thread_execution: Option<ThreadExecution>,
    ) -> Result<OperationReport> {
        trace!(
            source = %source.display(),
            stream_format,
            algorithm_count = algo.len(),
            "running streamed checksum auto-extract fast path"
        );
        self.emit_running(
            OperationLabel {
                command: "checksum",
                family: OperationFamily::Checksum,
                format: Some(self.checksum.name()),
            },
            "prepare",
            format!(
                "streaming checksum payload from `{}` ({stream_format})",
                source.display()
            ),
            None,
            thread_execution.clone(),
        );

        let filter = Self::libarchive_read_filter_for_stream_format(stream_format)?;
        let algorithms = algo
            .iter()
            .map(|algorithm| algorithm.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let checksum_algorithm_count = algorithms.len();
        let values =
            with_raw_stream_reader(source, stream_format, filter, 64 * 1024, |stream_reader| {
                checksum_reader_values_with_progress(
                    stream_reader,
                    &algorithms,
                    context,
                    &mut |progress| {
                        self.emit_running(
                            OperationLabel {
                                command: "checksum",
                                family: OperationFamily::Checksum,
                                format: Some(self.checksum.name()),
                            },
                            "checksum",
                            format!(
                                "computing {} checksum algorithm(s)",
                                checksum_algorithm_count
                            ),
                            Some(progress.percent()),
                            thread_execution.clone(),
                        );
                    },
                )
            })?;

        let mut label = Self::render_streamed_checksum_label(&algorithms, &values.values);
        label.push_str(&format!(
            "; checksum source streamed from {stream_format} container"
        ));
        Ok(OperationReport::succeeded(
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            "checksum",
            label,
            Some(100.0),
            Some(values.execution),
        ))
    }

    pub(super) fn libarchive_read_filter_for_stream_format(
        stream_format: &str,
    ) -> Result<LibarchiveReadFilter> {
        match stream_format {
            "gz" => Ok(LibarchiveReadFilter::Gzip),
            "bz2" => Ok(LibarchiveReadFilter::Bzip2),
            "xz" => Ok(LibarchiveReadFilter::Xz),
            "zst" => Ok(LibarchiveReadFilter::Zstd),
            _ => Err(RomWeaverError::Validation(format!(
                "streamed checksum auto-extract does not support `{stream_format}`"
            ))),
        }
    }

    pub(super) fn inferred_stream_extract_output_path(
        source: &Path,
        stream_format: &str,
    ) -> Option<PathBuf> {
        let file_name = source.file_name()?.to_str()?;
        let extension = match stream_format {
            "gz" => ".gz",
            "bz2" => ".bz2",
            "xz" => ".xz",
            "zst" => ".zst",
            _ => return None,
        };
        let file_name_lower = file_name.to_ascii_lowercase();
        let trimmed = if file_name_lower.ends_with(extension) && extension.len() < file_name.len() {
            file_name[..file_name.len() - extension.len()].to_string()
        } else {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(file_name)
                .to_string()
        };
        let normalized = trimmed.trim().trim_matches('.');
        let output_name = if normalized.is_empty() {
            format!("{stream_format}.out")
        } else {
            normalized.to_string()
        };
        let parent = source
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        Some(parent.join(output_name))
    }

    pub(super) fn render_streamed_checksum_label(
        algorithms: &[String],
        values: &BTreeMap<String, String>,
    ) -> String {
        let mut ordered = Vec::new();
        let mut seen = BTreeSet::new();
        for algorithm in algorithms {
            let normalized = algorithm.trim().to_ascii_lowercase();
            if !seen.insert(normalized.clone()) {
                continue;
            }
            if let Some(value) = values.get(&normalized) {
                ordered.push(format!("{normalized}={value}"));
            }
        }
        if ordered.is_empty() {
            values
                .iter()
                .map(|(algorithm, value)| format!("{algorithm}={value}"))
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            ordered.join(" ")
        }
    }
}
