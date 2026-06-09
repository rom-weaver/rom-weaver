use super::selection_resolution::SelectionExtract;
use super::*;
/// The mode/operation settings for a single trim operation, grouped so `trim_file` takes one
/// request descriptor instead of four positional flags.
#[derive(Clone, Copy)]
pub(super) struct TrimRequest {
    pub(super) in_place: bool,
    pub(super) dry_run: bool,
    pub(super) operation: TrimOperation,
    pub(super) kind: TrimInputKind,
    /// When set on a trim, append a small revert footer recording the original size and padding
    /// byte so the file can later be reverted to a byte-identical original.
    pub(super) revert_marker: bool,
}

// Revert footer format: see `docs/trim-revert-footer.md` for the full specification.
/// 4-byte magic + version identifying a rom-weaver revert footer (`"RWT"` + version `0x01`).
pub(super) const REVERT_FOOTER_MAGIC: &[u8; 4] = b"RWT\x01";
/// Total on-disk size of the revert footer: magic+version(4) + pad_byte(1) + pad_len(5, 40-bit LE)
/// + crc32(4).
pub(super) const REVERT_FOOTER_LEN: u64 = 14;
/// Maximum padding length the 40-bit `pad_len` field can encode (1 TiB, far beyond any cartridge).
pub(super) const REVERT_FOOTER_MAX_PAD_LEN: u64 = (1 << 40) - 1;

/// Metadata recovered from a revert footer: enough to reconstruct the original file byte-for-byte.
#[derive(Clone, Copy, Debug)]
pub(super) struct RevertFooter {
    original_size: u64,
    pad_byte: u8,
}

impl CliApp {
    pub(super) fn format_mode_counts(mode_counts: &BTreeMap<&'static str, usize>) -> String {
        if mode_counts.is_empty() {
            return "none".to_string();
        }

        mode_counts
            .iter()
            .map(|(mode, count)| format!("{mode}:{count}"))
            .collect::<Vec<_>>()
            .join(",")
    }

    pub(super) fn trim_fix_eligible_kind_for_path(&self, path: &Path) -> Option<TrimInputKind> {
        if let Some(kind) = TrimInputKind::from_path(path) {
            return Some(kind);
        }

        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("iso"))
            && let Ok(source_file) = File::options().read(true).open(path)
        {
            let source_reader = BufReader::new(source_file);
            if XdvdfsOffsetWrapper::new(source_reader).is_ok() {
                return Some(TrimInputKind::Xiso);
            }
        }

        None
    }

    pub(super) fn trim_eligible_kind_for_path(&self, path: &Path) -> Option<TrimInputKind> {
        if let Some(kind) = self.trim_fix_eligible_kind_for_path(path) {
            return Some(kind);
        }

        if self.is_rvz_scrub_candidate(path) {
            return Some(TrimInputKind::RvzScrub);
        }

        None
    }

    pub(super) fn is_rvz_scrub_candidate(&self, path: &Path) -> bool {
        let recommendation = self.containers.recommend_compress_format(path);
        recommendation.format_name.eq_ignore_ascii_case("rvz")
    }

    pub(super) fn read_checksum_trim_plan_with_offset(
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

    pub(super) fn collect_trim_input_files(
        &self,
        sources: &[PathBuf],
        options: TrimCollectOptions<'_>,
        cleanup_paths: &mut Vec<PathBuf>,
        skipped_unsupported: &mut usize,
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
                self.collect_trim_file(
                    source,
                    options,
                    &mut files,
                    cleanup_paths,
                    skipped_unsupported,
                )?;
                continue;
            }
            if metadata.is_dir() {
                self.collect_trim_directory_files(
                    source,
                    options,
                    &mut files,
                    cleanup_paths,
                    skipped_unsupported,
                )?;
                continue;
            }

            *skipped_unsupported = skipped_unsupported.saturating_add(1);
        }

        files.sort_by(|left, right| left.path.cmp(&right.path));
        files.dedup_by(|left, right| left.path == right.path);
        Ok(files)
    }

    /// Resolve a single file input into trim sources: a directly trim-eligible file becomes one
    /// source, otherwise an extractable archive is unpacked and its trim-eligible payloads are
    /// added. Anything else increments the unsupported counter.
    pub(super) fn collect_trim_file(
        &self,
        path: &Path,
        options: TrimCollectOptions<'_>,
        files: &mut Vec<TrimSource>,
        cleanup_paths: &mut Vec<PathBuf>,
        skipped_unsupported: &mut usize,
    ) -> Result<()> {
        if let Some(kind) = self.trim_eligible_kind_for_path(path) {
            files.push(TrimSource {
                path: path.to_path_buf(),
                kind,
                archive_origin: None,
                repack_root: None,
            });
            return Ok(());
        }

        if options.no_extract {
            *skipped_unsupported = skipped_unsupported.saturating_add(1);
            return Ok(());
        }

        let extracted = if options.in_place {
            self.extract_trim_repack_payload(path, options, cleanup_paths)?
        } else {
            self.extract_trim_payloads(path, options, cleanup_paths)?
        };
        if extracted.is_empty() {
            *skipped_unsupported = skipped_unsupported.saturating_add(1);
        } else {
            files.extend(extracted);
        }
        Ok(())
    }

    pub(super) fn collect_trim_directory_files(
        &self,
        root: &Path,
        options: TrimCollectOptions<'_>,
        files: &mut Vec<TrimSource>,
        cleanup_paths: &mut Vec<PathBuf>,
        skipped_unsupported: &mut usize,
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
                    if options.recursive {
                        directories.push(path);
                    }
                    continue;
                }
                if !file_type.is_file() {
                    *skipped_unsupported = skipped_unsupported.saturating_add(1);
                    continue;
                }
                self.collect_trim_file(&path, options, files, cleanup_paths, skipped_unsupported)?;
            }
        }
        Ok(())
    }

    /// Extract an archive (recursively, bounded) into temporary directories and return only the
    /// payloads whose type trim actually supports. Temp directories are recorded in
    /// `cleanup_paths` so the caller can remove them after trimming completes.
    pub(super) fn extract_trim_payloads(
        &self,
        archive: &Path,
        options: TrimCollectOptions<'_>,
        cleanup_paths: &mut Vec<PathBuf>,
    ) -> Result<Vec<TrimSource>> {
        let kind_filter = ArchiveEntryKindFilter::new(options.rom_filter, false);
        let mut found = Vec::new();
        let mut queue = VecDeque::new();
        queue.push_back((archive.to_path_buf(), 1usize));
        let mut extracted_archives = 0usize;

        while let Some((current, depth)) = queue.pop_front() {
            if depth > MAX_NESTED_EXTRACT_DEPTH {
                return Err(RomWeaverError::Validation(format!(
                    "trim extract exceeded max depth of {MAX_NESTED_EXTRACT_DEPTH} at `{}`",
                    current.display()
                )));
            }
            if extracted_archives >= MAX_NESTED_EXTRACT_ARCHIVES {
                return Err(RomWeaverError::Validation(format!(
                    "trim extract exceeded max archive count of {MAX_NESTED_EXTRACT_ARCHIVES}"
                )));
            }

            let Some(handler) = self.containers.probe(&current) else {
                continue;
            };
            if handler.descriptor().matches_name("xiso") || !handler.capabilities().extract {
                continue;
            }
            // Only extract sources that genuinely probe as a container, so extension-only matches
            // on non-container payloads do not abort the batch.
            let probe_request = ContainerProbeRequest {
                source: current.clone(),
                split_bin: false,
            };
            if handler
                .probe_details(&probe_request, options.context)
                .is_err()
            {
                continue;
            }

            let out_dir = options.context.temp_paths().next_path("trim-extract", None);
            fs::create_dir_all(&out_dir)?;
            cleanup_paths.push(out_dir.clone());
            trace!(
                archive = %archive.display(),
                source = %current.display(),
                format = handler.descriptor().name,
                out_dir = %out_dir.display(),
                depth,
                rom_filter = options.rom_filter,
                "extracting archive for trim"
            );
            self.extract_with_selection_fallback(
                handler.as_ref(),
                &current,
                SelectionExtract {
                    out_dir: &out_dir,
                    selections: &[],
                    kind_filter,
                    split_bin: false,
                    ignore_common_files: true,
                    overwrite: true,
                    source_label: "trim",
                    allow_multi_select: false,
                },
                options.context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "trim payload extraction failed for `{}` ({}): {error}",
                    current.display(),
                    handler.descriptor().name
                ))
            })?;
            extracted_archives = extracted_archives.saturating_add(1);

            for candidate in self.collect_checksum_extract_candidates(&out_dir)? {
                if candidate.ignored {
                    continue;
                }
                if let Some(kind) = self.trim_eligible_kind_for_path(&candidate.source) {
                    trace!(
                        archive = %archive.display(),
                        payload = %candidate.source.display(),
                        kind = kind.mode_label(),
                        "found trim-eligible payload in archive"
                    );
                    found.push(TrimSource {
                        path: candidate.source,
                        kind,
                        archive_origin: Some(archive.to_path_buf()),
                        repack_root: None,
                    });
                } else if self.containers.probe(&candidate.source).is_some() {
                    queue.push_back((candidate.source, depth + 1));
                }
            }
        }

        Ok(found)
    }

    /// Extract an archive's full contents (all non-junk files preserved) into a temp directory so
    /// `--in-place` can trim the ROM and recompress the directory back over the original archive.
    /// Only a single top-level trim-eligible ROM is supported; deeper or multiple ROMs are
    /// rejected so the repack stays unambiguous.
    pub(super) fn extract_trim_repack_payload(
        &self,
        archive: &Path,
        options: TrimCollectOptions<'_>,
        cleanup_paths: &mut Vec<PathBuf>,
    ) -> Result<Vec<TrimSource>> {
        let Some(handler) = self.containers.probe(archive) else {
            return Ok(Vec::new());
        };
        if handler.descriptor().matches_name("xiso") || !handler.capabilities().extract {
            return Ok(Vec::new());
        }
        let probe_request = ContainerProbeRequest {
            source: archive.to_path_buf(),
            split_bin: false,
        };
        if handler
            .probe_details(&probe_request, options.context)
            .is_err()
        {
            return Ok(Vec::new());
        }
        if !handler.capabilities().create {
            return Err(RomWeaverError::Validation(format!(
                "--in-place is not supported for `{}`: the `{}` format cannot be recreated; omit --in-place to write the trimmed ROM beside the archive",
                archive.display(),
                handler.descriptor().name
            )));
        }

        let out_dir = options.context.temp_paths().next_path("trim-repack", None);
        fs::create_dir_all(&out_dir)?;
        cleanup_paths.push(out_dir.clone());
        trace!(
            archive = %archive.display(),
            format = handler.descriptor().name,
            out_dir = %out_dir.display(),
            "extracting full archive contents for in-place trim repack"
        );
        // Preserve every file faithfully: disable both the ROM kind filter and common-file ignores
        // so nothing is dropped from the rebuilt archive. The presence of non-ROM files is what
        // gates an in-place repack behind confirmation.
        self.extract_with_selection_fallback(
            handler.as_ref(),
            archive,
            SelectionExtract {
                out_dir: &out_dir,
                selections: &[],
                kind_filter: ArchiveEntryKindFilter::new(false, false),
                split_bin: false,
                ignore_common_files: false,
                overwrite: true,
                source_label: "trim",
                allow_multi_select: false,
            },
            options.context,
        )
        .map_err(|error| {
            RomWeaverError::Validation(format!(
                "trim repack extraction failed for `{}` ({}): {error}",
                archive.display(),
                handler.descriptor().name
            ))
        })?;

        let mut roms = Vec::new();
        for candidate in self.collect_checksum_extract_candidates(&out_dir)? {
            if candidate.ignored {
                continue;
            }
            if let Some(kind) = self.trim_eligible_kind_for_path(&candidate.source) {
                roms.push((candidate.source, kind));
            }
        }

        if roms.len() > 1 {
            return Err(RomWeaverError::Validation(format!(
                "--in-place repack found {} trim-eligible ROMs in `{}`; in-place repacking supports a single ROM per archive",
                roms.len(),
                archive.display()
            )));
        }

        Ok(roms
            .into_iter()
            .map(|(path, kind)| TrimSource {
                path,
                kind,
                archive_origin: Some(archive.to_path_buf()),
                repack_root: Some(out_dir.clone()),
            })
            .collect())
    }

    pub(super) fn collect_batch_header_fix_input_files(
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

    pub(super) fn collect_batch_header_fix_directory_files(
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

    pub(super) fn header_fix_candidate_for_path(path: &Path) -> bool {
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            return false;
        };
        HEADER_FIXER_SUPPORTED_EXTENSIONS
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(extension))
    }

    pub(super) fn default_batch_header_fix_output_path(source: &Path, extension: &str) -> PathBuf {
        let source_extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("bin");
        let extension = extension.replace("{ext}", source_extension);
        let mut output = source.to_path_buf();
        output.set_extension(extension);
        output
    }

    pub(super) fn fix_headers_for_file(
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

    pub(super) fn default_trim_output_path(source: &TrimSource, extension: &str) -> PathBuf {
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

    /// Side-by-side output for an archive-extracted payload: places the trimmed ROM next to the
    /// original archive using the payload's base name and resolved extension.
    pub(super) fn archive_sidecar_trim_output_path(
        archive: &Path,
        source: &TrimSource,
        extension: &str,
    ) -> PathBuf {
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
        let directory = archive
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let stem = source
            .path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("trimmed");
        let mut output = directory.join(stem);
        output.set_extension(extension);
        output
    }

    pub(super) fn trim_file(
        &self,
        source: &Path,
        destination: &Path,
        request: TrimRequest,
        context: &OperationContext,
    ) -> Result<NdsTrimOutcome> {
        let TrimRequest {
            in_place,
            dry_run,
            operation,
            kind,
            revert_marker,
        } = request;

        // A revert footer, when present, fully describes the original file, so it takes precedence
        // over the per-format revert heuristics and reconstructs the original byte-for-byte.
        if operation == TrimOperation::Revert
            && let Some(footer) = Self::read_revert_footer(source)?
        {
            return Self::revert_with_footer(source, destination, in_place, dry_run, kind, footer);
        }

        let outcome = match kind {
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
        }?;

        // Embed the revert footer only when an actual trim happened, so a clean ROM is never grown
        // pointlessly and the footer always carries a real original size to restore.
        if operation == TrimOperation::Trim
            && revert_marker
            && !dry_run
            && !outcome.already_target_size
        {
            let pad_byte = Self::detect_trailing_pad_byte(source)?.unwrap_or(0xFF);
            Self::write_revert_footer(&outcome.output_path, outcome.original_size, pad_byte)?;
        }

        Ok(outcome)
    }

    /// Reconstruct the original file from a trimmed file that carries a revert footer: drop the
    /// footer, then pad back to the recorded original size with the recorded padding byte.
    pub(super) fn revert_with_footer(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        kind: TrimInputKind,
        footer: RevertFooter,
    ) -> Result<NdsTrimOutcome> {
        let file_size = fs::metadata(source)?.len();
        let data_size = file_size.saturating_sub(REVERT_FOOTER_LEN);
        let RevertFooter {
            original_size,
            pad_byte,
        } = footer;
        if original_size < data_size {
            return Err(RomWeaverError::Validation(format!(
                "revert footer in `{}` records an original size smaller than the trimmed data",
                source.display()
            )));
        }

        let output_path = if in_place {
            source.to_path_buf()
        } else {
            destination.to_path_buf()
        };

        if dry_run {
            return Ok(NdsTrimOutcome {
                original_size: file_size,
                result_size: original_size,
                output_path,
                mode: kind.mode_label(),
                preserved_download_play_cert: false,
                already_target_size: false,
                revert_supported: true,
            });
        }

        if in_place || source == destination {
            let mut file = File::options().read(true).write(true).open(source)?;
            file.set_len(data_size)?; // drop the footer first
            file.seek(SeekFrom::Start(data_size))?;
            Self::write_padding_bytes(&mut file, original_size - data_size, pad_byte)?;
            file.flush()?;
        } else {
            // apply_file_size_target copies min(data_size, original_size) = data_size bytes, which
            // naturally excludes the trailing footer, then pads up to the original size.
            Self::apply_file_size_target(
                source,
                destination,
                false,
                data_size,
                original_size,
                pad_byte,
            )?;
        }

        Ok(NdsTrimOutcome {
            original_size: file_size,
            result_size: original_size,
            output_path,
            mode: kind.mode_label(),
            preserved_download_play_cert: false,
            already_target_size: false,
            revert_supported: true,
        })
    }

    pub(super) fn trim_nds_file(
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
                // NDS carts pad unused trailing space with 0xFF, so revert must restore 0xFF to
                // reproduce the original dump (and match No-Intro checksums).
                (revert_size, original_size == revert_size, 0xFF_u8)
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

    pub(super) fn trim_power_of_two_file(
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
                // Detect the actual trailing pad byte (0x00 or 0xFF) so both conventions trim,
                // instead of assuming a single fixed fill. Files that do not end in recognizable
                // padding are left untouched.
                match Self::detect_trailing_pad_byte(source)? {
                    Some(pad_byte) => {
                        let trimmed_size =
                            Self::scan_trimmed_size_from_trailing_padding(source, pad_byte)?;
                        (trimmed_size, trimmed_size == original_size)
                    }
                    None => (original_size, true),
                }
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

    pub(super) fn trim_xiso_file(
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

    pub(super) fn trim_rvz_scrub_file(
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

    pub(super) fn create_rvz_scrubbed_output(
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

    pub(super) fn measure_rvz_scrubbed_size(
        &self,
        source: &Path,
        context: &OperationContext,
    ) -> Result<u64> {
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

    pub(super) fn open_xiso_trim_source_filesystem(
        source_path: &Path,
    ) -> Result<XisoTrimSourceFilesystem> {
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

    pub(super) fn create_trimmed_xiso(source: &Path, destination: &Path) -> Result<()> {
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

    pub(super) fn measure_trimmed_xiso_size(source: &Path) -> Result<u64> {
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

    pub(super) fn temporary_xiso_trim_path(source: &Path) -> PathBuf {
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

    pub(super) fn temporary_header_fix_path(source: &Path) -> PathBuf {
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

    pub(super) fn apply_file_size_target(
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

    pub(super) fn write_padding_bytes(
        writer: &mut dyn Write,
        length: u64,
        fill_byte: u8,
    ) -> io::Result<()> {
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

    pub(super) fn scan_trimmed_size_from_trailing_padding(
        path: &Path,
        fill_byte: u8,
    ) -> Result<u64> {
        Self::scan_trimmed_size_from_trailing_padding_from_offset(path, fill_byte, 0)
    }

    /// CRC32 (IEEE) over a small buffer, used to validate the revert footer without pulling in a
    /// dependency. Bitwise form is fine for the 24-byte footer body.
    pub(super) fn revert_footer_crc32(bytes: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    /// Append a revert footer recording the padding length and byte so a later `--revert` can
    /// reconstruct the original file exactly. `path` must already hold the trimmed data only.
    pub(super) fn write_revert_footer(path: &Path, original_size: u64, pad_byte: u8) -> Result<()> {
        let data_size = fs::metadata(path)?.len();
        let pad_len = original_size.saturating_sub(data_size);
        if pad_len > REVERT_FOOTER_MAX_PAD_LEN {
            return Err(RomWeaverError::Validation(format!(
                "padding length {pad_len} is too large for a revert footer in `{}`",
                path.display()
            )));
        }

        let mut footer = Vec::with_capacity(REVERT_FOOTER_LEN as usize);
        footer.extend_from_slice(REVERT_FOOTER_MAGIC);
        footer.push(pad_byte);
        footer.extend_from_slice(&pad_len.to_le_bytes()[0..5]); // 40-bit little-endian
        let crc = Self::revert_footer_crc32(&footer);
        footer.extend_from_slice(&crc.to_le_bytes());
        debug_assert_eq!(footer.len() as u64, REVERT_FOOTER_LEN);

        let mut file = File::options().append(true).open(path)?;
        file.write_all(&footer)?;
        file.flush()?;
        trace!(
            path = %path.display(),
            original_size,
            pad_len,
            pad_byte,
            "appended revert footer"
        );
        Ok(())
    }

    /// Read and validate a revert footer from the end of a file. Returns `None` when the file is
    /// too small or the trailing bytes are not a valid footer (magic + CRC must both match). The
    /// reconstructed original size is derived from the data length plus the recorded padding.
    pub(super) fn read_revert_footer(path: &Path) -> Result<Option<RevertFooter>> {
        let mut file = File::open(path)?;
        let file_size = file.metadata()?.len();
        if file_size < REVERT_FOOTER_LEN {
            return Ok(None);
        }
        file.seek(SeekFrom::Start(file_size - REVERT_FOOTER_LEN))?;
        let mut buffer = [0_u8; REVERT_FOOTER_LEN as usize];
        file.read_exact(&mut buffer)?;
        if &buffer[0..4] != REVERT_FOOTER_MAGIC {
            return Ok(None);
        }
        let stored_crc = u32::from_le_bytes([buffer[10], buffer[11], buffer[12], buffer[13]]);
        if Self::revert_footer_crc32(&buffer[0..10]) != stored_crc {
            return Ok(None);
        }
        let pad_byte = buffer[4];
        let pad_len = u64::from_le_bytes([
            buffer[5], buffer[6], buffer[7], buffer[8], buffer[9], 0, 0, 0,
        ]);
        let data_size = file_size - REVERT_FOOTER_LEN;
        Ok(Some(RevertFooter {
            original_size: data_size + pad_len,
            pad_byte,
        }))
    }

    /// Inspect the final byte of a ROM to decide which padding convention it uses. Returns the pad
    /// byte (`0x00` or `0xFF`) when the file ends in one, or `None` when the trailing byte is real
    /// data and there is no padding to remove.
    pub(super) fn detect_trailing_pad_byte(path: &Path) -> Result<Option<u8>> {
        let mut input = File::open(path)?;
        let file_size = input.metadata()?.len();
        if file_size == 0 {
            return Ok(None);
        }
        input.seek(SeekFrom::Start(file_size - 1))?;
        let mut last = [0_u8; 1];
        input.read_exact(&mut last)?;
        match last[0] {
            0x00 | 0xFF => Ok(Some(last[0])),
            _ => Ok(None),
        }
    }

    pub(super) fn scan_trimmed_size_from_trailing_padding_from_offset(
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

    pub(super) fn power_of_two_target_size_for_revert(size: u64) -> Result<u64> {
        if size == 0 {
            return Err(RomWeaverError::Validation(
                "cannot revert an empty file".to_string(),
            ));
        }
        size.checked_next_power_of_two().ok_or_else(|| {
            RomWeaverError::Validation("file is too large to revert safely".to_string())
        })
    }

    pub(super) fn read_nds_trim_plan(
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

    pub(super) fn validate_nds_header(header: &[u8]) -> Result<()> {
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

    pub(super) fn nds_crc16(bytes: &[u8]) -> u16 {
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

    pub(super) fn read_u16_le(buffer: &[u8], offset: usize, label: &str) -> Result<u16> {
        let bytes = buffer.get(offset..offset + 2).ok_or_else(|| {
            RomWeaverError::Validation(format!("missing {label} bytes at offset 0x{offset:X}"))
        })?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    pub(super) fn read_u32_le(buffer: &[u8], offset: usize, label: &str) -> Result<u32> {
        let bytes = buffer.get(offset..offset + 4).ok_or_else(|| {
            RomWeaverError::Validation(format!("missing {label} bytes at offset 0x{offset:X}"))
        })?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub(super) fn probe_compress_recommendation(
        &self,
        source: &Path,
    ) -> Option<CompressFormatRecommendation> {
        if source.is_file() {
            Some(self.containers.recommend_compress_format(source))
        } else {
            None
        }
    }

    pub(super) fn append_recommended_compress_label(
        mut report: OperationReport,
        recommendation: Option<&CompressFormatRecommendation>,
    ) -> OperationReport {
        if let Some(recommendation) = recommendation {
            report.label =
                Self::append_compress_recommendation_label(&report.label, recommendation);
        }
        report
    }

    pub(super) fn attach_container_probe_details(
        mut report: OperationReport,
        listed_entries: Option<Vec<ContainerListEntry>>,
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
            container.insert(
                "entries".to_string(),
                json!(
                    entries
                        .iter()
                        .map(|entry| entry.path.clone())
                        .collect::<Vec<_>>()
                ),
            );
            container.insert(
                "entry_records".to_string(),
                json!(
                    entries
                        .iter()
                        .map(|entry| {
                            let mut record = Map::new();
                            record.insert("file_name".to_string(), json!(entry.path));
                            record.insert(
                                "size_bytes".to_string(),
                                entry.size.map_or(Value::Null, |value| json!(value)),
                            );
                            Value::Object(record)
                        })
                        .collect::<Vec<_>>()
                ),
            );
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

    pub(super) fn attach_patch_probe_details(mut report: OperationReport) -> OperationReport {
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
