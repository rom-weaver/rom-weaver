use super::*;

pub(super) struct PatchApplyFinalizeOptions<'a> {
    pub repair_hint_path: Option<&'a Path>,
    pub restore_n64_order: Option<N64ByteOrderTransform>,
}

impl CliApp {
    pub(super) fn append_compress_recommendation_label(
        base: &str,
        recommendation: &CompressFormatRecommendation,
    ) -> String {
        format!(
            "{base}; recommended_compress_format={} reason={}",
            recommendation.format_name, recommendation.reason
        )
    }

    pub(super) fn known_header_candidates_for_path(path: &Path) -> Vec<KnownRomHeader> {
        let mut candidates = Vec::with_capacity(KnownRomHeader::ALL.len());
        let extension_with_dot = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{value}"));

        if let Some(extension_with_dot) = extension_with_dot.as_deref() {
            for header in KnownRomHeader::ALL {
                if header.matches_extension(extension_with_dot) {
                    candidates.push(header);
                }
            }
        }

        for header in KnownRomHeader::ALL {
            if !candidates.contains(&header) {
                candidates.push(header);
            }
        }
        candidates
    }

    pub(super) fn detect_known_rom_header_from_prefix(
        path: &Path,
        prefix: &[u8],
    ) -> Option<KnownRomHeaderMatch> {
        for header in Self::known_header_candidates_for_path(path) {
            if header.signature_matches(prefix) {
                return Some(KnownRomHeaderMatch {
                    header,
                    stripped_bytes: header.data_offset_bytes(),
                });
            }
        }
        None
    }

    pub(super) fn detect_known_rom_header(path: &Path) -> Result<Option<KnownRomHeaderMatch>> {
        let mut source = BufReader::new(File::open(path)?);
        let mut prefix = vec![0_u8; ROM_HEADER_SCAN_BYTES];
        let bytes_read = source.read(&mut prefix)?;
        prefix.truncate(bytes_read);
        Ok(Self::detect_known_rom_header_from_prefix(path, &prefix))
    }

    pub(super) fn has_extension(path: &Path, expected: &[&str]) -> bool {
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            return false;
        };
        expected
            .iter()
            .any(|candidate| extension.eq_ignore_ascii_case(candidate))
    }

    /// Whether the 512 bytes a size match points at are really copier padding.
    ///
    /// A Super Magic Drive (`.smd`) dump is `512 % 1024` bytes long just like a
    /// copier-headered SNES ROM, and `512 % 8192` like a PCE one, so size alone
    /// claims every misnamed Genesis dump. Its 512 bytes head up 16 KiB blocks
    /// holding each block's odd bytes first and its even bytes second: removing
    /// them leaves interleaved data rather than a shorter ROM, so there is no
    /// removable header here at all.
    ///
    /// Bytes this cannot read stay copier padding, which is the answer the size
    /// test gave before this check existed.
    fn size_based_header_is_copier_padding(path: &Path) -> bool {
        let Ok(mut file) = File::open(path) else {
            return true;
        };
        let mut prefix = [0_u8; ROM_HEADER_BYTES];
        if file.read_exact(&mut prefix).is_err() {
            return true;
        }
        if header_declares_smd_interleave(&prefix) {
            debug!(
                input = %path.display(),
                "size matches a copier header but the bytes declare a Super Magic Drive interleave; nothing here is removable"
            );
            return false;
        }
        true
    }

    pub(super) fn detect_size_based_copier_header(
        path: &Path,
        input_len: u64,
    ) -> Option<KnownRomHeaderMatch> {
        if input_len <= ROM_HEADER_BYTES as u64 {
            return None;
        }
        let header = if Self::has_extension(path, &["smc", "sfc"])
            && input_len % SNES_COPIER_HEADER_MODULUS == ROM_HEADER_BYTES as u64
        {
            KnownRomHeader::SnesCopier
        } else if Self::has_extension(path, &["pce", "tg16"])
            && input_len % PCE_COPIER_HEADER_MODULUS == ROM_HEADER_BYTES as u64
        {
            KnownRomHeader::PceCopier
        } else {
            return None;
        };
        // Only now is it worth reading the file: the size and the name already
        // agree, and this is the check that can still take the verdict away.
        if !Self::size_based_header_is_copier_padding(path) {
            return None;
        }
        Some(KnownRomHeaderMatch {
            header,
            stripped_bytes: Some(ROM_HEADER_BYTES),
        })
    }

    pub(super) fn detect_strippable_rom_header(path: &Path) -> Result<KnownRomHeaderMatch> {
        let input_len = fs::metadata(path)?.len();
        let mut source = BufReader::new(File::open(path)?);
        let probe_len =
            ROM_HEADER_SCAN_BYTES.min(usize::try_from(input_len).unwrap_or(ROM_HEADER_SCAN_BYTES));
        let mut probe_bytes = vec![0_u8; probe_len];
        source.read_exact(&mut probe_bytes)?;
        let mut matched_header = Self::detect_known_rom_header_from_prefix(path, &probe_bytes);
        if matched_header
            .and_then(|value| value.stripped_bytes())
            .is_none()
        {
            matched_header = Self::detect_size_based_copier_header(path, input_len);
        }
        let Some(header_match) = matched_header else {
            return Err(RomWeaverError::Validation(format!(
                "could not detect a supported removable ROM header for `{}`",
                path.display()
            )));
        };
        let Some(header_len) = header_match.stripped_bytes() else {
            return Err(RomWeaverError::Validation(format!(
                "could not detect a supported removable ROM header for `{}`",
                path.display()
            )));
        };
        if input_len < header_len as u64 {
            return Err(RomWeaverError::Validation(format!(
                "cannot strip {header_len}-byte header from `{}` (file is only {input_len} byte(s))",
                path.display()
            )));
        }
        Ok(header_match)
    }

    pub(super) fn strip_header_to_temp(
        input: &Path,
        stripped_path: &Path,
    ) -> Result<StripHeaderResult> {
        let header_match = Self::detect_strippable_rom_header(input)?;
        let header_len = header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES);
        if let Some(parent) = stripped_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut source = BufReader::new(File::open(input)?);
        source.seek(SeekFrom::Start(0))?;
        let mut header = vec![0_u8; header_len];
        source.read_exact(&mut header)?;

        let mut stripped = BufWriter::new(File::create(stripped_path)?);
        io::copy(&mut source, &mut stripped)?;
        stripped.flush()?;
        Ok(StripHeaderResult {
            header_bytes: header,
            matched_header: Some(header_match),
        })
    }

    pub(super) fn finalize_patch_apply_output(
        staged_output: &Path,
        final_output: &Path,
        add_header: bool,
        stripped_header: Option<&[u8]>,
        strip_output_header: bool,
        repair_checksum: bool,
        options: PatchApplyFinalizeOptions<'_>,
    ) -> Result<PatchApplyFinalizeResult> {
        let PatchApplyFinalizeOptions {
            repair_hint_path,
            restore_n64_order,
        } = options;
        // A re-add always restores the real bytes captured at strip time; the
        // decision layer never sets `add_header` without a captured header.
        let header_bytes = if add_header { stripped_header } else { None };
        // `--output-header strip` on an apply that ran against the headered bytes:
        // drop the still-present header while writing the final output. A missing
        // header is not an error - the request is "make the output headerless" and
        // it already is.
        let skip_prefix_bytes = if strip_output_header && header_bytes.is_none() {
            match Self::detect_strippable_rom_header(staged_output) {
                Ok(header_match) => {
                    let stripped = header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES);
                    debug!(
                        header = ?header_match.header,
                        stripped_bytes = stripped,
                        "stripping ROM header from patched output"
                    );
                    stripped as u64
                }
                Err(error) => {
                    trace!(
                        %error,
                        "output header strip requested but no removable header detected; output left as-is"
                    );
                    0
                }
            }
        } else {
            0
        };

        if let Some(transform) = restore_n64_order {
            Self::rewrite_n64_byte_order(
                staged_output,
                final_output,
                transform.from,
                transform.to,
            )?;
        } else if skip_prefix_bytes > 0 {
            Self::copy_skipping_prefix(staged_output, final_output, skip_prefix_bytes)?;
        } else {
            Self::copy_with_optional_header(staged_output, final_output, header_bytes)?;
        }

        if repair_checksum {
            let repair_outcome =
                Self::repair_checksum_file_in_place(final_output, repair_hint_path)?;
            let repair_warning = if repair_outcome.repaired_profiles.is_empty() {
                if repair_outcome.matched_without_changes.is_empty() {
                    Some(
                        "no supported header repair profile matched; output left unchanged"
                            .to_string(),
                    )
                } else {
                    Some(format!(
                        "header repair matched profile(s) {} but no writable changes were required",
                        repair_outcome.matched_without_changes.join(", ")
                    ))
                }
            } else {
                None
            };
            return Ok(PatchApplyFinalizeResult {
                repaired_profiles: repair_outcome.repaired_profiles,
                repair_warning,
            });
        }

        Ok(PatchApplyFinalizeResult {
            repaired_profiles: Vec::new(),
            repair_warning: None,
        })
    }

    pub(super) fn copy_skipping_prefix(
        source: &Path,
        destination: &Path,
        prefix_bytes: u64,
    ) -> Result<()> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut reader = BufReader::new(File::open(source)?);
        reader.seek(SeekFrom::Start(prefix_bytes))?;
        let mut writer = BufWriter::new(File::create(destination)?);
        io::copy(&mut reader, &mut writer)?;
        writer.flush()?;
        Ok(())
    }

    pub(super) fn copy_with_optional_header(
        source: &Path,
        destination: &Path,
        header: Option<&[u8]>,
    ) -> Result<()> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut reader = BufReader::new(File::open(source)?);
        let mut writer = BufWriter::new(File::create(destination)?);
        if let Some(header) = header {
            writer.write_all(header)?;
        }
        io::copy(&mut reader, &mut writer)?;
        writer.flush()?;
        Ok(())
    }

    pub(super) fn record_header_repair_status(
        outcome: &mut HeaderRepairOutcome,
        profile: &'static str,
        status: HeaderRepairStatus,
    ) {
        match status {
            HeaderRepairStatus::NotMatched => {}
            HeaderRepairStatus::MatchedNoChange => outcome.matched_without_changes.push(profile),
            HeaderRepairStatus::Repaired => outcome.repaired_profiles.push(profile),
        }
    }
}
