impl CliApp {
    fn repair_checksum_if_supported(
        bytes: &mut Vec<u8>,
        hint_path: Option<&Path>,
    ) -> HeaderRepairOutcome {
        let extension = hint_path
            .and_then(|path| path.extension())
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        let extension = extension.as_deref();

        let mut outcome = HeaderRepairOutcome {
            repaired_profiles: Vec::new(),
            matched_without_changes: Vec::new(),
        };

        Self::record_header_repair_status(
            &mut outcome,
            "snes",
            Self::repair_snes_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "nes",
            Self::repair_nes_header_padding(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "fds",
            Self::validate_fds_header(bytes.as_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "game-boy",
            Self::repair_game_boy_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "gba",
            Self::repair_gba_header_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "sega-genesis",
            Self::repair_sega_genesis_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "sms-gg",
            Self::repair_sms_tmr_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "n64",
            Self::repair_n64_checksum(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "atari-7800",
            Self::repair_atari_7800_header(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "atari-lynx",
            Self::repair_atari_lynx_header(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "pce-tg16",
            Self::repair_pce_copier_header(bytes, extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "virtual-boy",
            Self::repair_virtual_boy_header(bytes.as_mut_slice(), extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "neo-geo-pocket",
            Self::repair_neo_geo_pocket_header(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "msx",
            Self::repair_msx_header(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "nds",
            Self::repair_nintendo_ds_header_crc(bytes.as_mut_slice()),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "atari-jaguar",
            Self::validate_atari_jaguar_header(bytes.as_slice(), extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "colecovision",
            Self::validate_colecovision_header(bytes.as_slice(), extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "watara-supervision",
            Self::validate_watara_supervision_header(bytes.as_slice(), extension),
        );
        Self::record_header_repair_status(
            &mut outcome,
            "intellivision",
            Self::validate_intellivision_header(bytes.as_slice(), extension),
        );

        outcome
    }

    fn repair_snes_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() <= ROM_HEADER_BYTES {
            return HeaderRepairStatus::NotMatched;
        }

        let copier_offset = if bytes.len() % SNES_COPIER_HEADER_MODULUS as usize == ROM_HEADER_BYTES
        {
            ROM_HEADER_BYTES
        } else {
            0
        };
        let rom_size = bytes.len().saturating_sub(copier_offset);
        if rom_size == 0 {
            return HeaderRepairStatus::NotMatched;
        }

        let lo_rom_header = copier_offset.saturating_add(0x7FC0);
        let hi_rom_header = copier_offset.saturating_add(0xFFC0);
        let header_offset = if hi_rom_header + 0x30 <= bytes.len()
            && Self::is_valid_snes_title(bytes, hi_rom_header)
        {
            hi_rom_header
        } else if lo_rom_header + 0x30 <= bytes.len()
            && Self::is_valid_snes_title(bytes, lo_rom_header)
        {
            lo_rom_header
        } else {
            return HeaderRepairStatus::NotMatched;
        };

        let checksum_complement_offset = header_offset + 0x1C;
        let checksum_offset = header_offset + 0x1E;
        if checksum_offset + 2 > bytes.len() || checksum_complement_offset + 2 > bytes.len() {
            return HeaderRepairStatus::NotMatched;
        }

        let old_complement = u16::from_le_bytes([
            bytes[checksum_complement_offset],
            bytes[checksum_complement_offset + 1],
        ]);
        let old_checksum = u16::from_le_bytes([bytes[checksum_offset], bytes[checksum_offset + 1]]);

        bytes[checksum_complement_offset] = 0;
        bytes[checksum_complement_offset + 1] = 0;
        bytes[checksum_offset] = 0;
        bytes[checksum_offset + 1] = 0;

        let mut sum = 0_u32;
        if rom_size.is_power_of_two() {
            for value in &bytes[copier_offset..] {
                sum = sum.wrapping_add(u32::from(*value));
            }
        } else {
            let base_size = rom_size.next_power_of_two() / 2;
            let excess_size = rom_size.saturating_sub(base_size);
            for value in &bytes[copier_offset..copier_offset + base_size] {
                sum = sum.wrapping_add(u32::from(*value));
            }
            if excess_size > 0 {
                let mut excess_sum = 0_u32;
                for value in &bytes[copier_offset + base_size..] {
                    excess_sum = excess_sum.wrapping_add(u32::from(*value));
                }
                let mirror_count = (rom_size.next_power_of_two() - base_size) / excess_size;
                sum = sum.wrapping_add(excess_sum.wrapping_mul(mirror_count as u32));
            }
        }

        let new_checksum = (sum & 0xFFFF) as u16;
        let new_complement = new_checksum ^ 0xFFFF;
        bytes[checksum_complement_offset..checksum_complement_offset + 2]
            .copy_from_slice(&new_complement.to_le_bytes());
        bytes[checksum_offset..checksum_offset + 2].copy_from_slice(&new_checksum.to_le_bytes());

        if old_checksum == new_checksum && old_complement == new_complement {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn is_valid_snes_title(bytes: &[u8], offset: usize) -> bool {
        if offset + 21 > bytes.len() {
            return false;
        }
        let mut printable_count = 0usize;
        for value in &bytes[offset..offset + 21] {
            if (0x20..=0x7E).contains(value) {
                printable_count = printable_count.saturating_add(1);
            }
        }
        printable_count >= 10
    }

    fn repair_nes_header_padding(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 16 || bytes[..4] != INES_HEADER_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let is_nes2 = (bytes[7] & 0x0C) == 0x08;
        if is_nes2 {
            return HeaderRepairStatus::MatchedNoChange;
        }

        let mut changed = false;
        for value in &mut bytes[11..16] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn validate_fds_header(bytes: &[u8]) -> HeaderRepairStatus {
        if bytes.len() < 16 || bytes[..FDS_HEADER_MAGIC.len()] != FDS_HEADER_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        HeaderRepairStatus::MatchedNoChange
    }

    fn repair_gba_header_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 0x1BE || bytes[0x04..0x08] != GBA_HEADER_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let old_checksum = bytes[0x1BD];
        let mut checksum = 0_i32;
        for value in &bytes[0xA0..=0xBC] {
            checksum -= i32::from(*value);
        }
        let new_checksum = ((checksum - 0x19) & 0xFF) as u8;
        bytes[0x1BD] = new_checksum;
        if old_checksum == new_checksum {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn repair_sega_genesis_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() <= 0x18F || bytes.len() < 0x200 {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes[0x100..0x104] != *b"SEGA" && bytes[0x101..0x105] != *b"SEGA" {
            return HeaderRepairStatus::NotMatched;
        }
        let old_checksum = u16::from_be_bytes([bytes[0x18E], bytes[0x18F]]);
        let mut sum = 0_u32;
        let mut cursor = 0x200usize;
        while cursor + 1 < bytes.len() {
            let word = u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]);
            sum = sum.wrapping_add(u32::from(word));
            cursor += 2;
        }
        if cursor < bytes.len() {
            sum = sum.wrapping_add(u32::from(bytes[cursor]) << 8);
        }
        let checksum = (sum & 0xFFFF) as u16;
        bytes[0x18E..=0x18F].copy_from_slice(&checksum.to_be_bytes());
        if old_checksum == checksum {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn repair_game_boy_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() <= 0x14F {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes[0x104..0x134] != GAME_BOY_NINTENDO_LOGO {
            return HeaderRepairStatus::NotMatched;
        }

        let old_header_checksum = bytes[0x14D];
        let old_global_checksum = u16::from_be_bytes([bytes[0x14E], bytes[0x14F]]);

        let mut header_checksum = 0_u8;
        for value in &bytes[0x134..=0x14C] {
            header_checksum = header_checksum.wrapping_sub(*value).wrapping_sub(1);
        }
        bytes[0x14D] = header_checksum;

        let mut global_checksum = 0_u16;
        for (index, value) in bytes.iter().copied().enumerate() {
            if index == 0x14E || index == 0x14F {
                continue;
            }
            global_checksum = global_checksum.wrapping_add(u16::from(value));
        }
        bytes[0x14E..=0x14F].copy_from_slice(&global_checksum.to_be_bytes());

        if old_header_checksum == header_checksum && old_global_checksum == global_checksum {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn repair_sms_tmr_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        let mut header_offset = None;
        for offset in [0x7FF0usize, 0x3FF0, 0x1FF0] {
            if bytes.get(offset..offset + SMS_TMR_SEGA_MAGIC.len())
                == Some(SMS_TMR_SEGA_MAGIC.as_slice())
            {
                header_offset = Some(offset);
                break;
            }
        }
        let Some(header_offset) = header_offset else {
            return HeaderRepairStatus::NotMatched;
        };
        if header_offset + 0x10 > bytes.len() {
            return HeaderRepairStatus::NotMatched;
        }
        let checksum_offset = header_offset + 0x0A;
        if checksum_offset + 2 > bytes.len() {
            return HeaderRepairStatus::NotMatched;
        }
        let old_checksum = u16::from_le_bytes([bytes[checksum_offset], bytes[checksum_offset + 1]]);
        let size_nibble = bytes[header_offset + 0x0F] & 0x0F;
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
            _ => bytes.len(),
        };
        let checksum_end = declared_end.min(bytes.len());
        let header_end = header_offset + 16;

        let mut sum = 0_u32;
        for value in &bytes[..header_offset.min(checksum_end)] {
            sum = sum.wrapping_add(u32::from(*value));
        }
        if header_end < checksum_end {
            for value in &bytes[header_end..checksum_end] {
                sum = sum.wrapping_add(u32::from(*value));
            }
        }
        let new_checksum = (sum & 0xFFFF) as u16;
        bytes[checksum_offset..checksum_offset + 2].copy_from_slice(&new_checksum.to_le_bytes());
        if old_checksum == new_checksum {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn repair_n64_checksum(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 0x101000 {
            return HeaderRepairStatus::NotMatched;
        }
        let Some(original_order) = Self::detect_n64_byte_order(bytes) else {
            return HeaderRepairStatus::NotMatched;
        };
        Self::normalize_n64_to_big_endian(bytes, original_order);

        let old_crc1 = u32::from_be_bytes([bytes[0x10], bytes[0x11], bytes[0x12], bytes[0x13]]);
        let old_crc2 = u32::from_be_bytes([bytes[0x14], bytes[0x15], bytes[0x16], bytes[0x17]]);

        let seed = 0xF8CA4DDCu32;
        let mut t1 = seed;
        let mut t2 = seed;
        let mut t3 = seed;
        let mut t4 = seed;
        let mut t5 = seed;
        let mut t6 = seed;

        for chunk in bytes[0x1000..0x101000].chunks_exact(4) {
            let d = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if t6.wrapping_add(d) < t6 {
                t4 = t4.wrapping_add(1);
            }
            t6 = t6.wrapping_add(d);
            t3 ^= d;

            let shift = (d & 0x1F) as u32;
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
        bytes[0x10..0x14].copy_from_slice(&new_crc1.to_be_bytes());
        bytes[0x14..0x18].copy_from_slice(&new_crc2.to_be_bytes());
        Self::denormalize_n64_from_big_endian(bytes, original_order);

        if old_crc1 == new_crc1 && old_crc2 == new_crc2 {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn detect_n64_byte_order(bytes: &[u8]) -> Option<N64ByteOrder> {
        if bytes.len() < 4 {
            return None;
        }
        let magic = [bytes[0], bytes[1], bytes[2], bytes[3]];
        if magic == N64_BIG_ENDIAN_MAGIC {
            Some(N64ByteOrder::BigEndian)
        } else if magic == N64_LITTLE_ENDIAN_MAGIC {
            Some(N64ByteOrder::LittleEndian)
        } else if magic == N64_BYTE_SWAPPED_MAGIC {
            Some(N64ByteOrder::ByteSwapped)
        } else {
            None
        }
    }

    fn normalize_n64_to_big_endian(bytes: &mut [u8], order: N64ByteOrder) {
        match order {
            N64ByteOrder::BigEndian => {}
            N64ByteOrder::LittleEndian => {
                for chunk in bytes.chunks_exact_mut(4) {
                    chunk.reverse();
                }
            }
            N64ByteOrder::ByteSwapped => {
                for chunk in bytes.chunks_exact_mut(4) {
                    chunk.swap(0, 1);
                    chunk.swap(2, 3);
                }
            }
        }
    }

    fn denormalize_n64_from_big_endian(bytes: &mut [u8], order: N64ByteOrder) {
        match order {
            N64ByteOrder::BigEndian => {}
            N64ByteOrder::LittleEndian => {
                for chunk in bytes.chunks_exact_mut(4) {
                    chunk.reverse();
                }
            }
            N64ByteOrder::ByteSwapped => {
                for chunk in bytes.chunks_exact_mut(4) {
                    chunk.swap(0, 1);
                    chunk.swap(2, 3);
                }
            }
        }
    }

    fn repair_atari_7800_header(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 128 {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes[1..1 + A78_HEADER_MAGIC.len()] != A78_HEADER_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let mut changed = false;
        for value in &mut bytes[0x64..0x80] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn repair_atari_lynx_header(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 64 || bytes[..4] != LNX_HEADER_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let mut changed = false;
        let page_size = u16::from_le_bytes([bytes[4], bytes[5]]);
        if page_size == 0 {
            bytes[4] = 0x00;
            bytes[5] = 0x01;
            changed = true;
        }
        for value in &mut bytes[59..64] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn repair_neo_geo_pocket_header(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 0x30 {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes[..NGP_COPYRIGHT_MAGIC.len()] != NGP_COPYRIGHT_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let mut changed = false;
        for value in &mut bytes[0x24..0x30] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn repair_msx_header(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 16 || bytes[..2] != *b"AB" {
            return HeaderRepairStatus::NotMatched;
        }
        let mut changed = false;
        for value in &mut bytes[0x0A..0x10] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn repair_nintendo_ds_header_crc(bytes: &mut [u8]) -> HeaderRepairStatus {
        if bytes.len() < 0x200 || bytes[0xC0..0xC4] != GBA_HEADER_MAGIC {
            return HeaderRepairStatus::NotMatched;
        }
        let old_crc = u16::from_le_bytes([bytes[0x15E], bytes[0x15F]]);
        let new_crc = Self::nds_crc16(&bytes[..0x15E]);
        bytes[0x15E..0x160].copy_from_slice(&new_crc.to_le_bytes());
        if old_crc == new_crc {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::Repaired
        }
    }

    fn repair_pce_copier_header(
        bytes: &mut Vec<u8>,
        extension: Option<&str>,
    ) -> HeaderRepairStatus {
        let is_pce = matches!(extension, Some("pce" | "tg16"));
        if !is_pce {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() <= ROM_HEADER_BYTES || bytes.len() < PCE_COPIER_HEADER_MODULUS as usize {
            return HeaderRepairStatus::MatchedNoChange;
        }
        if bytes.len() as u64 % PCE_COPIER_HEADER_MODULUS != ROM_HEADER_BYTES as u64 {
            return HeaderRepairStatus::MatchedNoChange;
        }
        bytes.drain(0..ROM_HEADER_BYTES);
        HeaderRepairStatus::Repaired
    }

    fn repair_virtual_boy_header(bytes: &mut [u8], extension: Option<&str>) -> HeaderRepairStatus {
        let is_virtual_boy = matches!(extension, Some("vb" | "vboy"));
        if !is_virtual_boy || bytes.len() < 1024 {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() < 0x220 {
            return HeaderRepairStatus::MatchedNoChange;
        }
        let header_offset = bytes.len() - 0x220;
        let mut changed = false;
        for value in &mut bytes[header_offset + 0x14..header_offset + 0x19] {
            if *value != 0 {
                *value = 0;
                changed = true;
            }
        }
        if changed {
            HeaderRepairStatus::Repaired
        } else {
            HeaderRepairStatus::MatchedNoChange
        }
    }

    fn validate_atari_jaguar_header(bytes: &[u8], extension: Option<&str>) -> HeaderRepairStatus {
        if !matches!(extension, Some("j64" | "jag")) {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() >= 0x2000 {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::NotMatched
        }
    }

    fn validate_colecovision_header(bytes: &[u8], extension: Option<&str>) -> HeaderRepairStatus {
        if !matches!(extension, Some("col" | "cv")) {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() >= 16
            && ((bytes[0] == 0xAA && bytes[1] == 0x55) || (bytes[0] == 0x55 && bytes[1] == 0xAA))
        {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::NotMatched
        }
    }

    fn validate_watara_supervision_header(
        bytes: &[u8],
        extension: Option<&str>,
    ) -> HeaderRepairStatus {
        if !matches!(extension, Some("sv")) {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() >= 64 {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::NotMatched
        }
    }

    fn validate_intellivision_header(bytes: &[u8], extension: Option<&str>) -> HeaderRepairStatus {
        if !matches!(extension, Some("int")) {
            return HeaderRepairStatus::NotMatched;
        }
        if bytes.len() >= 0x50 {
            HeaderRepairStatus::MatchedNoChange
        } else {
            HeaderRepairStatus::NotMatched
        }
    }

}
