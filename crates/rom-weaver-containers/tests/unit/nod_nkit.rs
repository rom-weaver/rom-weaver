//! Coverage for `src/nod/io/nkit.rs`: NKit v1/v2 header parsing and writing,
//! the junk-data bitmap, and the `DiscStream` read adapter.

use crate::nod::read::DiscMeta;

use super::*;

fn v2_header(header: &NKitHeader) -> Vec<u8> {
    let mut out = Vec::new();
    header.write_to(&mut out).expect("v2 header writes");
    out
}

fn full_header(version: u8, junk_bits: Option<JunkBits>) -> NKitHeader {
    NKitHeader {
        version,
        size: Some(0x1234_5678),
        crc32: Some(0xDEAD_BEEF),
        md5: Some([0x11; 16]),
        sha1: Some([0x22; 20]),
        xxh64: Some(0x0102_0304_0506_0708),
        junk_bits,
        encrypted: true,
    }
}

// --- Defaults and flags ---------------------------------------------------

#[test]
fn default_header_is_an_empty_version_two_header() {
    let header = NKitHeader::default();
    assert_eq!(header.version, 2);
    assert!(header.size.is_none());
    assert!(header.crc32.is_none());
    assert!(header.md5.is_none());
    assert!(header.sha1.is_none());
    assert!(header.xxh64.is_none());
    assert!(header.junk_bits.is_none());
    assert!(!header.encrypted);
    assert_eq!(header.calc_flags(), 0);
}

#[test]
fn calc_flags_sets_one_bit_per_populated_field() {
    let header = full_header(2, None);
    // Size | Crc32 | Md5 | Sha1 | Xxhash64 | Encrypted
    assert_eq!(header.calc_flags(), 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x40);
}

#[test]
fn calc_header_size_accounts_for_every_optional_field() {
    // Version 1 has no header-size/flags word of its own.
    assert_eq!(
        calc_header_size(1, NKIT_HEADER_V1_FLAGS, 0),
        8 + 4 + 16 + 20 + 8
    );
    // Version 2 adds the 2-byte size plus the 2-byte flags.
    assert_eq!(calc_header_size(2, 0, 0), 12);
    // The key flag adds the key itself plus its 2-byte length.
    assert_eq!(calc_header_size(2, 0x20, 16), 12 + 18);
}

// --- Round trips ----------------------------------------------------------

#[test]
fn version_two_header_round_trips_every_field() {
    let header = full_header(2, None);
    let bytes = v2_header(&header);
    assert_eq!(&bytes[..8], b"NKIT  v2");

    let parsed =
        NKitHeader::read_from(&mut bytes.as_slice(), 0x8000, false).expect("v2 header parses back");
    assert_eq!(parsed.version, 2);
    assert_eq!(parsed.size, header.size);
    assert_eq!(parsed.crc32, header.crc32);
    assert_eq!(parsed.md5, header.md5);
    assert_eq!(parsed.sha1, header.sha1);
    assert_eq!(parsed.xxh64, header.xxh64);
    assert!(parsed.encrypted);
    assert!(parsed.junk_bits.is_none());
}

#[test]
fn version_two_header_round_trips_the_junk_bitmap() {
    let block_size = 0x20_0000;
    let mut junk_bits = JunkBits::new(block_size);
    junk_bits.set(1, true);
    junk_bits.set(9, true);

    let header = NKitHeader {
        junk_bits: Some(junk_bits),
        ..full_header(2, None)
    };
    let bytes = v2_header(&header);

    let parsed = NKitHeader::read_from(&mut bytes.as_slice(), block_size, true)
        .expect("v2 header with junk bits parses");
    assert_eq!(parsed.is_junk_block(0), Some(false));
    assert_eq!(parsed.is_junk_block(1), Some(true));
    assert_eq!(parsed.is_junk_block(9), Some(true));
    assert_eq!(parsed.is_junk_block(10), Some(false));
}

#[test]
fn version_one_header_round_trips_its_fixed_field_set() {
    // Version 1 has no flags word, so its field set is fixed and `size` is
    // not part of it.
    let header = NKitHeader {
        size: None,
        encrypted: false,
        ..full_header(1, None)
    };
    let mut bytes = Vec::new();
    header.write_to(&mut bytes).expect("v1 header writes");
    assert_eq!(&bytes[..8], b"NKIT  v1");
    assert_eq!(bytes.len(), calc_header_size(1, NKIT_HEADER_V1_FLAGS, 0));

    let parsed =
        NKitHeader::read_from(&mut bytes.as_slice(), 0x8000, false).expect("v1 header parses back");
    assert_eq!(parsed.version, 1);
    assert_eq!(parsed.crc32, header.crc32);
    assert_eq!(parsed.md5, header.md5);
    assert_eq!(parsed.sha1, header.sha1);
    assert_eq!(parsed.xxh64, header.xxh64);
    assert!(parsed.size.is_none(), "v1 does not carry a disc size");
    assert!(!parsed.encrypted, "v1 has no encrypted flag");
}

// --- Parse errors ---------------------------------------------------------

#[test]
fn read_from_rejects_a_bad_version_string() {
    for bad in [
        b"XXXX  v2".as_slice(),
        b"NKIT  v0".as_slice(),
        b"NKIT  vA".as_slice(),
    ] {
        let mut padded = bad.to_vec();
        padded.extend_from_slice(&[0u8; 64]);
        let error = NKitHeader::read_from(&mut padded.as_slice(), 0x8000, false)
            .expect_err("version string is invalid");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(
            error
                .to_string()
                .contains("Invalid NKit header version string"),
            "unexpected message: {error}"
        );
    }
}

#[test]
fn read_from_rejects_an_unsupported_version_number() {
    let mut bytes = b"NKIT  v3".to_vec();
    bytes.extend_from_slice(&[0u8; 64]);
    let error = NKitHeader::read_from(&mut bytes.as_slice(), 0x8000, false)
        .expect_err("version 3 is unsupported");
    assert!(
        error
            .to_string()
            .contains("Unsupported NKit header version: 3"),
        "unexpected message: {error}"
    );
}

// --- write_to errors ------------------------------------------------------

#[test]
fn write_to_rejects_an_unsupported_version_number() {
    let header = NKitHeader {
        version: 3,
        ..full_header(3, None)
    };
    let mut out = Vec::new();
    let error = header
        .write_to(&mut out)
        .expect_err("version 3 cannot be written");
    assert!(
        error
            .to_string()
            .contains("Unsupported NKit header version: 3"),
        "unexpected message: {error}"
    );
}

#[test]
fn write_to_requires_every_digest_for_a_version_one_header() {
    let cases: [(NKitHeader, &str); 4] = [
        (
            NKitHeader {
                crc32: None,
                size: None,
                ..full_header(1, None)
            },
            "Missing CRC32 in NKit v1 header",
        ),
        (
            NKitHeader {
                md5: None,
                size: None,
                ..full_header(1, None)
            },
            "Missing MD5 in NKit v1 header",
        ),
        (
            NKitHeader {
                sha1: None,
                size: None,
                ..full_header(1, None)
            },
            "Missing SHA1 in NKit v1 header",
        ),
        (
            NKitHeader {
                xxh64: None,
                size: None,
                ..full_header(1, None)
            },
            "Missing XXHash64 in NKit header",
        ),
    ];
    for (header, expected) in cases {
        let mut out = Vec::new();
        let error = header
            .write_to(&mut out)
            .expect_err("v1 requires all digests");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(
            error.to_string().contains(expected),
            "unexpected message: {error}"
        );
    }
}

// --- try_read_from --------------------------------------------------------

#[test]
fn try_read_from_returns_none_without_the_nkit_magic() {
    let mut stream: Vec<u8> = vec![0u8; 128];
    stream[..4].copy_from_slice(b"NOPE");
    assert!(NKitHeader::try_read_from(&mut stream, 0, 0x8000, false).is_none());
}

#[test]
fn try_read_from_returns_none_for_a_malformed_header() {
    // Right magic, wrong version string, so parsing fails after the probe.
    let mut stream = b"NKITxxxx".to_vec();
    stream.extend_from_slice(&[0u8; 128]);
    assert!(NKitHeader::try_read_from(&mut stream, 0, 0x8000, false).is_none());
}

#[test]
fn try_read_from_parses_a_header_at_a_non_zero_offset() {
    let header = full_header(2, None);
    let mut stream = vec![0xAA_u8; 64];
    stream.extend_from_slice(&v2_header(&header));
    stream.extend_from_slice(&[0u8; 16]);

    let parsed =
        NKitHeader::try_read_from(&mut stream, 64, 0x8000, false).expect("header parses at 64");
    assert_eq!(parsed.crc32, header.crc32);
    assert_eq!(parsed.size, header.size);
}

// --- apply ----------------------------------------------------------------

#[test]
fn apply_copies_digests_and_only_fills_a_missing_disc_size() {
    let header = full_header(2, Some(JunkBits::new(0x20_0000)));
    let mut meta = DiscMeta::default();
    header.apply(&mut meta);
    assert!(meta.needs_hash_recovery);
    assert!(
        meta.lossless,
        "size plus junk bits makes the format lossless"
    );
    assert_eq!(meta.disc_size, header.size);
    assert_eq!(meta.crc32, header.crc32);
    assert_eq!(meta.md5, header.md5);
    assert_eq!(meta.sha1, header.sha1);
    assert_eq!(meta.xxh64, header.xxh64);

    // An existing disc size wins over the header's.
    let mut meta = DiscMeta {
        disc_size: Some(0x4000),
        ..Default::default()
    };
    header.apply(&mut meta);
    assert_eq!(meta.disc_size, Some(0x4000));
}

#[test]
fn apply_without_junk_bits_leaves_the_format_lossy() {
    let header = NKitHeader {
        junk_bits: None,
        ..full_header(2, None)
    };
    let mut meta = DiscMeta::default();
    header.apply(&mut meta);
    assert!(!meta.needs_hash_recovery);
    assert!(!meta.lossless);
    assert!(header.is_junk_block(0).is_none());
}

// --- JunkBits -------------------------------------------------------------

#[test]
fn junk_bits_set_and_clear_individual_blocks() {
    let block_size = 0x20_0000;
    let mut bits = JunkBits::new(block_size);
    assert!(!bits.get(3));

    bits.set(3, true);
    assert!(bits.get(3));
    assert!(!bits.get(2));
    assert!(!bits.get(4));

    bits.set(3, false);
    assert!(!bits.get(3));
}

#[test]
fn junk_bits_ignore_blocks_past_the_end_of_the_bitmap() {
    let block_size = 0x20_0000;
    let mut bits = JunkBits::new(block_size);
    let past_end = u32::MAX;
    // Neither call may panic, and the block still reads as "not junk".
    bits.set(past_end, true);
    assert!(!bits.get(past_end));
}

#[test]
fn junk_bits_length_covers_a_dual_layer_disc() {
    let block_size = 0x20_0000_u32;
    let expected = DL_DVD_SIZE.div_ceil(block_size as u64).div_ceil(8) as usize;
    assert_eq!(JunkBits::len(block_size), expected);

    let mut out = Vec::new();
    JunkBits::new(block_size)
        .write_to(&mut out)
        .expect("writes");
    assert_eq!(out.len(), expected);

    let parsed = JunkBits::read_from(&mut out.as_slice(), block_size).expect("reads back");
    assert!(!parsed.get(0));
}

// --- ReadAdapter ----------------------------------------------------------

#[test]
fn read_adapter_supports_only_exact_reads() {
    let mut stream: Vec<u8> = (0..64u8).collect();
    let mut adapter = ReadAdapter::new(&mut stream, 8);

    let mut buf = [0u8; 4];
    let error = Read::read(&mut adapter, &mut buf).expect_err("streaming reads are unsupported");
    assert_eq!(error.kind(), io::ErrorKind::Unsupported);

    adapter.read_exact(&mut buf).expect("exact read");
    assert_eq!(buf, [8, 9, 10, 11]);
    // The adapter advances by exactly what it read.
    adapter.read_exact(&mut buf).expect("second exact read");
    assert_eq!(buf, [12, 13, 14, 15]);
}

#[test]
fn read_adapter_seeks_from_start_current_and_end() {
    let mut stream: Vec<u8> = (0..64u8).collect();
    let mut adapter = ReadAdapter::new(&mut stream, 0);

    assert_eq!(adapter.seek(io::SeekFrom::Start(16)).expect("start"), 16);
    assert_eq!(adapter.seek(io::SeekFrom::Current(4)).expect("current"), 20);
    assert_eq!(adapter.seek(io::SeekFrom::Current(-8)).expect("back"), 12);
    assert_eq!(adapter.seek(io::SeekFrom::End(-1)).expect("end"), 63);
    // Seeking before the start saturates at zero.
    assert_eq!(
        adapter
            .seek(io::SeekFrom::Current(-128))
            .expect("saturates"),
        0
    );

    let mut buf = [0u8; 2];
    adapter
        .read_exact(&mut buf)
        .expect("read from the new position");
    assert_eq!(buf, [0, 1]);
}
