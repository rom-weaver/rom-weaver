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
    // A canonical `u64` encoding never exceeds `VARINT_MAX_LEN` bytes; bounding the
    // iteration count keeps a malformed all-continuation stream from looping forever.
    for _ in 0..VARINT_MAX_LEN {
        let byte = u64::from(read_byte()?);
        // `checked_mul` folds the data-byte contribution into the overflow check; the
        // old unchecked `(byte & 0x7f) * shift` could wrap before any guard ran.
        let addend = (byte & 0x7f).checked_mul(shift).ok_or_else(|| {
            RomWeaverError::Validation(format!("{label} varint overflowed available range"))
        })?;
        data = data.checked_add(addend).ok_or_else(|| {
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
    Err(RomWeaverError::Validation(format!(
        "{label} varint exceeded maximum length"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reader(bytes: Vec<u8>) -> impl FnMut() -> Result<u8> {
        let mut iter = bytes.into_iter();
        move || {
            iter.next()
                .ok_or_else(|| RomWeaverError::Validation("TEST varint ran out of input".into()))
        }
    }

    #[test]
    fn round_trips_u64_max() {
        let mut buffer = [0u8; VARINT_MAX_LEN];
        let len = encode_varint(&mut buffer, u64::MAX);
        let decoded = read_varint(reader(buffer[..len].to_vec()), "TEST").expect("decode");
        assert_eq!(decoded, u64::MAX);
    }

    #[test]
    fn rejects_unterminated_stream_without_overflow_panic() {
        // 0x00 bytes never set the terminator bit; a malformed over-long run must
        // return a validation error rather than wrapping or looping forever.
        let bytes = vec![0u8; VARINT_MAX_LEN + 8];
        let error = read_varint(reader(bytes), "TEST").expect_err("must reject");
        assert!(matches!(error, RomWeaverError::Validation(_)));
    }
}
