/* jscpd:ignore-start */
#[derive(Clone, Debug)]
struct PbpIsoIndexEntry {
    offset: u64,
    length: u64,
}

#[derive(Clone, Debug)]
struct PbpTocTrack {
    track_type: u8,
    track_number: u8,
    start_frames: u32,
}

impl PbpTocTrack {
    fn cue_track_type(&self) -> Result<&'static str> {
        match self.track_type {
            0x41 => Ok("MODE2/2352"),
            0x01 => Ok("AUDIO"),
            other => Err(RomWeaverError::Validation(format!(
                "pbp toc uses unsupported track type 0x{other:02X}; supported types are 0x41 (MODE2/2352) and 0x01 (AUDIO)"
            ))),
        }
    }
}

#[derive(Clone, Debug)]
struct PbpDiscEntry {
    disc_number: usize,
    disc_id: String,
    psar_offset: u64,
    iso_size: u64,
    toc_tracks: Vec<PbpTocTrack>,
    iso_indexes: Vec<PbpIsoIndexEntry>,
}

#[derive(Clone, Debug)]
struct PbpArchive {
    discs: Vec<PbpDiscEntry>,
}

#[derive(Clone, Debug)]
struct PbpDiscOutput {
    cue_name: String,
    bin_name: String,
}

#[derive(Clone, Debug)]
struct PbpDiscExtractTask {
    disc_index: usize,
    task_index: usize,
    start_block: usize,
    block_count: usize,
    expected_len: u64,
}

#[derive(Debug)]
struct PbpDiscDecodedChunk {
    disc_index: usize,
    task_index: usize,
    data: Vec<u8>,
}

struct PbpContainerHandler;

impl PbpContainerHandler {
    const PBP_HEADER_SIZE: usize = 0x28;
    const PBP_SECTION_COUNT: usize = 8;
    const PSAR_INDEX_FIELD_OFFSET: usize = 0x24;
    const PSAR_GAME_ID_OFFSET: u64 = 0x400;
    const PSAR_TOC_OFFSET: u64 = 0x800;
    const PSAR_INDEX_OFFSET: u64 = 0x4000;
    const PSAR_ISO_OFFSET: u64 = 0x100000;
    const PSAR_INDEX_ENTRY_SIZE: usize = 0x20;
    const ISO_SECTOR_BYTES: usize = 0x930;
    const ISO_BLOCK_SECTORS: usize = 16;
    const ISO_BLOCK_BYTES: usize = Self::ISO_SECTOR_BYTES * Self::ISO_BLOCK_SECTORS;
    const PBP_EXTRACT_TASK_BLOCKS: usize = 128;
    const MULTI_DISC_SLOT_COUNT: usize = 5;
    const MULTI_DISC_MAGIC: [u8; 16] = *b"PSTITLEIMG000000";
    const SINGLE_DISC_MAGIC: [u8; 12] = *b"PSISOIMG0000";
    const MULTI_DISC_HEADER_KEYS: [u32; 4] = [0x2CC9_C5BC, 0x33B5_A90F, 0x06F6_B4B3, 0xB259_45BA];

    fn parse_archive(&self, source: &Path) -> Result<PbpArchive> {
        let mut file = File::open(source).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open pbp source `{}`: {error}",
                source.display()
            ))
        })?;
        let file_size = file.metadata()?.len();
        if file_size < Self::PBP_HEADER_SIZE as u64 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` is too small to be a pbp container",
                source.display()
            )));
        }

        let psar_offset = self.parse_psar_offset(source, &mut file, file_size)?;
        let disc_offsets = self.parse_disc_offsets(source, &mut file, psar_offset, file_size)?;
        let mut discs = Vec::with_capacity(disc_offsets.len());
        for (index, disc_offset) in disc_offsets.into_iter().enumerate() {
            discs.push(self.parse_disc_entry(
                source,
                &mut file,
                disc_offset,
                index + 1,
                file_size,
            )?);
        }
        if discs.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "pbp source `{}` contains no disc entries",
                source.display()
            )));
        }
        Ok(PbpArchive { discs })
    }

    fn parse_psar_offset(&self, source: &Path, file: &mut File, file_size: u64) -> Result<u64> {
        let mut header = [0u8; Self::PBP_HEADER_SIZE];
        self.read_exact_at(source, file, 0, &mut header, "PBP header")?;
        if header[..4] != PBP_SIGNATURE {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` is not a pbp container (missing \\0PBP magic)",
                source.display()
            )));
        }

        let mut previous = 0u32;
        for section_index in 0..Self::PBP_SECTION_COUNT {
            let offset_index = 8 + (section_index * 4);
            let offset = u32::from_le_bytes([
                header[offset_index],
                header[offset_index + 1],
                header[offset_index + 2],
                header[offset_index + 3],
            ]);
            if section_index == 0 && offset < Self::PBP_HEADER_SIZE as u32 {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has an invalid PBP section table (first section offset is {offset:#X})",
                    source.display()
                )));
            }
            if section_index > 0 && offset < previous {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has non-monotonic PBP section offsets",
                    source.display()
                )));
            }
            if u64::from(offset) > file_size {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has an out-of-range PBP section offset ({offset:#X})",
                    source.display()
                )));
            }
            previous = offset;
        }

        let psar_offset = u32::from_le_bytes([
            header[Self::PSAR_INDEX_FIELD_OFFSET],
            header[Self::PSAR_INDEX_FIELD_OFFSET + 1],
            header[Self::PSAR_INDEX_FIELD_OFFSET + 2],
            header[Self::PSAR_INDEX_FIELD_OFFSET + 3],
        ]) as u64;
        if psar_offset >= file_size {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has an invalid DATA.PSAR offset ({psar_offset:#X})",
                source.display()
            )));
        }
        Ok(psar_offset)
    }

    fn parse_disc_offsets(
        &self,
        source: &Path,
        file: &mut File,
        psar_offset: u64,
        file_size: u64,
    ) -> Result<Vec<u64>> {
        let mut signature = [0u8; 16];
        self.read_exact_at(
            source,
            file,
            psar_offset,
            &mut signature,
            "DATA.PSAR signature",
        )?;

        if signature[..12] == Self::SINGLE_DISC_MAGIC {
            return Ok(vec![psar_offset]);
        }

        if signature != Self::MULTI_DISC_MAGIC {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` does not contain a supported PS1 DATA.PSAR signature",
                source.display()
            )));
        }

        let mut cursor = psar_offset + 16;
        cursor = cursor
            .checked_add(8)
            .ok_or_else(|| RomWeaverError::Validation("pbp multi-disc header overflowed".into()))?;
        for (index, expected) in Self::MULTI_DISC_HEADER_KEYS.iter().enumerate() {
            let value = self.read_u32_le_at(source, file, cursor)?;
            if value != *expected {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has an unexpected multi-disc key at slot {}",
                    source.display(),
                    index + 1
                )));
            }
            cursor = cursor.checked_add(4).ok_or_else(|| {
                RomWeaverError::Validation("pbp multi-disc header overflowed".into())
            })?;
        }

        cursor = cursor
            .checked_add(0x76 * 4)
            .ok_or_else(|| RomWeaverError::Validation("pbp multi-disc header overflowed".into()))?;

        let mut raw_offsets = [0u8; Self::MULTI_DISC_SLOT_COUNT * 4];
        self.read_exact_at(
            source,
            file,
            cursor,
            &mut raw_offsets,
            "multi-disc offset table",
        )?;

        let mut discs = Vec::new();
        for index in 0..Self::MULTI_DISC_SLOT_COUNT {
            let offset_index = index * 4;
            let relative = u32::from_le_bytes([
                raw_offsets[offset_index],
                raw_offsets[offset_index + 1],
                raw_offsets[offset_index + 2],
                raw_offsets[offset_index + 3],
            ]) as u64;
            if relative == 0 {
                continue;
            }
            let absolute = psar_offset
                .checked_add(relative)
                .ok_or_else(|| RomWeaverError::Validation("pbp disc offset overflowed".into()))?;
            if absolute >= file_size {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` contains an out-of-range disc offset ({absolute:#X})",
                    source.display()
                )));
            }
            discs.push(absolute);
        }
        if discs.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` contains a multi-disc header with no disc offsets",
                source.display()
            )));
        }
        Ok(discs)
    }

    fn parse_disc_entry(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
        disc_number: usize,
        file_size: u64,
    ) -> Result<PbpDiscEntry> {
        let mut header = [0u8; 12];
        self.read_exact_at(
            source,
            file,
            disc_psar_offset,
            &mut header,
            "PSISOIMG header",
        )?;
        if header != Self::SINGLE_DISC_MAGIC {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` disc {} does not start with a PSISOIMG section",
                source.display(),
                disc_number
            )));
        }

        let disc_id = self.read_disc_id(source, file, disc_psar_offset)?;
        let toc_tracks = self.read_toc_tracks(source, file, disc_psar_offset)?;
        let iso_indexes = self.read_iso_indexes(source, file, disc_psar_offset, file_size)?;
        if iso_indexes.len() < 2 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` disc {} has too few ISO index blocks",
                source.display(),
                disc_number
            )));
        }
        let iso_size =
            self.read_iso_size_from_index(source, file, disc_psar_offset, &iso_indexes)?;
        let required_blocks = self.required_block_count(iso_size)?;
        if iso_indexes.len() < required_blocks {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` disc {} index table is incomplete ({} blocks required, {} present)",
                source.display(),
                disc_number,
                required_blocks,
                iso_indexes.len()
            )));
        }

        Ok(PbpDiscEntry {
            disc_number,
            disc_id,
            psar_offset: disc_psar_offset,
            iso_size,
            toc_tracks,
            iso_indexes,
        })
    }

    fn read_disc_id(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
    ) -> Result<String> {
        let mut bytes = [0u8; 11];
        self.read_exact_at(
            source,
            file,
            disc_psar_offset + Self::PSAR_GAME_ID_OFFSET,
            &mut bytes,
            "disc id",
        )?;
        let mut disc_id_bytes = [0u8; 9];
        disc_id_bytes[..4].copy_from_slice(&bytes[1..5]);
        disc_id_bytes[4..].copy_from_slice(&bytes[6..11]);
        let disc_id = String::from_utf8_lossy(&disc_id_bytes)
            .trim_matches(char::from(0))
            .trim()
            .to_string();
        if disc_id.is_empty() {
            Ok("unknown".to_string())
        } else {
            Ok(disc_id)
        }
    }

    fn read_toc_tracks(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
    ) -> Result<Vec<PbpTocTrack>> {
        let mut entry = [0u8; 10];
        let mut cursor = disc_psar_offset + Self::PSAR_TOC_OFFSET;
        self.read_exact_at(source, file, cursor, &mut entry, "TOC start-track entry")?;
        if entry[2] != 0xA0 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has an invalid PBP TOC (missing A0 entry)",
                source.display()
            )));
        }
        let start_track = Self::decode_bcd(entry[7], "TOC start track")?;
        cursor += 10;

        self.read_exact_at(source, file, cursor, &mut entry, "TOC end-track entry")?;
        if entry[2] != 0xA1 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has an invalid PBP TOC (missing A1 entry)",
                source.display()
            )));
        }
        let end_track = Self::decode_bcd(entry[7], "TOC end track")?;
        if start_track == 0 || end_track < start_track {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has an invalid TOC track range ({start_track}..={end_track})",
                source.display()
            )));
        }
        cursor += 10;

        self.read_exact_at(source, file, cursor, &mut entry, "TOC leadout entry")?;
        if entry[2] != 0xA2 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has an invalid PBP TOC (missing A2 entry)",
                source.display()
            )));
        }
        let _leadout = Self::msf_to_frames(
            Self::decode_bcd(entry[7], "TOC leadout minute")?,
            Self::decode_bcd(entry[8], "TOC leadout second")?,
            Self::decode_bcd(entry[9], "TOC leadout frame")?,
        )?;
        cursor += 10;

        let mut tracks = Vec::new();
        for expected_track in start_track..=end_track {
            self.read_exact_at(source, file, cursor, &mut entry, "TOC track entry")?;
            cursor += 10;
            let track_number = Self::decode_bcd(entry[2], "TOC track number")?;
            if track_number != expected_track {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has an invalid TOC track order (expected {}, found {})",
                    source.display(),
                    expected_track,
                    track_number
                )));
            }

            let start_frames = Self::msf_to_frames(
                Self::decode_bcd(entry[3], "TOC track minute")?,
                Self::decode_bcd(entry[4], "TOC track second")?,
                Self::decode_bcd(entry[5], "TOC track frame")?,
            )?;
            let track = PbpTocTrack {
                track_type: entry[0],
                track_number,
                start_frames,
            };
            track.cue_track_type()?;
            tracks.push(track);
        }
        Ok(tracks)
    }

    fn read_iso_indexes(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
        file_size: u64,
    ) -> Result<Vec<PbpIsoIndexEntry>> {
        let index_span = usize::try_from(Self::PSAR_ISO_OFFSET - Self::PSAR_INDEX_OFFSET)
            .map_err(|_| RomWeaverError::Validation("pbp index table length overflowed".into()))?;
        let mut bytes = vec![0u8; index_span];
        self.read_exact_at(
            source,
            file,
            disc_psar_offset + Self::PSAR_INDEX_OFFSET,
            &mut bytes,
            "ISO index table",
        )?;

        let mut indexes = Vec::new();
        for chunk in bytes.chunks_exact(Self::PSAR_INDEX_ENTRY_SIZE) {
            let offset = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as u64;
            let length = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
            if offset == 0 && length == 0 {
                continue;
            }
            if length == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has a malformed ISO index entry",
                    source.display()
                )));
            }
            let data_start = disc_psar_offset
                .checked_add(Self::PSAR_ISO_OFFSET)
                .and_then(|value| value.checked_add(offset))
                .ok_or_else(|| {
                    RomWeaverError::Validation("pbp ISO index offset overflowed".into())
                })?;
            let data_end = data_start.checked_add(length).ok_or_else(|| {
                RomWeaverError::Validation("pbp ISO index length overflowed".into())
            })?;
            if data_end > file_size {
                return Err(RomWeaverError::Validation(format!(
                    "source `{}` has an out-of-range ISO index entry",
                    source.display()
                )));
            }
            indexes.push(PbpIsoIndexEntry { offset, length });
        }

        if indexes.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` does not contain any ISO index blocks",
                source.display()
            )));
        }
        Ok(indexes)
    }

    fn read_iso_size_from_index(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
        indexes: &[PbpIsoIndexEntry],
    ) -> Result<u64> {
        let mut block = vec![0u8; Self::ISO_BLOCK_BYTES];
        let decoded =
            self.read_iso_block(source, file, disc_psar_offset, indexes, 1, &mut block)?;
        if decoded < 108 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` has a truncated ISO size descriptor block",
                source.display()
            )));
        }
        let sector_count = u32::from_le_bytes([block[104], block[105], block[106], block[107]]);
        if sector_count == 0 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` reported an invalid ISO sector count of zero",
                source.display()
            )));
        }
        u64::from(sector_count)
            .checked_mul(Self::ISO_SECTOR_BYTES as u64)
            .ok_or_else(|| RomWeaverError::Validation("pbp ISO size overflowed".into()))
    }

    fn read_iso_block(
        &self,
        source: &Path,
        file: &mut File,
        disc_psar_offset: u64,
        indexes: &[PbpIsoIndexEntry],
        block_index: usize,
        output: &mut [u8],
    ) -> Result<usize> {
        let entry = indexes.get(block_index).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "source `{}` is missing ISO block index {}",
                source.display(),
                block_index
            ))
        })?;
        let compressed_len = usize::try_from(entry.length).map_err(|_| {
            RomWeaverError::Validation("pbp ISO block length overflowed usize".into())
        })?;
        if compressed_len == 0 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` contains an empty ISO block entry",
                source.display()
            )));
        }
        let mut compressed = vec![0u8; compressed_len];
        let source_offset = disc_psar_offset
            .checked_add(Self::PSAR_ISO_OFFSET)
            .and_then(|value| value.checked_add(entry.offset))
            .ok_or_else(|| RomWeaverError::Validation("pbp ISO block offset overflowed".into()))?;
        self.read_exact_at(
            source,
            file,
            source_offset,
            &mut compressed,
            "ISO block payload",
        )?;

        if compressed_len == Self::ISO_BLOCK_BYTES {
            output[..Self::ISO_BLOCK_BYTES].copy_from_slice(&compressed);
            return Ok(Self::ISO_BLOCK_BYTES);
        }

        let decode = decode_deflate_into_buffer(&compressed, output).map_err(|error| {
            RomWeaverError::Validation(format!(
                "source `{}` contains an undecodable deflate ISO block: {error}",
                source.display()
            ))
        })?;
        if decode.has_trailing_bytes {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` contains an oversized deflate ISO block",
                source.display()
            )));
        }
        if decode.bytes_written == 0 {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` contains an undecodable deflate ISO block",
                source.display()
            )));
        }
        Ok(decode.bytes_written)
    }

    fn required_block_count(&self, iso_size: u64) -> Result<usize> {
        if iso_size == 0 {
            return Ok(0);
        }
        let block_bytes = Self::ISO_BLOCK_BYTES as u64;
        let blocks = iso_size.div_ceil(block_bytes);
        usize::try_from(blocks).map_err(|_| {
            RomWeaverError::Validation("pbp ISO block count exceeds supported size".into())
        })
    }

    fn build_disc_extract_tasks(
        &self,
        disc_index: usize,
        disc: &PbpDiscEntry,
    ) -> Result<Vec<PbpDiscExtractTask>> {
        let required_blocks = self.required_block_count(disc.iso_size)?;
        if required_blocks == 0 {
            return Ok(Vec::new());
        }

        let mut tasks = Vec::new();
        let mut start_block = 0usize;
        let mut task_index = 0usize;
        while start_block < required_blocks {
            let block_count = (required_blocks - start_block).min(Self::PBP_EXTRACT_TASK_BLOCKS);
            let start_offset = u64::try_from(start_block)
                .ok()
                .and_then(|value| value.checked_mul(Self::ISO_BLOCK_BYTES as u64))
                .ok_or_else(|| {
                    RomWeaverError::Validation("pbp extract block offset overflowed".into())
                })?;
            let max_task_len = u64::try_from(block_count)
                .ok()
                .and_then(|value| value.checked_mul(Self::ISO_BLOCK_BYTES as u64))
                .ok_or_else(|| {
                    RomWeaverError::Validation("pbp extract block length overflowed".into())
                })?;
            let expected_len = disc.iso_size.saturating_sub(start_offset).min(max_task_len);
            tasks.push(PbpDiscExtractTask {
                disc_index,
                task_index,
                start_block,
                block_count,
                expected_len,
            });
            start_block += block_count;
            task_index += 1;
        }
        Ok(tasks)
    }

    fn decode_disc_extract_task(
        &self,
        source: &Path,
        disc: &PbpDiscEntry,
        task: &PbpDiscExtractTask,
    ) -> Result<PbpDiscDecodedChunk> {
        let mut source_file = File::open(source).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open pbp source `{}`: {error}",
                source.display()
            ))
        })?;
        let expected_len = usize::try_from(task.expected_len).map_err(|_| {
            RomWeaverError::Validation("pbp extract chunk length overflowed usize".into())
        })?;
        let mut output = Vec::with_capacity(expected_len);
        let mut block = vec![0u8; Self::ISO_BLOCK_BYTES];
        let mut remaining = task.expected_len;
        let mut total_written = 0u64;

        for block_offset in 0..task.block_count {
            if remaining == 0 {
                break;
            }
            let block_index = task.start_block + block_offset;
            let decoded = self.read_iso_block(
                source,
                &mut source_file,
                disc.psar_offset,
                &disc.iso_indexes,
                block_index,
                &mut block,
            )?;
            if decoded == 0 {
                break;
            }
            let to_write = remaining.min(decoded as u64);
            let to_write_usize = usize::try_from(to_write).map_err(|_| {
                RomWeaverError::Validation("pbp block write length overflowed usize".into())
            })?;
            output.extend_from_slice(&block[..to_write_usize]);
            total_written = total_written.saturating_add(to_write);
            remaining -= to_write;
        }

        if total_written != task.expected_len {
            return Err(RomWeaverError::Validation(format!(
                "source `{}` disc {} chunk {} wrote {} bytes but expected {}",
                source.display(),
                disc.disc_number,
                task.task_index,
                total_written,
                task.expected_len
            )));
        }

        Ok(PbpDiscDecodedChunk {
            disc_index: task.disc_index,
            task_index: task.task_index,
            data: output,
        })
    }

    fn write_cue_sheet(
        &self,
        cue_path: &Path,
        bin_name: &str,
        tracks: &[PbpTocTrack],
        overwrite: bool,
    ) -> Result<()> {
        let mut writer = BufWriter::new(create_extract_output_file(cue_path, overwrite)?);
        writer.write_all(format!("FILE \"{bin_name}\" BINARY\n").as_bytes())?;
        for track in tracks {
            let track_type = track.cue_track_type()?;
            writer.write_all(
                format!("  TRACK {:02} {track_type}\n", track.track_number).as_bytes(),
            )?;
            if track.track_type == 0x01 {
                let index00 = track.start_frames.saturating_sub(150);
                writer.write_all(
                    format!("    INDEX 00 {}\n", Self::format_msf(index00)).as_bytes(),
                )?;
            }
            writer.write_all(
                format!("    INDEX 01 {}\n", Self::format_msf(track.start_frames)).as_bytes(),
            )?;
        }
        writer.flush()?;
        Ok(())
    }

    fn build_disc_outputs(&self, source: &Path, disc_count: usize) -> Vec<PbpDiscOutput> {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        if disc_count <= 1 {
            return vec![PbpDiscOutput {
                cue_name: format!("{stem}.cue"),
                bin_name: format!("{stem}.bin"),
            }];
        }
        (1..=disc_count)
            .map(|disc_number| PbpDiscOutput {
                cue_name: format!("{stem}.disc{disc_number:02}.cue"),
                bin_name: format!("{stem}.disc{disc_number:02}.bin"),
            })
            .collect()
    }

    fn decode_bcd(value: u8, label: &str) -> Result<u8> {
        let ones = value & 0x0F;
        let tens = value >> 4;
        if ones > 9 || tens > 9 {
            return Err(RomWeaverError::Validation(format!(
                "pbp toc contains invalid BCD value for {label}: 0x{value:02X}"
            )));
        }
        Ok(tens * 10 + ones)
    }

    fn msf_to_frames(minutes: u8, seconds: u8, frames: u8) -> Result<u32> {
        if seconds >= 60 || frames >= 75 {
            return Err(RomWeaverError::Validation(format!(
                "pbp toc contains invalid MSF timestamp {minutes:02}:{seconds:02}:{frames:02}"
            )));
        }
        Ok(u32::from(minutes) * 60 * 75 + u32::from(seconds) * 75 + u32::from(frames))
    }

    fn format_msf(frames: u32) -> String {
        let minutes = frames / (60 * 75);
        let seconds = (frames / 75) % 60;
        let frame = frames % 75;
        format!("{minutes:02}:{seconds:02}:{frame:02}")
    }

    fn read_u32_le_at(&self, source: &Path, file: &mut File, offset: u64) -> Result<u32> {
        let mut bytes = [0u8; 4];
        self.read_exact_at(source, file, offset, &mut bytes, "u32 value")?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_exact_at(
        &self,
        source: &Path,
        file: &mut File,
        offset: u64,
        output: &mut [u8],
        label: &str,
    ) -> Result<()> {
        file.seek(SeekFrom::Start(offset))?;
        if let Err(error) = file.read_exact(output) {
            return if error.kind() == io::ErrorKind::UnexpectedEof {
                Err(RomWeaverError::Validation(format!(
                    "source `{}` is truncated while reading {label}",
                    source.display()
                )))
            } else {
                Err(error.into())
            };
        }
        Ok(())
    }
}

impl ContainerHandlerOperations for PbpContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &PBP
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if file_starts_with(source, &PBP_SIGNATURE) {
            ProbeConfidence::Signature
        } else {
            ProbeConfidence::Extension
        }
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let archive = self.parse_archive(&request.source)?;
        let disc_count = archive.discs.len();
        let total_tracks = archive
            .discs
            .iter()
            .map(|disc| disc.toc_tracks.len())
            .sum::<usize>();
        let total_bytes = archive.discs.iter().map(|disc| disc.iso_size).sum::<u64>();
        let disc_ids = archive
            .discs
            .iter()
            .map(|disc| format!("{}={}", disc.disc_number, disc.disc_id))
            .collect::<Vec<_>>()
            .join(", ");

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(PBP.name.to_string()),
            "inspect",
            format!(
                "pbp: {disc_count} disc(s), {total_tracks} track(s), {total_bytes} bytes; disc_ids=[{disc_ids}]"
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        let archive = self.parse_archive(&request.source)?;
        let outputs = self.build_disc_outputs(&request.source, archive.discs.len());
        let mut entries = Vec::with_capacity(outputs.len() * 2);
        for output in outputs {
            entries.push(output.cue_name);
            entries.push(output.bin_name);
        }
        Ok(entries)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let archive = self.parse_archive(&request.source)?;
        let outputs = self.build_disc_outputs(&request.source, archive.discs.len());
        fs::create_dir_all(&request.out_dir)?;

        let selection_requested = !request.selections.is_empty();
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut extract_plan = Vec::new();
        for (disc_index, output) in outputs.iter().enumerate() {
            let cue_selected = selections.matches(&output.cue_name);
            let bin_selected = selections.matches(&output.bin_name);
            let write_cue = !selection_requested || cue_selected;
            let mut write_bin = !selection_requested || bin_selected;
            if selection_requested && cue_selected && !write_bin {
                write_bin = true;
            }
            if write_cue || write_bin {
                extract_plan.push((disc_index, write_cue, write_bin));
            }
        }
        selections.ensure_all_matched()?;
        if selection_requested && extract_plan.is_empty() {
            return Err(RomWeaverError::Validation(
                "requested selections resolved to no extractable pbp outputs".into(),
            ));
        }
        let total_extract_bytes =
            extract_plan
                .iter()
                .try_fold(0_u64, |total, (disc_index, _, write_bin)| {
                    if !*write_bin {
                        return Ok(total);
                    }
                    total
                        .checked_add(archive.discs[*disc_index].iso_size)
                        .ok_or_else(|| {
                            RomWeaverError::Validation(
                                "pbp extract selected output size overflowed".into(),
                            )
                        })
                })?;
        let extract_progress_label = format!("extracting `{}`", PBP.name);
        let extract_progress_bytes = Arc::new(AtomicU64::new(0));
        let extract_progress_bucket = Arc::new(AtomicU8::new(0));
        let mut execution = context.plan_threads(ThreadCapability::parallel(None));

        let mut produced_outputs = Vec::new();
        let mut total_written = 0u64;

        for (disc_index, write_cue, write_bin) in extract_plan {
            let disc = &archive.discs[disc_index];
            let output = &outputs[disc_index];
            let bin_path = request.out_dir.join(&output.bin_name);
            if write_bin {
                let tasks = self.build_disc_extract_tasks(disc_index, disc)?;
                let extract_capability = ThreadCapability::parallel(Some(tasks.len().max(1)));
                let (disc_execution, pool) = context.build_pool(extract_capability)?;
                execution = disc_execution;

                if let Some(parent) = bin_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut ordered_writer = OrderedChunkWriter::new(
                    BufWriter::new(create_extract_output_file(&bin_path, request.overwrite)?),
                    bounded_items_for_threads(execution.effective_threads),
                )?;
                let source = request.source.clone();
                let decode_result = if execution.used_parallelism {
                    let progress_context = context.clone();
                    let progress_execution = execution.clone();
                    write_decoded_chunks_from_workers(
                        &pool,
                        &tasks,
                        bounded_items_for_threads(execution.effective_threads),
                        "pbp extract output receiver closed",
                        |task| {
                            let chunk = self.decode_disc_extract_task(&source, disc, task)?;
                            let chunk_len = u64::try_from(chunk.data.len()).map_err(|_| {
                                RomWeaverError::Validation(
                                    "pbp extract chunk length overflowed".into(),
                                )
                            })?;
                            if chunk_len != task.expected_len {
                                return Err(RomWeaverError::Validation(format!(
                                    "pbp extract chunk {} for disc {} wrote {} bytes but expected {}",
                                    task.task_index, disc.disc_number, chunk_len, task.expected_len
                                )));
                            }
                            if chunk.disc_index != task.disc_index
                                || chunk.task_index != task.task_index
                            {
                                return Err(RomWeaverError::Validation(format!(
                                    "pbp extract chunk order mismatch for disc {} task {}",
                                    disc.disc_number, task.task_index
                                )));
                            }
                            let chunk_index = u64::try_from(task.task_index).map_err(|_| {
                                RomWeaverError::Validation(
                                    "pbp extract chunk index overflowed".into(),
                                )
                            })?;
                            Ok((chunk_index, chunk.data, chunk_len))
                        },
                        |(chunk_index, data, chunk_len)| {
                            ordered_writer.write_chunk(chunk_index, data)?;
                            if total_extract_bytes > 0 {
                                let completed = extract_progress_bytes
                                    .fetch_add(chunk_len, Ordering::Relaxed)
                                    .saturating_add(chunk_len)
                                    .min(total_extract_bytes);
                                maybe_emit_container_byte_progress(
                                    &progress_context,
                                    completed,
                                    total_extract_bytes,
                                    ContainerByteProgress {
                                        command: "extract",
                                        format: PBP.name,
                                        stage: "extract",
                                        label: &extract_progress_label,
                                        thread_execution: Some(&progress_execution),
                                        emitted_progress_bucket: extract_progress_bucket.as_ref(),
                                    },
                                );
                            }
                            Ok(())
                        },
                    )
                } else {
                    tasks.iter().try_for_each(|task| {
                        let chunk = self.decode_disc_extract_task(&source, disc, task)?;
                        let chunk_len = u64::try_from(chunk.data.len()).map_err(|_| {
                            RomWeaverError::Validation("pbp extract chunk length overflowed".into())
                        })?;
                        if chunk_len != task.expected_len {
                            return Err(RomWeaverError::Validation(format!(
                                "pbp extract chunk {} for disc {} wrote {} bytes but expected {}",
                                task.task_index, disc.disc_number, chunk_len, task.expected_len
                            )));
                        }
                        if chunk.disc_index != task.disc_index
                            || chunk.task_index != task.task_index
                        {
                            return Err(RomWeaverError::Validation(format!(
                                "pbp extract chunk order mismatch for disc {} task {}",
                                disc.disc_number, task.task_index
                            )));
                        }
                        let chunk_index = u64::try_from(task.task_index).map_err(|_| {
                            RomWeaverError::Validation("pbp extract chunk index overflowed".into())
                        })?;
                        ordered_writer.write_chunk(chunk_index, chunk.data)?;
                        if total_extract_bytes > 0 {
                            let completed = extract_progress_bytes
                                .fetch_add(chunk_len, Ordering::Relaxed)
                                .saturating_add(chunk_len)
                                .min(total_extract_bytes);
                            maybe_emit_container_byte_progress(
                                context,
                                completed,
                                total_extract_bytes,
                                ContainerByteProgress {
                                    command: "extract",
                                    format: PBP.name,
                                    stage: "extract",
                                    label: &extract_progress_label,
                                    thread_execution: Some(&execution),
                                    emitted_progress_bucket: extract_progress_bucket.as_ref(),
                                },
                            );
                        }
                        Ok(())
                    })
                };
                if let Err(error) = decode_result {
                    let _ = fs::remove_file(&bin_path);
                    return Err(error);
                }
                if let Err(error) = ordered_writer.finish() {
                    let _ = fs::remove_file(&bin_path);
                    return Err(error);
                }

                total_written = total_written.saturating_add(disc.iso_size);
                produced_outputs.push(bin_path.clone());
            }
            if write_cue {
                let cue_path = request.out_dir.join(&output.cue_name);
                self.write_cue_sheet(
                    &cue_path,
                    &output.bin_name,
                    &disc.toc_tracks,
                    request.overwrite,
                )?;
                produced_outputs.push(cue_path);
            }
        }

        if selection_requested && produced_outputs.is_empty() {
            return Err(RomWeaverError::Validation(
                "requested selections resolved to no extractable pbp outputs".into(),
            ));
        }

        let label = if selection_requested {
            let outputs = produced_outputs
                .iter()
                .map(|path| format!("`{}`", path.display()))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "extracted `{}` to selected outputs: {} ({} disc(s), {} bytes written)",
                request.source.display(),
                outputs,
                archive.discs.len(),
                total_written
            )
        } else if archive.discs.len() == 1 {
            let output = &outputs[0];
            format!(
                "extracted `{}` to `{}` and `{}` ({} bytes written)",
                request.source.display(),
                request.out_dir.join(&output.cue_name).display(),
                request.out_dir.join(&output.bin_name).display(),
                total_written
            )
        } else {
            format!(
                "extracted `{}` to {} cue/bin pair(s) ({} bytes written)",
                request.source.display(),
                archive.discs.len(),
                total_written
            )
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(PBP.name.to_string()),
            "extract",
            label,
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "pbp create is not supported".into(),
        ))
    }
}

type XisoSourceDevice = XdvdfsOffsetWrapper<BufReader<File>, io::Error>;
type XisoSourceFilesystem = XdvdfsFilesystem<io::Error, XisoSourceDevice>;
/* jscpd:ignore-end */
