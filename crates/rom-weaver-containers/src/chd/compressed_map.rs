use super::*;

pub(super) const CRC16_IBM3740_TABLE: [u16; 256] = build_crc16_ibm3740_table();

pub(super) const fn build_crc16_ibm3740_table() -> [u16; 256] {
    let mut table = [0_u16; 256];
    let mut value = 0usize;
    while value < 256 {
        let mut crc = (value as u16) << 8;
        let mut bit = 0;
        while bit < 8 {
            if (crc & 0x8000) != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
            bit += 1;
        }
        table[value] = crc;
        value += 1;
    }
    table
}

impl ChdContainerHandler {
    pub(super) fn encode_v5_compressed_map(
        entries: &[RustCompressedHunkEntry],
        hunk_bytes: u32,
        unit_bytes: u32,
    ) -> Result<(Vec<u8>, u16, u8, u8, u8, u64)> {
        let mut raw_map = vec![0_u8; entries.len().saturating_mul(12)];
        for (index, entry) in entries.iter().enumerate() {
            let offset = index.saturating_mul(12);
            raw_map[offset] = entry.compression_type;
            let map_length = if entry.compression_type == Self::CHD_V5_MAP_TYPE_UNCOMPRESSED {
                hunk_bytes
            } else {
                entry.length
            };
            Self::write_u24_be(&mut raw_map[offset + 1..offset + 4], map_length)?;
            Self::write_u48_be(&mut raw_map[offset + 4..offset + 10], entry.offset)?;
            raw_map[offset + 10..offset + 12].copy_from_slice(&entry.crc16.to_be_bytes());
        }
        let map_crc = Self::crc16_ibm3740(&raw_map);
        let length_bits = Self::bits_for_value(
            entries
                .iter()
                .filter(|entry| entry.compression_type <= Self::CHD_V5_MAP_TYPE_COMPRESSED_MAX)
                .map(|entry| entry.length)
                .max()
                .unwrap_or_default(),
        );
        let mut first_offset = 0_u64;
        for entry in entries {
            if let 0..=Self::CHD_V5_MAP_TYPE_UNCOMPRESSED = entry.compression_type
                && first_offset == 0
            {
                first_offset = entry.offset;
            }
        }

        let units_per_hunk = u64::from(hunk_bytes / unit_bytes.max(1));
        let mut map_symbols = Vec::with_capacity(entries.len());
        let mut max_self = 0_u64;
        let mut max_parent = 0_u64;
        let mut last_self = 0_u64;
        let mut last_parent = 0_u64;
        for (hunk_index, entry) in entries.iter().enumerate() {
            match entry.compression_type {
                Self::CHD_V5_MAP_TYPE_SELF => {
                    let symbol = if entry.offset == last_self {
                        Self::CHD_V5_MAP_TYPE_SELF0
                    } else if entry.offset == last_self.saturating_add(1) {
                        last_self = last_self.saturating_add(1);
                        Self::CHD_V5_MAP_TYPE_SELF1
                    } else {
                        last_self = entry.offset;
                        max_self = max_self.max(entry.offset);
                        Self::CHD_V5_MAP_TYPE_SELF
                    };
                    map_symbols.push(symbol);
                }
                Self::CHD_V5_MAP_TYPE_PARENT => {
                    let current_parent_unit = (hunk_index as u64).saturating_mul(units_per_hunk);
                    let symbol = if entry.offset == current_parent_unit {
                        last_parent = entry.offset;
                        Self::CHD_V5_MAP_TYPE_PARENT_SELF
                    } else if entry.offset == last_parent {
                        Self::CHD_V5_MAP_TYPE_PARENT0
                    } else if entry.offset == last_parent.saturating_add(units_per_hunk) {
                        last_parent = entry.offset;
                        Self::CHD_V5_MAP_TYPE_PARENT1
                    } else {
                        last_parent = entry.offset;
                        max_parent = max_parent.max(entry.offset);
                        Self::CHD_V5_MAP_TYPE_PARENT
                    };
                    map_symbols.push(symbol);
                }
                other => map_symbols.push(other),
            }
        }

        let self_bits = if max_self == 0 {
            0
        } else {
            (u64::BITS - max_self.leading_zeros()) as u8
        };
        let parent_bits = if max_parent == 0 {
            0
        } else {
            (u64::BITS - max_parent.leading_zeros()) as u8
        };
        let encoded_map_symbols = Self::rle_encode_map_symbols(&map_symbols);
        let max_symbol = encoded_map_symbols.iter().copied().max().unwrap_or(0);
        if max_symbol >= Self::CHD_V5_MAP_SYMBOL_COUNT as u8 {
            return Err(RomWeaverError::Validation(format!(
                "unsupported compressed CHD map symbol {} for rust map encoder",
                max_symbol
            )));
        }
        let symbol_bit_lengths = Self::map_symbol_bit_lengths(&encoded_map_symbols)?;
        let symbol_codes = Self::canonical_huffman_codes(&symbol_bit_lengths)?;

        let mut bit_writer = MsbBitWriter::new();
        Self::write_map_symbol_tree_rle(&mut bit_writer, &symbol_bit_lengths)?;

        for symbol in &encoded_map_symbols {
            let (bits, bit_count) = symbol_codes[usize::from(*symbol)].ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "missing map huffman code for compression type {}",
                    symbol
                ))
            })?;
            bit_writer.write_bits(u64::from(bits), bit_count);
        }

        for (entry, symbol) in entries.iter().zip(&map_symbols) {
            match *symbol {
                0..=Self::CHD_V5_MAP_TYPE_COMPRESSED_MAX => {
                    bit_writer.write_bits(u64::from(entry.length), length_bits);
                    bit_writer.write_bits(u64::from(entry.crc16), 16);
                }
                Self::CHD_V5_MAP_TYPE_UNCOMPRESSED => {
                    bit_writer.write_bits(u64::from(entry.crc16), 16);
                }
                Self::CHD_V5_MAP_TYPE_SELF => {
                    bit_writer.write_bits(entry.offset, self_bits);
                }
                Self::CHD_V5_MAP_TYPE_PARENT => {
                    bit_writer.write_bits(entry.offset, parent_bits);
                }
                Self::CHD_V5_MAP_TYPE_SELF0
                | Self::CHD_V5_MAP_TYPE_SELF1
                | Self::CHD_V5_MAP_TYPE_PARENT_SELF
                | Self::CHD_V5_MAP_TYPE_PARENT0
                | Self::CHD_V5_MAP_TYPE_PARENT1 => {}
                other => {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported compressed CHD map type {} for rust map encoder",
                        other
                    )));
                }
            }
        }
        Ok((
            bit_writer.finish(),
            map_crc,
            length_bits,
            self_bits,
            parent_bits,
            first_offset,
        ))
    }

    pub(super) fn rle_encode_map_symbols(symbols: &[u8]) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(symbols.len());
        let mut index = 0usize;
        let mut last_symbol = Some(0);
        while index < symbols.len() {
            let symbol = symbols[index];
            if let Some(last) = last_symbol
                && symbol == last
            {
                let mut run_len = 0usize;
                while index + run_len < symbols.len() && symbols[index + run_len] == last {
                    run_len += 1;
                }
                if run_len >= 3 {
                    let mut remaining = run_len;
                    while remaining >= 3 {
                        let chunk = remaining.min(274);
                        if chunk >= 19 {
                            let value = chunk - 19;
                            encoded.push(Self::CHD_V5_MAP_TYPE_RLE_LARGE);
                            encoded.push(((value >> 4) & 0x0f) as u8);
                            encoded.push((value & 0x0f) as u8);
                        } else {
                            encoded.push(Self::CHD_V5_MAP_TYPE_RLE_SMALL);
                            encoded.push((chunk - 3) as u8);
                        }
                        index += chunk;
                        remaining -= chunk;
                    }
                    for _ in 0..remaining {
                        encoded.push(last);
                        index += 1;
                    }
                    continue;
                }
            }

            encoded.push(symbol);
            last_symbol = Some(symbol);
            index += 1;
        }
        encoded
    }

    pub(super) fn map_symbol_bit_lengths(symbols: &[u8]) -> Result<[u8; 16]> {
        let mut frequencies = [0_u64; Self::CHD_V5_MAP_SYMBOL_COUNT];
        for &symbol in symbols {
            let index = usize::from(symbol);
            if index >= frequencies.len() {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported compressed CHD map symbol {symbol} for rust map encoder"
                )));
            }
            frequencies[index] = frequencies[index].saturating_add(1);
        }
        let max_symbol = symbols.iter().copied().max().unwrap_or(0);
        let dynamic = Self::map_symbol_bit_lengths_for_frequencies(&frequencies);
        if dynamic.iter().all(|&length| length <= 8)
            && Self::canonical_huffman_codes(&dynamic).is_ok()
        {
            return Ok(dynamic);
        }
        Self::fixed_map_symbol_bit_lengths_for_max_type(max_symbol)
    }

    pub(super) fn map_symbol_bit_lengths_for_frequencies(frequencies: &[u64; 16]) -> [u8; 16] {
        #[derive(Clone)]
        struct Node {
            weight: u64,
            min_symbol: usize,
            symbol: Option<usize>,
            left: Option<usize>,
            right: Option<usize>,
        }

        let mut nodes = Vec::<Node>::new();
        let mut active = Vec::<usize>::new();
        for (symbol, &weight) in frequencies.iter().enumerate() {
            if weight == 0 {
                continue;
            }
            let index = nodes.len();
            nodes.push(Node {
                weight,
                min_symbol: symbol,
                symbol: Some(symbol),
                left: None,
                right: None,
            });
            active.push(index);
        }

        let mut lengths = [0_u8; 16];
        if active.is_empty() {
            lengths[0] = 1;
            return lengths;
        }
        if active.len() == 1 {
            lengths[nodes[active[0]].min_symbol] = 1;
            return lengths;
        }

        while active.len() > 1 {
            active.sort_by_key(|&index| (nodes[index].weight, nodes[index].min_symbol));
            let left = active.remove(0);
            let right = active.remove(0);
            let index = nodes.len();
            nodes.push(Node {
                weight: nodes[left].weight.saturating_add(nodes[right].weight),
                min_symbol: nodes[left].min_symbol.min(nodes[right].min_symbol),
                symbol: None,
                left: Some(left),
                right: Some(right),
            });
            active.push(index);
        }

        fn assign_lengths(nodes: &[Node], index: usize, depth: u8, lengths: &mut [u8; 16]) {
            let node = &nodes[index];
            if let Some(symbol) = node.symbol {
                lengths[symbol] = depth.max(1);
                return;
            }
            if let Some(left) = node.left {
                assign_lengths(nodes, left, depth.saturating_add(1), lengths);
            }
            if let Some(right) = node.right {
                assign_lengths(nodes, right, depth.saturating_add(1), lengths);
            }
        }

        assign_lengths(&nodes, active[0], 0, &mut lengths);
        lengths
    }

    pub(super) fn fixed_map_symbol_bit_lengths_for_max_type(max_type: u8) -> Result<[u8; 16]> {
        let mut lengths = [0_u8; 16];
        match max_type {
            0 => {
                lengths[0] = 1;
            }
            1 => {
                lengths[0] = 1;
                lengths[1] = 1;
            }
            2 => {
                lengths[0] = 1;
                lengths[1] = 2;
                lengths[2] = 2;
            }
            3 => {
                lengths[0] = 2;
                lengths[1] = 2;
                lengths[2] = 2;
                lengths[3] = 2;
            }
            4 => {
                lengths[0] = 2;
                lengths[1] = 2;
                lengths[2] = 2;
                lengths[3] = 3;
                lengths[4] = 3;
            }
            5 | 6 => {
                lengths[0..8].fill(3);
            }
            7..=15 => {
                lengths.fill(4);
            }
            _ => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported compressed CHD map type {max_type} for rust map encoder"
                )));
            }
        }
        Ok(lengths)
    }

    pub(super) fn canonical_huffman_codes(lengths: &[u8; 16]) -> Result<[Option<(u32, u8)>; 16]> {
        let mut histogram = [0_u32; 33];
        for &length in lengths {
            if usize::from(length) >= histogram.len() {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported CHD map huffman bit length {}",
                    length
                )));
            }
            histogram[length as usize] = histogram[length as usize].saturating_add(1);
        }

        let mut curr_start = 0_u32;
        for code_len in (1..histogram.len()).rev() {
            let next_start = (curr_start + histogram[code_len]) >> 1;
            if code_len != 1 && next_start.saturating_mul(2) != curr_start + histogram[code_len] {
                return Err(RomWeaverError::Validation(
                    "invalid CHD map huffman length distribution".to_string(),
                ));
            }
            histogram[code_len] = curr_start;
            curr_start = next_start;
        }

        let mut codes = [None; 16];
        for (index, &length) in lengths.iter().enumerate() {
            if length == 0 {
                continue;
            }
            let start = &mut histogram[length as usize];
            codes[index] = Some((*start, length));
            *start = start.saturating_add(1);
        }
        Ok(codes)
    }

    pub(super) fn write_map_symbol_tree_rle(
        bit_writer: &mut MsbBitWriter,
        lengths: &[u8; 16],
    ) -> Result<()> {
        let mut index = 0usize;
        while index < lengths.len() {
            let value = lengths[index];
            let mut run_len = 1usize;
            while index + run_len < lengths.len()
                && lengths[index + run_len] == value
                && run_len < 18
            {
                run_len += 1;
            }

            if value != 1 && run_len >= 3 {
                bit_writer.write_bits(1, 4);
                bit_writer.write_bits(u64::from(value), 4);
                bit_writer.write_bits(u64::try_from(run_len - 3).unwrap_or(0), 4);
                index += run_len;
                continue;
            }

            for _ in 0..run_len {
                if value == 1 {
                    bit_writer.write_bits(1, 4);
                    bit_writer.write_bits(1, 4);
                } else {
                    bit_writer.write_bits(u64::from(value), 4);
                }
            }
            index += run_len;
        }
        Ok(())
    }

    pub(super) fn write_u24_be(dst: &mut [u8], value: u32) -> Result<()> {
        if dst.len() < 3 {
            return Err(RomWeaverError::Validation(
                "internal CHD map write buffer underflow".into(),
            ));
        }
        if value > 0x00FF_FFFF {
            return Err(RomWeaverError::Validation(format!(
                "value {value} exceeds u24 range"
            )));
        }
        dst[0] = ((value >> 16) & 0xFF) as u8;
        dst[1] = ((value >> 8) & 0xFF) as u8;
        dst[2] = (value & 0xFF) as u8;
        Ok(())
    }

    pub(super) fn write_u48_be(dst: &mut [u8], value: u64) -> Result<()> {
        if dst.len() < 6 {
            return Err(RomWeaverError::Validation(
                "internal CHD map write buffer underflow".into(),
            ));
        }
        if value > 0x0000_FFFF_FFFF_FFFF {
            return Err(RomWeaverError::Validation(format!(
                "value {value} exceeds u48 range"
            )));
        }
        dst[0] = ((value >> 40) & 0xFF) as u8;
        dst[1] = ((value >> 32) & 0xFF) as u8;
        dst[2] = ((value >> 24) & 0xFF) as u8;
        dst[3] = ((value >> 16) & 0xFF) as u8;
        dst[4] = ((value >> 8) & 0xFF) as u8;
        dst[5] = (value & 0xFF) as u8;
        Ok(())
    }

    pub(super) fn bits_for_value(value: u32) -> u8 {
        if value == 0 {
            0
        } else {
            (u32::BITS - value.leading_zeros()) as u8
        }
    }

    pub(super) fn crc16_ibm3740(bytes: &[u8]) -> u16 {
        let mut crc = 0xFFFFu16;
        for &byte in bytes {
            let table_index = usize::from(((crc >> 8) as u8) ^ byte);
            crc = (crc << 8) ^ CRC16_IBM3740_TABLE[table_index];
        }
        crc
    }
}
