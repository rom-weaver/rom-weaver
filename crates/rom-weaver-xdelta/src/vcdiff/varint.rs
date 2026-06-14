//! Shared base-128 (VCDIFF) varint codec.
//!
//! The VCDIFF/xdelta byte stream encodes integers as big-endian base-128
//! groups with the high bit marking continuation. The decode (overflow-checked
//! `*128 + (b & 0x7F)`, capped at 10 bytes) and encode (`% 128` / `/= 128` digit
//! stack emitted MSB-first with the continuation bit) loops were duplicated
//! across the `Read`/slice readers and the `Write`/`Vec` writers. They are
//! unified here behind byte-source/byte-sink closures so the four call sites
//! stay thin adapters while emitting and accepting identical bytes.

use rom_weaver_core::{Result, RomWeaverError};

/// Maximum number of base-128 groups in a 64-bit varint.
const MAX_GROUPS: usize = 10;

/// Decodes a base-128 varint by pulling one byte at a time from `next`.
///
/// `next` returns `None` once no more bytes are available; that is reported as
/// the "exceeds the supported length" error, identical to running off the end
/// of the encoded stream. Callers that track how many bytes were consumed do so
/// by counting their own `next` invocations.
pub(super) fn decode_base128(mut next: impl FnMut() -> Option<u8>) -> Result<u64> {
    let mut value = 0u64;
    for _ in 0..MAX_GROUPS {
        let Some(byte) = next() else {
            return Err(RomWeaverError::Validation(
                "base-128 integer exceeds the supported length".into(),
            ));
        };
        value = value
            .checked_mul(128)
            .and_then(|current| current.checked_add(u64::from(byte & 0x7F)))
            .ok_or_else(|| RomWeaverError::Validation("base-128 integer overflowed u64".into()))?;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(RomWeaverError::Validation(
        "base-128 integer exceeds the supported length".into(),
    ))
}

/// Encodes `value` as a base-128 varint, emitting each byte to `push` in
/// stream order (most-significant group first, continuation bit set on every
/// group but the last).
pub(super) fn encode_base128(mut value: u64, mut push: impl FnMut(u8)) {
    if value == 0 {
        push(0);
        return;
    }

    let mut groups = [0u8; MAX_GROUPS];
    let mut len = 0usize;
    while value > 0 {
        groups[len] = (value % 128) as u8;
        len += 1;
        value /= 128;
    }

    for index in (0..len).rev() {
        let is_last = index == 0;
        push(if is_last {
            groups[index]
        } else {
            groups[index] | 0x80
        });
    }
}
