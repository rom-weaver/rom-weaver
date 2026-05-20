    impl ChdContainerHandler {
        fn infer_create_kind(&self, input: &Path, logical_bytes: u64) -> Result<ChdCreateKind> {
            let extension = input
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase());
            match extension.as_deref() {
                Some("iso") => {
                    self.ensure_multiple_of(logical_bytes, Self::DVD_SECTOR_BYTES, "dvd image")?;
                    Ok(ChdCreateKind::Dvd)
                }
                Some("img") | Some("ima") => Ok(ChdCreateKind::HardDisk(
                    self.infer_hd_geometry(logical_bytes)?,
                )),
                Some("cue") => Ok(ChdCreateKind::Disc(self.parse_cue_file(input)?)),
                Some("gdi") => Ok(ChdCreateKind::Disc(self.parse_gdi_file(input)?)),
                _ => Ok(ChdCreateKind::Raw),
            }
        }

        fn parse_create_mode_override(
            &self,
            format: &str,
        ) -> Result<Option<ChdCreateModeOverride>> {
            let normalized = format.trim().to_ascii_lowercase();
            if normalized == "chd" {
                return Ok(None);
            }

            let Some(mode) = normalized.strip_prefix("chd-") else {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported chd format `{format}`; expected `chd` or `chd-<mode>` where mode is cd|dvd|raw|hd"
                )));
            };

            match mode {
                "cd" => Ok(Some(ChdCreateModeOverride::Cd)),
                "dvd" => Ok(Some(ChdCreateModeOverride::Dvd)),
                "raw" => Ok(Some(ChdCreateModeOverride::Raw)),
                "hd" => Ok(Some(ChdCreateModeOverride::HardDisk)),
                _ => Err(RomWeaverError::Validation(format!(
                    "unsupported chd mode `{mode}` in `{format}`; expected one of: cd, dvd, raw, hd"
                ))),
            }
        }

        fn infer_create_kind_with_override(
            &self,
            input: &Path,
            logical_bytes: u64,
            mode: ChdCreateModeOverride,
        ) -> Result<ChdCreateKind> {
            match mode {
                ChdCreateModeOverride::Cd => {
                    let extension = input
                        .extension()
                        .and_then(|value| value.to_str())
                        .map(|value| value.to_ascii_lowercase());
                    let layout = match extension.as_deref() {
                        Some("cue") => self.parse_cue_file(input)?,
                        Some("gdi") => {
                            return Err(RomWeaverError::Validation(format!(
                                "chd-cd does not accept gdi input `{}`; use `chd` or `chd-raw` for gd media",
                                input.display()
                            )));
                        }
                        _ => {
                            let (mode, sector_bytes) = if logical_bytes
                                % u64::try_from(DiscTrackMode::Mode1Raw.data_bytes())
                                    .unwrap_or(2352)
                                == 0
                            {
                                (
                                    DiscTrackMode::Mode1Raw,
                                    DiscTrackMode::Mode1Raw.data_bytes(),
                                )
                            } else if logical_bytes
                                % u64::try_from(DiscTrackMode::Mode1.data_bytes()).unwrap_or(2048)
                                == 0
                            {
                                (DiscTrackMode::Mode1, DiscTrackMode::Mode1.data_bytes())
                            } else {
                                return Err(RomWeaverError::Validation(format!(
                                    "chd-cd input `{}` size must be a multiple of 2352 or 2048 bytes unless a cue file is provided",
                                    input.display()
                                )));
                            };
                            let frames = logical_bytes / u64::try_from(sector_bytes).unwrap_or(1);
                            let frames = u32::try_from(frames).map_err(|_| {
                                RomWeaverError::Validation(format!(
                                    "chd-cd input `{}` is too large for current track metadata limits",
                                    input.display()
                                ))
                            })?;
                            DiscLayout {
                                kind: DiscKind::CdRom,
                                tracks: vec![DiscTrack {
                                    number: 1,
                                    mode,
                                    file_path: input.to_path_buf(),
                                    file_offset_bytes: 0,
                                    frames,
                                    pregap_frames: 0,
                                    postgap_frames: 0,
                                    pregap_has_data: false,
                                    has_subcode: false,
                                    pad_frames: 0,
                                    swap_audio_on_read: false,
                                }],
                            }
                        }
                    };
                    if layout.kind != DiscKind::CdRom {
                        return Err(RomWeaverError::Validation(format!(
                            "chd-cd input `{}` resolved to non-cd media",
                            input.display()
                        )));
                    }
                    Ok(ChdCreateKind::Disc(layout))
                }
                ChdCreateModeOverride::Dvd => {
                    self.ensure_multiple_of(logical_bytes, Self::DVD_SECTOR_BYTES, "dvd image")?;
                    Ok(ChdCreateKind::Dvd)
                }
                ChdCreateModeOverride::Raw => Ok(ChdCreateKind::Raw),
                ChdCreateModeOverride::HardDisk => Ok(ChdCreateKind::HardDisk(
                    self.infer_hd_geometry(logical_bytes)?,
                )),
            }
        }

        #[cfg(test)]
        pub(super) fn infer_create_kind_label_for_tests(
            &self,
            format: &str,
            input: &Path,
            logical_bytes: u64,
        ) -> Result<&'static str> {
            let mode_override = self.parse_create_mode_override(format)?;
            let create_kind = if let Some(mode) = mode_override {
                self.infer_create_kind_with_override(input, logical_bytes, mode)?
            } else {
                self.infer_create_kind(input, logical_bytes)?
            };
            Ok(match create_kind {
                ChdCreateKind::Raw => "raw",
                ChdCreateKind::HardDisk(_) => "hd",
                ChdCreateKind::Dvd => "dvd",
                ChdCreateKind::Disc(layout) => match layout.kind {
                    DiscKind::CdRom => "cd",
                    DiscKind::GdRom => "gd",
                },
                ChdCreateKind::Av(_) => "av",
            })
        }

        fn unit_bytes(&self, create_kind: &ChdCreateKind) -> u32 {
            match create_kind {
                ChdCreateKind::Raw => 1,
                ChdCreateKind::HardDisk(geometry) => geometry.bytes_per_sector,
                ChdCreateKind::Dvd => Self::DVD_SECTOR_BYTES,
                ChdCreateKind::Disc(_) => Self::CD_FRAME_BYTES,
                ChdCreateKind::Av(_) => 1,
            }
        }

        fn hunk_bytes(
            &self,
            create_kind: &ChdCreateKind,
            logical_bytes: u64,
            codec: ChdCodec,
        ) -> u32 {
            match create_kind {
                ChdCreateKind::Disc(_) if codec != ChdCodec::NONE => {
                    let total_frames = logical_bytes / u64::from(Self::CD_FRAME_BYTES);
                    if total_frames <= 1 {
                        Self::CD_HUNK_BYTES
                    } else {
                        let frames_per_hunk = total_frames.div_ceil(2).min(8);
                        u32::try_from(frames_per_hunk)
                            .unwrap_or(8)
                            .saturating_mul(Self::CD_FRAME_BYTES)
                    }
                }
                ChdCreateKind::Disc(_) => Self::CD_HUNK_BYTES,
                ChdCreateKind::Av(profile) => profile.frame_bytes,
                _ => Self::DEFAULT_HUNK_BYTES,
            }
        }

        fn infer_hd_geometry(&self, logical_bytes: u64) -> Result<HdGeometry> {
            self.ensure_multiple_of(logical_bytes, Self::HD_SECTOR_BYTES, "hard-disk image")?;
            let total_sectors = logical_bytes / u64::from(Self::HD_SECTOR_BYTES);
            const CANDIDATES: &[(u32, u32)] = &[
                (255, 63),
                (240, 63),
                (128, 63),
                (64, 63),
                (32, 63),
                (16, 63),
                (16, 32),
                (16, 16),
                (8, 32),
                (8, 16),
                (4, 16),
                (2, 16),
                (1, 1),
            ];

            for &(heads, sectors) in CANDIDATES {
                let span = u64::from(heads) * u64::from(sectors);
                if span == 0 || total_sectors % span != 0 {
                    continue;
                }

                let cylinders = total_sectors / span;
                if cylinders <= u64::from(u32::MAX) {
                    return Ok(HdGeometry {
                        cylinders: cylinders as u32,
                        heads,
                        sectors,
                        bytes_per_sector: Self::HD_SECTOR_BYTES,
                    });
                }
            }

            Err(RomWeaverError::Validation(format!(
                "hard-disk image `{logical_bytes}` bytes is too large for the current synthetic geometry heuristic"
            )))
        }

        fn infer_av_profile(&self, input: &Path, logical_bytes: u64) -> Result<AvProfile> {
            let mut reader = BufReader::new(File::open(input).map_err(|error| {
                RomWeaverError::Validation(format!("failed to open `{}`: {error}", input.display()))
            })?);
            let mut header = [0_u8; 12];
            reader.read_exact(&mut header).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read A/V header from `{}`: {error}",
                    input.display()
                ))
            })?;
            if &header[..4] != b"chav" {
                return Err(RomWeaverError::Validation(format!(
                    "chd codec `avhuff` requires `chav` frames; `{}` does not start with a `chav` header",
                    input.display()
                )));
            }

            let metadata_bytes = u64::from(header[4]);
            let channels = u64::from(header[5]);
            let samples = u64::from(u16::from_be_bytes([header[6], header[7]]));
            let width = u64::from(u16::from_be_bytes([header[8], header[9]]));
            let height = u64::from(u16::from_be_bytes([header[10], header[11]]));

            let frame_bytes = 12_u64
                .saturating_add(metadata_bytes)
                .saturating_add(channels.saturating_mul(samples).saturating_mul(2))
                .saturating_add(width.saturating_mul(height).saturating_mul(2));
            let frame_bytes_u32 = u32::try_from(frame_bytes).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "A/V frame size `{frame_bytes}` in `{}` exceeds supported limits",
                    input.display()
                ))
            })?;
            if frame_bytes_u32 == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "A/V frame size in `{}` resolved to zero bytes",
                    input.display()
                )));
            }
            self.ensure_multiple_of(logical_bytes, frame_bytes_u32, "av frame stream")?;

            Ok(AvProfile {
                frame_bytes: frame_bytes_u32,
                fps: 1,
                fpsfrac: 0,
                width: width as u32,
                height: height as u32,
                interlaced: 0,
                channels: channels as u32,
                sample_rate: samples as u32,
            })
        }

        fn ensure_multiple_of(
            &self,
            logical_bytes: u64,
            unit_bytes: u32,
            label: &str,
        ) -> Result<()> {
            if logical_bytes % u64::from(unit_bytes) == 0 {
                Ok(())
            } else {
                Err(RomWeaverError::Validation(format!(
                    "{label} size must be a multiple of {unit_bytes} bytes"
                )))
            }
        }
    }
