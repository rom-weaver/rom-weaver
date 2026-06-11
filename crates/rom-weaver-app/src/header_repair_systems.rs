//! Per-system header/checksum repair routines.
//!
//! Each `repair_*`/`validate_*` function inspects an already-open ROM [`File`],
//! decides whether it matches that platform's header format, and either repairs
//! the checksum/padding in place or reports a non-match. They are orchestrated
//! by `CliApp::repair_checksum_file_in_place` (see `header_repair.rs`) and lean
//! on the generic byte helpers in `header_repair_byte_io`.

use super::*;

impl CliApp {
    pub(super) fn repair_snes_checksum_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len <= ROM_HEADER_BYTES {
            return Ok(HeaderRepairStatus::NotMatched);
        }

        let copier_offset =
            if file_len as u64 % SNES_COPIER_HEADER_MODULUS == ROM_HEADER_BYTES as u64 {
                ROM_HEADER_BYTES
            } else {
                0
            };
        let rom_size = file_len.saturating_sub(copier_offset);
        if rom_size == 0 {
            return Ok(HeaderRepairStatus::NotMatched);
        }

        let lo_rom_header = copier_offset.saturating_add(0x7FC0);
        let hi_rom_header = copier_offset.saturating_add(0xFFC0);
        let header_offset = if hi_rom_header + 0x30 <= file_len
            && Self::is_valid_snes_title_file(file, hi_rom_header, file_len)?
        {
            hi_rom_header
        } else if lo_rom_header + 0x30 <= file_len
            && Self::is_valid_snes_title_file(file, lo_rom_header, file_len)?
        {
            lo_rom_header
        } else {
            return Ok(HeaderRepairStatus::NotMatched);
        };

        let checksum_complement_offset = header_offset + 0x1C;
        let checksum_offset = header_offset + 0x1E;
        if checksum_offset + 2 > file_len || checksum_complement_offset + 2 > file_len {
            return Ok(HeaderRepairStatus::NotMatched);
        }

        let old_complement_bytes = read_vec_at(file, checksum_complement_offset as u64, 2)?;
        let old_checksum_bytes = read_vec_at(file, checksum_offset as u64, 2)?;
        let old_complement = u16::from_le_bytes([old_complement_bytes[0], old_complement_bytes[1]]);
        let old_checksum = u16::from_le_bytes([old_checksum_bytes[0], old_checksum_bytes[1]]);

        let zeroed_ranges = [
            (checksum_complement_offset, checksum_complement_offset + 2),
            (checksum_offset, checksum_offset + 2),
        ];

        let sum = if rom_size.is_power_of_two() {
            sum_range_with_zeroed(file, copier_offset, file_len, &zeroed_ranges)?
        } else {
            let Some(next_power_of_two) = rom_size.checked_next_power_of_two() else {
                return Ok(HeaderRepairStatus::NotMatched);
            };
            let base_size = next_power_of_two / 2;
            let excess_size = rom_size.saturating_sub(base_size);
            let mut sum = sum_range_with_zeroed(
                file,
                copier_offset,
                copier_offset + base_size,
                &zeroed_ranges,
            )?;
            if excess_size > 0 {
                let excess_sum = sum_range_with_zeroed(
                    file,
                    copier_offset + base_size,
                    file_len,
                    &zeroed_ranges,
                )?;
                let mirror_count = (next_power_of_two - base_size)
                    .checked_div(excess_size)
                    .unwrap_or(0);
                sum = sum.wrapping_add(excess_sum.wrapping_mul(mirror_count as u32));
            }
            sum
        };

        let new_checksum = (sum & 0xFFFF) as u16;
        let new_complement = new_checksum ^ 0xFFFF;
        write_all_at(
            file,
            checksum_complement_offset as u64,
            &new_complement.to_le_bytes(),
        )?;
        write_all_at(file, checksum_offset as u64, &new_checksum.to_le_bytes())?;

        if old_checksum == new_checksum && old_complement == new_complement {
            Ok(HeaderRepairStatus::MatchedNoChange)
        } else {
            Ok(HeaderRepairStatus::Repaired)
        }
    }

    pub(super) fn is_valid_snes_title_file(
        file: &mut File,
        offset: usize,
        file_len: usize,
    ) -> Result<bool> {
        if offset + 21 > file_len {
            return Ok(false);
        }
        let bytes = read_vec_at(file, offset as u64, 21)?;
        let printable_count = bytes
            .iter()
            .filter(|value| (0x20..=0x7E).contains(*value))
            .count();
        Ok(printable_count >= 10)
    }

    pub(super) fn repair_nes_header_padding_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len < 16 {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let mut header = read_vec_at(file, 0, 16)?;
        if header[..4] != INES_HEADER_MAGIC {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let is_nes2 = (header[7] & 0x0C) == 0x08;
        if is_nes2 {
            return Ok(HeaderRepairStatus::MatchedNoChange);
        }

        let mut changed = false;
        for value in &mut header[11..16] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            write_all_at(file, 11, &header[11..16])?;
            Ok(HeaderRepairStatus::Repaired)
        } else {
            Ok(HeaderRepairStatus::MatchedNoChange)
        }
    }

    pub(super) fn validate_fds_header_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len < 16 {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let prefix = read_vec_at(file, 0, FDS_HEADER_MAGIC.len())?;
        if prefix == FDS_HEADER_MAGIC {
            Ok(HeaderRepairStatus::MatchedNoChange)
        } else {
            Ok(HeaderRepairStatus::NotMatched)
        }
    }

    pub(super) fn repair_gba_header_checksum_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len < 0x1BE {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let header = read_vec_at(file, 0, 0x1BE)?;
        if header[0x04..0x08] != GBA_HEADER_MAGIC {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let old_checksum = header[0x1BD];
        let mut checksum = 0_i32;
        for value in &header[0xA0..=0xBC] {
            checksum -= i32::from(*value);
        }
        let new_checksum = ((checksum - 0x19) & 0xFF) as u8;
        write_all_at(file, 0x1BD, &[new_checksum])?;

        if old_checksum == new_checksum {
            Ok(HeaderRepairStatus::MatchedNoChange)
        } else {
            Ok(HeaderRepairStatus::Repaired)
        }
    }

    pub(super) fn repair_sega_genesis_checksum_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len <= 0x18F || file_len < 0x200 {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let sega_probe = read_vec_at(file, 0x100, 5)?;
        if sega_probe[0..4] != *b"SEGA" && sega_probe[1..5] != *b"SEGA" {
            return Ok(HeaderRepairStatus::NotMatched);
        }

        let old_checksum_bytes = read_vec_at(file, 0x18E, 2)?;
        let old_checksum = u16::from_be_bytes([old_checksum_bytes[0], old_checksum_bytes[1]]);
        let sum = sum_sega_words(file, 0x200, file_len)?;
        let new_checksum = (sum & 0xFFFF) as u16;
        write_all_at(file, 0x18E, &new_checksum.to_be_bytes())?;

        if old_checksum == new_checksum {
            Ok(HeaderRepairStatus::MatchedNoChange)
        } else {
            Ok(HeaderRepairStatus::Repaired)
        }
    }

    pub(super) fn repair_game_boy_checksum_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len <= 0x14F {
            return Ok(HeaderRepairStatus::NotMatched);
        }

        let header = read_vec_at(file, 0, 0x150)?;
        if header[0x104..0x134] != GAME_BOY_NINTENDO_LOGO {
            return Ok(HeaderRepairStatus::NotMatched);
        }

        let old_header_checksum = header[0x14D];
        let old_global_checksum = u16::from_be_bytes([header[0x14E], header[0x14F]]);

        let mut header_checksum = 0_u8;
        for value in &header[0x134..=0x14C] {
            header_checksum = header_checksum.wrapping_sub(*value).wrapping_sub(1);
        }

        let global_sum = sum_range_with_zeroed(file, 0, file_len, &[(0x14E, 0x150)])?;
        let global_checksum = (global_sum & 0xFFFF) as u16;

        write_all_at(file, 0x14D, &[header_checksum])?;
        write_all_at(file, 0x14E, &global_checksum.to_be_bytes())?;

        if old_header_checksum == header_checksum && old_global_checksum == global_checksum {
            Ok(HeaderRepairStatus::MatchedNoChange)
        } else {
            Ok(HeaderRepairStatus::Repaired)
        }
    }

    pub(super) fn repair_sms_tmr_checksum_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        let mut header_offset = None;
        for offset in [0x7FF0usize, 0x3FF0, 0x1FF0] {
            if offset + SMS_TMR_SEGA_MAGIC.len() > file_len {
                continue;
            }
            let probe = read_vec_at(file, offset as u64, SMS_TMR_SEGA_MAGIC.len())?;
            if probe == SMS_TMR_SEGA_MAGIC {
                header_offset = Some(offset);
                break;
            }
        }
        let Some(header_offset) = header_offset else {
            return Ok(HeaderRepairStatus::NotMatched);
        };

        if header_offset + 0x10 > file_len {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let checksum_offset = header_offset + 0x0A;
        if checksum_offset + 2 > file_len {
            return Ok(HeaderRepairStatus::NotMatched);
        }

        let header = read_vec_at(file, header_offset as u64, 16)?;
        let old_checksum = u16::from_le_bytes([header[0x0A], header[0x0B]]);
        let size_nibble = header[0x0F] & 0x0F;
        let declared_end = match size_nibble {
            0xA => 0x2000usize,
            0xB => 0x4000,
            0xC => 0x8000,
            0xD => 0xC000,
            0xE => 0x10000,
            0xF => 0x20000,
            0x0 => 0x40000,
            0x1 => 0x80000,
            0x2 => 0x100000,
            _ => file_len,
        };
        let checksum_end = declared_end.min(file_len);

        let sum = sum_range_with_zeroed(
            file,
            0,
            checksum_end,
            &[(header_offset, header_offset + 16)],
        )?;
        let new_checksum = (sum & 0xFFFF) as u16;
        write_all_at(file, checksum_offset as u64, &new_checksum.to_le_bytes())?;

        if old_checksum == new_checksum {
            Ok(HeaderRepairStatus::MatchedNoChange)
        } else {
            Ok(HeaderRepairStatus::Repaired)
        }
    }

    pub(super) fn repair_n64_checksum_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len < 0x101000 {
            return Ok(HeaderRepairStatus::NotMatched);
        }

        let Some(order) = Self::detect_n64_byte_order_file(file, file_len)? else {
            return Ok(HeaderRepairStatus::NotMatched);
        };

        let old_crc1 = Self::read_n64_word_normalized(file, 0x10, order)?;
        let old_crc2 = Self::read_n64_word_normalized(file, 0x14, order)?;

        let seed = 0xF8CA4DDCu32;
        let mut t1 = seed;
        let mut t2 = seed;
        let mut t3 = seed;
        let mut t4 = seed;
        let mut t5 = seed;
        let mut t6 = seed;

        for offset in (0x1000usize..0x101000usize).step_by(4) {
            let d = Self::read_n64_word_normalized(file, offset as u64, order)?;
            if t6.wrapping_add(d) < t6 {
                t4 = t4.wrapping_add(1);
            }
            t6 = t6.wrapping_add(d);
            t3 ^= d;

            let shift = d & 0x1F;
            let rotated = if shift == 0 { d } else { d.rotate_left(shift) };

            t5 = t5.wrapping_add(rotated);
            if t2 > d {
                t2 ^= rotated;
            } else {
                t2 ^= t6 ^ d;
            }
            t1 = t1.wrapping_add(t5 ^ d);
        }

        let new_crc1 = t6 ^ t4 ^ t3;
        let new_crc2 = t5 ^ t2 ^ t1;
        Self::write_n64_word_original_order(file, 0x10, new_crc1, order)?;
        Self::write_n64_word_original_order(file, 0x14, new_crc2, order)?;

        if old_crc1 == new_crc1 && old_crc2 == new_crc2 {
            Ok(HeaderRepairStatus::MatchedNoChange)
        } else {
            Ok(HeaderRepairStatus::Repaired)
        }
    }

    pub(super) fn repair_atari_7800_header_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len < 128 {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let probe = read_vec_at(file, 0, 1 + A78_HEADER_MAGIC.len())?;
        if probe[1..1 + A78_HEADER_MAGIC.len()] != A78_HEADER_MAGIC {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let mut header_tail = read_vec_at(file, 0x64, 0x80 - 0x64)?;
        let mut changed = false;
        for value in &mut header_tail {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            write_all_at(file, 0x64, &header_tail)?;
            Ok(HeaderRepairStatus::Repaired)
        } else {
            Ok(HeaderRepairStatus::MatchedNoChange)
        }
    }

    pub(super) fn repair_atari_lynx_header_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len < 64 {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let mut header = read_vec_at(file, 0, 64)?;
        if header[..4] != LNX_HEADER_MAGIC {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let mut changed = false;
        let page_size = u16::from_le_bytes([header[4], header[5]]);
        if page_size == 0 {
            header[4] = 0x00;
            header[5] = 0x01;
            changed = true;
        }
        for value in &mut header[59..64] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            write_all_at(file, 0, &header)?;
            Ok(HeaderRepairStatus::Repaired)
        } else {
            Ok(HeaderRepairStatus::MatchedNoChange)
        }
    }

    pub(super) fn repair_neo_geo_pocket_header_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len < 0x30 {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let mut header = read_vec_at(file, 0, 0x30)?;
        if header[..NGP_COPYRIGHT_MAGIC.len()] != NGP_COPYRIGHT_MAGIC {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let mut changed = false;
        for value in &mut header[0x24..0x30] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            write_all_at(file, 0x24, &header[0x24..0x30])?;
            Ok(HeaderRepairStatus::Repaired)
        } else {
            Ok(HeaderRepairStatus::MatchedNoChange)
        }
    }

    pub(super) fn repair_msx_header_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len < 16 {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let mut header = read_vec_at(file, 0, 16)?;
        if header[..2] != *b"AB" {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let mut changed = false;
        for value in &mut header[0x0A..0x10] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            write_all_at(file, 0x0A, &header[0x0A..0x10])?;
            Ok(HeaderRepairStatus::Repaired)
        } else {
            Ok(HeaderRepairStatus::MatchedNoChange)
        }
    }

    pub(super) fn repair_nintendo_ds_header_crc_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<HeaderRepairStatus> {
        if file_len < 0x200 {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let header = read_vec_at(file, 0, 0x200)?;
        if header[0xC0..0xC4] != GBA_HEADER_MAGIC {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let old_crc = u16::from_le_bytes([header[0x15E], header[0x15F]]);
        let new_crc = Self::nds_crc16(&header[..0x15E]);
        write_all_at(file, 0x15E, &new_crc.to_le_bytes())?;
        if old_crc == new_crc {
            Ok(HeaderRepairStatus::MatchedNoChange)
        } else {
            Ok(HeaderRepairStatus::Repaired)
        }
    }

    pub(super) fn repair_pce_copier_header(
        repaired_len: usize,
        extension: Option<&str>,
    ) -> HeaderRepairStatus {
        let is_pce = matches!(extension, Some("pce" | "tg16"));
        if !is_pce {
            return HeaderRepairStatus::NotMatched;
        }
        if repaired_len <= ROM_HEADER_BYTES || repaired_len < PCE_COPIER_HEADER_MODULUS as usize {
            return HeaderRepairStatus::MatchedNoChange;
        }
        if repaired_len as u64 % PCE_COPIER_HEADER_MODULUS != ROM_HEADER_BYTES as u64 {
            return HeaderRepairStatus::MatchedNoChange;
        }
        HeaderRepairStatus::Repaired
    }

    pub(super) fn repair_virtual_boy_header_file(
        file: &mut File,
        file_len: usize,
        extension: Option<&str>,
    ) -> Result<HeaderRepairStatus> {
        let is_virtual_boy = matches!(extension, Some("vb" | "vboy"));
        if !is_virtual_boy || file_len < 1024 {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        if file_len < 0x220 {
            return Ok(HeaderRepairStatus::MatchedNoChange);
        }
        let header_offset = file_len - 0x220;
        let mut bytes = read_vec_at(file, (header_offset + 0x14) as u64, 5)?;
        let mut changed = false;
        for value in &mut bytes {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            write_all_at(file, (header_offset + 0x14) as u64, &bytes)?;
            Ok(HeaderRepairStatus::Repaired)
        } else {
            Ok(HeaderRepairStatus::MatchedNoChange)
        }
    }

    pub(super) fn validate_atari_jaguar_header_file(
        file_len: usize,
        extension: Option<&str>,
    ) -> HeaderRepairStatus {
        if !matches!(extension, Some("j64" | "jag")) {
            return HeaderRepairStatus::NotMatched;
        }
        if file_len >= 0x2000 {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::NotMatched
        }
    }

    pub(super) fn validate_colecovision_header_file(
        file: &mut File,
        file_len: usize,
        extension: Option<&str>,
    ) -> Result<HeaderRepairStatus> {
        if !matches!(extension, Some("col" | "cv")) {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        if file_len < 16 {
            return Ok(HeaderRepairStatus::NotMatched);
        }
        let bytes = read_vec_at(file, 0, 2)?;
        if (bytes[0] == 0xAA && bytes[1] == 0x55) || (bytes[0] == 0x55 && bytes[1] == 0xAA) {
            Ok(HeaderRepairStatus::MatchedNoChange)
        } else {
            Ok(HeaderRepairStatus::NotMatched)
        }
    }

    pub(super) fn validate_watara_supervision_header_file(
        file_len: usize,
        extension: Option<&str>,
    ) -> HeaderRepairStatus {
        if !matches!(extension, Some("sv")) {
            return HeaderRepairStatus::NotMatched;
        }
        if file_len >= 64 {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::NotMatched
        }
    }

    pub(super) fn validate_intellivision_header_file(
        file_len: usize,
        extension: Option<&str>,
    ) -> HeaderRepairStatus {
        if !matches!(extension, Some("int")) {
            return HeaderRepairStatus::NotMatched;
        }
        if file_len >= 0x50 {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::NotMatched
        }
    }
}
