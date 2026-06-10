use super::*;

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
}
