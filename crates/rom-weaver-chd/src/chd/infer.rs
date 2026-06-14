use super::*;

impl ChdContainerHandler {
    pub(super) const CD_ISO_MAX_FRAMES: u64 = 450_000;
    pub(super) const MBR_PARTITION_TABLE_OFFSET: usize = 446;
    pub(super) const MBR_PARTITION_ENTRY_BYTES: usize = 16;
    pub(super) const MBR_PARTITION_ENTRY_COUNT: usize = 4;
    pub(super) const GPT_HEADER_LBA: u64 = 1;
    /// ISO9660 volume descriptors begin at logical sector 16 with a one-byte type followed by
    /// the `CD001` standard identifier; matching it is positive evidence of a CD/DVD filesystem.
    pub(super) const ISO9660_STANDARD_ID: &'static [u8; 5] = b"CD001";
    /// `CD001` byte offset for 2048-byte cooked sectors: 16 * 2048 + 1 (skip the type byte).
    pub(super) const ISO9660_COOKED_DESCRIPTOR_OFFSET: u64 = 16 * 2048 + 1;
    /// `CD001` byte offset for 2352-byte raw Mode1 sectors: 16 * 2352 + 16 (sync + address) + 1.
    pub(super) const ISO9660_RAW_DESCRIPTOR_OFFSET: u64 = 16 * 2352 + 16 + 1;

    pub(super) fn infer_single_track_cd_layout(
        &self,
        input: &Path,
        logical_bytes: u64,
    ) -> Result<DiscLayout> {
        let prefer_mode1 = Self::is_extension(input, "iso");
        let mode1_bytes = u64::try_from(DiscTrackMode::Mode1.data_bytes()).unwrap_or(2048);
        let mode1_raw_bytes = u64::try_from(DiscTrackMode::Mode1Raw.data_bytes()).unwrap_or(2352);
        let (mode, sector_bytes) = if prefer_mode1 && logical_bytes.is_multiple_of(mode1_bytes) {
            (DiscTrackMode::Mode1, DiscTrackMode::Mode1.data_bytes())
        } else if logical_bytes.is_multiple_of(mode1_raw_bytes) {
            (
                DiscTrackMode::Mode1Raw,
                DiscTrackMode::Mode1Raw.data_bytes(),
            )
        } else if logical_bytes.is_multiple_of(mode1_bytes) {
            (DiscTrackMode::Mode1, DiscTrackMode::Mode1.data_bytes())
        } else {
            return Err(RomWeaverError::Validation(format!(
                "cd input `{}` size must be a multiple of 2352 or 2048 bytes unless a cue file is provided",
                input.display()
            )));
        };
        let frames = logical_bytes / u64::try_from(sector_bytes).unwrap_or(1);
        let frames = u32::try_from(frames).map_err(|_| {
            RomWeaverError::Validation(format!(
                "cd input `{}` is too large for current track metadata limits",
                input.display()
            ))
        })?;
        let mut layout = DiscLayout {
            kind: DiscKind::CdRom,
            tracks: vec![DiscTrack {
                number: 1,
                mode,
                file_path: input.to_path_buf(),
                memory_source: None,
                file_offset_bytes: 0,
                frames,
                pregap_frames: 0,
                postgap_frames: 0,
                pregap_has_data: false,
                has_subcode: false,
                pad_frames: 0,
                swap_audio_on_read: false,
            }],
        };
        layout.apply_cd_track_padding();
        Ok(layout)
    }

    pub(super) fn is_extension(input: &Path, extension: &str) -> bool {
        input
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
    }

    pub(super) fn should_auto_infer_single_track_cd(&self, input: &Path) -> bool {
        matches!(
            input
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase())
                .as_deref(),
            Some("bin") | Some("iso") | None
        )
    }

    pub(super) fn is_single_track_cd_sector_sized(&self, logical_bytes: u64) -> bool {
        let mode1_bytes = u64::try_from(DiscTrackMode::Mode1.data_bytes()).unwrap_or(2048);
        let mode1_raw_bytes = u64::try_from(DiscTrackMode::Mode1Raw.data_bytes()).unwrap_or(2352);
        logical_bytes > 0
            && (logical_bytes.is_multiple_of(mode1_raw_bytes)
                || logical_bytes.is_multiple_of(mode1_bytes))
    }

    pub(super) fn is_cd_sized_iso(&self, input: &Path, logical_bytes: u64) -> bool {
        let max_iso_bytes = Self::CD_ISO_MAX_FRAMES
            * u64::try_from(DiscTrackMode::Mode1.data_bytes()).unwrap_or(2048);
        !Self::is_extension(input, "iso") || logical_bytes <= max_iso_bytes
    }

    /// Read `len` bytes from `input` at `offset`, returning `None` on any open/seek/read
    /// failure. Best-effort sniffing: a read error means "no evidence found", not a hard error.
    pub(super) fn read_bytes_at(&self, input: &Path, offset: u64, len: usize) -> Option<Vec<u8>> {
        let mut file = File::open(input).ok()?;
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut buffer = vec![0_u8; len];
        file.read_exact(&mut buffer).ok()?;
        Some(buffer)
    }

    /// Whether the first 12 bytes are the raw CD sector sync header (`00 FF*10 00`), present on
    /// every raw 2352-byte Mode1/Mode2 sector and strong evidence of a CD rip.
    pub(super) fn has_cd_sync_header(&self, input: &Path) -> bool {
        self.read_bytes_at(input, 0, CD_SYNC_HEADER.len())
            .is_some_and(|bytes| bytes == CD_SYNC_HEADER)
    }

    /// Whether the ISO9660 `CD001` standard identifier sits at `offset` (the sector-16 volume
    /// descriptor).
    pub(super) fn has_iso9660_descriptor_at(&self, input: &Path, offset: u64) -> bool {
        self.read_bytes_at(input, offset, Self::ISO9660_STANDARD_ID.len())
            .is_some_and(|bytes| bytes.as_slice() == Self::ISO9660_STANDARD_ID)
    }

    /// Positive evidence that a raw/extensionless input is a single-track CD image: a raw
    /// 2352-byte image with a sync header (or raw-offset ISO9660 descriptor), or a cooked
    /// 2048-byte CD-sized image carrying an ISO9660 descriptor. Reads the source bytes rather
    /// than trusting size alone so plain raw blobs are not misclassified as CD.
    pub(super) fn has_single_track_cd_evidence(&self, input: &Path, logical_bytes: u64) -> bool {
        let mode1_raw_bytes = u64::try_from(DiscTrackMode::Mode1Raw.data_bytes()).unwrap_or(2352);
        let mode1_bytes = u64::try_from(DiscTrackMode::Mode1.data_bytes()).unwrap_or(2048);

        if logical_bytes.is_multiple_of(mode1_raw_bytes)
            && (self.has_cd_sync_header(input)
                || self.has_iso9660_descriptor_at(input, Self::ISO9660_RAW_DESCRIPTOR_OFFSET))
        {
            return true;
        }

        logical_bytes.is_multiple_of(mode1_bytes)
            && self.is_cd_sized_iso(input, logical_bytes)
            && self.has_iso9660_descriptor_at(input, Self::ISO9660_COOKED_DESCRIPTOR_OFFSET)
    }

    pub(super) fn has_sector_signature(sector: &[u8]) -> bool {
        sector.len() >= Self::HD_SECTOR_BYTES as usize && sector[510] == 0x55 && sector[511] == 0xAA
    }

    pub(super) fn read_le_u16(bytes: &[u8], offset: usize) -> Option<u16> {
        bytes
            .get(offset..offset + 2)
            .map(|value| u16::from_le_bytes([value[0], value[1]]))
    }

    pub(super) fn read_le_u32(bytes: &[u8], offset: usize) -> Option<u32> {
        bytes
            .get(offset..offset + 4)
            .map(|value| u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
    }

    pub(super) fn read_le_u64(bytes: &[u8], offset: usize) -> Option<u64> {
        bytes.get(offset..offset + 8).map(|value| {
            u64::from_le_bytes([
                value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7],
            ])
        })
    }

    pub(super) fn is_valid_volume_sector_size(bytes_per_sector: u16) -> bool {
        matches!(bytes_per_sector, 512 | 1024 | 2048 | 4096)
    }

    pub(super) fn has_valid_mbr_partition_table(&self, sector: &[u8], logical_bytes: u64) -> bool {
        if !Self::has_sector_signature(sector) {
            return false;
        }

        let total_sectors = logical_bytes / u64::from(Self::HD_SECTOR_BYTES);
        let mut populated_entries = 0_usize;
        for entry_index in 0..Self::MBR_PARTITION_ENTRY_COUNT {
            let offset =
                Self::MBR_PARTITION_TABLE_OFFSET + entry_index * Self::MBR_PARTITION_ENTRY_BYTES;
            let Some(entry) = sector.get(offset..offset + Self::MBR_PARTITION_ENTRY_BYTES) else {
                return false;
            };
            let boot_flag = entry[0];
            let partition_type = entry[4];
            let Some(start_lba) = Self::read_le_u32(entry, 8).map(u64::from) else {
                return false;
            };
            let Some(sector_count) = Self::read_le_u32(entry, 12).map(u64::from) else {
                return false;
            };

            if partition_type == 0 && start_lba == 0 && sector_count == 0 {
                continue;
            }
            if boot_flag != 0 && boot_flag != 0x80 {
                return false;
            }
            if partition_type == 0 || start_lba == 0 || sector_count == 0 {
                return false;
            }
            if start_lba >= total_sectors {
                return false;
            }
            if partition_type != 0xEE
                && start_lba
                    .checked_add(sector_count)
                    .is_none_or(|end_lba| end_lba > total_sectors)
            {
                return false;
            }
            populated_entries += 1;
        }

        populated_entries > 0
    }

    pub(super) fn has_valid_gpt_header(&self, sector: &[u8], logical_bytes: u64) -> bool {
        if sector.len() < Self::HD_SECTOR_BYTES as usize || sector.get(..8) != Some(b"EFI PART") {
            return false;
        }

        let total_sectors = logical_bytes / u64::from(Self::HD_SECTOR_BYTES);
        let Some(header_bytes) = Self::read_le_u32(sector, 12) else {
            return false;
        };
        let Some(current_lba) = Self::read_le_u64(sector, 24) else {
            return false;
        };
        let Some(backup_lba) = Self::read_le_u64(sector, 32) else {
            return false;
        };
        let Some(first_usable_lba) = Self::read_le_u64(sector, 40) else {
            return false;
        };
        let Some(last_usable_lba) = Self::read_le_u64(sector, 48) else {
            return false;
        };
        let Some(partition_entry_lba) = Self::read_le_u64(sector, 72) else {
            return false;
        };
        let Some(partition_entry_count) = Self::read_le_u32(sector, 80) else {
            return false;
        };
        let Some(partition_entry_bytes) = Self::read_le_u32(sector, 84) else {
            return false;
        };

        (92..=Self::HD_SECTOR_BYTES).contains(&header_bytes)
            && current_lba == Self::GPT_HEADER_LBA
            && backup_lba < total_sectors
            && first_usable_lba <= last_usable_lba
            && last_usable_lba < total_sectors
            && partition_entry_lba < total_sectors
            && partition_entry_count > 0
            && partition_entry_bytes >= 128
            && partition_entry_bytes.is_multiple_of(8)
    }

    pub(super) fn boot_sector_declares_matching_size(
        sector_bytes: u16,
        declared_sectors: u64,
        logical_bytes: u64,
    ) -> bool {
        declared_sectors > 0
            && Self::is_valid_volume_sector_size(sector_bytes)
            && declared_sectors
                .checked_mul(u64::from(sector_bytes))
                .is_some_and(|declared_bytes| declared_bytes <= logical_bytes)
    }

    pub(super) fn has_valid_fat_boot_sector(&self, sector: &[u8], logical_bytes: u64) -> bool {
        if !Self::has_sector_signature(sector) {
            return false;
        }
        let Some(bytes_per_sector) = Self::read_le_u16(sector, 11) else {
            return false;
        };
        let sectors_per_cluster = sector.get(13).copied().unwrap_or(0);
        let Some(reserved_sectors) = Self::read_le_u16(sector, 14) else {
            return false;
        };
        let fat_count = sector.get(16).copied().unwrap_or(0);
        let Some(total_sectors_16) = Self::read_le_u16(sector, 19) else {
            return false;
        };
        let Some(total_sectors_32) = Self::read_le_u32(sector, 32) else {
            return false;
        };
        let Some(sectors_per_fat_16) = Self::read_le_u16(sector, 22) else {
            return false;
        };
        let Some(sectors_per_fat_32) = Self::read_le_u32(sector, 36) else {
            return false;
        };
        let declared_sectors = if total_sectors_16 > 0 {
            u64::from(total_sectors_16)
        } else {
            u64::from(total_sectors_32)
        };

        Self::is_valid_volume_sector_size(bytes_per_sector)
            && sectors_per_cluster.is_power_of_two()
            && sectors_per_cluster <= 128
            && reserved_sectors > 0
            && matches!(fat_count, 1 | 2)
            && (sectors_per_fat_16 > 0 || sectors_per_fat_32 > 0)
            && Self::boot_sector_declares_matching_size(
                bytes_per_sector,
                declared_sectors,
                logical_bytes,
            )
    }

    pub(super) fn has_valid_ntfs_boot_sector(&self, sector: &[u8], logical_bytes: u64) -> bool {
        if !Self::has_sector_signature(sector) || sector.get(3..11) != Some(b"NTFS    ") {
            return false;
        }
        let Some(bytes_per_sector) = Self::read_le_u16(sector, 11) else {
            return false;
        };
        let sectors_per_cluster = sector.get(13).copied().unwrap_or(0);
        let Some(total_sectors) = Self::read_le_u64(sector, 40) else {
            return false;
        };
        let Some(mft_cluster) = Self::read_le_u64(sector, 48) else {
            return false;
        };

        Self::is_valid_volume_sector_size(bytes_per_sector)
            && sectors_per_cluster.is_power_of_two()
            && sectors_per_cluster > 0
            && mft_cluster > 0
            && Self::boot_sector_declares_matching_size(
                bytes_per_sector,
                total_sectors,
                logical_bytes,
            )
    }

    pub(super) fn has_valid_exfat_boot_sector(&self, sector: &[u8], logical_bytes: u64) -> bool {
        if !Self::has_sector_signature(sector) || sector.get(3..11) != Some(b"EXFAT   ") {
            return false;
        }
        if sector
            .get(11..64)
            .is_none_or(|reserved| reserved.iter().any(|byte| *byte != 0))
        {
            return false;
        }

        let Some(volume_length) = Self::read_le_u64(sector, 72) else {
            return false;
        };
        let Some(fat_offset) = Self::read_le_u32(sector, 80).map(u64::from) else {
            return false;
        };
        let Some(fat_length) = Self::read_le_u32(sector, 84).map(u64::from) else {
            return false;
        };
        let Some(cluster_heap_offset) = Self::read_le_u32(sector, 88).map(u64::from) else {
            return false;
        };
        let Some(cluster_count) = Self::read_le_u32(sector, 92) else {
            return false;
        };
        let bytes_per_sector_shift = sector.get(108).copied().unwrap_or(0);
        let sectors_per_cluster_shift = sector.get(109).copied().unwrap_or(0);
        let sector_bytes = 1_u64.checked_shl(u32::from(bytes_per_sector_shift));
        let Some(sector_bytes) = sector_bytes else {
            return false;
        };

        (512..=4096).contains(&sector_bytes)
            && sector_bytes.is_power_of_two()
            && sectors_per_cluster_shift <= 25
            && volume_length > 0
            && volume_length
                .checked_mul(sector_bytes)
                .is_some_and(|declared_bytes| declared_bytes <= logical_bytes)
            && fat_offset > 0
            && fat_length > 0
            && fat_offset
                .checked_add(fat_length)
                .is_some_and(|fat_end| fat_end <= volume_length)
            && cluster_heap_offset < volume_length
            && cluster_count > 0
    }

    pub(super) fn has_known_volume_boot_sector(&self, sector: &[u8], logical_bytes: u64) -> bool {
        self.has_valid_fat_boot_sector(sector, logical_bytes)
            || self.has_valid_ntfs_boot_sector(sector, logical_bytes)
            || self.has_valid_exfat_boot_sector(sector, logical_bytes)
    }

    pub(super) fn should_auto_infer_hard_disk(&self, input: &Path, logical_bytes: u64) -> bool {
        if logical_bytes < u64::from(Self::HD_SECTOR_BYTES)
            || !logical_bytes.is_multiple_of(u64::from(Self::HD_SECTOR_BYTES))
        {
            return false;
        }

        let mut file = match File::open(input) {
            Ok(file) => BufReader::new(file),
            Err(_) => return false,
        };
        let mut sector = [0_u8; Self::HD_SECTOR_BYTES as usize];
        if file.read_exact(&mut sector).is_err() {
            return false;
        }

        if self.has_valid_mbr_partition_table(&sector, logical_bytes)
            || self.has_known_volume_boot_sector(&sector, logical_bytes)
        {
            return true;
        }

        if logical_bytes < u64::from(Self::HD_SECTOR_BYTES) * 2 {
            return false;
        }
        if file.read_exact(&mut sector).is_err() {
            return false;
        }
        self.has_valid_gpt_header(&sector, logical_bytes)
    }

    pub(super) fn infer_create_kind(
        &self,
        input: &Path,
        logical_bytes: u64,
    ) -> Result<ChdCreateKind> {
        let extension = input
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        match extension.as_deref() {
            Some("cue") => Ok(ChdCreateKind::Disc(self.parse_disc_input(input)?)),
            Some("gdi") => Ok(ChdCreateKind::Disc(self.parse_gdi_file(input)?)),
            Some("iso")
                if self.is_cd_sized_iso(input, logical_bytes)
                    && self.is_single_track_cd_sector_sized(logical_bytes) =>
            {
                Ok(ChdCreateKind::Disc(
                    self.infer_single_track_cd_layout(input, logical_bytes)?,
                ))
            }
            Some("iso") => {
                self.ensure_multiple_of(logical_bytes, Self::DVD_SECTOR_BYTES, "dvd image")?;
                Ok(ChdCreateKind::Dvd)
            }
            Some("img") | Some("ima") => Ok(ChdCreateKind::HardDisk(
                self.infer_hd_geometry(logical_bytes)?,
            )),
            _ if self.should_auto_infer_hard_disk(input, logical_bytes) => Ok(
                ChdCreateKind::HardDisk(self.infer_hd_geometry(logical_bytes)?),
            ),
            _ if self.should_auto_infer_single_track_cd(input)
                && self.is_single_track_cd_sector_sized(logical_bytes)
                && self.has_single_track_cd_evidence(input, logical_bytes) =>
            {
                Ok(ChdCreateKind::Disc(
                    self.infer_single_track_cd_layout(input, logical_bytes)?,
                ))
            }
            // A/V (laserdisc) sources are raw `chav` frame streams; detect them so
            // the output is compressed as A/V media without requiring the caller to
            // pass `--codec avhuff` explicitly.
            _ if self.is_chav_stream(input) => Ok(ChdCreateKind::Av(
                self.infer_av_profile(input, logical_bytes)?,
            )),
            _ => Ok(ChdCreateKind::Raw),
        }
    }

    /// Cheaply detect an A/V `chav` frame stream by its leading magic bytes.
    pub(super) fn is_chav_stream(&self, input: &Path) -> bool {
        let Ok(mut file) = File::open(input) else {
            return false;
        };
        let mut magic = [0_u8; 4];
        file.read_exact(&mut magic).is_ok() && &magic == b"chav"
    }

    pub(super) fn parse_create_mode_override(
        &self,
        format: &str,
    ) -> Result<Option<ChdCreateModeOverride>> {
        let normalized = format.trim().to_ascii_lowercase();
        if normalized == "chd" {
            return Ok(None);
        }

        let Some(mode) = normalized.strip_prefix("chd-") else {
            return Err(RomWeaverError::Validation(format!(
                "unsupported chd format `{format}`; expected `chd` or `chd-<mode>` where mode is cd|gd|dvd|raw|hd|av|ld"
            )));
        };

        match mode {
            "cd" => Ok(Some(ChdCreateModeOverride::Cd)),
            "gd" => Ok(Some(ChdCreateModeOverride::Gd)),
            "dvd" => Ok(Some(ChdCreateModeOverride::Dvd)),
            "raw" => Ok(Some(ChdCreateModeOverride::Raw)),
            "hd" => Ok(Some(ChdCreateModeOverride::HardDisk)),
            "av" | "ld" => Ok(Some(ChdCreateModeOverride::Av)),
            _ => Err(RomWeaverError::Validation(format!(
                "unsupported chd mode `{mode}` in `{format}`; expected one of: cd, gd, dvd, raw, hd, av, ld"
            ))),
        }
    }

    pub(super) fn infer_create_kind_with_override(
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
                            "chd-cd does not accept gdi input `{}`; use `chd` or `chd-gd` for gd media",
                            input.display()
                        )));
                    }
                    _ => self.infer_single_track_cd_layout(input, logical_bytes)?,
                };
                if layout.kind != DiscKind::CdRom {
                    return Err(RomWeaverError::Validation(format!(
                        "chd-cd input `{}` resolved to non-cd media",
                        input.display()
                    )));
                }
                Ok(ChdCreateKind::Disc(layout))
            }
            ChdCreateModeOverride::Gd => {
                let extension = input
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| value.to_ascii_lowercase());
                let layout = match extension.as_deref() {
                    Some("gdi") => self.parse_gdi_file(input)?,
                    Some("cue") => {
                        let layout = self.parse_disc_input(input)?;
                        if layout.kind != DiscKind::GdRom {
                            return Err(RomWeaverError::Validation(format!(
                                "chd-gd input `{}` is not a gd-rom; provide a `.gdi`, a sibling `.gdi`, or a cue with `REM HIGH-DENSITY AREA` markers (or use `chd-cd`)",
                                input.display()
                            )));
                        }
                        layout
                    }
                    _ => {
                        return Err(RomWeaverError::Validation(format!(
                            "chd-gd requires a `.gdi` or `.cue` input; `{}` is neither",
                            input.display()
                        )));
                    }
                };
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
            ChdCreateModeOverride::Av => {
                if !self.is_chav_stream(input) {
                    return Err(RomWeaverError::Validation(format!(
                        "chd-av/chd-ld requires a `chav` A/V frame stream; `{}` is not one",
                        input.display()
                    )));
                }
                Ok(ChdCreateKind::Av(
                    self.infer_av_profile(input, logical_bytes)?,
                ))
            }
        }
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn infer_create_kind_label_for_tests(
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

    pub(super) fn unit_bytes(&self, create_kind: &ChdCreateKind) -> u32 {
        match create_kind {
            ChdCreateKind::Raw => 1,
            ChdCreateKind::HardDisk(geometry) => geometry.bytes_per_sector,
            ChdCreateKind::Dvd => Self::DVD_SECTOR_BYTES,
            ChdCreateKind::Disc(_) => Self::CD_FRAME_BYTES,
            ChdCreateKind::Av(_) => 1,
        }
    }

    pub(super) fn hunk_bytes(
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

    pub(super) fn infer_hd_geometry(&self, logical_bytes: u64) -> Result<HdGeometry> {
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
            if span == 0 || !total_sectors.is_multiple_of(span) {
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

    pub(super) fn infer_av_profile(&self, input: &Path, logical_bytes: u64) -> Result<AvProfile> {
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

    pub(super) fn ensure_multiple_of(
        &self,
        logical_bytes: u64,
        unit_bytes: u32,
        label: &str,
    ) -> Result<()> {
        if logical_bytes.is_multiple_of(u64::from(unit_bytes)) {
            Ok(())
        } else {
            Err(RomWeaverError::Validation(format!(
                "{label} size must be a multiple of {unit_bytes} bytes"
            )))
        }
    }
}
