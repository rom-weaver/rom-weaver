use super::*;

impl ChdContainerHandler {
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
}
