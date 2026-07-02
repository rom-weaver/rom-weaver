use super::*;
pub(super) fn xdelta_djw_compress(section: &[u8], section_kind: DjwSectionKind) -> Result<Vec<u8>> {
    if section.is_empty() {
        return Err(RomWeaverError::Validation(
            "xdelta djw secondary encoder requires non-empty input".into(),
        ));
    }

    let (groups, sector_size) = djw_select_groups_and_sector_size(section.len(), section_kind)?;
    if groups > 1
        && let Ok(compressed) = xdelta_djw_compress_multi_group(section, groups, sector_size)
        && let Ok(decoded) = decode_djw_secondary(&compressed, section.len())
        && decoded == section
    {
        return Ok(compressed);
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

pub(super) fn djw_select_groups_and_sector_size(
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
    if !(DJW_SECTORSZ_MULT..=DJW_SECTORSZ_MAX).contains(&sector_size)
        || !sector_size.is_multiple_of(DJW_SECTORSZ_MULT)
    {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder selected an invalid sector size".into(),
        ));
    }
    Ok((groups, sector_size))
}

pub(super) fn xdelta_djw_compress_multi_group(
    section: &[u8],
    groups: usize,
    sector_size: usize,
) -> Result<Vec<u8>> {
    if groups <= 1 || groups > DJW_MAX_GROUPS {
        return Err(RomWeaverError::Validation(
            "xdelta djw encoder received an invalid group count".into(),
        ));
    }
    if !(DJW_SECTORSZ_MULT..=DJW_SECTORSZ_MAX).contains(&sector_size)
        || !sector_size.is_multiple_of(DJW_SECTORSZ_MULT)
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

pub(super) fn djw_seed_group_frequencies(groups: usize) -> Vec<[u32; DJW_ALPHABET_SIZE]> {
    let mut frequencies = vec![[0u32; DJW_ALPHABET_SIZE]; groups];
    for (group_index, group_frequencies) in frequencies.iter_mut().enumerate() {
        let start = (group_index * DJW_ALPHABET_SIZE) / groups;
        let end = ((group_index + 1) * DJW_ALPHABET_SIZE) / groups;
        for value in group_frequencies.iter_mut().take(end).skip(start) {
            *value = 8;
        }
    }
    frequencies
}

pub(super) fn djw_smooth_group_frequencies(
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

pub(super) type DjwGroupCodeTables = (Vec<Vec<u8>>, Vec<Vec<usize>>);

pub(super) fn djw_build_group_code_tables(
    group_frequencies: &[[u32; DJW_ALPHABET_SIZE]],
    real_frequencies: &[u32; DJW_ALPHABET_SIZE],
) -> Result<DjwGroupCodeTables> {
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

pub(super) fn djw_choose_best_sector_groups(
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

pub(super) fn djw_rebuild_group_frequencies(
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

pub(super) fn xdelta_fgk_compress(section: &[u8]) -> Result<Vec<u8>> {
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
pub(super) struct DjwBitWriter {
    output: Vec<u8>,
    current_byte: u8,
    current_mask: u16,
}

impl DjwBitWriter {
    pub(super) fn new() -> Self {
        Self {
            output: Vec::new(),
            current_byte: 0,
            current_mask: 1,
        }
    }

    pub(super) fn write_bit(&mut self, bit: u8) -> Result<()> {
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

    pub(super) fn write_bits(&mut self, bit_count: usize, value: usize) -> Result<()> {
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

    pub(super) fn finish(mut self) -> Vec<u8> {
        if self.current_mask != 1 {
            self.output.push(self.current_byte);
        }
        self.output
    }
}

pub(super) const XZ_MAGIC_BYTES: &[u8; 6] = b"\xFD7zXZ\0";
pub(super) const XDELTA_LZMA_PRESET: u32 = 3;

#[derive(Clone, Default)]
pub(super) struct XdeltaLzmaFeed {
    pending: std::rc::Rc<std::cell::RefCell<std::collections::VecDeque<u8>>>,
}

impl XdeltaLzmaFeed {
    pub(super) fn push(&self, bytes: &[u8]) {
        self.pending.borrow_mut().extend(bytes.iter().copied());
    }
}

impl Read for XdeltaLzmaFeed {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let mut pending = self.pending.borrow_mut();
        let len = output.len().min(pending.len());
        for value in output.iter_mut().take(len) {
            *value = pending
                .pop_front()
                .expect("pending length should match popped bytes");
        }
        Ok(len)
    }
}

pub(super) struct XdeltaLzmaSectionDecoder {
    feed: XdeltaLzmaFeed,
    decoder: lzma_rust2::XzReader<XdeltaLzmaFeed>,
}

impl XdeltaLzmaSectionDecoder {
    pub(super) fn new() -> Self {
        let feed = XdeltaLzmaFeed::default();
        let decoder = lzma_rust2::XzReader::new(feed.clone(), false);
        Self { feed, decoder }
    }

    pub(super) fn decode(
        &mut self,
        payload: &[u8],
        expected_size: usize,
        max_output: usize,
    ) -> Result<Vec<u8>> {
        // LZMA can expand by an arbitrary ratio, so the declared size cannot be
        // trusted: cap it against the window-derived ceiling before allocating
        // so a tiny compressed payload cannot demand a gigabyte buffer.
        if expected_size > max_output {
            return Err(RomWeaverError::Validation(format!(
                "xdelta lzma secondary declares {expected_size}-byte section but the window bounds it to {max_output}"
            )));
        }
        self.feed.push(payload);
        let mut output = vec![0u8; expected_size];
        self.decoder.read_exact(&mut output).map_err(|error| {
            RomWeaverError::Validation(format!("xdelta lzma secondary decode failed: {error}"))
        })?;
        Ok(output)
    }
}

pub(super) struct XdeltaLzmaSectionDecoders {
    data: XdeltaLzmaSectionDecoder,
    inst: XdeltaLzmaSectionDecoder,
    addr: XdeltaLzmaSectionDecoder,
}

impl XdeltaLzmaSectionDecoders {
    pub(super) fn new() -> Self {
        Self {
            data: XdeltaLzmaSectionDecoder::new(),
            inst: XdeltaLzmaSectionDecoder::new(),
            addr: XdeltaLzmaSectionDecoder::new(),
        }
    }

    pub(super) fn decode_sections(
        &mut self,
        data: &[u8],
        inst: &[u8],
        addr: &[u8],
        delta_indicator: u8,
        max_output: usize,
    ) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
        let data = decode_xdelta_lzma_section_with_state(
            data,
            delta_indicator & DELTA_DATA_COMP != 0,
            &mut self.data,
            max_output,
        )?;
        let inst = decode_xdelta_lzma_section_with_state(
            inst,
            delta_indicator & DELTA_INST_COMP != 0,
            &mut self.inst,
            max_output,
        )?;
        let addr = decode_xdelta_lzma_section_with_state(
            addr,
            delta_indicator & DELTA_ADDR_COMP != 0,
            &mut self.addr,
            max_output,
        )?;
        Ok((data, inst, addr))
    }
}

pub(super) struct XdeltaLzmaSectionEncoder {
    stream: liblzma_sys::lzma_stream,
    _options: Box<liblzma_sys::lzma_options_lzma>,
    _filters: [liblzma_sys::lzma_filter; 2],
    output: Vec<u8>,
}

impl XdeltaLzmaSectionEncoder {
    pub(super) fn new() -> Result<Self> {
        use liblzma_sys as lzma_sys;

        let mut stream = unsafe { std::mem::zeroed::<lzma_sys::lzma_stream>() };
        let mut options = Box::new(unsafe { std::mem::zeroed::<lzma_sys::lzma_options_lzma>() });
        let preset_status =
            unsafe { lzma_sys::lzma_lzma_preset(&mut *options, XDELTA_LZMA_PRESET) };
        if preset_status != 0 {
            return Err(RomWeaverError::Validation(format!(
                "xdelta lzma secondary encode init failed: preset {XDELTA_LZMA_PRESET} is invalid"
            )));
        }

        let mut filters = [
            lzma_sys::lzma_filter {
                id: lzma_sys::LZMA_FILTER_LZMA2,
                options: (&mut *options as *mut lzma_sys::lzma_options_lzma)
                    .cast::<std::ffi::c_void>(),
            },
            lzma_sys::lzma_filter {
                id: lzma_sys::LZMA_VLI_UNKNOWN,
                options: std::ptr::null_mut(),
            },
        ];

        let init_status = unsafe {
            lzma_sys::lzma_stream_encoder(
                &mut stream,
                filters.as_mut_ptr(),
                lzma_sys::LZMA_CHECK_NONE,
            )
        };
        if init_status != lzma_sys::LZMA_OK {
            return Err(RomWeaverError::Validation(format!(
                "xdelta lzma secondary encode init failed: {}",
                lzma_status_name(init_status)
            )));
        }

        Ok(Self {
            stream,
            _options: options,
            _filters: filters,
            output: Vec::new(),
        })
    }

    pub(super) fn encode<'a>(&mut self, section: &'a [u8]) -> Result<(Cow<'a, [u8]>, bool)> {
        // Stream continuity lives in `self.stream`; the scratch `output` buffer
        // only holds the current window's emitted bytes, so clearing it each call
        // is byte-safe and stops it from accumulating every prior window.
        self.output.clear();
        if section.len() < XDELTA_SECONDARY_MIN_INPUT {
            return Ok((Cow::Borrowed(section), false));
        }

        let emitted_start = self.output.len();
        self.encode_sync_flush(section)?;
        let compressed = self.output[emitted_start..].to_vec();

        let mut candidate = Vec::with_capacity(varint_len(section.len() as u64) + compressed.len());
        encode_varint_raw(&mut candidate, section.len() as u64);
        candidate.extend_from_slice(&compressed);
        Ok((Cow::Owned(candidate), true))
    }

    pub(super) fn encode_sync_flush(&mut self, section: &[u8]) -> Result<()> {
        use liblzma_sys as lzma_sys;

        self.stream.next_in = section.as_ptr();
        self.stream.avail_in = section.len();
        let mut output = [0u8; 16 * 1024];

        loop {
            self.stream.next_out = output.as_mut_ptr();
            self.stream.avail_out = output.len();

            let status =
                unsafe { lzma_sys::lzma_code(&mut self.stream, lzma_sys::LZMA_SYNC_FLUSH) };
            let written = output.len() - self.stream.avail_out;
            self.output.extend_from_slice(&output[..written]);

            match status {
                value if value == lzma_sys::LZMA_OK => {
                    if self.stream.avail_in == 0 && self.stream.avail_out > 0 {
                        return Ok(());
                    }
                }
                value if value == lzma_sys::LZMA_STREAM_END => return Ok(()),
                other => {
                    return Err(RomWeaverError::Validation(format!(
                        "xdelta lzma secondary encode failed: {}",
                        lzma_status_name(other)
                    )));
                }
            }
        }
    }
}

impl Drop for XdeltaLzmaSectionEncoder {
    fn drop(&mut self) {
        unsafe {
            liblzma_sys::lzma_end(&mut self.stream);
        }
    }
}

pub(super) fn lzma_status_name(status: liblzma_sys::lzma_ret) -> &'static str {
    use liblzma_sys as lzma_sys;

    match status {
        value if value == lzma_sys::LZMA_OK => "ok",
        value if value == lzma_sys::LZMA_STREAM_END => "stream end",
        value if value == lzma_sys::LZMA_MEM_ERROR => "memory allocation failed",
        value if value == lzma_sys::LZMA_MEMLIMIT_ERROR => "memory limit reached",
        value if value == lzma_sys::LZMA_FORMAT_ERROR => "format error",
        value if value == lzma_sys::LZMA_OPTIONS_ERROR => "unsupported options",
        value if value == lzma_sys::LZMA_DATA_ERROR => "input data error",
        value if value == lzma_sys::LZMA_BUF_ERROR => "output buffer too small",
        value if value == lzma_sys::LZMA_PROG_ERROR => "programming error",
        _ => "unknown error",
    }
}

pub(super) struct XdeltaLzmaSectionEncoders {
    data: XdeltaLzmaSectionEncoder,
    inst: XdeltaLzmaSectionEncoder,
    addr: XdeltaLzmaSectionEncoder,
}

impl XdeltaLzmaSectionEncoders {
    pub(super) fn new() -> Result<Self> {
        Ok(Self {
            data: XdeltaLzmaSectionEncoder::new()?,
            inst: XdeltaLzmaSectionEncoder::new()?,
            addr: XdeltaLzmaSectionEncoder::new()?,
        })
    }

    pub(super) fn encode_data<'a>(&mut self, section: &'a [u8]) -> Result<(Cow<'a, [u8]>, bool)> {
        self.data.encode(section)
    }

    pub(super) fn encode_inst<'a>(&mut self, section: &'a [u8]) -> Result<(Cow<'a, [u8]>, bool)> {
        self.inst.encode(section)
    }

    pub(super) fn encode_addr<'a>(&mut self, section: &'a [u8]) -> Result<(Cow<'a, [u8]>, bool)> {
        self.addr.encode(section)
    }
}

pub(super) fn xdelta_lzma_section_has_stream_header(section: &[u8]) -> bool {
    let Ok((_, prefix_len)) = decode_varint_raw(section) else {
        return false;
    };
    section
        .get(prefix_len..)
        .is_some_and(|payload| payload.starts_with(XZ_MAGIC_BYTES))
}

pub(super) fn window_win_indicator(window: &WindowIndex) -> u8 {
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

pub(super) fn encode_varint_raw(bytes: &mut Vec<u8>, value: u64) {
    encode_base128(value, |byte| bytes.push(byte));
}

pub(super) fn decode_varint_raw(bytes: &[u8]) -> Result<(u64, usize)> {
    let mut iter = bytes.iter().copied();
    let mut count = 0usize;
    let value = decode_base128(|| {
        iter.next().inspect(|_| {
            count += 1;
        })
    })?;
    Ok((value, count))
}

pub(super) fn decode_window_with_native_engine<R: Read + Seek>(
    patch_reader: &mut R,
    window: &WindowIndex,
    secondary_compressor_id: Option<u8>,
    source_segment: &[u8],
    validate_checksums: bool,
) -> Result<Vec<u8>> {
    let (data, inst, addr) = read_window_sections(patch_reader, window, secondary_compressor_id)?;
    decode_native_window_sections(
        window,
        &data,
        &inst,
        &addr,
        source_segment,
        validate_checksums,
    )
}

pub(super) fn decode_window_with_xdelta_lzma_sections<R: Read + Seek>(
    patch_reader: &mut R,
    window: &WindowIndex,
    decoders: &mut XdeltaLzmaSectionDecoders,
    source_segment: &[u8],
    validate_checksums: bool,
) -> Result<Vec<u8>> {
    let data = read_section(patch_reader, window.data_start, window.data_len)?;
    let inst = read_section(patch_reader, window.inst_start, window.inst_len)?;
    let addr = read_section(patch_reader, window.addr_start, window.addr_len)?;
    let (data, inst, addr) = if window.delta_indicator == 0 {
        (data, inst, addr)
    } else {
        let max_output = lzma_section_output_ceiling(window);
        decoders.decode_sections(&data, &inst, &addr, window.delta_indicator, max_output)?
    };
    decode_native_window_sections(
        window,
        &data,
        &inst,
        &addr,
        source_segment,
        validate_checksums,
    )
}

pub(super) fn decode_native_window_sections(
    window: &WindowIndex,
    data: &[u8],
    inst: &[u8],
    addr: &[u8],
    source_segment: &[u8],
    validate_checksums: bool,
) -> Result<Vec<u8>> {
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
        data,
        inst,
        addr,
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

pub(super) fn read_window_sections<R: Read + Seek>(
    patch_reader: &mut R,
    window: &WindowIndex,
    secondary_compressor_id: Option<u8>,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let data = read_section(patch_reader, window.data_start, window.data_len)?;
    let inst = read_section(patch_reader, window.inst_start, window.inst_len)?;
    let addr = read_section(patch_reader, window.addr_start, window.addr_len)?;

    trace!(
        output_offset = window.output_offset,
        target = window.target_window_size,
        data = data.len(),
        inst = inst.len(),
        addr = addr.len(),
        delta_indicator = window.delta_indicator,
        secondary = secondary_compressor_id,
        "xdelta apply window sections read"
    );

    if window.delta_indicator == 0 {
        return Ok((data, inst, addr));
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

/// Upper bound on a single secondary-decompressed window section. A window
/// decodes to `target_window_size` bytes; the data section holds at most one
/// byte per output byte, and the instruction/address sections are bounded by the
/// instruction count (at worst a few bytes per output byte). `16 * target +
/// source + 64 KiB` covers every spec-valid section with wide margin while
/// turning a malicious "expands to gigabytes" LZMA stream into a validation
/// error instead of an out-of-memory abort.
fn lzma_section_output_ceiling(window: &WindowIndex) -> usize {
    const SLACK: u64 = 64 * 1024;
    window
        .target_window_size
        .saturating_mul(16)
        .saturating_add(window.source_segment_size)
        .saturating_add(SLACK)
        .try_into()
        .unwrap_or(usize::MAX)
}

pub(super) fn decode_xdelta_lzma_section_with_state(
    section: &[u8],
    compressed: bool,
    decoder: &mut XdeltaLzmaSectionDecoder,
    max_output: usize,
) -> Result<Vec<u8>> {
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
    let decoded = decoder.decode(payload, expected, max_output)?;
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
pub(super) struct DjwBitState {
    pub(super) cur_byte: u8,
    pub(super) cur_mask: u16,
}

impl DjwBitState {
    pub(super) fn decode_init() -> Self {
        Self {
            cur_byte: 0,
            cur_mask: 0x100,
        }
    }
}

#[derive(Clone)]
pub(super) struct DjwDecodeTable {
    pub(super) inorder: Vec<u8>,
    pub(super) base: Vec<usize>,
    pub(super) limit: Vec<usize>,
    pub(super) min_len: usize,
    pub(super) max_len: usize,
}
