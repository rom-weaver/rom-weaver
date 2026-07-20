//! Unit tests for raw `MODE1/2352` sector re-encoding.
//!
//! The committed tests are self-contained: they encode synthetic user data and
//! verify the sector's structural fields (sync pattern, BCD address, mode byte,
//! user data, and a recomputed EDC) without depending on any external file. A
//! separate `#[ignore]`d test reproduces a real Dreamcast GD-ROM data track
//! sector-for-sector for anyone who has the disc image locally.

use super::mode1::{RAW_SECTOR_SIZE, USER_DATA_SIZE, encode_mode1_sector};

/// The sync pattern that must lead every raw physical sector.
const SYNC_PATTERN: [u8; 12] = [
    0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00,
];

/// Recompute the CD-ROM EDC over `data` independently of the implementation, to
/// cross-check the embedded checksum.
fn reference_edc(data: &[u8]) -> u32 {
    let mut edc = 0u32;
    for &b in data {
        let mut acc = (edc ^ u32::from(b)) & 0xFF;
        for _ in 0..8 {
            acc = (acc >> 1) ^ (if acc & 1 != 0 { 0xD801_8001 } else { 0 });
        }
        edc = (edc >> 8) ^ acc;
    }
    edc
}

/// Decode a packed-BCD byte back to its decimal value.
fn from_bcd(b: u8) -> u32 {
    u32::from(b >> 4) * 10 + u32::from(b & 0x0F)
}

#[test]
fn structure_and_fields_are_correct() {
    let mut user = [0u8; USER_DATA_SIZE];
    for (i, byte) in user.iter_mut().enumerate() {
        *byte = (i as u8).wrapping_mul(31).wrapping_add(7);
    }

    let lba = 45000u32;
    let sector = encode_mode1_sector(lba, &user);
    assert_eq!(sector.len(), RAW_SECTOR_SIZE);

    // Sync pattern.
    assert_eq!(&sector[0..12], &SYNC_PATTERN);

    // BCD address: frames = lba + 150.
    let total_frames =
        from_bcd(sector[12]) * (75 * 60) + from_bcd(sector[13]) * 75 + from_bcd(sector[14]);
    assert_eq!(total_frames, lba + 150);

    // Mode byte.
    assert_eq!(sector[15], 0x01);

    // User data echoed verbatim.
    assert_eq!(&sector[16..2064], &user[..]);

    // EDC over bytes 0..2064, stored little-endian at 2064..2068.
    let edc = reference_edc(&sector[0..2064]);
    assert_eq!(&sector[2064..2068], &edc.to_le_bytes());

    // Intermediate field is zero.
    assert_eq!(&sector[2068..2076], &[0u8; 8]);

    // ECC region is fully populated (non-trivial for this data).
    assert!(sector[2076..2352].iter().any(|&b| b != 0));
}

#[test]
fn address_advances_with_lba() {
    let user = [0u8; USER_DATA_SIZE];
    let a = encode_mode1_sector(45000, &user);
    let b = encode_mode1_sector(45001, &user);
    // Same user data + sync/mode, but the address (and thus EDC/ECC) differ.
    assert_ne!(&a[12..15], &b[12..15]);
    assert_ne!(&a[2064..2068], &b[2064..2068]);
}

#[test]
fn high_lba_minute_field_stays_valid_bcd() {
    // A full-size GD-ROM high-density track runs past 99 minutes of MSF address
    // (~LBA 445350). The single-byte minute field wraps modulo 100 to stay
    // valid packed BCD; verify no nibble escapes 0..=9 and the EDC stays
    // self-consistent over the encoded address.
    let user = [0u8; USER_DATA_SIZE];
    let lba = 549_000u32; // ~122 minutes -> minute wraps to 22
    let sector = encode_mode1_sector(lba, &user);

    for &b in &sector[12..15] {
        assert!(b >> 4 <= 9, "high BCD nibble out of range: {b:#04x}");
        assert!(b & 0x0F <= 9, "low BCD nibble out of range: {b:#04x}");
    }
    // Minute wraps modulo 100: 122 -> 22 -> packed BCD 0x22.
    assert_eq!(sector[12], 0x22);

    // EDC over bytes 0..2064 (which include the address) stays self-consistent.
    let edc = reference_edc(&sector[0..2064]);
    assert_eq!(&sector[2064..2068], &edc.to_le_bytes());
}

#[test]
fn zero_data_is_deterministic() {
    let user = [0u8; USER_DATA_SIZE];
    let a = encode_mode1_sector(150, &user);
    let b = encode_mode1_sector(150, &user);
    assert_eq!(a, b);
}

/// Reproduce a real Dreamcast GD-ROM data track byte-for-byte.
///
/// Ignored by default because it needs a local disc image. Track 3 of
/// "Space Channel 5 Part 2 (Japan)" is a `MODE1/2352` data track whose first
/// sector is absolute LBA 45000. For each physical sector we strip the user
/// data (bytes 16..2064), re-encode it, and require the result to match the
/// original sector exactly - sync, address, mode, EDC, and all 276 ECC bytes.
#[test]
#[ignore = "requires local Space Channel 5 Part 2 (Japan) Track 3.bin"]
fn matches_real_track_byte_for_byte() {
    use std::io::{Read, Seek, SeekFrom};

    const TRACK_PATH: &str = "/Users/bcasey/Downloads/weaver/Space Channel 5 Part 2 (Japan)/Space Channel 5 Part 2 (Japan) (Track 3).bin";
    const TRACK_START_LBA: u32 = 45000;

    let mut file = std::fs::File::open(TRACK_PATH).expect("open real track");
    let len = file.seek(SeekFrom::End(0)).expect("track length");
    let total_sectors = (len / RAW_SECTOR_SIZE as u64) as u32;
    assert!(total_sectors > 0, "track has no sectors");

    // Test the first 2000 sectors plus a window near the end.
    let mut indices: Vec<u32> = (0..2000.min(total_sectors)).collect();
    let tail_start = total_sectors.saturating_sub(3000);
    indices.extend(tail_start..total_sectors);
    indices.dedup();

    let mut raw = [0u8; RAW_SECTOR_SIZE];
    let mut matched = 0u64;
    for &i in &indices {
        file.seek(SeekFrom::Start(u64::from(i) * RAW_SECTOR_SIZE as u64))
            .expect("seek sector");
        file.read_exact(&mut raw).expect("read sector");

        // Skip any non-MODE1 sector (defensive; the data track is all MODE1).
        if raw[..12] != SYNC_PATTERN || raw[15] != 0x01 {
            continue;
        }

        let mut user = [0u8; USER_DATA_SIZE];
        user.copy_from_slice(&raw[16..2064]);

        let encoded = encode_mode1_sector(TRACK_START_LBA + i, &user);
        assert_eq!(
            encoded,
            raw,
            "sector {i} (lba {}) mismatch",
            TRACK_START_LBA + i
        );
        matched += 1;
    }

    println!("re-encoded {matched} real MODE1 sectors byte-for-byte");
    assert!(matched >= 2000, "expected to validate many sectors");
}
