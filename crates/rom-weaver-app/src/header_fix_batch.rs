use super::*;

impl CliApp {
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
}
