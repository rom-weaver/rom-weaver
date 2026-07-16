//! Re-encode a cooked 2048-byte ISO9660 logical sector back into a raw
//! `MODE1/2352` physical sector - the exact inverse of the cooking that
//! [`crate::sector`] performs when reading.
//!
//! Rebuilding a Dreamcast GD-ROM data track byte-for-byte requires regenerating
//! the full CD-ROM physical framing of each sector: the 12-byte sync pattern,
//! the 3-byte BCD address, the mode byte, the 2048 user bytes, the 4-byte EDC
//! checksum, an 8-byte zero intermediate field, and the 276-byte Reed-Solomon
//! Product Code (ECC) P/Q parity.
//!
//! The EDC and ECC math here is the canonical ECMA-130 / CD-ROM algorithm as
//! popularized by Neill Corlett's ECM tool (`edc_partial_computeblock`,
//! `ecc_computeblock`, `ecc_writesector`) and libcdio. The Galois-field tables
//! are built once on first use.

use std::sync::OnceLock;

/// The size of a raw `MODE1/2352` physical sector, in bytes.
pub const RAW_SECTOR_SIZE: usize = 2352;

/// The size of one cooked logical sector (the user-data payload), in bytes.
pub const USER_DATA_SIZE: usize = 2048;

/// The CD-ROM physical-sector sync pattern: `00 FF*10 00`.
const SYNC_PATTERN: [u8; 12] = [
    0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00,
];

/// The LBA-to-address bias: physical address frame count = LBA + 150 (a
/// 2-second / 150-frame lead-in offset).
const ADDRESS_LBA_BIAS: u32 = 150;

/// Precomputed Galois-field and EDC lookup tables for the CD-ROM RS Product
/// Code. Built once via [`tables`].
struct EccTables {
    /// EDC CRC table (0x8001801B, reflected), 256 entries.
    edc_lut: [u32; 256],
    /// GF(2^8) "forward" log/multiply helper: `ecc_f_lut[i] = (i << 1) ^ (i & 0x80 ? 0x11D : 0)`.
    ecc_f_lut: [u8; 256],
    /// GF(2^8) "backward" helper used to fold the parity divisor.
    ecc_b_lut: [u8; 256],
}

/// Build the EDC/ECC lookup tables. This mirrors Neill Corlett's
/// `eccedc_init`.
fn build_tables() -> EccTables {
    let mut edc_lut = [0u32; 256];
    let mut ecc_f_lut = [0u8; 256];
    let mut ecc_b_lut = [0u8; 256];

    for i in 0u32..256 {
        // EDC table: reflected CRC with polynomial 0x8001801B.
        let mut edc = i;
        for _ in 0..8 {
            edc = (edc >> 1) ^ (if edc & 1 != 0 { 0xD801_8001 } else { 0 });
        }
        edc_lut[i as usize] = edc;

        // GF(2^8) multiply-by-x (with primitive polynomial 0x11D).
        let j = (i << 1) ^ (if i & 0x80 != 0 { 0x11D } else { 0 });
        let f = (j & 0xFF) as u8;
        ecc_f_lut[i as usize] = f;
        // Backward table: ecc_b_lut[i ^ f] = i.
        ecc_b_lut[(i ^ u32::from(f)) as usize] = i as u8;
    }

    EccTables {
        edc_lut,
        ecc_f_lut,
        ecc_b_lut,
    }
}

/// Access the lazily-initialized EDC/ECC tables.
fn tables() -> &'static EccTables {
    static TABLES: OnceLock<EccTables> = OnceLock::new();
    TABLES.get_or_init(build_tables)
}

/// Compute the CD-ROM EDC (reflected CRC-32 with polynomial 0x8001801B,
/// initial value 0, no final xor) over `data`.
fn edc_compute(tables: &EccTables, data: &[u8]) -> u32 {
    let mut edc = 0u32;
    for &b in data {
        edc = (edc >> 8) ^ tables.edc_lut[((edc ^ u32::from(b)) & 0xFF) as usize];
    }
    edc
}

/// Compute one set of P or Q ECC parity bytes into `out[..2]` for the
/// interleave described by `major_count`, `minor_count`, `major_mult`,
/// `minor_inc`. This is Neill Corlett's `ecc_computeblock` generalized over the
/// 2-byte parity output, walking `sector` (bytes 12..2076, the header through
/// the intermediate field) as the protected region.
///
/// `dest` is the parity output buffer (the ECC region of the sector); parity is
/// written at `dest[major * 2]` and `dest[major * 2 + 1]`.
fn ecc_compute(
    tables: &EccTables,
    sector: &[u8; RAW_SECTOR_SIZE],
    dest: &mut [u8],
    major_count: usize,
    minor_count: usize,
    major_mult: usize,
    minor_inc: usize,
) {
    let size = major_count * minor_count;
    for major in 0..major_count {
        let mut index = (major >> 1) * major_mult + (major & 1);
        let mut ecc_a = 0u8;
        let mut ecc_b = 0u8;
        for _ in 0..minor_count {
            // Bytes 12.. of the sector are the protected region; the parity
            // walks that region (offset by 12 from the start of `sector`).
            let temp = sector[12 + index];
            index += minor_inc;
            if index >= size {
                index -= size;
            }
            ecc_a ^= temp;
            ecc_b ^= temp;
            ecc_a = tables.ecc_f_lut[ecc_a as usize];
        }
        ecc_a = tables.ecc_b_lut[(tables.ecc_f_lut[ecc_a as usize] ^ ecc_b) as usize];
        dest[major] = ecc_a;
        dest[major + major_count] = ecc_a ^ ecc_b;
    }
}

/// Write the P and Q parity (the 276-byte ECC region, bytes 2076..2352) for a
/// MODE1 sector whose bytes 12..2076 are already populated (header, user data,
/// EDC, zero intermediate field).
fn ecc_write(tables: &EccTables, sector: &mut [u8; RAW_SECTOR_SIZE]) {
    // P parity: 86 majors × 24 minors, 172 bytes at offset 2076.
    let mut p = [0u8; 172];
    ecc_compute(tables, sector, &mut p, 86, 24, 2, 86);
    sector[2076..2076 + 172].copy_from_slice(&p);

    // Q parity: 52 majors × 43 minors, 104 bytes at offset 2248. Q reads the
    // protected region including the P parity just written, so recompute over
    // the updated sector.
    let mut q = [0u8; 104];
    ecc_compute(tables, sector, &mut q, 52, 43, 86, 88);
    sector[2248..2248 + 104].copy_from_slice(&q);
}

/// Encode a byte as packed BCD: `((v / 10) << 4) | (v % 10)`.
fn to_bcd(v: u8) -> u8 {
    ((v / 10) << 4) | (v % 10)
}

/// Compute the 3-byte BCD MIN/SEC/FRAME address for an absolute `lba`.
///
/// The MSF minute field is a single packed-BCD byte and so can only hold two
/// decimal digits. A full-size GD-ROM high-density track runs past 99 minutes
/// of address (~LBA 445350), so the minute wraps modulo 100 to stay valid BCD -
/// the standard MSF/CD-subcode behavior for a value that overflows its field.
/// The EDC/ECC are computed over the encoded bytes afterwards, so they remain
/// self-consistent regardless of how the minute is represented.
fn address_bcd(lba: u32) -> [u8; 3] {
    let total_frames = lba.wrapping_add(ADDRESS_LBA_BIAS);
    let minute = total_frames / (75 * 60);
    let second = (total_frames / 75) % 60;
    let frame = total_frames % 75;
    [
        to_bcd((minute % 100) as u8),
        to_bcd(second as u8),
        to_bcd(frame as u8),
    ]
}

/// Encode a 2048-byte cooked sector into a 2352-byte raw `MODE1` physical
/// sector for the given absolute `lba`.
///
/// The output is byte-identical to the original physical sector of a real
/// CD/GD-ROM data track: sync pattern, BCD address, mode byte, user data, EDC
/// checksum, zero intermediate field, and the full P/Q Reed-Solomon ECC.
pub fn encode_mode1_sector(lba: u32, user_data: &[u8; USER_DATA_SIZE]) -> [u8; RAW_SECTOR_SIZE] {
    let tables = tables();
    let mut sector = [0u8; RAW_SECTOR_SIZE];

    // bytes 0..12: sync pattern.
    sector[0..12].copy_from_slice(&SYNC_PATTERN);

    // bytes 12..15: BCD address; byte 15: mode = 0x01.
    let addr = address_bcd(lba);
    sector[12..15].copy_from_slice(&addr);
    sector[15] = 0x01;

    // bytes 16..2064: the 2048 user-data bytes.
    sector[16..16 + USER_DATA_SIZE].copy_from_slice(user_data);

    // bytes 2064..2068: EDC (little-endian) over bytes 0..2064.
    let edc = edc_compute(tables, &sector[0..2064]);
    sector[2064..2068].copy_from_slice(&edc.to_le_bytes());

    // bytes 2068..2076: 8-byte zero intermediate field (already zero).

    // bytes 2076..2352: P then Q Reed-Solomon parity.
    ecc_write(tables, &mut sector);

    sector
}

#[cfg(test)]
mod private_tests {
    use super::*;

    #[test]
    fn bcd_encoding() {
        assert_eq!(to_bcd(0), 0x00);
        assert_eq!(to_bcd(9), 0x09);
        assert_eq!(to_bcd(10), 0x10);
        assert_eq!(to_bcd(59), 0x59);
        assert_eq!(to_bcd(74), 0x74);
    }

    #[test]
    fn address_for_lba_zero() {
        // LBA 0 -> frame 150 -> 00:02:00.
        assert_eq!(address_bcd(0), [0x00, 0x02, 0x00]);
    }

    #[test]
    fn address_for_lba_45000() {
        // 45000 + 150 = 45150 frames. 45150 / 4500 = 10 min; rem 150.
        // 150 / 75 = 2 sec; frame 0.
        assert_eq!(address_bcd(45000), [0x10, 0x02, 0x00]);
    }
}
