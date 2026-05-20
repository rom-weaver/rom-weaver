fn xdelta_djw_compress(section: &[u8], section_kind: DjwSectionKind) -> Result<Vec<u8>> {
    if section.is_empty() {
        return Err(RomWeaverError::Validation(
            "xdelta djw secondary encoder requires non-empty input".into(),
        ));
    }

    let (groups, sector_size) = djw_select_groups_and_sector_size(section.len(), section_kind)?;
    if groups > 1 {
        if let Ok(compressed) = xdelta_djw_compress_multi_group(section, groups, sector_size) {
            if let Ok(decoded) = decode_djw_secondary(&compressed, section.len()) {
                if decoded == section {
                    return Ok(compressed);
                }
            }
        }
    }

    let frequencies = djw_count_byte_frequencies(section);
    let (code_lengths, _) = djw_build_prefix_lengths(&frequencies, DJW_MAX_CODELEN)?;
    let codes = djw_build_codes_from_lengths(&code_lengths, DJW_MAX_CODELEN)?;

    let mut writer = DjwBitWriter::new();
    writer.write_bits(DJW_GROUP_BITS, 0)?;

    let mut prefix = DjwPrefix::new(code_lengths.to_vec());
    djw_encode_prefix(&mut writer, &mut prefix)?;

    for &symbol in section {
        let index = usize::from(symbol);
        let bits = usize::from(code_lengths[index]);
        if bits == 0 {
            return Err(RomWeaverError::Validation(format!(
                "xdelta djw secondary encoder produced zero-length code for symbol {index}"
            )));
        }
        writer.write_bits(bits, codes[index])?;
    }

    Ok(writer.finish())
}

fn djw_select_groups_and_sector_size(
    input_size: usize,
    section_kind: DjwSectionKind,
) -> Result<(usize, usize)> {
    let (groups, sector_size) = match section_kind {
        DjwSectionKind::Data => {
            if input_size < 1_000 {
                (1, 0)
            } else if input_size < 4_000 {
                (2, 10)
            } else if input_size < 7_000 {
                (3, 10)
            } else if input_size < 10_000 {
                (4, 10)
            } else if input_size < 25_000 {
                (5, 10)
            } else if input_size < 50_000 {
                (7, 20)
            } else if input_size < 100_000 {
                (8, 30)
            } else {
                (8, 70)
            }
        }
        DjwSectionKind::Inst => {
            if input_size < 7_000 {
                (1, 0)
            } else if input_size < 10_000 {
                (2, 50)
            } else if input_size < 25_000 {
                (3, 50)
            } else if input_size < 50_000 {
                (6, 40)
            } else {
                (8, 40)
            }
        }
        DjwSectionKind::Addr => {
            if input_size < 9_000 {
                (1, 0)
            } else if input_size < 25_000 {
                (2, 130)
            } else if input_size < 50_000 {
                (3, 130)
            } else if input_size < 100_000 {
                (5, 130)
            } else {
                (7, 130)
            }
        }
    };
    if groups > DJW_MAX_GROUPS {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder selected too many groups".into(),
        ));
    }
    if groups == 1 {
        return Ok((1, 0));
    }
    if sector_size < DJW_SECTORSZ_MULT
        || sector_size > DJW_SECTORSZ_MAX
        || sector_size % DJW_SECTORSZ_MULT != 0
    {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder selected an invalid sector size".into(),
        ));
    }
    Ok((groups, sector_size))
}

fn xdelta_djw_compress_multi_group(
    section: &[u8],
    groups: usize,
    sector_size: usize,
) -> Result<Vec<u8>> {
    if groups <= 1 || groups > DJW_MAX_GROUPS {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder received an invalid group count".into(),
        ));
    }
    if sector_size < DJW_SECTORSZ_MULT
        || sector_size > DJW_SECTORSZ_MAX
        || sector_size % DJW_SECTORSZ_MULT != 0
    {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder received an invalid sector size".into(),
        ));
    }

    let sectors = 1 + (section.len() - 1) / sector_size;
    let real_freq = djw_count_byte_frequencies(section);
    let mut selected_groups = vec![0u8; sectors];
    let mut group_freq = djw_seed_group_frequencies(groups);
    djw_smooth_group_frequencies(&mut group_freq, &real_freq);

    for _ in 0..3 {
        let (group_lengths, _) = djw_build_group_code_tables(&group_freq, &real_freq)?;
        djw_choose_best_sector_groups(section, sector_size, &group_lengths, &mut selected_groups)?;
        djw_rebuild_group_frequencies(section, sector_size, &selected_groups, &mut group_freq)?;
        djw_smooth_group_frequencies(&mut group_freq, &real_freq);
    }

    let (group_lengths, group_codes) = djw_build_group_code_tables(&group_freq, &real_freq)?;
    let mut writer = DjwBitWriter::new();
    writer.write_bits(DJW_GROUP_BITS, groups - 1)?;
    writer.write_bits(DJW_SECTORSZ_BITS, (sector_size / DJW_SECTORSZ_MULT) - 1)?;

    let mut group_symbols = Vec::with_capacity(groups * DJW_ALPHABET_SIZE);
    for lengths in &group_lengths {
        group_symbols.extend_from_slice(lengths);
    }
    let mut group_prefix = DjwPrefix::new(group_symbols);
    djw_encode_prefix(&mut writer, &mut group_prefix)?;

    let mut selector_prefix = DjwPrefix::new(selected_groups.clone());
    let mut selector_mtf = (0..groups)
        .map(|index| {
            u8::try_from(index).map_err(|_| {
                RomWeaverError::Validation("xdelta djw selector index exceeded u8".into())
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut selector_freq = vec![0u32; groups + 1];
    djw_compute_mtf_1_2(
        &mut selector_prefix,
        &mut selector_mtf,
        &mut selector_freq,
        groups,
    )?;
    let (selector_lengths, _) = djw_build_prefix_lengths(&selector_freq, DJW_MAX_GBCLEN)?;
    let selector_codes = djw_build_codes_from_lengths(&selector_lengths, DJW_MAX_GBCLEN)?;
    for &length in selector_lengths.iter().take(groups + 1) {
        writer.write_bits(DJW_GBCLEN_BITS, usize::from(length))?;
    }
    for &symbol in selector_prefix.mtfsym.iter().take(selector_prefix.mcount) {
        let index = usize::from(symbol);
        let bits = usize::from(selector_lengths[index]);
        let code = selector_codes[index];
        writer.write_bits(bits, code)?;
    }

    let mut offset = 0usize;
    for &group in &selected_groups {
        let group_index = usize::from(group);
        if group_index >= groups {
            return Err(RomWeaverError::Validation(format!(
                "xdelta djw selector chose invalid group index {group_index}"
            )));
        }
        let end = (offset + sector_size).min(section.len());
        let lengths = &group_lengths[group_index];
        let codes = &group_codes[group_index];
        for &symbol in &section[offset..end] {
            let index = usize::from(symbol);
            let bits = usize::from(lengths[index]);
            if bits == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "xdelta djw secondary encoder produced zero-length code for symbol {index}"
                )));
            }
            writer.write_bits(bits, codes[index])?;
        }
        offset = end;
    }
    if offset != section.len() {
        return Err(RomWeaverError::Validation(
            "xdelta djw secondary encoder failed to encode all input bytes".into(),
        ));
    }

    Ok(writer.finish())
}

fn djw_seed_group_frequencies(groups: usize) -> Vec<[u32; DJW_ALPHABET_SIZE]> {
    let mut frequencies = vec![[0u32; DJW_ALPHABET_SIZE]; groups];
    for symbol in 0..DJW_ALPHABET_SIZE {
        let mut group = (symbol * groups) / DJW_ALPHABET_SIZE;
        if group >= groups {
            group = groups - 1;
        }
        frequencies[group][symbol] = 8;
    }
    frequencies
}

fn djw_smooth_group_frequencies(
    group_frequencies: &mut [[u32; DJW_ALPHABET_SIZE]],
    real_frequencies: &[u32; DJW_ALPHABET_SIZE],
) {
    for group in group_frequencies.iter_mut() {
        for symbol in 0..DJW_ALPHABET_SIZE {
            if real_frequencies[symbol] != 0 && group[symbol] == 0 {
                group[symbol] = 1;
            }
        }
    }
}

fn djw_build_group_code_tables(
    group_frequencies: &[[u32; DJW_ALPHABET_SIZE]],
    real_frequencies: &[u32; DJW_ALPHABET_SIZE],
) -> Result<(Vec<Vec<u8>>, Vec<Vec<usize>>)> {
    let mut lengths = Vec::with_capacity(group_frequencies.len());
    let mut codes = Vec::with_capacity(group_frequencies.len());
    for group in group_frequencies {
        let mut adjusted = *group;
        for symbol in 0..DJW_ALPHABET_SIZE {
            if adjusted[symbol] == 0 && real_frequencies[symbol] != 0 {
                adjusted[symbol] = 1;
            }
        }
        let (group_lengths, _) = djw_build_prefix_lengths(&adjusted, DJW_MAX_CODELEN)?;
        let group_codes = djw_build_codes_from_lengths(&group_lengths, DJW_MAX_CODELEN)?;
        lengths.push(group_lengths);
        codes.push(group_codes);
    }
    Ok((lengths, codes))
}

fn djw_choose_best_sector_groups(
    section: &[u8],
    sector_size: usize,
    group_lengths: &[Vec<u8>],
    selected_groups: &mut [u8],
) -> Result<()> {
    let expected_sectors = 1 + (section.len() - 1) / sector_size;
    if selected_groups.len() != expected_sectors {
        return Err(RomWeaverError::Validation(
            "xdelta djw selector vector has the wrong size".into(),
        ));
    }
    if group_lengths.is_empty() {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder has no group code tables".into(),
        ));
    }

    for (sector_index, sector) in section.chunks(sector_size).enumerate() {
        let mut winner = 0usize;
        let mut winner_cost = usize::MAX;

        for (group_index, lengths) in group_lengths.iter().enumerate() {
            let mut cost = 0usize;
            let mut valid = true;
            for &symbol in sector {
                let bits = usize::from(lengths[usize::from(symbol)]);
                if bits == 0 {
                    valid = false;
                    break;
                }
                cost = cost.saturating_add(bits);
            }
            if valid && cost < winner_cost {
                winner = group_index;
                winner_cost = cost;
            }
        }

        selected_groups[sector_index] = u8::try_from(winner).map_err(|_| {
            RomWeaverError::Validation("xdelta djw winner index exceeded u8".into())
        })?;
    }

    Ok(())
}

fn djw_rebuild_group_frequencies(
    section: &[u8],
    sector_size: usize,
    selected_groups: &[u8],
    group_frequencies: &mut [[u32; DJW_ALPHABET_SIZE]],
) -> Result<()> {
    for group in group_frequencies.iter_mut() {
        group.fill(0);
    }

    for (sector_index, sector) in section.chunks(sector_size).enumerate() {
        let group_index = usize::from(selected_groups[sector_index]);
        let group = group_frequencies.get_mut(group_index).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "xdelta djw selector chose invalid group index {group_index}"
            ))
        })?;
        for &symbol in sector {
            let slot = &mut group[usize::from(symbol)];
            *slot = slot.saturating_add(1);
        }
    }

    Ok(())
}

fn xdelta_fgk_compress(section: &[u8]) -> Result<Vec<u8>> {
    let mut state = FgkState::new(DJW_ALPHABET_SIZE)?;
    let mut writer = DjwBitWriter::new();

    for &symbol in section {
        let mut bits = state.fgk_encode_data(usize::from(symbol))?;
        while bits != 0 {
            bits -= 1;
            writer.write_bit(state.fgk_get_encoded_bit()?)?;
        }
    }

    Ok(writer.finish())
}

#[derive(Default)]
struct DjwBitWriter {
    output: Vec<u8>,
    current_byte: u8,
    current_mask: u16,
}

impl DjwBitWriter {
    fn new() -> Self {
        Self {
            output: Vec::new(),
            current_byte: 0,
            current_mask: 1,
        }
    }

    fn write_bit(&mut self, bit: u8) -> Result<()> {
        if bit > 1 {
            return Err(RomWeaverError::Validation(
                "xdelta secondary encoder received a non-bit value".into(),
            ));
        }
        if bit == 1 {
            self.current_byte |= self.current_mask as u8;
        }
        if self.current_mask == 0x80 {
            self.output.push(self.current_byte);
            self.current_byte = 0;
            self.current_mask = 1;
        } else {
            self.current_mask <<= 1;
        }
        Ok(())
    }

    fn write_bits(&mut self, bit_count: usize, value: usize) -> Result<()> {
        if bit_count == 0 || bit_count >= usize::BITS as usize {
            return Err(RomWeaverError::Validation(
                "xdelta secondary encoder invalid bit width".into(),
            ));
        }
        let mask = 1usize
            .checked_shl(u32::try_from(bit_count).unwrap_or(u32::MAX))
            .ok_or_else(|| {
                RomWeaverError::Validation("xdelta secondary encoder bit mask overflowed".into())
            })?;
        if value >= mask {
            return Err(RomWeaverError::Validation(
                "xdelta secondary encoder bit value out of range".into(),
            ));
        }
        let mut current = mask;
        while current != 1 {
            current >>= 1;
            self.write_bit(if value & current != 0 { 1 } else { 0 })?;
        }
        Ok(())
    }

    fn finish(mut self) -> Vec<u8> {
        if self.current_mask != 1 {
            self.output.push(self.current_byte);
        }
        self.output
    }
}

fn xdelta_lzma2_compress(bytes: &[u8]) -> Result<Vec<u8>> {
    encode_xz_preset(bytes, 6).map_err(|error| {
        RomWeaverError::Validation(format!("xdelta lzma secondary encode failed: {error}"))
    })
}

fn xdelta_lzma2_decompress(bytes: &[u8], expected_size: usize) -> Result<Vec<u8>> {
    decode_xz_exact(bytes, expected_size).map_err(|error| {
        RomWeaverError::Validation(format!("xdelta lzma secondary decode failed: {error}"))
    })
}

fn window_win_indicator(window: &WindowIndex) -> u8 {
    let mut win_indicator = match window.source_kind {
        Some(WindowSourceKind::Source) => WIN_SOURCE,
        Some(WindowSourceKind::Target) => WIN_TARGET,
        None => 0,
    };
    if window.checksum.is_some() {
        win_indicator |= WIN_CHECKSUM;
    }
    win_indicator
}

fn encode_varint_raw(bytes: &mut Vec<u8>, mut value: u64) {
    if value == 0 {
        bytes.push(0);
        return;
    }

    let mut stack = Vec::new();
    while value > 0 {
        stack.push((value % 128) as u8);
        value /= 128;
    }

    for (index, digit) in stack.iter().rev().enumerate() {
        let is_last = index + 1 == stack.len();
        bytes.push(if is_last { *digit } else { *digit | 0x80 });
    }
}

fn decode_varint_raw(bytes: &[u8]) -> Result<(u64, usize)> {
    let mut value = 0u64;
    for (index, byte) in bytes.iter().copied().enumerate() {
        value = value
            .checked_mul(128)
            .and_then(|current| current.checked_add(u64::from(byte & 0x7F)))
            .ok_or_else(|| RomWeaverError::Validation("base-128 integer overflowed u64".into()))?;
        if byte & 0x80 == 0 {
            return Ok((value, index + 1));
        }
        if index >= 9 {
            break;
        }
    }
    Err(RomWeaverError::Validation(
        "base-128 integer exceeds the supported length".into(),
    ))
}

fn decode_window_with_native_engine<R: Read + Seek>(
    patch_reader: &mut R,
    window: &WindowIndex,
    secondary_compressor_id: Option<u8>,
    source_segment: &[u8],
    validate_checksums: bool,
) -> Result<Vec<u8>> {
    let (data, inst, addr) = read_window_sections(patch_reader, window, secondary_compressor_id)?;
    let source_len = if window.source_kind.is_some() {
        window.source_segment_size
    } else {
        0
    };
    let header = build_native_window_header(window, source_len);
    let mut source: &[u8] = source_segment;
    let mut copy_buf = Vec::new();

    let decoded = oxidelta_decoder::decode_window(
        &header,
        &data,
        &inst,
        &addr,
        &mut source,
        validate_checksums,
        &mut copy_buf,
    )
    .map_err(|error| native_decode_error(error, window))?;

    if decoded.len() as u64 != window.target_window_size {
        return Err(RomWeaverError::Validation(format!(
            "native VCDIFF decoder produced {} byte(s) but expected {}",
            decoded.len(),
            window.target_window_size
        )));
    }

    if validate_checksums && let Some(expected) = window.checksum {
        let actual = adler32(&decoded);
        if actual != expected {
            return Err(RomWeaverError::Validation(format!(
                "target window checksum mismatch: expected 0x{expected:08X}, got 0x{actual:08X}"
            )));
        }
    }

    Ok(decoded)
}

fn read_window_sections<R: Read + Seek>(
    patch_reader: &mut R,
    window: &WindowIndex,
    secondary_compressor_id: Option<u8>,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let data = read_section(patch_reader, window.data_start, window.data_len)?;
    let inst = read_section(patch_reader, window.inst_start, window.inst_len)?;
    let addr = read_section(patch_reader, window.addr_start, window.addr_len)?;

    if window.delta_indicator == 0 {
        return Ok((data, inst, addr));
    }

    if secondary_compressor_id == Some(XDELTA_LZMA_SECONDARY_ID)
        && let Ok(decoded) =
            try_decode_xdelta_lzma_sections(&data, &inst, &addr, window.delta_indicator)
    {
        return Ok(decoded);
    }

    if secondary_compressor_id == Some(XDELTA_DJW_SECONDARY_ID) {
        return try_decode_xdelta_djw_sections(&data, &inst, &addr, window.delta_indicator);
    }

    if secondary_compressor_id == Some(XDELTA_FGK_SECONDARY_ID) {
        return try_decode_xdelta_fgk_sections(&data, &inst, &addr, window.delta_indicator);
    }

    ensure_supported_secondary_compressor(secondary_compressor_id)?;

    oxidelta::compress::secondary::decompress_sections(
        &data,
        &inst,
        &addr,
        window.delta_indicator,
        secondary_compressor_id,
    )
    .map_err(|error| {
        RomWeaverError::Validation(format!(
            "native VCDIFF secondary decompression failed at output offset {}: {error}",
            window.output_offset
        ))
    })
}

fn try_decode_xdelta_lzma_sections(
    data: &[u8],
    inst: &[u8],
    addr: &[u8],
    delta_indicator: u8,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let data = decode_xdelta_lzma_section_if_flag(data, delta_indicator & DELTA_DATA_COMP != 0)?;
    let inst = decode_xdelta_lzma_section_if_flag(inst, delta_indicator & DELTA_INST_COMP != 0)?;
    let addr = decode_xdelta_lzma_section_if_flag(addr, delta_indicator & DELTA_ADDR_COMP != 0)?;
    Ok((data, inst, addr))
}

fn decode_xdelta_lzma_section_if_flag(section: &[u8], compressed: bool) -> Result<Vec<u8>> {
    if !compressed {
        return Ok(section.to_vec());
    }

    let (decoded_size, prefix_len) = decode_varint_raw(section)?;
    let payload = section.get(prefix_len..).ok_or_else(|| {
        RomWeaverError::Validation("xdelta lzma section payload is missing".into())
    })?;
    let expected = usize::try_from(decoded_size).map_err(|_| {
        RomWeaverError::Validation("xdelta lzma section decoded size is too large".into())
    })?;
    let decoded = xdelta_lzma2_decompress(payload, expected)?;
    if decoded.len() != expected {
        return Err(RomWeaverError::Validation(format!(
            "xdelta lzma section decoded to {} byte(s) but expected {}",
            decoded.len(),
            expected
        )));
    }
    Ok(decoded)
}

#[derive(Clone, Copy)]
struct DjwBitState {
    cur_byte: u8,
    cur_mask: u16,
}

impl DjwBitState {
    fn decode_init() -> Self {
        Self {
            cur_byte: 0,
            cur_mask: 0x100,
        }
    }
}

#[derive(Clone)]
struct DjwDecodeTable {
    inorder: Vec<u8>,
    base: Vec<usize>,
    limit: Vec<usize>,
    min_len: usize,
    max_len: usize,
}

