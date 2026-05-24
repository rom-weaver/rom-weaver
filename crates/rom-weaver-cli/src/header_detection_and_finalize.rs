impl CliApp {
    fn append_compress_recommendation_label(
        base: &str,
        recommendation: &CompressFormatRecommendation,
    ) -> String {
        format!(
            "{base}; recommended_compress_format={} reason={}",
            recommendation.format_name, recommendation.reason
        )
    }

    fn known_header_candidates_for_path(path: &Path) -> Vec<KnownRomHeader> {
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

    fn detect_known_rom_header_from_prefix(
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

    fn detect_known_rom_header(path: &Path) -> Result<Option<KnownRomHeaderMatch>> {
        let mut source = BufReader::new(File::open(path)?);
        let mut prefix = vec![0_u8; ROM_HEADER_SCAN_BYTES];
        let bytes_read = source.read(&mut prefix)?;
        prefix.truncate(bytes_read);
        Ok(Self::detect_known_rom_header_from_prefix(path, &prefix))
    }

    fn has_extension(path: &Path, expected: &[&str]) -> bool {
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            return false;
        };
        expected
            .iter()
            .any(|candidate| extension.eq_ignore_ascii_case(candidate))
    }

    fn detect_size_based_copier_header(path: &Path, input_len: u64) -> Option<KnownRomHeaderMatch> {
        if input_len <= ROM_HEADER_BYTES as u64 {
            return None;
        }
        if Self::has_extension(path, &["smc", "sfc"])
            && input_len % SNES_COPIER_HEADER_MODULUS == ROM_HEADER_BYTES as u64
        {
            return Some(KnownRomHeaderMatch {
                header: KnownRomHeader::SnesCopier,
                stripped_bytes: Some(ROM_HEADER_BYTES),
            });
        }
        if Self::has_extension(path, &["pce", "tg16"])
            && input_len % PCE_COPIER_HEADER_MODULUS == ROM_HEADER_BYTES as u64
        {
            return Some(KnownRomHeaderMatch {
                header: KnownRomHeader::PceCopier,
                stripped_bytes: Some(ROM_HEADER_BYTES),
            });
        }
        None
    }

    fn detect_strippable_rom_header(path: &Path) -> Result<KnownRomHeaderMatch> {
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

    fn strip_header_to_temp(input: &Path, stripped_path: &Path) -> Result<StripHeaderResult> {
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

    fn finalize_patch_apply_output(
        staged_output: &Path,
        final_output: &Path,
        add_header: bool,
        stripped_header: Option<&[u8]>,
        repair_checksum: bool,
        repair_hint_path: Option<&Path>,
    ) -> Result<PatchApplyFinalizeResult> {
        let header_bytes = if add_header {
            Some(stripped_header.unwrap_or(&[0_u8; ROM_HEADER_BYTES]))
        } else {
            None
        };

        if repair_checksum {
            Self::copy_with_optional_header(staged_output, final_output, header_bytes)?;
            let repair_outcome = Self::repair_checksum_file_in_place(final_output, repair_hint_path)?;
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

        Self::copy_with_optional_header(staged_output, final_output, header_bytes)?;
        Ok(PatchApplyFinalizeResult {
            repaired_profiles: Vec::new(),
            repair_warning: None,
        })
    }

    fn copy_with_optional_header(
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

    fn record_header_repair_status(
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
