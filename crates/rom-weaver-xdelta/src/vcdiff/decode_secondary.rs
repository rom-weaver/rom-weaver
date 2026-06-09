use super::*;
pub(super) fn decode_djw_secondary(input: &[u8], output_size: usize) -> Result<Vec<u8>> {
    if output_size == 0 {
        return Err(RomWeaverError::Validation(
            "xdelta djw secondary decoder invalid output size".into(),
        ));
    }

    let mut state = DjwBitState::decode_init();
    let mut input_pos = 0usize;
    let mut output = Vec::with_capacity(output_size);

    let groups = decode_djw_bits(&mut state, input, &mut input_pos, DJW_GROUP_BITS)? + 1;
    if groups == 0 || groups > DJW_MAX_GROUPS {
        return Err(RomWeaverError::Validation(format!(
            "xdelta djw secondary decoder invalid group count {groups}"
        )));
    }

    let sector_size = if groups > 1 {
        (decode_djw_bits(&mut state, input, &mut input_pos, DJW_SECTORSZ_BITS)? + 1)
            .checked_mul(DJW_SECTORSZ_MULT)
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "xdelta djw secondary decoder sector size overflowed".into(),
                )
            })?
    } else {
        output_size
    };
    let sectors = 1 + (output_size - 1) / sector_size;

    let mut cl_mtf = [0u8; DJW_TOTAL_CODES];
    let cl_decode_table = decode_djw_clclen_table(&mut state, input, &mut input_pos, &mut cl_mtf)?;

    let mut clen = vec![0u8; groups * DJW_ALPHABET_SIZE];
    decode_djw_1_2(
        &mut state,
        input,
        &mut input_pos,
        &cl_decode_table,
        &mut cl_mtf,
        DjwDecodeOutput {
            elements: groups * DJW_ALPHABET_SIZE,
            skip_offset: DJW_ALPHABET_SIZE,
            output: &mut clen,
        },
    )?;

    let mut group_tables = Vec::with_capacity(groups);
    for group in 0..groups {
        let start = group * DJW_ALPHABET_SIZE;
        let end = start + DJW_ALPHABET_SIZE;
        group_tables.push(build_djw_decoder_table(
            &clen[start..end],
            DJW_ALPHABET_SIZE,
            DJW_MAX_CODELEN,
        )?);
    }

    let mut selected_groups = vec![0u8; sectors];
    if groups > 1 {
        let mut sel_clen = vec![0u8; groups + 1];
        let mut sel_mtf = vec![0u8; groups + 1];
        for i in 0..(groups + 1) {
            let code_len = decode_djw_bits(&mut state, input, &mut input_pos, DJW_GBCLEN_BITS)?;
            sel_clen[i] = u8::try_from(code_len).map_err(|_| {
                RomWeaverError::Validation("xdelta djw selector code length exceeded u8".into())
            })?;
            sel_mtf[i] = u8::try_from(i).map_err(|_| {
                RomWeaverError::Validation("xdelta djw selector index exceeded u8".into())
            })?;
        }

        let selector_table = build_djw_decoder_table(&sel_clen, groups + 1, DJW_MAX_GBCLEN)?;
        decode_djw_1_2(
            &mut state,
            input,
            &mut input_pos,
            &selector_table,
            &mut sel_mtf,
            DjwDecodeOutput {
                elements: sectors,
                skip_offset: 0,
                output: &mut selected_groups,
            },
        )?;
    }

    for &selected_group in selected_groups.iter().take(sectors) {
        let group_index = if groups > 1 {
            usize::from(selected_group)
        } else {
            0
        };
        if group_index >= group_tables.len() {
            return Err(RomWeaverError::Validation(format!(
                "xdelta djw secondary decoder selected invalid group index {group_index}"
            )));
        }

        let remaining = output_size.checked_sub(output.len()).ok_or_else(|| {
            RomWeaverError::Validation("xdelta djw output size underflowed".into())
        })?;
        let symbols = sector_size.min(remaining);
        let table = &group_tables[group_index];

        for _ in 0..symbols {
            let symbol =
                decode_djw_symbol(&mut state, input, &mut input_pos, table, DJW_ALPHABET_SIZE)?;
            output.push(u8::try_from(symbol).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "xdelta djw secondary decoder produced out-of-range symbol {symbol}"
                ))
            })?);
        }
    }

    if output.len() != output_size {
        return Err(RomWeaverError::Validation(format!(
            "xdelta djw secondary decoder produced {} byte(s) but expected {}",
            output.len(),
            output_size
        )));
    }
    if input_pos != input.len() {
        return Err(RomWeaverError::Validation(format!(
            "xdelta djw secondary decoder finished with {} unused input byte(s)",
            input.len() - input_pos
        )));
    }

    Ok(output)
}

pub(super) fn decode_djw_clclen_table(
    state: &mut DjwBitState,
    input: &[u8],
    input_pos: &mut usize,
    cl_mtf: &mut [u8; DJW_TOTAL_CODES],
) -> Result<DjwDecodeTable> {
    let num_codes = decode_djw_bits(state, input, input_pos, DJW_EXTRA_CODE_BITS)?
        .checked_add(DJW_EXTRA_12OFFSET)
        .ok_or_else(|| {
            RomWeaverError::Validation("xdelta djw code length count overflowed".into())
        })?;
    if num_codes > DJW_TOTAL_CODES {
        return Err(RomWeaverError::Validation(format!(
            "xdelta djw code length count {num_codes} exceeds limit {DJW_TOTAL_CODES}"
        )));
    }

    let mut cl_clen = vec![0u8; DJW_TOTAL_CODES];
    for value in cl_clen.iter_mut().take(num_codes) {
        *value = u8::try_from(decode_djw_bits(state, input, input_pos, DJW_CLCLEN_BITS)?)
            .map_err(|_| RomWeaverError::Validation("xdelta djw code length exceeded u8".into()))?;
    }

    init_djw_clen_mtf(cl_mtf);
    build_djw_decoder_table(&cl_clen, DJW_TOTAL_CODES, DJW_MAX_CLCLEN)
}

pub(super) struct DjwDecodeOutput<'a> {
    elements: usize,
    skip_offset: usize,
    output: &'a mut [u8],
}

pub(super) fn decode_djw_1_2(
    state: &mut DjwBitState,
    input: &[u8],
    input_pos: &mut usize,
    table: &DjwDecodeTable,
    mtf_values: &mut [u8],
    output_spec: DjwDecodeOutput<'_>,
) -> Result<()> {
    let DjwDecodeOutput {
        elements,
        skip_offset,
        output,
    } = output_spec;
    let mut index = 0usize;
    let mut repeat = 0usize;
    let mut mtf = 0usize;
    let mut shift = 0usize;

    while index < elements {
        if skip_offset != 0 && index >= skip_offset && output[index - skip_offset] == 0 {
            output[index] = 0;
            index += 1;
            continue;
        }

        if repeat != 0 {
            output[index] = mtf_values[0];
            repeat -= 1;
            index += 1;
            continue;
        }

        if mtf != 0 {
            let symbol = djw_update_mtf(mtf_values, mtf)?;
            output[index] = symbol;
            mtf = 0;
            index += 1;
            continue;
        }

        mtf = decode_djw_symbol(state, input, input_pos, table, DJW_TOTAL_CODES)?;
        if mtf <= DJW_RUN_1 {
            repeat = (mtf + 1)
                .checked_shl(u32::try_from(shift).unwrap_or(u32::MAX))
                .ok_or_else(|| {
                    RomWeaverError::Validation("xdelta djw repeat count overflowed".into())
                })?;
            mtf = 0;
            shift = shift
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("xdelta djw shift overflowed".into()))?;
        } else {
            mtf -= 1;
            shift = 0;
        }
    }

    if repeat != 0 {
        return Err(RomWeaverError::Validation(
            "xdelta djw secondary decoder invalid repeat code".into(),
        ));
    }

    Ok(())
}

pub(super) fn build_djw_decoder_table(
    code_lengths: &[u8],
    alphabet_size: usize,
    max_code_len: usize,
) -> Result<DjwDecodeTable> {
    if code_lengths.len() < alphabet_size {
        return Err(RomWeaverError::Validation(
            "xdelta djw decoder table input is too short".into(),
        ));
    }

    let mut counts = vec![0usize; max_code_len + 1];
    for &code_len in code_lengths.iter().take(alphabet_size) {
        let value = usize::from(code_len);
        if value > max_code_len {
            return Err(RomWeaverError::Validation(format!(
                "xdelta djw code length {value} exceeds max {max_code_len}"
            )));
        }
        counts[value] += 1;
    }

    let mut min_len = None;
    let mut max_len = None;
    for (length, &count) in counts.iter().enumerate().skip(1) {
        if count != 0 {
            min_len.get_or_insert(length);
            max_len = Some(length);
        }
    }

    let min_len = min_len.ok_or_else(|| {
        RomWeaverError::Validation("xdelta djw decoder table has no symbols".into())
    })?;
    let max_len = max_len.unwrap_or(min_len);

    let mut base = vec![0usize; max_code_len + 2];
    let mut limit = vec![0usize; max_code_len + 2];
    let mut cursor = vec![0usize; max_code_len + 2];
    let mut inorder = vec![0u8; alphabet_size];

    base[min_len] = 0;
    limit[min_len] = counts[min_len]
        .checked_sub(1)
        .ok_or_else(|| RomWeaverError::Validation("xdelta djw invalid prefix table".into()))?;
    cursor[min_len] = 0;

    for length in (min_len + 1)..=max_len {
        let previous = (limit[length - 1] + 1) << 1;
        cursor[length] = cursor[length - 1]
            .checked_add(counts[length - 1])
            .ok_or_else(|| {
                RomWeaverError::Validation("xdelta djw prefix cursor overflowed".into())
            })?;
        limit[length] = previous
            .checked_add(counts[length])
            .and_then(|value| value.checked_sub(1))
            .ok_or_else(|| {
                RomWeaverError::Validation("xdelta djw prefix limit overflowed".into())
            })?;
        base[length] = previous.checked_sub(cursor[length]).ok_or_else(|| {
            RomWeaverError::Validation("xdelta djw prefix base overflowed".into())
        })?;
    }

    for (symbol, &code_len) in code_lengths.iter().take(alphabet_size).enumerate() {
        let length = usize::from(code_len);
        if length == 0 {
            continue;
        }
        let position = cursor[length];
        if position >= inorder.len() {
            return Err(RomWeaverError::Validation(
                "xdelta djw inorder table overflowed".into(),
            ));
        }
        inorder[position] = u8::try_from(symbol).map_err(|_| {
            RomWeaverError::Validation("xdelta djw symbol index exceeded u8".into())
        })?;
        cursor[length] += 1;
    }

    Ok(DjwDecodeTable {
        inorder,
        base,
        limit,
        min_len,
        max_len,
    })
}

pub(super) fn decode_djw_symbol(
    state: &mut DjwBitState,
    input: &[u8],
    input_pos: &mut usize,
    table: &DjwDecodeTable,
    max_symbol: usize,
) -> Result<usize> {
    let mut code = 0usize;
    let mut bits = 0usize;

    loop {
        if state.cur_mask == 0x100 {
            if *input_pos >= input.len() {
                return Err(RomWeaverError::Validation(
                    "xdelta djw secondary decoder reached end of input".into(),
                ));
            }
            state.cur_byte = input[*input_pos];
            *input_pos += 1;
            state.cur_mask = 1;
        }

        if bits == table.max_len {
            return Err(RomWeaverError::Validation(
                "xdelta djw secondary decoder encountered an invalid symbol".into(),
            ));
        }

        bits += 1;
        code <<= 1;
        if (usize::from(state.cur_byte) & usize::from(state.cur_mask)) != 0 {
            code |= 1;
        }
        state.cur_mask <<= 1;

        if bits >= table.min_len && code <= table.limit[bits] {
            if table.base[bits] > code {
                break;
            }
            let offset = code - table.base[bits];
            if offset < table.inorder.len() && offset <= max_symbol {
                return Ok(usize::from(table.inorder[offset]));
            }
            break;
        }
    }

    Err(RomWeaverError::Validation(
        "xdelta djw secondary decoder encountered an invalid symbol".into(),
    ))
}

pub(super) fn decode_djw_bits(
    state: &mut DjwBitState,
    input: &[u8],
    input_pos: &mut usize,
    bit_count: usize,
) -> Result<usize> {
    if bit_count == 0 || bit_count >= usize::BITS as usize {
        return Err(RomWeaverError::Validation(
            "xdelta djw secondary decoder requested an invalid bit count".into(),
        ));
    }

    let mut value = 0usize;
    let mut mask = 1usize << bit_count;
    loop {
        if state.cur_mask == 0x100 {
            if *input_pos >= input.len() {
                return Err(RomWeaverError::Validation(
                    "xdelta djw secondary decoder reached end of input".into(),
                ));
            }
            state.cur_byte = input[*input_pos];
            *input_pos += 1;
            state.cur_mask = 1;
        }

        mask >>= 1;
        if (usize::from(state.cur_byte) & usize::from(state.cur_mask)) != 0 {
            value |= mask;
        }
        state.cur_mask <<= 1;
        if mask == 1 {
            break;
        }
    }
    Ok(value)
}

pub(super) fn init_djw_clen_mtf(cl_mtf: &mut [u8]) {
    if cl_mtf.len() < DJW_MAX_CODELEN + 1 {
        return;
    }
    let mut index = 0usize;
    cl_mtf[index] = 0;
    index += 1;
    for &value in &DJW_ENCODE_12BASIC {
        cl_mtf[index] = value;
        index += 1;
    }
    for &value in &DJW_ENCODE_12EXTRA {
        cl_mtf[index] = value;
        index += 1;
    }
}

pub(super) fn djw_update_mtf(mtf_values: &mut [u8], mtf_index: usize) -> Result<u8> {
    if mtf_index >= mtf_values.len() {
        return Err(RomWeaverError::Validation(format!(
            "xdelta djw mtf index {mtf_index} is out of bounds"
        )));
    }

    let symbol = mtf_values[mtf_index];
    for index in (1..=mtf_index).rev() {
        mtf_values[index] = mtf_values[index - 1];
    }
    mtf_values[0] = symbol;
    Ok(symbol)
}

#[derive(Clone, Copy, Default)]
pub(super) struct DjwHeapNode {
    depth: u32,
    freq: u32,
    parent: usize,
}

#[derive(Clone)]
pub(super) struct DjwPrefix {
    pub(super) symbol: Vec<u8>,
    pub(super) mtfsym: Vec<u8>,
    pub(super) mcount: usize,
}

impl DjwPrefix {
    pub(super) fn new(symbol: Vec<u8>) -> Self {
        Self {
            mtfsym: vec![0; symbol.len().max(1)],
            symbol,
            mcount: 0,
        }
    }
}

pub(super) fn djw_count_byte_frequencies(section: &[u8]) -> [u32; DJW_ALPHABET_SIZE] {
    let mut freq = [0u32; DJW_ALPHABET_SIZE];
    for &byte in section {
        freq[usize::from(byte)] += 1;
    }
    freq
}

pub(super) fn djw_heap_less(ents: &[DjwHeapNode], left: usize, right: usize) -> bool {
    ents[left].freq < ents[right].freq
        || (ents[left].freq == ents[right].freq && ents[left].depth < ents[right].depth)
}

pub(super) fn djw_heap_insert(
    heap: &mut [usize],
    ents: &[DjwHeapNode],
    mut position: usize,
    entry: usize,
) {
    let mut parent = position / 2;
    while djw_heap_less(ents, entry, heap[parent]) {
        heap[position] = heap[parent];
        position = parent;
        parent = position / 2;
    }
    heap[position] = entry;
}

pub(super) fn djw_heap_extract(
    heap: &mut [usize],
    ents: &[DjwHeapNode],
    heap_last: usize,
) -> usize {
    let smallest = heap[1];
    heap[1] = heap[heap_last + 1];
    let mut parent = 1usize;
    loop {
        let mut child = parent * 2;
        if child > heap_last {
            break;
        }
        if child < heap_last && djw_heap_less(ents, heap[child + 1], heap[child]) {
            child += 1;
        }
        if !djw_heap_less(ents, heap[child], heap[parent]) {
            break;
        }
        heap.swap(parent, child);
        parent = child;
    }
    smallest
}

pub(super) fn djw_build_prefix_lengths(
    freq: &[u32],
    max_code_len: usize,
) -> Result<(Vec<u8>, usize)> {
    if freq.is_empty() {
        return Err(RomWeaverError::Validation(
            "xdelta djw prefix builder received empty frequency input".into(),
        ));
    }
    let asize = freq.len();
    let mut work_freq = freq.to_vec();

    loop {
        let mut heap = vec![0usize; asize + 1];
        let mut ents = vec![DjwHeapNode::default(); asize * 2 + 1];
        let mut heap_last = 0usize;
        let mut ents_size = 1usize;
        let mut total_bits = 0usize;

        ents[0].depth = 0;
        ents[0].freq = 0;
        heap[0] = 0;

        for &value in &work_freq {
            ents[ents_size].depth = 0;
            ents[ents_size].parent = 0;
            ents[ents_size].freq = value;
            if value != 0 {
                heap_last += 1;
                djw_heap_insert(&mut heap, &ents, heap_last, ents_size);
            }
            ents_size += 1;
        }

        if heap_last == 0 {
            return Err(RomWeaverError::Validation(
                "xdelta djw prefix builder requires at least one symbol".into(),
            ));
        }

        if heap_last == 1 {
            let fake = if work_freq[0] != 0 { asize - 1 } else { 0 };
            work_freq[fake] = 1;
            continue;
        }

        while heap_last > 1 {
            heap_last -= 1;
            let first = djw_heap_extract(&mut heap, &ents, heap_last);
            heap_last -= 1;
            let second = djw_heap_extract(&mut heap, &ents, heap_last);
            let node = ents_size;
            ents[node].freq = ents[first]
                .freq
                .checked_add(ents[second].freq)
                .ok_or_else(|| {
                    RomWeaverError::Validation("xdelta djw frequency sum overflowed".into())
                })?;
            ents[node].depth = 1 + ents[first].depth.max(ents[second].depth);
            ents[node].parent = 0;
            ents[first].parent = node;
            ents[second].parent = node;
            heap_last += 1;
            djw_heap_insert(&mut heap, &ents, heap_last, node);
            ents_size += 1;
        }

        let mut overflow = false;
        let mut lengths = vec![0u8; asize];
        for i in 1..=asize {
            let mut bits = 0usize;
            if ents[i].freq != 0 {
                let mut parent = i;
                while ents[parent].parent != 0 {
                    bits += 1;
                    parent = ents[parent].parent;
                }
                if bits > max_code_len {
                    overflow = true;
                }
                total_bits = total_bits
                    .checked_add(bits.saturating_mul(work_freq[i - 1] as usize))
                    .ok_or_else(|| {
                        RomWeaverError::Validation("xdelta djw total bit count overflowed".into())
                    })?;
            }
            lengths[i - 1] = u8::try_from(bits).map_err(|_| {
                RomWeaverError::Validation("xdelta djw code length exceeded u8".into())
            })?;
        }

        if !overflow {
            return Ok((lengths, total_bits));
        }

        for value in &mut work_freq {
            *value = value.saturating_div(2).saturating_add(1);
        }
    }
}

pub(super) fn djw_build_codes_from_lengths(
    code_lengths: &[u8],
    max_code_len: usize,
) -> Result<Vec<usize>> {
    let mut min_len = max_code_len;
    let mut max_len = 0usize;
    for &length in code_lengths {
        let length = usize::from(length);
        if length > 0 && length < min_len {
            min_len = length;
        }
        if length > max_len {
            max_len = length;
        }
    }
    if max_len == 0 {
        return Err(RomWeaverError::Validation(
            "xdelta djw code table has no symbols".into(),
        ));
    }
    if max_len > max_code_len {
        return Err(RomWeaverError::Validation(
            "xdelta djw code length exceeded configured maximum".into(),
        ));
    }

    let mut code = 0usize;
    let mut codes = vec![0usize; code_lengths.len()];
    for length in min_len..=max_len {
        for (symbol, &symbol_len) in code_lengths.iter().enumerate() {
            if usize::from(symbol_len) == length {
                codes[symbol] = code;
                code = code.checked_add(1).ok_or_else(|| {
                    RomWeaverError::Validation("xdelta djw code counter overflowed".into())
                })?;
            }
        }
        code = code
            .checked_shl(1)
            .ok_or_else(|| RomWeaverError::Validation("xdelta djw code shift overflowed".into()))?;
    }
    Ok(codes)
}

pub(super) fn djw_update_1_2(
    mtf_run: &mut usize,
    mtf_index: &mut usize,
    mtf_symbols: &mut [u8],
    frequencies: &mut [u32],
) -> Result<()> {
    loop {
        *mtf_run = mtf_run.saturating_sub(1);
        let code = if (*mtf_run & 1) != 0 { DJW_RUN_1 } else { 0 };
        if *mtf_index >= mtf_symbols.len() {
            return Err(RomWeaverError::Validation(
                "xdelta djw mtf symbol buffer overflowed".into(),
            ));
        }
        mtf_symbols[*mtf_index] = code as u8;
        *mtf_index += 1;
        frequencies[code] = frequencies[code].saturating_add(1);
        *mtf_run >>= 1;
        if *mtf_run < 1 {
            break;
        }
    }
    *mtf_run = 0;
    Ok(())
}

pub(super) fn djw_compute_mtf_1_2(
    prefix: &mut DjwPrefix,
    mtf_values: &mut [u8],
    frequencies_out: &mut [u32],
    symbol_count: usize,
) -> Result<()> {
    frequencies_out.fill(0);
    let mut mtf_index = 0usize;
    let mut mtf_run = 0usize;

    for &symbol in &prefix.symbol {
        let position = mtf_values
            .iter()
            .position(|value| *value == symbol)
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "xdelta djw prefix symbol was missing from MTF table".into(),
                )
            })?;
        let _ = djw_update_mtf(mtf_values, position)?;

        if position == 0 {
            mtf_run = mtf_run.saturating_add(1);
            continue;
        }

        if mtf_run > 0 {
            djw_update_1_2(
                &mut mtf_run,
                &mut mtf_index,
                &mut prefix.mtfsym,
                frequencies_out,
            )?;
        }

        let encoded = position
            .checked_add(DJW_RUN_1)
            .ok_or_else(|| RomWeaverError::Validation("xdelta djw mtf offset overflowed".into()))?;
        if encoded >= symbol_count + 2 {
            return Err(RomWeaverError::Validation(
                "xdelta djw mtf symbol exceeded expected range".into(),
            ));
        }
        if mtf_index >= prefix.mtfsym.len() {
            return Err(RomWeaverError::Validation(
                "xdelta djw mtf output overflowed".into(),
            ));
        }
        prefix.mtfsym[mtf_index] = encoded as u8;
        mtf_index += 1;
        frequencies_out[encoded] = frequencies_out[encoded].saturating_add(1);
    }

    if mtf_run > 0 {
        djw_update_1_2(
            &mut mtf_run,
            &mut mtf_index,
            &mut prefix.mtfsym,
            frequencies_out,
        )?;
    }

    prefix.mcount = mtf_index;
    Ok(())
}

pub(super) fn djw_compute_prefix_1_2(
    prefix: &mut DjwPrefix,
    frequencies: &mut [u32],
) -> Result<()> {
    let mut code_len_mtf = [0u8; DJW_MAX_CODELEN + 1];
    init_djw_clen_mtf(&mut code_len_mtf);
    djw_compute_mtf_1_2(prefix, &mut code_len_mtf, frequencies, DJW_MAX_CODELEN)
}

pub(super) fn djw_encode_prefix(writer: &mut DjwBitWriter, prefix: &mut DjwPrefix) -> Result<()> {
    let mut code_len_freq = [0u32; DJW_TOTAL_CODES];
    djw_compute_prefix_1_2(prefix, &mut code_len_freq)?;
    let (code_len_lengths, _) = djw_build_prefix_lengths(&code_len_freq, DJW_MAX_CLCLEN)?;
    let code_len_codes = djw_build_codes_from_lengths(&code_len_lengths, DJW_MAX_CLCLEN)?;

    let mut num_to_encode = DJW_TOTAL_CODES;
    while num_to_encode > DJW_EXTRA_12OFFSET && code_len_lengths[num_to_encode - 1] == 0 {
        num_to_encode -= 1;
    }
    if num_to_encode < DJW_EXTRA_12OFFSET {
        return Err(RomWeaverError::Validation(
            "xdelta djw prefix encoder computed invalid code count".into(),
        ));
    }
    let extra_codes = num_to_encode - DJW_EXTRA_12OFFSET;
    if extra_codes >= (1 << DJW_EXTRA_CODE_BITS) {
        return Err(RomWeaverError::Validation(
            "xdelta djw prefix encoder overflowed extra code count".into(),
        ));
    }

    writer.write_bits(DJW_EXTRA_CODE_BITS, extra_codes)?;
    for &length in code_len_lengths.iter().take(num_to_encode) {
        writer.write_bits(DJW_CLCLEN_BITS, usize::from(length))?;
    }

    for &symbol in prefix.mtfsym.iter().take(prefix.mcount) {
        let index = usize::from(symbol);
        let bits = usize::from(code_len_lengths[index]);
        let code = code_len_codes[index];
        writer.write_bits(bits, code)?;
    }

    Ok(())
}

#[derive(Clone, Copy, Default)]
pub(super) struct FgkNode {
    weight: u32,
    parent: Option<usize>,
    left_child: Option<usize>,
    right_child: Option<usize>,
    left: Option<usize>,
    right: Option<usize>,
    my_block: Option<usize>,
}

#[derive(Clone, Copy, Default)]
pub(super) struct FgkBlock {
    leader: Option<usize>,
    free_next: Option<usize>,
}

pub(super) struct FgkState {
    alphabet_size: usize,
    zero_freq_count: usize,
    zero_freq_exp: usize,
    zero_freq_rem: usize,
    coded_depth: usize,
    coded_bits: Vec<u8>,
    blocks: Vec<FgkBlock>,
    free_block: Option<usize>,
    nodes: Vec<FgkNode>,
    decode_ptr: usize,
    remaining_zeros: Option<usize>,
    root_node: usize,
    free_node: usize,
}

impl FgkState {
    pub(super) fn new(alphabet_size: usize) -> Result<Self> {
        let total_nodes = (2 * alphabet_size).checked_sub(1).ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk total node count overflowed".into())
        })?;
        let total_blocks = total_nodes.checked_mul(2).ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk block count overflowed".into())
        })?;

        let mut nodes = vec![FgkNode::default(); total_nodes];
        for (index, node) in nodes.iter_mut().enumerate().take(alphabet_size) {
            let right_child = if index + 1 < alphabet_size {
                Some(index + 1)
            } else {
                None
            };
            let left_child = if index >= 1 { Some(index - 1) } else { None };
            *node = FgkNode {
                weight: 0,
                parent: None,
                left_child,
                right_child,
                left: None,
                right: None,
                my_block: None,
            };
        }

        let mut blocks = vec![FgkBlock::default(); total_blocks];
        for (index, block) in blocks.iter_mut().enumerate() {
            block.free_next = if index + 1 < total_blocks {
                Some(index + 1)
            } else {
                None
            };
        }

        let mut state = Self {
            alphabet_size,
            zero_freq_count: alphabet_size + 2,
            zero_freq_exp: 0,
            zero_freq_rem: 0,
            coded_depth: 0,
            coded_bits: vec![0; alphabet_size],
            blocks,
            free_block: Some(0),
            nodes,
            decode_ptr: 0,
            remaining_zeros: Some(0),
            root_node: 0,
            free_node: alphabet_size,
        };

        state.fgk_factor_remaining()?;
        state.fgk_factor_remaining()?;
        Ok(state)
    }

    pub(super) fn fgk_decode_bit(&mut self, bit: u8) -> Result<bool> {
        if bit > 1 {
            return Err(RomWeaverError::Validation(
                "xdelta fgk decoder received an invalid bit".into(),
            ));
        }

        if self.nodes[self.decode_ptr].weight == 0 {
            let bits_required = if self.zero_freq_rem == 0 {
                self.zero_freq_exp
            } else {
                self.zero_freq_exp + 1
            };
            if self.coded_depth >= self.coded_bits.len() {
                return Err(RomWeaverError::Validation(
                    "xdelta fgk coded bit buffer overflowed".into(),
                ));
            }
            self.coded_bits[self.coded_depth] = bit;
            self.coded_depth += 1;
            return Ok(self.coded_depth >= bits_required);
        }

        let next = if bit == 1 {
            self.nodes[self.decode_ptr].right_child.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk missing right child".into())
            })?
        } else {
            self.nodes[self.decode_ptr]
                .left_child
                .ok_or_else(|| RomWeaverError::Validation("xdelta fgk missing left child".into()))?
        };
        self.decode_ptr = next;

        if self.nodes[self.decode_ptr].left_child.is_none() {
            if self.nodes[self.decode_ptr].weight != 0 {
                return Ok(true);
            }
            return Ok(self.zero_freq_count == 1);
        }
        Ok(false)
    }

    pub(super) fn fgk_find_nth_zero(&self, symbol_index: usize) -> Result<usize> {
        if symbol_index >= self.alphabet_size {
            return Err(RomWeaverError::Validation(format!(
                "xdelta fgk symbol index {symbol_index} exceeds alphabet size {}",
                self.alphabet_size
            )));
        }
        let mut cursor = self
            .remaining_zeros
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk zero list is empty".into()))?;
        let target = symbol_index;
        let mut index = 0usize;
        while cursor != target {
            cursor = self.nodes[cursor].right_child.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero list traversal failed".into())
            })?;
            index = index.checked_add(1).ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero index overflowed".into())
            })?;
        }
        Ok(index)
    }

    pub(super) fn fgk_encode_data(&mut self, symbol_index: usize) -> Result<usize> {
        if symbol_index >= self.alphabet_size {
            return Err(RomWeaverError::Validation(format!(
                "xdelta fgk symbol index {symbol_index} exceeds alphabet size {}",
                self.alphabet_size
            )));
        }

        self.coded_depth = 0;
        let mut target = symbol_index;
        if self.nodes[target].weight == 0 {
            let where_zero = self.fgk_find_nth_zero(symbol_index)?;
            let bits_required = if self.zero_freq_rem == 0 {
                self.zero_freq_exp
            } else {
                self.zero_freq_exp + 1
            };
            let mut shift = 1usize;
            let mut bits_left = bits_required;
            while bits_left > 0 {
                if self.coded_depth >= self.coded_bits.len() {
                    return Err(RomWeaverError::Validation(
                        "xdelta fgk coded bit buffer overflowed".into(),
                    ));
                }
                self.coded_bits[self.coded_depth] = if (shift & where_zero) != 0 { 1 } else { 0 };
                self.coded_depth += 1;
                bits_left -= 1;
                shift <<= 1;
            }
            target = self.remaining_zeros.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero list is empty".into())
            })?;
        }

        while target != self.root_node {
            let parent = self.nodes[target].parent.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk node is missing a parent".into())
            })?;
            if self.coded_depth >= self.coded_bits.len() {
                return Err(RomWeaverError::Validation(
                    "xdelta fgk coded bit buffer overflowed".into(),
                ));
            }
            self.coded_bits[self.coded_depth] = if self.nodes[parent].right_child == Some(target) {
                1
            } else {
                0
            };
            self.coded_depth += 1;
            target = parent;
        }

        self.fgk_update_tree(symbol_index)?;
        Ok(self.coded_depth)
    }

    pub(super) fn fgk_get_encoded_bit(&mut self) -> Result<u8> {
        if self.coded_depth == 0 {
            return Err(RomWeaverError::Validation(
                "xdelta fgk encoded bit buffer was empty".into(),
            ));
        }
        self.coded_depth -= 1;
        Ok(self.coded_bits[self.coded_depth])
    }

    pub(super) fn fgk_nth_zero(&self, mut index: usize) -> Result<usize> {
        let mut cursor = self
            .remaining_zeros
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk zero list is empty".into()))?;
        while index != 0 {
            if let Some(next) = self.nodes[cursor].right_child {
                cursor = next;
            } else {
                break;
            }
            index -= 1;
        }
        Ok(cursor)
    }

    pub(super) fn fgk_decode_data(&mut self) -> Result<u8> {
        let mut symbol_index = self.decode_ptr;
        if self.nodes[self.decode_ptr].weight == 0 {
            let mut value = 0usize;
            if self.coded_depth > 0 {
                for &bit in self.coded_bits.iter().take(self.coded_depth - 1) {
                    value |= usize::from(bit);
                    value <<= 1;
                }
                value |= usize::from(self.coded_bits[self.coded_depth - 1]);
            }
            symbol_index = self.fgk_nth_zero(value)?;
        }

        self.coded_depth = 0;
        self.fgk_update_tree(symbol_index)?;
        self.decode_ptr = self.root_node;

        if symbol_index >= self.alphabet_size {
            return Err(RomWeaverError::Validation(format!(
                "xdelta fgk decoded symbol index {symbol_index} exceeds alphabet size {}",
                self.alphabet_size
            )));
        }
        u8::try_from(symbol_index).map_err(|_| {
            RomWeaverError::Validation("xdelta fgk decoded symbol index exceeded u8".into())
        })
    }

    pub(super) fn fgk_update_tree(&mut self, symbol_index: usize) -> Result<()> {
        let mut current = if self.nodes[symbol_index].weight == 0 {
            self.fgk_increase_zero_weight(symbol_index)?
        } else {
            symbol_index
        };

        while current != self.root_node {
            self.fgk_move_right(current)?;
            self.fgk_promote(current)?;
            self.nodes[current].weight = self.nodes[current]
                .weight
                .checked_add(1)
                .ok_or_else(|| RomWeaverError::Validation("xdelta fgk weight overflowed".into()))?;
            let parent = self.nodes[current].parent.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk node is missing a parent".into())
            })?;
            current = parent;
        }

        self.nodes[self.root_node].weight = self.nodes[self.root_node]
            .weight
            .checked_add(1)
            .ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk root weight overflowed".into())
            })?;
        Ok(())
    }

    pub(super) fn fgk_move_right(&mut self, move_fwd: usize) -> Result<()> {
        let block_index = self.nodes[move_fwd].my_block.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk node is missing a block".into())
        })?;
        let move_back = self.blocks[block_index].leader.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk block is missing a leader".into())
        })?;

        if move_fwd == move_back
            || self.nodes[move_fwd].parent == Some(move_back)
            || self.nodes[move_fwd].weight == 0
        {
            return Ok(());
        }

        let move_back_right = self.nodes[move_back].right.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk move-back node is missing right link".into())
        })?;
        self.nodes[move_back_right].left = Some(move_fwd);

        if let Some(left) = self.nodes[move_fwd].left {
            self.nodes[left].right = Some(move_back);
        }

        let tmp_right = self.nodes[move_fwd].right;
        self.nodes[move_fwd].right = self.nodes[move_back].right;
        if tmp_right == Some(move_back) {
            self.nodes[move_back].right = Some(move_fwd);
        } else {
            let tmp = tmp_right.ok_or_else(|| {
                RomWeaverError::Validation(
                    "xdelta fgk move-forward node is missing right link".into(),
                )
            })?;
            self.nodes[tmp].left = Some(move_back);
            self.nodes[move_back].right = Some(tmp);
        }

        let tmp_left = self.nodes[move_back].left;
        self.nodes[move_back].left = self.nodes[move_fwd].left;
        if tmp_left == Some(move_fwd) {
            self.nodes[move_fwd].left = Some(move_back);
        } else {
            let tmp = tmp_left.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk move-back node is missing left link".into())
            })?;
            self.nodes[tmp].right = Some(move_fwd);
            self.nodes[move_fwd].left = Some(tmp);
        }

        let move_fwd_parent = self.nodes[move_fwd].parent.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk move-forward parent missing".into())
        })?;
        let move_back_parent = self.nodes[move_back].parent.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk move-back parent missing".into())
        })?;

        let fwd_is_right = self.nodes[move_fwd_parent].right_child == Some(move_fwd);
        let back_is_right = self.nodes[move_back_parent].right_child == Some(move_back);

        self.nodes[move_fwd].parent = Some(move_back_parent);
        self.nodes[move_back].parent = Some(move_fwd_parent);

        if fwd_is_right {
            self.nodes[move_fwd_parent].right_child = Some(move_back);
        } else {
            self.nodes[move_fwd_parent].left_child = Some(move_back);
        }
        if back_is_right {
            self.nodes[move_back_parent].right_child = Some(move_fwd);
        } else {
            self.nodes[move_back_parent].left_child = Some(move_fwd);
        }

        self.blocks[block_index].leader = Some(move_fwd);
        Ok(())
    }

    pub(super) fn fgk_promote(&mut self, node: usize) -> Result<()> {
        if self.nodes[node].weight == 0 {
            return Ok(());
        }

        let my_right = self.nodes[node].right.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk promote missing right link".into())
        })?;
        let my_left = self.nodes[node].left;
        let current_block = self.nodes[node]
            .my_block
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk promote missing block".into()))?;

        if my_left == self.nodes[node].right_child
            && self.nodes[node].left_child.is_some()
            && self.nodes[self.nodes[node].left_child.unwrap()].weight == 0
        {
            if self.nodes[node].weight == self.nodes[my_right].weight.saturating_sub(1)
                && my_right != self.root_node
            {
                self.fgk_free_block(current_block);
                let right_block = self.nodes[my_right].my_block.ok_or_else(|| {
                    RomWeaverError::Validation("xdelta fgk right node missing block".into())
                })?;
                self.nodes[node].my_block = Some(right_block);
                let left_child = self.nodes[node].left_child.unwrap();
                self.nodes[left_child].my_block = Some(right_block);
            }
            return Ok(());
        }

        if my_left == self.remaining_zeros {
            return Ok(());
        }

        if let Some(left_index) = my_left {
            if self.nodes[left_index].my_block == Some(current_block) {
                self.blocks[current_block].leader = Some(left_index);
            } else {
                self.fgk_free_block(current_block);
            }
        } else {
            self.fgk_free_block(current_block);
        }

        if self.nodes[node].weight == self.nodes[my_right].weight.saturating_sub(1)
            && my_right != self.root_node
        {
            self.nodes[node].my_block = self.nodes[my_right].my_block;
        } else {
            let block = self.fgk_make_block(node)?;
            self.nodes[node].my_block = Some(block);
        }

        Ok(())
    }

    pub(super) fn fgk_increase_zero_weight(&mut self, symbol_index: usize) -> Result<usize> {
        let this_zero = symbol_index;
        if self.zero_freq_count == 1 {
            self.nodes[this_zero].right_child = None;
            let right = self.nodes[this_zero].right.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero node missing right link".into())
            })?;
            if self.nodes[right].weight == 1 {
                self.nodes[this_zero].my_block = self.nodes[right].my_block;
            } else {
                let block = self.fgk_make_block(this_zero)?;
                self.nodes[this_zero].my_block = Some(block);
            }
            self.remaining_zeros = None;
            return Ok(this_zero);
        }

        let zero_ptr = self
            .remaining_zeros
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk zero list is empty".into()))?;
        let new_internal = self.free_node;
        if new_internal >= self.nodes.len() {
            return Err(RomWeaverError::Validation(
                "xdelta fgk exhausted internal node capacity".into(),
            ));
        }
        self.free_node += 1;

        self.nodes[new_internal].parent = self.nodes[zero_ptr].parent;
        self.nodes[new_internal].right = self.nodes[zero_ptr].right;
        self.nodes[new_internal].weight = 0;
        self.nodes[new_internal].right_child = Some(this_zero);
        self.nodes[new_internal].left = Some(this_zero);

        if self.remaining_zeros == Some(self.root_node) {
            self.root_node = new_internal;
            let zero_block = self.fgk_make_block(this_zero)?;
            self.nodes[this_zero].my_block = Some(zero_block);
            let internal_block = self.fgk_make_block(new_internal)?;
            self.nodes[new_internal].my_block = Some(internal_block);
        } else {
            let right = self.nodes[new_internal].right.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk internal node missing right link".into())
            })?;
            self.nodes[right].left = Some(new_internal);

            let zero_parent = self.nodes[zero_ptr].parent.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero node missing parent".into())
            })?;
            if self.nodes[zero_parent].right_child == Some(zero_ptr) {
                self.nodes[zero_parent].right_child = Some(new_internal);
            } else {
                self.nodes[zero_parent].left_child = Some(new_internal);
            }

            if self.nodes[right].weight == 1 {
                self.nodes[new_internal].my_block = self.nodes[right].my_block;
            } else {
                let block = self.fgk_make_block(new_internal)?;
                self.nodes[new_internal].my_block = Some(block);
            }
            self.nodes[this_zero].my_block = self.nodes[new_internal].my_block;
        }

        self.fgk_eliminate_zero(this_zero)?;

        self.nodes[new_internal].left_child = self.remaining_zeros;
        self.nodes[this_zero].right = Some(new_internal);
        self.nodes[this_zero].left = self.remaining_zeros;
        self.nodes[this_zero].parent = Some(new_internal);
        self.nodes[this_zero].left_child = None;
        self.nodes[this_zero].right_child = None;

        let remaining = self.remaining_zeros.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk zero list became empty".into())
        })?;
        self.nodes[remaining].parent = Some(new_internal);
        self.nodes[remaining].right = Some(this_zero);

        Ok(this_zero)
    }

    pub(super) fn fgk_eliminate_zero(&mut self, node: usize) -> Result<()> {
        if self.zero_freq_count == 1 {
            return Ok(());
        }

        self.fgk_factor_remaining()?;

        if self.nodes[node].left_child.is_none() {
            let next = self
                .remaining_zeros
                .and_then(|index| self.nodes[index].right_child)
                .ok_or_else(|| {
                    RomWeaverError::Validation("xdelta fgk zero list is missing a successor".into())
                })?;
            self.remaining_zeros = Some(next);
            self.nodes[next].left_child = None;
            return Ok(());
        }

        if self.nodes[node].right_child.is_none() {
            let left = self.nodes[node].left_child.ok_or_else(|| {
                RomWeaverError::Validation("xdelta fgk zero node missing left child".into())
            })?;
            self.nodes[left].right_child = None;
            return Ok(());
        }

        let right = self.nodes[node].right_child.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk zero node missing right child".into())
        })?;
        let left = self.nodes[node].left_child.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk zero node missing left child".into())
        })?;
        self.nodes[right].left_child = Some(left);
        self.nodes[left].right_child = Some(right);
        Ok(())
    }

    pub(super) fn fgk_make_block(&mut self, leader: usize) -> Result<usize> {
        let block = self.free_block.ok_or_else(|| {
            RomWeaverError::Validation("xdelta fgk block allocator exhausted".into())
        })?;
        self.free_block = self.blocks[block].free_next;
        self.blocks[block].leader = Some(leader);
        self.blocks[block].free_next = None;
        Ok(block)
    }

    pub(super) fn fgk_free_block(&mut self, block: usize) {
        self.blocks[block].leader = None;
        self.blocks[block].free_next = self.free_block;
        self.free_block = Some(block);
    }

    pub(super) fn fgk_factor_remaining(&mut self) -> Result<()> {
        if self.zero_freq_count == 0 {
            return Err(RomWeaverError::Validation(
                "xdelta fgk zero-frequency count underflowed".into(),
            ));
        }
        self.zero_freq_count -= 1;
        let mut i = self.zero_freq_count;
        self.zero_freq_exp = 0;
        while i > 1 {
            self.zero_freq_exp += 1;
            i >>= 1;
        }
        let base = 1usize
            .checked_shl(u32::try_from(self.zero_freq_exp).unwrap_or(u32::MAX))
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk exponent overflowed".into()))?;
        self.zero_freq_rem = self
            .zero_freq_count
            .checked_sub(base)
            .ok_or_else(|| RomWeaverError::Validation("xdelta fgk remainder underflowed".into()))?;
        Ok(())
    }
}

pub(super) fn decode_fgk_secondary(input: &[u8], output_size: usize) -> Result<Vec<u8>> {
    let mut state = FgkState::new(DJW_ALPHABET_SIZE)?;
    let mut output = Vec::with_capacity(output_size);
    let mut input_pos = 0usize;

    while output.len() < output_size {
        if input_pos >= input.len() {
            return Err(RomWeaverError::Validation(
                "xdelta fgk secondary decoder reached end of input".into(),
            ));
        }
        let byte = input[input_pos];
        input_pos += 1;
        let mut mask = 1u16;
        while mask != 0x100 {
            let bit = if (u16::from(byte) & mask) != 0 { 1 } else { 0 };
            let done = state.fgk_decode_bit(bit)?;
            mask <<= 1;
            if !done {
                continue;
            }
            let symbol = state.fgk_decode_data()?;
            output.push(symbol);
            if output.len() == output_size {
                break;
            }
        }
    }
    if input_pos != input.len() {
        return Err(RomWeaverError::Validation(format!(
            "xdelta fgk secondary decoder finished with {} unused input byte(s)",
            input.len() - input_pos
        )));
    }

    Ok(output)
}

pub(super) fn try_decode_xdelta_djw_sections(
    data: &[u8],
    inst: &[u8],
    addr: &[u8],
    delta_indicator: u8,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let data = decode_xdelta_djw_section_if_flag(data, delta_indicator & DELTA_DATA_COMP != 0)?;
    let inst = decode_xdelta_djw_section_if_flag(inst, delta_indicator & DELTA_INST_COMP != 0)?;
    let addr = decode_xdelta_djw_section_if_flag(addr, delta_indicator & DELTA_ADDR_COMP != 0)?;
    Ok((data, inst, addr))
}

pub(super) fn decode_xdelta_djw_section_if_flag(
    section: &[u8],
    compressed: bool,
) -> Result<Vec<u8>> {
    if !compressed {
        return Ok(section.to_vec());
    }

    let (decoded_size, prefix_len) = decode_varint_raw(section)?;
    let payload = section.get(prefix_len..).ok_or_else(|| {
        RomWeaverError::Validation("xdelta djw section payload is missing".into())
    })?;
    let decoded = decode_djw_secondary(
        payload,
        usize::try_from(decoded_size).map_err(|_| {
            RomWeaverError::Validation("xdelta djw section decoded size is too large".into())
        })?,
    )?;
    Ok(decoded)
}

pub(super) fn try_decode_xdelta_fgk_sections(
    data: &[u8],
    inst: &[u8],
    addr: &[u8],
    delta_indicator: u8,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let data = decode_xdelta_fgk_section_if_flag(data, delta_indicator & DELTA_DATA_COMP != 0)?;
    let inst = decode_xdelta_fgk_section_if_flag(inst, delta_indicator & DELTA_INST_COMP != 0)?;
    let addr = decode_xdelta_fgk_section_if_flag(addr, delta_indicator & DELTA_ADDR_COMP != 0)?;
    Ok((data, inst, addr))
}

pub(super) fn decode_xdelta_fgk_section_if_flag(
    section: &[u8],
    compressed: bool,
) -> Result<Vec<u8>> {
    if !compressed {
        return Ok(section.to_vec());
    }

    let (decoded_size, prefix_len) = decode_varint_raw(section)?;
    let payload = section.get(prefix_len..).ok_or_else(|| {
        RomWeaverError::Validation("xdelta fgk section payload is missing".into())
    })?;
    let decoded = decode_fgk_secondary(
        payload,
        usize::try_from(decoded_size).map_err(|_| {
            RomWeaverError::Validation("xdelta fgk section decoded size is too large".into())
        })?,
    )?;
    Ok(decoded)
}
