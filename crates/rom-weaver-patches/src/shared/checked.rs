//! Checked-arithmetic and bounds-checked little-endian slice readers shared by
//! the patch format handlers. Message text is part of the user-visible error
//! contract, so formats whose wording differs keep their own helpers.

use rom_weaver_core::{Result, RomWeaverError};

/// `lhs + rhs`, failing with `"{label} overflowed"`.
pub(crate) fn checked_add(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
}

/// `lhs + rhs` over `usize`, failing with `"{label} overflowed"`.
pub(crate) fn checked_add_usize(lhs: usize, rhs: usize, label: &str) -> Result<usize> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
}

/// Borrow `N` bytes of `bytes` at `offset`, failing with `"u{bits} read overflowed"` or
/// `"u{bits} read exceeded patch bounds"`.
fn read_array_at<const N: usize>(bytes: &[u8], offset: usize) -> Result<[u8; N]> {
    let bits = N * 8;
    let end = offset
        .checked_add(N)
        .ok_or_else(|| RomWeaverError::Validation(format!("u{bits} read overflowed")))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| RomWeaverError::Validation(format!("u{bits} read exceeded patch bounds")))?;
    let mut buf = [0u8; N];
    buf.copy_from_slice(slice);
    Ok(buf)
}

#[cfg(test)]
pub(crate) fn read_u16_le(bytes: &[u8], offset: usize) -> Result<u16> {
    read_array_at::<2>(bytes, offset).map(u16::from_le_bytes)
}

pub(crate) fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32> {
    read_array_at::<4>(bytes, offset).map(u32::from_le_bytes)
}
