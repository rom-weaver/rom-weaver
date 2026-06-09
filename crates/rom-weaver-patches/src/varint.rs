//! Shared little-endian "number" varint codec used by the BPS and UPS patch formats.
//!
//! Both formats encode unsigned integers with the same 7-bit-per-byte scheme from the
//! beat/byuu specification: the low 7 bits of each byte carry data, the high bit marks the
//! final byte, and every continuation implicitly adds one to keep the encoding canonical.
//! The read/write loops were duplicated verbatim across `bps.rs` and `ups.rs` (slice parser,
//! streaming file parser, and create-side writer); they live here once and take a `label` so
//! each format keeps its own error-message prefix.

use rom_weaver_core::{Result, RomWeaverError};

/// Maximum number of bytes a `u64` can occupy in this encoding (ceil(64 / 7) = 10).
pub(crate) const VARINT_MAX_LEN: usize = 10;

/// Encode `data` into `buffer`, returning the number of bytes written (always <= [`VARINT_MAX_LEN`]).
///
/// Used by the create-side writers that want a stack buffer instead of heap allocation per number.
pub(crate) fn encode_varint(buffer: &mut [u8; VARINT_MAX_LEN], mut data: u64) -> usize {
    let mut len = 0usize;
    loop {
        let value = (data & 0x7f) as u8;
        data >>= 7;
        if data == 0 {
            buffer[len] = 0x80 | value;
            len += 1;
            return len;
        }
        buffer[len] = value;
        len += 1;
        data -= 1;
    }
}

/// Append the varint encoding of `data` to `bytes`.
pub(crate) fn push_varint(bytes: &mut Vec<u8>, data: u64) {
    let mut buffer = [0u8; VARINT_MAX_LEN];
    let len = encode_varint(&mut buffer, data);
    bytes.extend_from_slice(&buffer[..len]);
}

/// Decode a varint by pulling one byte at a time from `read_byte`.
///
/// `label` is the format name (e.g. `"BPS"`, `"UPS"`) and is woven into the overflow error
/// messages so callers keep their existing, format-specific diagnostics.
pub(crate) fn read_varint(mut read_byte: impl FnMut() -> Result<u8>, label: &str) -> Result<u64> {
    let mut data = 0u64;
    let mut shift = 1u64;
    loop {
        let byte = u64::from(read_byte()?);
        data = data.checked_add((byte & 0x7f) * shift).ok_or_else(|| {
            RomWeaverError::Validation(format!("{label} varint overflowed available range"))
        })?;
        if byte & 0x80 != 0 {
            return Ok(data);
        }
        shift = shift.checked_shl(7).ok_or_else(|| {
            RomWeaverError::Validation(format!("{label} varint shift overflowed"))
        })?;
        data = data.checked_add(shift).ok_or_else(|| {
            RomWeaverError::Validation(format!("{label} varint overflowed available range"))
        })?;
    }
}
