impl CliApp {
    fn format_mode_counts(mode_counts: &BTreeMap<&'static str, usize>) -> String {
        if mode_counts.is_empty() {
            return "none".to_string();
        }

        mode_counts
            .iter()
            .map(|(mode, count)| format!("{mode}:{count}"))
            .collect::<Vec<_>>()
            .join(",")
    }

    fn trim_fix_eligible_kind_for_path(&self, path: &Path) -> Option<TrimInputKind> {
        if let Some(kind) = TrimInputKind::from_path(path) {
            return Some(kind);
        }

        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("iso"))
        {
            if let Ok(source_file) = File::options().read(true).open(path) {
                let source_reader = BufReader::new(source_file);
                if XdvdfsOffsetWrapper::new(source_reader).is_ok() {
                    return Some(TrimInputKind::Xiso);
                }
            }
        }

        None
    }

    fn trim_eligible_kind_for_path(&self, path: &Path) -> Option<TrimInputKind> {
        if let Some(kind) = self.trim_fix_eligible_kind_for_path(path) {
            return Some(kind);
        }

        if self.is_rvz_scrub_candidate(path) {
            return Some(TrimInputKind::RvzScrub);
        }

        None
    }

    fn is_rvz_scrub_candidate(&self, path: &Path) -> bool {
        let recommendation = self.containers.recommend_compress_format(path);
        recommendation.format_name.eq_ignore_ascii_case("rvz")
    }

    fn read_checksum_trim_plan_with_offset(
        &self,
        source: &Path,
        data_start_offset: u64,
    ) -> Result<ChecksumTrimPlan> {
        let Some(kind) = self.trim_fix_eligible_kind_for_path(source) else {
            return Err(RomWeaverError::Validation(format!(
                "trim-fix unavailable for non-trim-eligible input: `{}`",
                source.display()
            )));
        };
        let file_size = fs::metadata(source)?.len();
        if file_size == 0 || data_start_offset >= file_size {
            return Err(RomWeaverError::Validation(format!(
                "input is empty and cannot be processed: `{}`",
                source.display()
            )));
        }
        let effective_file_size = file_size.saturating_sub(data_start_offset);
        match kind {
            TrimInputKind::NdsFamily => {
                if effective_file_size < NDS_HEADER_TOTAL_BYTES as u64 {
                    return Err(RomWeaverError::Validation(format!(
                        "input is too small to contain a valid NDS/DSi header: `{}`",
                        source.display()
                    )));
                }
                let mut input = File::open(source)?;
                let plan = Self::read_nds_trim_plan(
                    &mut input,
                    effective_file_size,
                    false,
                    data_start_offset,
                )?;
                Ok(ChecksumTrimPlan {
                    trimmed_size: plan.trimmed_size.min(effective_file_size),
                    mode: if plan.dsi_mode { "dsi" } else { "ds" },
                    preserved_download_play_cert: plan.preserved_download_play_cert,
                })
            }
            TrimInputKind::Gba | TrimInputKind::ThreeDs => {
                let trimmed_size = Self::scan_trimmed_size_from_trailing_padding_from_offset(
                    source,
                    kind.default_padding_byte(),
                    data_start_offset,
                )?;
                Ok(ChecksumTrimPlan {
                    trimmed_size,
                    mode: kind.mode_label(),
                    preserved_download_play_cert: false,
                })
            }
            TrimInputKind::Xiso => {
                if data_start_offset > 0 {
                    return Err(RomWeaverError::Validation(format!(
                        "checksum trim-fix is not supported for header-stripped xiso inputs: `{}`",
                        source.display()
                    )));
                }
                let trimmed_size = Self::measure_trimmed_xiso_size(source).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "checksum trim-fix failed while evaluating xiso `{}`: {error}",
                        source.display()
                    ))
                })?;
                Ok(ChecksumTrimPlan {
                    trimmed_size,
                    mode: kind.mode_label(),
                    preserved_download_play_cert: false,
                })
            }
            TrimInputKind::RvzScrub => Err(RomWeaverError::Validation(format!(
                "checksum trim-fix is not supported for rvz-scrub inputs: `{}`",
                source.display()
            ))),
        }
    }

    fn collect_trim_input_files(
        &self,
        sources: &[PathBuf],
        recursive: bool,
        skipped_non_nds: &mut usize,
    ) -> Result<Vec<TrimSource>> {
        let mut files = Vec::new();
        for source in sources {
            let metadata = fs::metadata(source).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "input path is not accessible: `{}` ({error})",
                    source.display()
                ))
            })?;
            if metadata.is_file() {
                if let Some(kind) = self.trim_eligible_kind_for_path(source) {
                    files.push(TrimSource {
                        path: source.clone(),
                        kind,
                    });
                } else {
                    *skipped_non_nds = skipped_non_nds.saturating_add(1);
                }
                continue;
            }
            if metadata.is_dir() {
                self.collect_trim_directory_files(source, recursive, &mut files, skipped_non_nds)?;
                continue;
            }

            *skipped_non_nds = skipped_non_nds.saturating_add(1);
        }

        files.sort_by(|left, right| left.path.cmp(&right.path));
        files.dedup_by(|left, right| left.path == right.path);
        Ok(files)
    }

    fn collect_trim_directory_files(
        &self,
        root: &Path,
        recursive: bool,
        files: &mut Vec<TrimSource>,
        skipped_non_nds: &mut usize,
    ) -> Result<()> {
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            let mut entries =
                fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path());

            for entry in entries {
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_dir() {
                    if recursive {
                        directories.push(path);
                    }
                    continue;
                }
                if !file_type.is_file() {
                    *skipped_non_nds = skipped_non_nds.saturating_add(1);
                    continue;
                }
                if let Some(kind) = self.trim_eligible_kind_for_path(&path) {
                    files.push(TrimSource { path, kind });
                } else {
                    *skipped_non_nds = skipped_non_nds.saturating_add(1);
                }
            }
        }
        Ok(())
    }

    fn collect_batch_header_fix_input_files(
        &self,
        sources: &[PathBuf],
        recursive: bool,
        skipped_non_rom: &mut usize,
    ) -> Result<Vec<PathBuf>> {
        let mut files = Vec::new();
        for source in sources {
            let metadata = fs::metadata(source).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "input path is not accessible: `{}` ({error})",
                    source.display()
                ))
            })?;
            if metadata.is_file() {
                files.push(source.clone());
                continue;
            }
            if metadata.is_dir() {
                self.collect_batch_header_fix_directory_files(
                    source,
                    recursive,
                    &mut files,
                    skipped_non_rom,
                )?;
                continue;
            }

            *skipped_non_rom = skipped_non_rom.saturating_add(1);
        }

        files.sort();
        files.dedup();
        Ok(files)
    }

    fn collect_batch_header_fix_directory_files(
        &self,
        root: &Path,
        recursive: bool,
        files: &mut Vec<PathBuf>,
        skipped_non_rom: &mut usize,
    ) -> Result<()> {
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            let mut entries =
                fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path());

            for entry in entries {
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_dir() {
                    if recursive {
                        directories.push(path);
                    }
                    continue;
                }
                if !file_type.is_file() {
                    *skipped_non_rom = skipped_non_rom.saturating_add(1);
                    continue;
                }
                if Self::header_fix_candidate_for_path(&path) {
                    files.push(path);
                } else {
                    *skipped_non_rom = skipped_non_rom.saturating_add(1);
                }
            }
        }
        Ok(())
    }

    fn header_fix_candidate_for_path(path: &Path) -> bool {
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            return false;
        };
        HEADER_FIXER_SUPPORTED_EXTENSIONS
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(extension))
    }

    fn default_batch_header_fix_output_path(source: &Path, extension: &str) -> PathBuf {
        let source_extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("bin");
        let extension = extension.replace("{ext}", source_extension);
        let mut output = source.to_path_buf();
        output.set_extension(extension);
        output
    }

    fn fix_headers_for_file(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
    ) -> Result<BatchHeaderFixOutcome> {
        let repair_outcome = if dry_run {
            let temp_path = Self::temporary_header_fix_path(source);
            Self::copy_with_optional_header(source, &temp_path, None)?;
            let repair = Self::repair_checksum_file_in_place(&temp_path, Some(source));
            fs::remove_file(&temp_path).ok();
            repair?
        } else if in_place {
            Self::repair_checksum_file_in_place(destination, Some(source))?
        } else {
            Self::copy_with_optional_header(source, destination, None)?;
            Self::repair_checksum_file_in_place(destination, Some(source))?
        };

        Ok(BatchHeaderFixOutcome {
            repaired_profiles: repair_outcome.repaired_profiles,
            matched_without_changes: repair_outcome.matched_without_changes,
        })
    }

    fn default_trim_output_path(source: &TrimSource, extension: &str) -> PathBuf {
        let source_extension = if source.kind == TrimInputKind::RvzScrub {
            "rvz"
        } else {
            source
                .path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("bin")
        };
        let extension = extension.replace("{ext}", source_extension);
        let mut output = source.path.to_path_buf();
        output.set_extension(extension);
        output
    }

    fn trim_file(
        &self,
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
        kind: TrimInputKind,
        context: &OperationContext,
    ) -> Result<NdsTrimOutcome> {
        match kind {
            TrimInputKind::NdsFamily => {
                Self::trim_nds_file(source, destination, in_place, dry_run, operation)
            }
            TrimInputKind::Gba | TrimInputKind::ThreeDs => Self::trim_power_of_two_file(
                source,
                destination,
                in_place,
                dry_run,
                operation,
                kind,
            ),
            TrimInputKind::Xiso => {
                Self::trim_xiso_file(source, destination, in_place, dry_run, operation)
            }
            TrimInputKind::RvzScrub => {
                self.trim_rvz_scrub_file(source, destination, in_place, dry_run, operation, context)
            }
        }
    }

    fn trim_nds_file(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
    ) -> Result<NdsTrimOutcome> {
        let mutate_source = in_place || source == destination;
        let mut input = File::options()
            .read(true)
            .write(mutate_source && !dry_run)
            .open(source)?;
        let original_size = input.metadata()?.len();
        if original_size < NDS_HEADER_TOTAL_BYTES as u64 {
            return Err(RomWeaverError::Validation(format!(
                "input is too small to contain a valid NDS/DSi header: `{}`",
                source.display()
            )));
        }

        let plan = Self::read_nds_trim_plan(
            &mut input,
            original_size,
            operation == TrimOperation::Revert,
            0,
        )?;
        let (target_size, already_target_size, fill_byte) = match operation {
            TrimOperation::Trim => (
                original_size.min(plan.trimmed_size),
                original_size <= plan.trimmed_size,
                0x00_u8,
            ),
            TrimOperation::Revert => {
                let mut revert_size = Self::power_of_two_target_size_for_revert(original_size)?;
                if revert_size < plan.trimmed_size {
                    revert_size = plan.trimmed_size;
                }
                (revert_size, original_size == revert_size, 0x00_u8)
            }
        };

        if dry_run {
            return Ok(NdsTrimOutcome {
                original_size,
                result_size: target_size,
                output_path: if in_place {
                    source.to_path_buf()
                } else {
                    destination.to_path_buf()
                },
                mode: if plan.dsi_mode { "dsi" } else { "ds" },
                preserved_download_play_cert: plan.preserved_download_play_cert,
                already_target_size,
                revert_supported: true,
            });
        }

        Self::apply_file_size_target(
            source,
            destination,
            in_place,
            original_size,
            target_size,
            fill_byte,
        )?;

        Ok(NdsTrimOutcome {
            original_size,
            result_size: target_size,
            output_path: if in_place {
                source.to_path_buf()
            } else {
                destination.to_path_buf()
            },
            mode: if plan.dsi_mode { "dsi" } else { "ds" },
            preserved_download_play_cert: plan.preserved_download_play_cert,
            already_target_size,
            revert_supported: true,
        })
    }

    fn trim_power_of_two_file(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
        kind: TrimInputKind,
    ) -> Result<NdsTrimOutcome> {
        let original_size = fs::metadata(source)?.len();
        if original_size == 0 {
            return Err(RomWeaverError::Validation(format!(
                "input is empty and cannot be processed: `{}`",
                source.display()
            )));
        }

        let fill_byte = kind.default_padding_byte();
        let (target_size, already_target_size) = match operation {
            TrimOperation::Trim => {
                let trimmed_size =
                    Self::scan_trimmed_size_from_trailing_padding(source, fill_byte)?;
                (trimmed_size, trimmed_size == original_size)
            }
            TrimOperation::Revert => {
                let revert_size = Self::power_of_two_target_size_for_revert(original_size)?;
                (revert_size, revert_size == original_size)
            }
        };

        if dry_run {
            return Ok(NdsTrimOutcome {
                original_size,
                result_size: target_size,
                output_path: if in_place {
                    source.to_path_buf()
                } else {
                    destination.to_path_buf()
                },
                mode: kind.mode_label(),
                preserved_download_play_cert: false,
                already_target_size,
                revert_supported: true,
            });
        }

        Self::apply_file_size_target(
            source,
            destination,
            in_place,
            original_size,
            target_size,
            fill_byte,
        )?;

        Ok(NdsTrimOutcome {
            original_size,
            result_size: target_size,
            output_path: if in_place {
                source.to_path_buf()
            } else {
                destination.to_path_buf()
            },
            mode: kind.mode_label(),
            preserved_download_play_cert: false,
            already_target_size,
            revert_supported: true,
        })
    }

    fn trim_xiso_file(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
    ) -> Result<NdsTrimOutcome> {
        if operation == TrimOperation::Revert {
            return Err(RomWeaverError::Validation(
                "xiso trim revert is not supported; trimmed padding cannot be reconstructed"
                    .to_string(),
            ));
        }

        let original_size = fs::metadata(source)?.len();
        if original_size == 0 {
            return Err(RomWeaverError::Validation(format!(
                "input is empty and cannot be processed: `{}`",
                source.display()
            )));
        }

        if dry_run {
            let result_size = Self::measure_trimmed_xiso_size(source).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "xiso trim simulation failed while rebuilding `{}`: {error}",
                    source.display()
                ))
            })?;
            return Ok(NdsTrimOutcome {
                original_size,
                result_size,
                output_path: if in_place {
                    source.to_path_buf()
                } else {
                    destination.to_path_buf()
                },
                mode: TrimInputKind::Xiso.mode_label(),
                preserved_download_play_cert: false,
                already_target_size: result_size == original_size,
                revert_supported: false,
            });
        }

        if in_place || source == destination {
            let temp_path = Self::temporary_xiso_trim_path(source);
            Self::create_trimmed_xiso(source, &temp_path)?;
            if let Err(rename_error) = fs::rename(&temp_path, source) {
                fs::copy(&temp_path, source).map_err(|copy_error| {
                    RomWeaverError::Validation(format!(
                        "failed to replace `{}` with trimmed xiso (rename error: {rename_error}; copy fallback error: {copy_error})",
                        source.display()
                    ))
                })?;
                fs::remove_file(&temp_path).ok();
            }
            let result_size = fs::metadata(source)?.len();
            return Ok(NdsTrimOutcome {
                original_size,
                result_size,
                output_path: source.to_path_buf(),
                mode: TrimInputKind::Xiso.mode_label(),
                preserved_download_play_cert: false,
                already_target_size: result_size == original_size,
                revert_supported: false,
            });
        }

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        Self::create_trimmed_xiso(source, destination)?;
        let result_size = fs::metadata(destination)?.len();
        Ok(NdsTrimOutcome {
            original_size,
            result_size,
            output_path: destination.to_path_buf(),
            mode: TrimInputKind::Xiso.mode_label(),
            preserved_download_play_cert: false,
            already_target_size: result_size == original_size,
            revert_supported: false,
        })
    }

    fn trim_rvz_scrub_file(
        &self,
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
        context: &OperationContext,
    ) -> Result<NdsTrimOutcome> {
        if operation == TrimOperation::Revert {
            return Err(RomWeaverError::Validation(
                "rvz-scrub trim revert is not supported; original source container layout cannot be reconstructed"
                    .to_string(),
            ));
        }

        let original_size = fs::metadata(source)?.len();
        if original_size == 0 {
            return Err(RomWeaverError::Validation(format!(
                "input is empty and cannot be processed: `{}`",
                source.display()
            )));
        }

        if dry_run {
            let result_size = self
                .measure_rvz_scrubbed_size(source, context)
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "rvz-scrub trim simulation failed while rebuilding `{}`: {error}",
                        source.display()
                    ))
                })?;
            return Ok(NdsTrimOutcome {
                original_size,
                result_size,
                output_path: if in_place {
                    source.to_path_buf()
                } else {
                    destination.to_path_buf()
                },
                mode: TrimInputKind::RvzScrub.mode_label(),
                preserved_download_play_cert: false,
                already_target_size: result_size == original_size,
                revert_supported: false,
            });
        }

        if in_place || source == destination {
            return Err(RomWeaverError::Validation(
                "rvz-scrub trim requires a separate output file; in-place replacement is not supported"
                    .to_string(),
            ));
        }

        self.create_rvz_scrubbed_output(source, destination, context)?;
        let result_size = fs::metadata(destination)?.len();
        Ok(NdsTrimOutcome {
            original_size,
            result_size,
            output_path: destination.to_path_buf(),
            mode: TrimInputKind::RvzScrub.mode_label(),
            preserved_download_play_cert: false,
            already_target_size: result_size == original_size,
            revert_supported: false,
        })
    }

    fn create_rvz_scrubbed_output(
        &self,
        source: &Path,
        destination: &Path,
        context: &OperationContext,
    ) -> Result<()> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let handler = self.containers.find_by_name("rvz").ok_or_else(|| {
            RomWeaverError::Unsupported(
                "rvz handler is not registered; rvz-scrub trim is unavailable".to_string(),
            )
        })?;
        handler
            .create(
                &ContainerCreateRequest {
                    inputs: vec![source.to_path_buf()],
                    output: destination.to_path_buf(),
                    format: "rvz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "rvz-scrub trim failed while rebuilding `{}`: {error}",
                    source.display()
                ))
            })?;
        Ok(())
    }

    fn measure_rvz_scrubbed_size(&self, source: &Path, context: &OperationContext) -> Result<u64> {
        let handler = self.containers.find_by_name("rvz").ok_or_else(|| {
            RomWeaverError::Unsupported(
                "rvz handler is not registered; rvz-scrub trim is unavailable".to_string(),
            )
        })?;
        handler
            .create_dry_run_size(
                &ContainerCreateRequest {
                    inputs: vec![source.to_path_buf()],
                    output: source.with_extension("rvz"),
                    format: "rvz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "rvz-scrub trim simulation failed while rebuilding `{}`: {error}",
                    source.display()
                ))
            })
    }

    fn open_xiso_trim_source_filesystem(source_path: &Path) -> Result<XisoTrimSourceFilesystem> {
        let source_file = File::options()
            .read(true)
            .open(source_path)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open xiso source `{}`: {error}",
                    source_path.display()
                ))
            })?;
        let source_reader = BufReader::new(source_file);
        let source_device = XdvdfsOffsetWrapper::new(source_reader).map_err(|error| {
            RomWeaverError::Validation(format!(
                "source `{}` is not an Xbox XDVDFS image (raw/XGD probe failed: {error})",
                source_path.display()
            ))
        })?;
        XdvdfsFilesystem::new(source_device).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "source `{}` could not be read as an XDVDFS filesystem",
                source_path.display()
            ))
        })
    }

    fn create_trimmed_xiso(source: &Path, destination: &Path) -> Result<()> {
        let mut source_fs = Self::open_xiso_trim_source_filesystem(source)?;
        let output = File::create(destination)?;
        let mut output = BufWriter::new(output);
        create_xdvdfs_image(&mut source_fs, &mut output, |_| {}).map_err(|error| {
            RomWeaverError::Validation(format!(
                "xiso trim failed while rebuilding `{}`: {error}",
                source.display()
            ))
        })?;
        output.flush()?;
        Ok(())
    }

    fn measure_trimmed_xiso_size(source: &Path) -> Result<u64> {
        let mut source_fs = Self::open_xiso_trim_source_filesystem(source)?;
        let mut sink = XisoMeasuredLengthSink::default();
        create_xdvdfs_image(&mut source_fs, &mut sink, |_| {}).map_err(|error| {
            RomWeaverError::Validation(format!(
                "xiso trim failed while rebuilding `{}`: {error}",
                source.display()
            ))
        })?;
        Ok(sink.output_len())
    }

    fn temporary_xiso_trim_path(source: &Path) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let name = source
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "xiso".to_string());
        let temp_name = format!(
            ".{name}.{}-{}-{timestamp}",
            XISO_TRIM_TEMP_SUFFIX,
            Self::runtime_process_id()
        );
        source
            .parent()
            .map(|parent| parent.join(&temp_name))
            .unwrap_or_else(|| PathBuf::from(temp_name))
    }

    fn temporary_header_fix_path(source: &Path) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let name = source
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "header-fix".to_string());
        let temp_name = format!(
            ".{name}.rom-weaver-header-fix-dry-run.tmp-{}-{timestamp}",
            Self::runtime_process_id()
        );
        source
            .parent()
            .map(|parent| parent.join(&temp_name))
            .unwrap_or_else(|| PathBuf::from(temp_name))
    }

    fn apply_file_size_target(
        source: &Path,
        destination: &Path,
        in_place: bool,
        original_size: u64,
        target_size: u64,
        fill_byte: u8,
    ) -> Result<()> {
        if in_place || source == destination {
            let mut input = File::options().read(true).write(true).open(source)?;
            if target_size < original_size {
                input.set_len(target_size)?;
            } else if target_size > original_size {
                input.seek(SeekFrom::Start(original_size))?;
                Self::write_padding_bytes(&mut input, target_size - original_size, fill_byte)?;
            }
            return Ok(());
        }

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut input = BufReader::new(File::open(source)?);
        let mut output = BufWriter::new(File::create(destination)?);
        let copy_len = original_size.min(target_size);
        io::copy(
            &mut std::io::Read::by_ref(&mut input).take(copy_len),
            &mut output,
        )?;
        if target_size > copy_len {
            Self::write_padding_bytes(&mut output, target_size - copy_len, fill_byte)?;
        }
        output.flush()?;
        Ok(())
    }

    fn write_padding_bytes(writer: &mut dyn Write, length: u64, fill_byte: u8) -> io::Result<()> {
        if length == 0 {
            return Ok(());
        }

        let chunk = [fill_byte; 8192];
        let mut remaining = length;
        while remaining > 0 {
            let write_len =
                usize::try_from(remaining.min(chunk.len() as u64)).unwrap_or(chunk.len());
            writer.write_all(&chunk[..write_len])?;
            remaining -= write_len as u64;
        }
        Ok(())
    }

    fn scan_trimmed_size_from_trailing_padding(path: &Path, fill_byte: u8) -> Result<u64> {
        Self::scan_trimmed_size_from_trailing_padding_from_offset(path, fill_byte, 0)
    }

    fn scan_trimmed_size_from_trailing_padding_from_offset(
        path: &Path,
        fill_byte: u8,
        start_offset: u64,
    ) -> Result<u64> {
        let mut input = File::open(path)?;
        let file_size = input.metadata()?.len();
        if file_size == 0 || start_offset >= file_size {
            return Ok(0);
        }

        let mut cursor = file_size;
        let mut buffer = vec![0_u8; TRIM_BINARY_SCAN_CHUNK_BYTES];
        while cursor > start_offset {
            let remaining = cursor.saturating_sub(start_offset);
            let read_len = usize::try_from(remaining.min(TRIM_BINARY_SCAN_CHUNK_BYTES as u64))
                .unwrap_or(TRIM_BINARY_SCAN_CHUNK_BYTES);
            cursor -= read_len as u64;
            input.seek(SeekFrom::Start(cursor))?;
            input.read_exact(&mut buffer[..read_len])?;
            for (offset, byte) in buffer[..read_len].iter().enumerate().rev() {
                if *byte != fill_byte {
                    return Ok(cursor + offset as u64 + 1 - start_offset);
                }
            }
        }

        Ok(1)
    }

    fn power_of_two_target_size_for_revert(size: u64) -> Result<u64> {
        if size == 0 {
            return Err(RomWeaverError::Validation(
                "cannot revert an empty file".to_string(),
            ));
        }
        size.checked_next_power_of_two().ok_or_else(|| {
            RomWeaverError::Validation("file is too large to revert safely".to_string())
        })
    }

    fn read_nds_trim_plan(
        input: &mut File,
        file_size: u64,
        allow_boundary_past_eof: bool,
        start_offset: u64,
    ) -> Result<NdsTrimPlan> {
        let mut header = vec![0_u8; NDS_HEADER_TOTAL_BYTES];
        input.seek(SeekFrom::Start(start_offset))?;
        input.read_exact(&mut header)?;
        Self::validate_nds_header(&header)?;

        let unit_code = header[NDS_HEADER_UNIT_CODE_OFFSET];
        let dsi_mode = unit_code != 0x00;
        let ntr_rom_size = u64::from(Self::read_u32_le(
            &header,
            NDS_HEADER_NTR_ROM_SIZE_OFFSET,
            "NTR ROM size",
        )?);
        let ntr_twl_rom_size = u64::from(Self::read_u32_le(
            &header,
            NDS_HEADER_NTR_TWL_ROM_SIZE_OFFSET,
            "NTR+TWL ROM size",
        )?);

        let mut trimmed_size = if dsi_mode {
            ntr_twl_rom_size
        } else {
            ntr_rom_size
        };
        if trimmed_size == 0 {
            return Err(RomWeaverError::Validation(
                "NDS header reported a zero trim boundary".into(),
            ));
        }

        let mut preserved_download_play_cert = false;
        if !dsi_mode && trimmed_size + 2 <= file_size {
            input.seek(SeekFrom::Start(start_offset.saturating_add(trimmed_size)))?;
            let mut cert_magic = [0_u8; 2];
            input.read_exact(&mut cert_magic)?;
            if cert_magic == NDS_DOWNLOAD_PLAY_CERT_MAGIC {
                trimmed_size = trimmed_size.saturating_add(NDS_DOWNLOAD_PLAY_CERT_SIZE_BYTES);
                preserved_download_play_cert = true;
            }
        }

        if trimmed_size > file_size && !allow_boundary_past_eof {
            return Err(RomWeaverError::Validation(format!(
                "trim boundary ({trimmed_size} byte(s)) exceeds input size ({file_size} byte(s)); input may already be incorrectly trimmed or corrupt"
            )));
        }

        Ok(NdsTrimPlan {
            trimmed_size,
            dsi_mode,
            preserved_download_play_cert,
        })
    }

    fn validate_nds_header(header: &[u8]) -> Result<()> {
        if header.len() < NDS_HEADER_TOTAL_BYTES {
            return Err(RomWeaverError::Validation(
                "NDS header buffer is truncated".into(),
            ));
        }

        let header_size = Self::read_u32_le(header, NDS_HEADER_HEADER_SIZE_OFFSET, "header size")?;
        if header_size < 0x160 {
            return Err(RomWeaverError::Validation(format!(
                "invalid NDS header size {header_size:#X}; expected at least 0x160"
            )));
        }

        let logo = &header[NDS_HEADER_LOGO_OFFSET..NDS_HEADER_LOGO_OFFSET + NDS_HEADER_LOGO_LENGTH];
        let expected_logo_crc = Self::read_u16_le(header, NDS_HEADER_LOGO_CRC_OFFSET, "logo CRC")?;
        let calculated_logo_crc = Self::nds_crc16(logo);
        if expected_logo_crc != calculated_logo_crc {
            return Err(RomWeaverError::Validation(format!(
                "NDS logo CRC mismatch: expected {expected_logo_crc:04X}, got {calculated_logo_crc:04X}"
            )));
        }

        let expected_header_crc = Self::read_u16_le(header, NDS_HEADER_CRC_OFFSET, "header CRC")?;
        let calculated_header_crc = Self::nds_crc16(&header[..NDS_HEADER_CRC_OFFSET]);
        if expected_header_crc != calculated_header_crc {
            return Err(RomWeaverError::Validation(format!(
                "NDS header CRC mismatch: expected {expected_header_crc:04X}, got {calculated_header_crc:04X}"
            )));
        }

        Ok(())
    }

    fn nds_crc16(bytes: &[u8]) -> u16 {
        let mut crc = 0xFFFF_u16;
        for byte in bytes {
            crc ^= u16::from(*byte);
            for _ in 0..8 {
                let carry = (crc & 1) != 0;
                crc >>= 1;
                if carry {
                    crc ^= 0xA001;
                }
            }
        }
        crc
    }

    fn read_u16_le(buffer: &[u8], offset: usize, label: &str) -> Result<u16> {
        let bytes = buffer.get(offset..offset + 2).ok_or_else(|| {
            RomWeaverError::Validation(format!("missing {label} bytes at offset 0x{offset:X}"))
        })?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn read_u32_le(buffer: &[u8], offset: usize, label: &str) -> Result<u32> {
        let bytes = buffer.get(offset..offset + 4).ok_or_else(|| {
            RomWeaverError::Validation(format!("missing {label} bytes at offset 0x{offset:X}"))
        })?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn append_entry_list_label(base: &str, entries: &[String]) -> String {
        if entries.is_empty() {
            return format!("{base}; selectable entries: (none)");
        }
        format!(
            "{base}; selectable entries ({}): {}",
            entries.len(),
            entries.join(", ")
        )
    }

    fn inspect_compress_recommendation(
        &self,
        source: &Path,
    ) -> Option<CompressFormatRecommendation> {
        if source.is_file() {
            Some(self.containers.recommend_compress_format(source))
        } else {
            None
        }
    }

    fn append_recommended_compress_label(
        mut report: OperationReport,
        recommendation: Option<&CompressFormatRecommendation>,
    ) -> OperationReport {
        if let Some(recommendation) = recommendation {
            report.label =
                Self::append_compress_recommendation_label(&report.label, recommendation);
        }
        report
    }

    fn attach_container_inspect_details(
        mut report: OperationReport,
        listed_entries: Option<Vec<String>>,
        recommendation: Option<&CompressFormatRecommendation>,
    ) -> OperationReport {
        if report.status != OperationStatus::Succeeded {
            return report;
        }

        let mut details = match report.details.take() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let mut container = match details.remove("container") {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };

        let entry_count = listed_entries.as_ref().map(Vec::len);
        container.insert(
            "entry_count".to_string(),
            entry_count.map_or(Value::Null, |value| json!(value)),
        );
        if let Some(entries) = listed_entries {
            container.insert("entries".to_string(), json!(entries));
        }
        if let Some(recommendation) = recommendation {
            container.insert(
                "recommended_compress_format".to_string(),
                json!(recommendation.format_name),
            );
            container.insert("reason".to_string(), json!(recommendation.reason));
        }

        details.insert("container".to_string(), Value::Object(container));
        report.details = Some(Value::Object(details));
        report
    }

    fn attach_patch_inspect_details(mut report: OperationReport) -> OperationReport {
        if report.status != OperationStatus::Succeeded {
            return report;
        }

        let mut details = match report.details.take() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let mut patch = match details.remove("patch") {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };

        patch.entry("format".to_string()).or_insert_with(|| {
            report
                .format
                .as_ref()
                .map_or(Value::Null, |format| json!(format))
        });
        for field in [
            "source_size",
            "target_size",
            "source_crc32",
            "target_crc32",
            "patch_crc32",
            "record_count",
        ] {
            patch.entry(field.to_string()).or_insert(Value::Null);
        }

        details.insert("patch".to_string(), Value::Object(patch));
        report.details = Some(Value::Object(details));
        report
    }

}
