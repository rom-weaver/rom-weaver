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

/// Copy `N` bytes of `bytes` at `offset`, failing with `"u{bits} read overflowed"` or
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

#[cfg(test)]
mod tests {
    use super::*;

    fn message(err: RomWeaverError) -> String {
        err.to_string()
    }

    #[test]
    fn reads_little_endian_values_at_an_offset() {
        let bytes = [0xff, 0x78, 0x56, 0x34, 0x12, 0x01];
        assert_eq!(read_u32_le(&bytes, 1).unwrap(), 0x1234_5678);
        assert_eq!(read_u16_le(&bytes, 4).unwrap(), 0x0112);
    }

    #[test]
    fn reads_report_bounds_and_offset_overflow() {
        let bytes = [0u8; 4];
        assert!(
            message(read_u32_le(&bytes, 1).unwrap_err()).contains("u32 read exceeded patch bounds")
        );
        assert!(
            message(read_u16_le(&bytes, 3).unwrap_err()).contains("u16 read exceeded patch bounds")
        );
        assert!(
            message(read_u32_le(&bytes, usize::MAX).unwrap_err()).contains("u32 read overflowed")
        );
        assert!(
            message(read_u16_le(&bytes, usize::MAX).unwrap_err()).contains("u16 read overflowed")
        );
        assert_eq!(read_u32_le(&bytes, 0).unwrap(), 0);
    }

    #[test]
    fn checked_adds_report_overflow_with_label() {
        assert_eq!(checked_add(1, 2, "x").unwrap(), 3);
        assert_eq!(checked_add_usize(1, 2, "x").unwrap(), 3);
        assert!(message(checked_add(u64::MAX, 1, "sum").unwrap_err()).contains("sum overflowed"));
        assert!(
            message(checked_add_usize(usize::MAX, 1, "sum").unwrap_err())
                .contains("sum overflowed")
        );
    }
}
