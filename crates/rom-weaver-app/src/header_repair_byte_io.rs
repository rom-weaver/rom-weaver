//! Generic byte-level file helpers shared by the header-repair routines.
//!
//! These are intentionally free of any `CliApp`/ROM-format knowledge: they read
//! and write fixed ranges of an already-open [`File`], accumulate byte/word
//! checksums over a range, and shift a file's contents to drop a leading
//! prefix. Keeping them as free functions makes the per-system repair logic in
//! `header_repair_systems`/`header_repair_n64` a thin layer of domain rules over
//! a small, separately-testable I/O vocabulary.

use super::*;

/// Seek to `offset` and fill `output` exactly, erroring on short reads.
pub(crate) fn read_exact_at(file: &mut File, offset: u64, output: &mut [u8]) -> Result<()> {
    trace!(
        offset,
        len = output.len(),
        "header-repair byte_io read_exact_at"
    );
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(output)?;
    Ok(())
}

/// Seek to `offset` and write all of `bytes`.
pub(crate) fn write_all_at(file: &mut File, offset: u64, bytes: &[u8]) -> Result<()> {
    trace!(
        offset,
        len = bytes.len(),
        "header-repair byte_io write_all_at"
    );
    file.seek(SeekFrom::Start(offset))?;
    file.write_all(bytes)?;
    Ok(())
}

/// Read `len` bytes starting at `offset` into a freshly allocated vector.
pub(crate) fn read_vec_at(file: &mut File, offset: u64, len: usize) -> Result<Vec<u8>> {
    let mut output = vec![0u8; len];
    read_exact_at(file, offset, output.as_mut_slice())?;
    Ok(output)
}

/// Sum every byte in `[start, end)` as a wrapping `u32`, skipping any byte whose
/// absolute offset falls inside one of `zeroed_ranges` (treated as zero).
pub(crate) fn sum_range_with_zeroed(
    file: &mut File,
    start: usize,
    end: usize,
    zeroed_ranges: &[(usize, usize)],
) -> Result<u32> {
    if end <= start {
        return Ok(0);
    }

    let mut sum = 0_u32;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut cursor = start as u64;
    let end_u64 = end as u64;

    while cursor < end_u64 {
        let chunk_len = ((end_u64 - cursor) as usize).min(buffer.len());
        read_exact_at(file, cursor, &mut buffer[..chunk_len])?;
        for (index, value) in buffer[..chunk_len].iter().enumerate() {
            let absolute = cursor + index as u64;
            if zeroed_ranges.iter().any(|(range_start, range_end)| {
                absolute >= *range_start as u64 && absolute < *range_end as u64
            }) {
                continue;
            }
            sum = sum.wrapping_add(u32::from(*value));
        }
        cursor = cursor.saturating_add(chunk_len as u64);
    }

    Ok(sum)
}

/// Sum big-endian 16-bit words across `[start, end)` as a wrapping `u32`. A
/// trailing odd byte is treated as the high byte of a final word.
pub(crate) fn sum_sega_words(file: &mut File, start: usize, end: usize) -> Result<u32> {
    if end <= start {
        return Ok(0);
    }

    let mut sum = 0_u32;
    let mut pending_high = None::<u8>;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut cursor = start as u64;
    let end_u64 = end as u64;

    while cursor < end_u64 {
        let chunk_len = ((end_u64 - cursor) as usize).min(buffer.len());
        read_exact_at(file, cursor, &mut buffer[..chunk_len])?;
        for value in &buffer[..chunk_len] {
            if let Some(high) = pending_high.take() {
                let word = u16::from_be_bytes([high, *value]);
                sum = sum.wrapping_add(u32::from(word));
            } else {
                pending_high = Some(*value);
            }
        }
        cursor = cursor.saturating_add(chunk_len as u64);
    }

    if let Some(high) = pending_high {
        sum = sum.wrapping_add(u32::from(high) << 8);
    }

    Ok(sum)
}

/// Drop the leading `prefix` bytes of `file` in place, shifting the remaining
/// bytes down and truncating. Returns the new length.
pub(crate) fn remove_prefix_in_place(
    file: &mut File,
    prefix: usize,
    file_len: usize,
) -> Result<usize> {
    trace!(
        prefix,
        file_len, "header-repair byte_io remove_prefix_in_place"
    );
    if prefix == 0 {
        return Ok(file_len);
    }
    if file_len <= prefix {
        file.set_len(0)?;
        return Ok(0);
    }

    let mut buffer = vec![0u8; 64 * 1024];
    let mut read_pos = prefix as u64;
    let mut write_pos = 0u64;
    let file_len_u64 = file_len as u64;

    while read_pos < file_len_u64 {
        let chunk_len = ((file_len_u64 - read_pos) as usize).min(buffer.len());
        read_exact_at(file, read_pos, &mut buffer[..chunk_len])?;
        write_all_at(file, write_pos, &buffer[..chunk_len])?;
        read_pos = read_pos.saturating_add(chunk_len as u64);
        write_pos = write_pos.saturating_add(chunk_len as u64);
    }

    file.set_len(write_pos)?;
    Ok(write_pos as usize)
}
