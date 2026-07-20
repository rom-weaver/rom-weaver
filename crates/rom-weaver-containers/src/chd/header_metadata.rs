use super::*;

impl ChdContainerHandler {
    pub(super) fn build_chd_v5_header(
        &self,
        logical_bytes: u64,
        map_offset: u64,
        hunk_bytes: u32,
        unit_bytes: u32,
        codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
        parent_sha1: Option<[u8; Self::CHD_SHA1_BYTES]>,
    ) -> [u8; Self::CHD_V5_HEADER_BYTES as usize] {
        let mut header = [0_u8; Self::CHD_V5_HEADER_BYTES as usize];
        header[0..8].copy_from_slice(&CHD_SIGNATURE);
        header[8..12].copy_from_slice(&(Self::CHD_V5_HEADER_BYTES as u32).to_be_bytes());
        header[12..16].copy_from_slice(&5_u32.to_be_bytes());
        header[16..20].copy_from_slice(&codecs[0].raw().to_be_bytes());
        header[20..24].copy_from_slice(&codecs[1].raw().to_be_bytes());
        header[24..28].copy_from_slice(&codecs[2].raw().to_be_bytes());
        header[28..32].copy_from_slice(&codecs[3].raw().to_be_bytes());
        header[32..40].copy_from_slice(&logical_bytes.to_be_bytes());
        header[40..48].copy_from_slice(&map_offset.to_be_bytes());
        header[48..56].copy_from_slice(&0_u64.to_be_bytes());
        header[56..60].copy_from_slice(&hunk_bytes.to_be_bytes());
        header[60..64].copy_from_slice(&unit_bytes.to_be_bytes());
        if let Some(parent_sha1) = parent_sha1 {
            header[Self::CHD_V5_HEADER_PARENT_SHA1_OFFSET as usize
                ..Self::CHD_V5_HEADER_PARENT_SHA1_OFFSET as usize + Self::CHD_SHA1_BYTES]
                .copy_from_slice(&parent_sha1);
        }
        header
    }

    pub(super) fn rust_metadata_entries(
        &self,
        create_kind: &ChdCreateKind,
    ) -> Result<Vec<RustMetadataEntry>> {
        match create_kind {
            ChdCreateKind::Raw => Ok(Vec::new()),
            ChdCreateKind::Dvd => Ok(vec![RustMetadataEntry {
                tag: DVD_METADATA_TAG,
                flags: CHD_METADATA_FLAG_CHECKSUM,
                data: vec![0],
            }]),
            ChdCreateKind::HardDisk(geometry) => {
                let mut metadata = format!(
                    "CYLS:{},HEADS:{},SECS:{},BPS:{}",
                    geometry.cylinders, geometry.heads, geometry.sectors, geometry.bytes_per_sector
                )
                .into_bytes();
                metadata.push(0);
                Ok(vec![RustMetadataEntry {
                    tag: HARD_DISK_METADATA_TAG,
                    flags: CHD_METADATA_FLAG_CHECKSUM,
                    data: metadata,
                }])
            }
            ChdCreateKind::Disc(layout) => {
                let mut entries = Vec::with_capacity(layout.tracks.len());
                for track in &layout.tracks {
                    let pgtype = if track.pregap_has_data {
                        format!("V{}", track.mode.metadata_label())
                    } else {
                        track.mode.pregap_metadata_label().to_string()
                    };
                    let mut data = match layout.kind {
                            DiscKind::CdRom => format!(
                                "TRACK:{} TYPE:{} SUBTYPE:NONE FRAMES:{} PREGAP:{} PGTYPE:{} PGSUB:NONE POSTGAP:{}",
                                track.number,
                                track.mode.metadata_label(),
                                // CD metadata reports the unpadded data frame count; the
                                // 4-frame track padding lives only in the hunk stream.
                                track.frames - track.pad_frames,
                                track.pregap_frames,
                                pgtype,
                                track.postgap_frames
                            ),
                            DiscKind::GdRom => format!(
                                "TRACK:{} TYPE:{} SUBTYPE:NONE FRAMES:{} PAD:{} PREGAP:{} PGTYPE:{} PGSUB:NONE POSTGAP:{}",
                                track.number,
                                track.mode.metadata_label(),
                                track.frames,
                                track.pad_frames,
                                track.pregap_frames,
                                pgtype,
                                track.postgap_frames
                            ),
                        }
                        .into_bytes();
                    data.push(0);
                    entries.push(RustMetadataEntry {
                        tag: layout.kind.metadata_tag(),
                        flags: CHD_METADATA_FLAG_CHECKSUM,
                        data,
                    });
                }
                Ok(entries)
            }
            ChdCreateKind::Av(profile) => {
                let mut metadata = format!(
                    "FPS:{}.{:06} WIDTH:{} HEIGHT:{} INTERLACED:{} CHANNELS:{} SAMPLERATE:{}",
                    profile.fps,
                    profile.fpsfrac,
                    profile.width,
                    profile.height,
                    profile.interlaced,
                    profile.channels,
                    profile.sample_rate
                )
                .into_bytes();
                metadata.push(0);
                Ok(vec![RustMetadataEntry {
                    tag: AV_METADATA_TAG,
                    flags: CHD_METADATA_FLAG_CHECKSUM,
                    data: metadata,
                }])
            }
        }
    }

    pub(super) fn append_rust_metadata(
        &self,
        output_file: &mut File,
        output_path: &Path,
        entries: &[RustMetadataEntry],
    ) -> Result<Option<u64>> {
        if entries.is_empty() {
            return Ok(None);
        }

        let mut entry_offsets = Vec::with_capacity(entries.len());
        for entry in entries {
            if entry.data.is_empty() || entry.data.len() >= 16 * 1024 * 1024 {
                return Err(RomWeaverError::Validation(
                    "CHD metadata entries must be 1..16MiB".to_string(),
                ));
            }
            let offset = output_file.stream_position().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to determine metadata offset in `{}`: {error}",
                    output_path.display()
                ))
            })?;
            entry_offsets.push(offset);

            let mut header = [0_u8; 16];
            header[..4].copy_from_slice(&entry.tag.to_be_bytes());
            header[4] = entry.flags;
            Self::write_u24_be(
                &mut header[5..8],
                u32::try_from(entry.data.len()).map_err(|_| {
                    RomWeaverError::Validation("metadata length overflow".to_string())
                })?,
            )?;
            output_file.write_all(&header).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to write CHD metadata header to `{}`: {error}",
                    output_path.display()
                ))
            })?;
            output_file.write_all(&entry.data).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to write CHD metadata payload to `{}`: {error}",
                    output_path.display()
                ))
            })?;
        }

        for (index, offset) in entry_offsets.iter().enumerate() {
            let next = entry_offsets.get(index + 1).copied().unwrap_or(0);
            output_file
                .seek(SeekFrom::Start(offset.saturating_add(8)))
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to seek CHD metadata link in `{}`: {error}",
                        output_path.display()
                    ))
                })?;
            output_file
                .write_all(&next.to_be_bytes())
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD metadata link in `{}`: {error}",
                        output_path.display()
                    ))
                })?;
        }
        let end = output_file.seek(SeekFrom::End(0)).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to restore CHD output offset in `{}`: {error}",
                output_path.display()
            ))
        })?;
        let first = entry_offsets[0];
        if end < first {
            return Err(RomWeaverError::Validation(
                "invalid CHD metadata layout".to_string(),
            ));
        }
        Ok(Some(first))
    }

    pub(super) fn patch_chd_header_sha1s(
        &self,
        output_file: &mut File,
        output_path: &Path,
        raw_sha1: &[u8; Self::CHD_SHA1_BYTES],
        metadata_entries: &[RustMetadataEntry],
    ) -> Result<()> {
        let overall_sha1 = Self::compute_overall_sha1(raw_sha1, metadata_entries);
        self.patch_chd_header_bytes(
            output_file,
            output_path,
            Self::CHD_V5_HEADER_RAW_SHA1_OFFSET,
            raw_sha1,
            "raw sha1",
        )?;
        self.patch_chd_header_bytes(
            output_file,
            output_path,
            Self::CHD_V5_HEADER_SHA1_OFFSET,
            &overall_sha1,
            "sha1",
        )
    }

    pub(super) fn compute_overall_sha1(
        raw_sha1: &[u8; Self::CHD_SHA1_BYTES],
        metadata_entries: &[RustMetadataEntry],
    ) -> [u8; Self::CHD_SHA1_BYTES] {
        let mut metadata_hashes = metadata_entries
            .iter()
            .filter(|entry| (entry.flags & CHD_METADATA_FLAG_CHECKSUM) != 0)
            .map(|entry| {
                let mut hash_entry = [0_u8; 4 + Self::CHD_SHA1_BYTES];
                hash_entry[..4].copy_from_slice(&entry.tag.to_be_bytes());
                let digest = Sha1::digest(&entry.data);
                hash_entry[4..].copy_from_slice(&digest);
                hash_entry
            })
            .collect::<Vec<_>>();
        metadata_hashes.sort_unstable();

        let mut overall_sha1 = Sha1::new();
        overall_sha1.update(raw_sha1);
        for hash_entry in metadata_hashes {
            overall_sha1.update(hash_entry);
        }
        let digest = overall_sha1.finalize();
        let mut out = [0_u8; Self::CHD_SHA1_BYTES];
        out.copy_from_slice(&digest);
        out
    }

    pub(super) fn patch_chd_header_u64(
        &self,
        output_file: &mut File,
        output_path: &Path,
        header_offset: u64,
        value: u64,
        field_label: &str,
    ) -> Result<()> {
        self.patch_chd_header_bytes(
            output_file,
            output_path,
            header_offset,
            &value.to_be_bytes(),
            field_label,
        )
    }

    pub(super) fn patch_chd_header_bytes(
        &self,
        output_file: &mut File,
        output_path: &Path,
        header_offset: u64,
        bytes: &[u8],
        field_label: &str,
    ) -> Result<()> {
        let restore_offset = output_file.stream_position().map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to capture CHD write offset in `{}`: {error}",
                output_path.display()
            ))
        })?;
        output_file
            .seek(SeekFrom::Start(header_offset))
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to seek CHD {field_label} pointer in `{}`: {error}",
                    output_path.display()
                ))
            })?;
        output_file.write_all(bytes).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to finalize CHD {field_label} pointer in `{}`: {error}",
                output_path.display()
            ))
        })?;
        output_file
            .seek(SeekFrom::Start(restore_offset))
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to restore CHD write offset in `{}`: {error}",
                    output_path.display()
                ))
            })?;
        Ok(())
    }
}
