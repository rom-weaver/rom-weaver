//! Unit coverage for `rom-weaver-chd` internals.
//!
//! These exercise the `pub(super)` primitives that back CHD's byte-parity
//! guarantees — the V5 compressed-map huffman/RLE/CRC machinery and the CD
//! sector ECC math — plus the codec-routing edge branches that cannot be
//! reached through the crate's public `*_for_tests` helpers (those are already
//! covered end-to-end by `rom-weaver-containers`' handler tests). Keeping these
//! isolated means a regression in, say, canonical huffman code assignment fails
//! precisely here instead of surfacing as a deep round-trip parity mismatch.

use super::*;

// --- CD sector ECC ---------------------------------------------------------

/// MAME CD sync header that prefixes every reconstructable 2352-byte sector.
const SYNC_HEADER: [u8; 12] = [
    0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00,
];

/// Build a Mode 1 raw sector with a deterministic data payload and freshly
/// generated P/Q ECC so it round-trips through verification.
fn mode1_sector_with_ecc() -> Vec<u8> {
    let mut sector = vec![0_u8; ChdContainerHandler::CD_SECTOR_DATA_BYTES];
    sector[..12].copy_from_slice(&SYNC_HEADER);
    sector[0x0f] = 1; // Mode 1.
    for (index, byte) in sector.iter_mut().enumerate().skip(16) {
        *byte = (index % 251) as u8;
    }
    ChdContainerHandler::generate_cd_sector_ecc_for_tests(&mut sector);
    sector
}

#[test]
fn cd_sector_ecc_round_trips_through_verification() {
    let sector = mode1_sector_with_ecc();
    assert!(ChdContainerHandler::cd_sector_verify_ecc(&sector));
    assert!(ChdContainerHandler::cd_sector_has_reconstructable_ecc(
        &sector
    ));
}

#[test]
fn cd_sector_ecc_rejects_corrupted_payload() {
    let mut sector = mode1_sector_with_ecc();
    // Flip a byte inside the ECC-covered data region.
    sector[100] ^= 0xff;
    assert!(!ChdContainerHandler::cd_sector_verify_ecc(&sector));
    assert!(!ChdContainerHandler::cd_sector_has_reconstructable_ecc(
        &sector
    ));
}

#[test]
fn cd_sector_ecc_rejects_missing_sync_header() {
    let mut sector = mode1_sector_with_ecc();
    // ECC is still valid, but a cleared sync header means it is not a
    // reconstructable sector.
    sector[1] = 0;
    assert!(ChdContainerHandler::cd_sector_verify_ecc(&sector));
    assert!(!ChdContainerHandler::cd_sector_has_reconstructable_ecc(
        &sector
    ));
}

#[test]
fn cd_sector_clear_sync_and_ecc_zeroes_only_sync_and_ecc() {
    let mut sector = mode1_sector_with_ecc();
    let data_before = sector[12..0x81c].to_vec();
    ChdContainerHandler::cd_sector_clear_sync_and_ecc(&mut sector);
    assert!(sector[..12].iter().all(|byte| *byte == 0));
    assert!(sector[0x81c..].iter().all(|byte| *byte == 0));
    // The user-data region between the sync header and the ECC block is left
    // intact so the sector can be rebuilt on extract.
    assert_eq!(&sector[12..0x81c], data_before.as_slice());
}

#[test]
fn cd_sector_ecc_helpers_reject_wrong_length() {
    let mut short = vec![0_u8; 100];
    assert!(!ChdContainerHandler::cd_sector_verify_ecc(&short));
    assert!(!ChdContainerHandler::cd_sector_has_reconstructable_ecc(
        &short
    ));
    // Generation and clearing are no-ops at the wrong length.
    ChdContainerHandler::generate_cd_sector_ecc_for_tests(&mut short);
    assert!(short.iter().all(|byte| *byte == 0));
    ChdContainerHandler::cd_sector_clear_sync_and_ecc(&mut short);
    assert!(short.iter().all(|byte| *byte == 0));
}

// --- V5 compressed-map CRC and integer writers -----------------------------

#[test]
fn crc16_ibm3740_matches_reference_check_value() {
    // The canonical CRC-16/CCITT-FALSE check value for "123456789".
    assert_eq!(ChdContainerHandler::crc16_ibm3740(b"123456789"), 0x29B1);
    // No bytes leaves the 0xFFFF initial register untouched.
    assert_eq!(ChdContainerHandler::crc16_ibm3740(&[]), 0xFFFF);
}

#[test]
fn write_u24_be_encodes_and_bounds_check() {
    let mut buf = [0_u8; 3];
    ChdContainerHandler::write_u24_be(&mut buf, 0x12_3456).expect("in range");
    assert_eq!(buf, [0x12, 0x34, 0x56]);

    assert!(ChdContainerHandler::write_u24_be(&mut buf, 0x0100_0000).is_err());
    let mut short = [0_u8; 2];
    assert!(ChdContainerHandler::write_u24_be(&mut short, 0).is_err());
}

#[test]
fn write_u48_be_encodes_and_bounds_check() {
    let mut buf = [0_u8; 6];
    ChdContainerHandler::write_u48_be(&mut buf, 0x1234_5678_9ABC).expect("in range");
    assert_eq!(buf, [0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC]);

    assert!(ChdContainerHandler::write_u48_be(&mut buf, 0x0001_0000_0000_0000).is_err());
    let mut short = [0_u8; 5];
    assert!(ChdContainerHandler::write_u48_be(&mut short, 0).is_err());
}

#[test]
fn bits_for_value_counts_significant_bits() {
    assert_eq!(ChdContainerHandler::bits_for_value(0), 0);
    assert_eq!(ChdContainerHandler::bits_for_value(1), 1);
    assert_eq!(ChdContainerHandler::bits_for_value(2), 2);
    assert_eq!(ChdContainerHandler::bits_for_value(3), 2);
    assert_eq!(ChdContainerHandler::bits_for_value(255), 8);
    assert_eq!(ChdContainerHandler::bits_for_value(256), 9);
    assert_eq!(ChdContainerHandler::bits_for_value(0x00FF_FFFF), 24);
}

// --- V5 compressed-map huffman / RLE ---------------------------------------

#[test]
fn canonical_huffman_codes_assigns_sequential_codes() {
    let mut lengths = [0_u8; 16];
    lengths[0] = 1;
    lengths[1] = 1;
    let codes = ChdContainerHandler::canonical_huffman_codes(&lengths).expect("valid lengths");
    assert_eq!(codes[0], Some((0, 1)));
    assert_eq!(codes[1], Some((1, 1)));

    let mut four = [0_u8; 16];
    four[..4].fill(2);
    let codes = ChdContainerHandler::canonical_huffman_codes(&four).expect("valid lengths");
    assert_eq!(codes[0], Some((0, 2)));
    assert_eq!(codes[1], Some((1, 2)));
    assert_eq!(codes[2], Some((2, 2)));
    assert_eq!(codes[3], Some((3, 2)));
}

#[test]
fn canonical_huffman_codes_rejects_unbalanced_distribution() {
    // A single symbol with a 2-bit length leaves the code space oversubscribed.
    let mut lengths = [0_u8; 16];
    lengths[0] = 2;
    assert!(ChdContainerHandler::canonical_huffman_codes(&lengths).is_err());
}

#[test]
fn rle_encode_map_symbols_collapses_runs() {
    // Distinct symbols pass through untouched.
    assert_eq!(
        ChdContainerHandler::rle_encode_map_symbols(&[1, 2, 3]),
        vec![1, 2, 3]
    );
    // A run shorter than 3 is not worth encoding.
    assert_eq!(
        ChdContainerHandler::rle_encode_map_symbols(&[9, 9]),
        vec![9, 9]
    );
    // A literal seeds the run, then the remaining 3 collapse into a small RLE.
    assert_eq!(
        ChdContainerHandler::rle_encode_map_symbols(&[9, 9, 9, 9]),
        vec![9, ChdContainerHandler::CHD_V5_MAP_TYPE_RLE_SMALL, 0]
    );
    // Ten identical symbols: literal + small RLE of the remaining nine.
    assert_eq!(
        ChdContainerHandler::rle_encode_map_symbols(&[4; 10]),
        vec![4, ChdContainerHandler::CHD_V5_MAP_TYPE_RLE_SMALL, 6]
    );
    // Twenty-five identical symbols spill past the small-run ceiling into a
    // large RLE: literal + large-RLE marker + nibble-split length (24 - 19 = 5).
    assert_eq!(
        ChdContainerHandler::rle_encode_map_symbols(&[4; 25]),
        vec![4, ChdContainerHandler::CHD_V5_MAP_TYPE_RLE_LARGE, 0, 5]
    );
}

#[test]
fn map_symbol_bit_lengths_produce_decodable_trees() {
    // A single symbol still needs a 1-bit length.
    let single = ChdContainerHandler::map_symbol_bit_lengths(&[0, 0, 0]).expect("single symbol");
    assert_eq!(single[0], 1);
    assert!(single[1..].iter().all(|length| *length == 0));
    assert!(ChdContainerHandler::canonical_huffman_codes(&single).is_ok());

    // Two symbols share a 1-bit length each and remain canonical.
    let pair = ChdContainerHandler::map_symbol_bit_lengths(&[0, 0, 0, 1]).expect("two symbols");
    assert_eq!(pair[0], 1);
    assert_eq!(pair[1], 1);
    assert!(ChdContainerHandler::canonical_huffman_codes(&pair).is_ok());
}

#[test]
fn fixed_map_symbol_bit_lengths_match_table() {
    let lengths = ChdContainerHandler::fixed_map_symbol_bit_lengths_for_max_type(0).unwrap();
    assert_eq!(lengths[0], 1);
    assert!(lengths[1..].iter().all(|length| *length == 0));

    let lengths = ChdContainerHandler::fixed_map_symbol_bit_lengths_for_max_type(2).unwrap();
    assert_eq!(&lengths[..3], &[1, 2, 2]);

    let lengths = ChdContainerHandler::fixed_map_symbol_bit_lengths_for_max_type(5).unwrap();
    assert!(lengths[..8].iter().all(|length| *length == 3));

    let lengths = ChdContainerHandler::fixed_map_symbol_bit_lengths_for_max_type(7).unwrap();
    assert!(lengths.iter().all(|length| *length == 4));

    assert!(ChdContainerHandler::fixed_map_symbol_bit_lengths_for_max_type(16).is_err());
}

#[test]
fn encode_v5_compressed_map_smoke() {
    // A small, self-consistent map: one compressed hunk plus a self-copy.
    let entries = [
        RustCompressedHunkEntry {
            compression_type: 0,
            offset: 124,
            length: 512,
            crc16: 0xABCD,
        },
        RustCompressedHunkEntry {
            compression_type: ChdContainerHandler::CHD_V5_MAP_TYPE_SELF,
            offset: 0,
            length: 0,
            crc16: 0,
        },
    ];
    let (bytes, map_crc, length_bits, _self_bits, parent_bits, first_offset) =
        ChdContainerHandler::encode_v5_compressed_map(&entries, 4096, 4096).expect("encode map");
    assert!(!bytes.is_empty());
    assert_ne!(map_crc, 0);
    // 512 needs 10 bits; no parent entries means zero parent bits.
    assert_eq!(length_bits, 10);
    assert_eq!(parent_bits, 0);
    assert_eq!(first_offset, 124);
}

// --- Codec routing edge branches -------------------------------------------

#[test]
fn map_codec_resolves_aliases_case_insensitively() {
    let handler = ChdContainerHandler;
    assert_eq!(handler.map_codec("huff").unwrap(), ChdCodec::HUFFMAN);
    assert_eq!(handler.map_codec("huffman").unwrap(), ChdCodec::HUFFMAN);
    assert_eq!(handler.map_codec("FLAC").unwrap(), ChdCodec::FLAC);
    assert_eq!(handler.map_codec("cdzl").unwrap(), ChdCodec::CD_ZLIB);
    assert_eq!(handler.map_codec("cdzs").unwrap(), ChdCodec::CD_ZSTD);
    assert_eq!(handler.map_codec("cdlz").unwrap(), ChdCodec::CD_LZMA);
    assert_eq!(handler.map_codec("cdfl").unwrap(), ChdCodec::CD_FLAC);
    assert_eq!(handler.map_codec("avhu").unwrap(), ChdCodec::AVHUFF);
    assert_eq!(handler.map_codec("store").unwrap(), ChdCodec::NONE);
    assert!(handler.map_codec("definitely-not-a-codec").is_err());
}

#[test]
fn parse_explicit_codecs_handles_separators_and_blanks() {
    let handler = ChdContainerHandler;
    assert!(handler.parse_explicit_codecs(None).unwrap().is_none());
    assert!(
        handler
            .parse_explicit_codecs(Some("   "))
            .unwrap()
            .is_none()
    );

    let codecs = handler
        .parse_explicit_codecs(Some("lzma+zlib"))
        .unwrap()
        .expect("codecs");
    assert_eq!(codecs, vec![ChdCodec::LZMA, ChdCodec::ZLIB]);

    // An empty entry between separators is an error.
    assert!(handler.parse_explicit_codecs(Some("lzma,,zlib")).is_err());
}

#[test]
fn explicit_codec_plan_enforces_combination_rules() {
    let handler = ChdContainerHandler;
    assert!(handler.explicit_codec_plan(Vec::new()).is_err());
    // `store` cannot be combined with another codec.
    assert!(
        handler
            .explicit_codec_plan(vec![ChdCodec::NONE, ChdCodec::ZSTD])
            .is_err()
    );
    // avhuff must lead when multiple codecs are present.
    assert!(
        handler
            .explicit_codec_plan(vec![ChdCodec::ZSTD, ChdCodec::AVHUFF])
            .is_err()
    );

    let plan = handler
        .explicit_codec_plan(vec![ChdCodec::LZMA, ChdCodec::ZLIB])
        .expect("valid plan");
    assert_eq!(plan.primary_codec, ChdCodec::LZMA);
    assert_eq!(
        plan.codecs,
        [
            ChdCodec::LZMA,
            ChdCodec::ZLIB,
            ChdCodec::NONE,
            ChdCodec::NONE
        ]
    );
}

#[test]
fn supports_rust_create_requires_contiguous_codec_slots() {
    let handler = ChdContainerHandler;
    let kind = ChdCreateKind::Raw;

    // A gap between active codec slots is rejected.
    let gapped = [
        ChdCodec::LZMA,
        ChdCodec::NONE,
        ChdCodec::ZLIB,
        ChdCodec::NONE,
    ];
    assert!(!handler.supports_rust_create(&kind, gapped, ChdCodec::LZMA));

    // Contiguous, supported codecs for raw media are accepted.
    let contiguous = [
        ChdCodec::LZMA,
        ChdCodec::ZLIB,
        ChdCodec::NONE,
        ChdCodec::NONE,
    ];
    assert!(handler.supports_rust_create(&kind, contiguous, ChdCodec::LZMA));

    // Pure store is accepted for raw media.
    let store = [ChdCodec::NONE; CHD_MAX_COMPRESSORS];
    assert!(handler.supports_rust_create(&kind, store, ChdCodec::NONE));
}

#[test]
fn resolve_compression_level_enforces_codec_ranges() {
    let handler = ChdContainerHandler;
    // No requested level resolves to the codec default.
    assert_eq!(
        handler
            .resolve_compression_level(ChdCodec::LZMA, None)
            .unwrap(),
        0
    );
    // In-range levels pass through.
    assert_eq!(
        handler
            .resolve_compression_level(ChdCodec::ZLIB, Some(5))
            .unwrap(),
        5
    );
    // Out-of-range levels are rejected.
    assert!(
        handler
            .resolve_compression_level(ChdCodec::ZLIB, Some(10))
            .is_err()
    );
    assert!(
        handler
            .resolve_compression_level(ChdCodec::LZMA, Some(10))
            .is_err()
    );
    // Level-less codecs reject an explicit level outright.
    assert!(
        handler
            .resolve_compression_level(ChdCodec::NONE, Some(1))
            .is_err()
    );
    assert!(
        handler
            .resolve_compression_level(ChdCodec::HUFFMAN, Some(1))
            .is_err()
    );
    assert!(
        handler
            .resolve_compression_level(ChdCodec::AVHUFF, Some(1))
            .is_err()
    );
}

#[test]
fn codec_accepts_level_excludes_levelless_codecs() {
    assert!(!ChdContainerHandler::codec_accepts_level(ChdCodec::NONE));
    assert!(!ChdContainerHandler::codec_accepts_level(ChdCodec::HUFFMAN));
    assert!(!ChdContainerHandler::codec_accepts_level(ChdCodec::AVHUFF));
    assert!(ChdContainerHandler::codec_accepts_level(ChdCodec::LZMA));
    assert!(ChdContainerHandler::codec_accepts_level(ChdCodec::FLAC));
    assert!(ChdContainerHandler::codec_accepts_level(ChdCodec::CD_ZSTD));
}

#[test]
fn codec_label_round_trips_known_codecs() {
    let handler = ChdContainerHandler;
    assert_eq!(handler.codec_label(ChdCodec::NONE), "store");
    assert_eq!(handler.codec_label(ChdCodec::LZMA), "lzma");
    assert_eq!(handler.codec_label(ChdCodec::CD_LZMA), "cdlz");
    assert_eq!(handler.codec_label(ChdCodec::AVHUFF), "avhuff");
}

// --- Disc / MSF / metadata helpers -----------------------------------------

#[test]
fn msf_parsing_round_trips() {
    let handler = ChdContainerHandler;
    assert_eq!(handler.parse_msf("00:02:00").unwrap(), 150);
    assert_eq!(handler.parse_msf("01:00:00").unwrap(), 4500);
    assert_eq!(handler.format_msf(150), "00:02:00");
    assert_eq!(handler.format_msf(4500), "01:00:00");

    // Field overflow and trailing components are rejected.
    assert!(handler.parse_msf("00:00:75").is_err());
    assert!(handler.parse_msf("00:60:00").is_err());
    assert!(handler.parse_msf("00:00:00:00").is_err());
    assert!(handler.parse_msf("oops").is_err());
}

#[test]
fn parse_disc_mode_maps_known_track_types() {
    let handler = ChdContainerHandler;
    assert_eq!(
        handler.parse_disc_mode("MODE1").unwrap(),
        DiscTrackMode::Mode1
    );
    assert_eq!(
        handler.parse_disc_mode("mode2/2352").unwrap(),
        DiscTrackMode::Mode2Raw
    );
    assert_eq!(
        handler.parse_disc_mode("AUDIO").unwrap(),
        DiscTrackMode::Audio
    );
    assert!(handler.parse_disc_mode("MODE9").is_err());
}

#[test]
fn sha1_hex_helpers_treat_zero_digest_as_absent() {
    let handler = ChdContainerHandler;
    let mut digest = [0_u8; 20];
    digest[0] = 0xde;
    digest[1] = 0xad;
    assert!(handler.sha1_hex(digest).starts_with("dead"));
    assert_eq!(
        handler.sha1_hex_from_optional(Some(digest)),
        Some(handler.sha1_hex(digest))
    );
    // An all-zero digest is reported as missing rather than a string of zeros.
    assert_eq!(handler.sha1_hex_from_optional(Some([0_u8; 20])), None);
    assert_eq!(handler.sha1_hex_from_optional(None), None);
}

#[test]
fn extract_name_uses_media_specific_extension() {
    let handler = ChdContainerHandler;
    assert_eq!(
        handler.extract_extension(ChdMediaKind::Raw).unwrap(),
        ".bin"
    );
    assert_eq!(
        handler.extract_extension(ChdMediaKind::Dvd).unwrap(),
        ".iso"
    );
    assert_eq!(
        handler.extract_extension(ChdMediaKind::CdRom).unwrap(),
        ".cue"
    );

    assert_eq!(
        handler
            .extract_name(Path::new("game.chd"), ChdMediaKind::Raw)
            .unwrap(),
        "game.bin"
    );
    // A pathological stem-less path falls back to a default name.
    assert_eq!(
        handler
            .extract_name(Path::new(""), ChdMediaKind::CdRom)
            .unwrap(),
        "output.cue"
    );
}

// --- Codec encoders (huffman / avhuff / pcm) -------------------------------

#[test]
fn pcm_i16_interleaved_to_samples_respects_byte_order() {
    let handler = ChdContainerHandler;
    let le = handler
        .pcm_i16_interleaved_to_samples(
            &[0x34, 0x12, 0x78, 0x56],
            FlacSampleByteOrder::LittleEndian,
        )
        .unwrap();
    assert_eq!(le, vec![0x1234, 0x5678]);

    let be = handler
        .pcm_i16_interleaved_to_samples(&[0x12, 0x34, 0x56, 0x78], FlacSampleByteOrder::BigEndian)
        .unwrap();
    assert_eq!(be, vec![0x1234, 0x5678]);

    // Sign extension into i32 is preserved.
    let signed = handler
        .pcm_i16_interleaved_to_samples(
            &[0x00, 0x80, 0xFF, 0x7F],
            FlacSampleByteOrder::LittleEndian,
        )
        .unwrap();
    assert_eq!(signed, vec![-32768, 32767]);

    // Stereo 16-bit PCM must be a multiple of four bytes.
    assert!(
        handler
            .pcm_i16_interleaved_to_samples(&[0x00, 0x01], FlacSampleByteOrder::LittleEndian)
            .is_err()
    );
}

#[test]
fn canonical_codes_from_lengths_assigns_and_validates() {
    let handler = ChdContainerHandler;
    let codes = handler.canonical_codes_from_lengths(&[1, 1]).unwrap();
    assert_eq!(codes[0], Some((0, 1)));
    assert_eq!(codes[1], Some((1, 1)));

    let codes = handler.canonical_codes_from_lengths(&[2, 2, 2, 2]).unwrap();
    assert_eq!(codes[3], Some((3, 2)));

    // A length beyond the 32-bit code ceiling is rejected.
    assert!(handler.canonical_codes_from_lengths(&[33]).is_err());
    // A single 2-bit symbol leaves the code space oversubscribed.
    assert!(handler.canonical_codes_from_lengths(&[2]).is_err());
}

#[test]
fn write_huffman_tree_rle_lengths_validates_configuration() {
    let handler = ChdContainerHandler;

    let mut writer = MsbBitWriter::new();
    assert!(
        handler
            .write_huffman_tree_rle_lengths(&mut writer, &[1, 1, 1], 0)
            .is_err()
    );

    let mut writer = MsbBitWriter::new();
    assert!(
        handler
            .write_huffman_tree_rle_lengths(&mut writer, &[1], 9)
            .is_err()
    );

    // A symbol value that exceeds the rle_bits range is rejected.
    let mut writer = MsbBitWriter::new();
    assert!(
        handler
            .write_huffman_tree_rle_lengths(&mut writer, &[5], 2)
            .is_err()
    );

    // A valid run emits bytes.
    let mut writer = MsbBitWriter::new();
    handler
        .write_huffman_tree_rle_lengths(&mut writer, &[2, 2, 2, 2], 4)
        .unwrap();
    assert!(!writer.finish().is_empty());
}

#[test]
fn encode_huffman_identity_payload_emits_fixed_tree_header() {
    let handler = ChdContainerHandler;
    // The 28-bit small/main tree header packs into four bytes for an empty hunk.
    let header = handler.encode_huffman_identity_payload(&[]);
    assert_eq!(header, vec![0x3C, 0x1F, 0x7F, 0x60]);

    // Each input byte appends eight bits to the identity stream.
    let one = handler.encode_huffman_identity_payload(&[0xAB]);
    assert_eq!(one.len(), header.len() + 1);
    // The header is deterministic and the payload distinguishes inputs.
    assert_ne!(
        handler.encode_huffman_identity_payload(&[0x00]),
        handler.encode_huffman_identity_payload(&[0x01])
    );
}

// --- V5 header / metadata builders -----------------------------------------

#[test]
fn build_chd_v5_header_lays_out_fixed_fields() {
    let handler = ChdContainerHandler;
    let codecs = [
        ChdCodec::LZMA,
        ChdCodec::ZLIB,
        ChdCodec::NONE,
        ChdCodec::NONE,
    ];
    let parent = [0x11_u8; 20];
    let header = handler.build_chd_v5_header(0x1234, 0x5678, 4096, 2048, codecs, Some(parent));

    assert_eq!(&header[0..8], b"MComprHD");
    assert_eq!(&header[8..12], &124_u32.to_be_bytes());
    assert_eq!(&header[12..16], &5_u32.to_be_bytes());
    // Codec tags are stored as their fourcc bytes in order.
    assert_eq!(&header[16..20], b"lzma");
    assert_eq!(&header[20..24], b"zlib");
    assert_eq!(&header[24..28], &[0, 0, 0, 0]);
    assert_eq!(&header[32..40], &0x1234_u64.to_be_bytes());
    assert_eq!(&header[40..48], &0x5678_u64.to_be_bytes());
    assert_eq!(&header[56..60], &4096_u32.to_be_bytes());
    assert_eq!(&header[60..64], &2048_u32.to_be_bytes());
    assert_eq!(&header[104..124], &parent);

    // Without a parent the parent-sha1 slot stays zeroed.
    let no_parent = handler.build_chd_v5_header(0, 0, 4096, 2048, codecs, None);
    assert!(no_parent[104..124].iter().all(|byte| *byte == 0));
}

#[test]
fn rust_metadata_entries_per_media_kind() {
    let handler = ChdContainerHandler;
    assert!(
        handler
            .rust_metadata_entries(&ChdCreateKind::Raw)
            .unwrap()
            .is_empty()
    );

    let dvd = handler.rust_metadata_entries(&ChdCreateKind::Dvd).unwrap();
    assert_eq!(dvd.len(), 1);
    assert_eq!(dvd[0].tag.to_be_bytes(), *b"DVD ");
    assert_eq!(dvd[0].data, vec![0]);

    let geometry = HdGeometry {
        cylinders: 2,
        heads: 16,
        sectors: 63,
        bytes_per_sector: 512,
    };
    let hd = handler
        .rust_metadata_entries(&ChdCreateKind::HardDisk(geometry))
        .unwrap();
    assert_eq!(hd.len(), 1);
    assert!(hd[0].data.starts_with(b"CYLS:2,HEADS:16,SECS:63,BPS:512"));
    assert_eq!(hd[0].data.last(), Some(&0));
}

#[test]
fn compute_overall_sha1_hashes_and_orders_metadata() {
    let raw_sha1 = [0xAB_u8; 20];

    // With no metadata the overall digest is just sha1(raw_sha1).
    let mut expected = Sha1::new();
    expected.update(raw_sha1);
    let mut expected_bytes = [0_u8; 20];
    expected_bytes.copy_from_slice(&expected.finalize());
    assert_eq!(
        ChdContainerHandler::compute_overall_sha1(&raw_sha1, &[]),
        expected_bytes
    );

    let entry_a = RustMetadataEntry {
        tag: 0x41414141,
        flags: 0x01,
        data: vec![1, 2, 3],
    };
    let entry_b = RustMetadataEntry {
        tag: 0x42424242,
        flags: 0x01,
        data: vec![4, 5, 6],
    };
    // Metadata hashes are sorted, so input order does not matter.
    assert_eq!(
        ChdContainerHandler::compute_overall_sha1(&raw_sha1, &[entry_a.clone(), entry_b.clone()]),
        ChdContainerHandler::compute_overall_sha1(&raw_sha1, &[entry_b, entry_a])
    );

    // Entries without the checksum flag are excluded from the digest.
    let unchecked = RustMetadataEntry {
        tag: 0x43434343,
        flags: 0x00,
        data: vec![9, 9, 9],
    };
    assert_eq!(
        ChdContainerHandler::compute_overall_sha1(&raw_sha1, &[unchecked]),
        expected_bytes
    );
}

#[test]
fn patch_chd_header_writes_big_endian_and_restores_cursor() {
    let handler = ChdContainerHandler;
    let path = std::env::temp_dir().join(format!(
        "rw-chd-unit-{}-patch-header.bin",
        std::process::id()
    ));
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .unwrap();
    file.write_all(&[0_u8; 124]).unwrap();
    // Park the cursor away from the header field being patched.
    file.seek(SeekFrom::Start(100)).unwrap();

    handler
        .patch_chd_header_u64(&mut file, &path, 56, 0x1122_3344_5566_7788, "test")
        .unwrap();
    // The write cursor is restored to where it was before the patch.
    assert_eq!(file.stream_position().unwrap(), 100);

    file.seek(SeekFrom::Start(56)).unwrap();
    let mut buf = [0_u8; 8];
    file.read_exact(&mut buf).unwrap();
    assert_eq!(buf, 0x1122_3344_5566_7788_u64.to_be_bytes());

    // A raw byte patch lands at its offset too.
    let sha1 = [0x5A_u8; 20];
    handler
        .patch_chd_header_bytes(&mut file, &path, 64, &sha1, "raw sha1")
        .unwrap();
    file.seek(SeekFrom::Start(64)).unwrap();
    let mut sha1_buf = [0_u8; 20];
    file.read_exact(&mut sha1_buf).unwrap();
    assert_eq!(sha1_buf, sha1);

    drop(file);
    let _ = std::fs::remove_file(&path);
}

// --- Inference helpers (pure size / layout heuristics) ---------------------

#[test]
fn read_le_helpers_are_bounds_checked() {
    assert_eq!(
        ChdContainerHandler::read_le_u16(&[0x34, 0x12], 0),
        Some(0x1234)
    );
    assert_eq!(ChdContainerHandler::read_le_u16(&[0x00], 0), None);
    assert_eq!(
        ChdContainerHandler::read_le_u32(&[0x78, 0x56, 0x34, 0x12], 0),
        Some(0x1234_5678)
    );
    assert_eq!(ChdContainerHandler::read_le_u32(&[0, 0, 0], 0), None);
    assert_eq!(
        ChdContainerHandler::read_le_u64(&[1, 0, 0, 0, 0, 0, 0, 0], 0),
        Some(1)
    );
    assert_eq!(ChdContainerHandler::read_le_u64(&[0; 7], 0), None);
}

#[test]
fn is_extension_matches_case_insensitively() {
    assert!(ChdContainerHandler::is_extension(
        Path::new("disc.ISO"),
        "iso"
    ));
    assert!(!ChdContainerHandler::is_extension(
        Path::new("disc.bin"),
        "iso"
    ));
    assert!(!ChdContainerHandler::is_extension(Path::new("disc"), "iso"));
}

#[test]
fn single_track_cd_and_volume_size_heuristics() {
    let handler = ChdContainerHandler;
    assert!(handler.is_single_track_cd_sector_sized(2352));
    assert!(handler.is_single_track_cd_sector_sized(2048));
    assert!(!handler.is_single_track_cd_sector_sized(0));
    assert!(!handler.is_single_track_cd_sector_sized(1000));
    assert!(!handler.is_single_track_cd_sector_sized(2353));

    for size in [512, 1024, 2048, 4096] {
        assert!(ChdContainerHandler::is_valid_volume_sector_size(size));
    }
    for size in [256, 1000, 8192] {
        assert!(!ChdContainerHandler::is_valid_volume_sector_size(size));
    }
}

#[test]
fn has_sector_signature_checks_boot_marker() {
    let mut sector = vec![0_u8; 512];
    sector[510] = 0x55;
    sector[511] = 0xAA;
    assert!(ChdContainerHandler::has_sector_signature(&sector));
    sector[511] = 0x00;
    assert!(!ChdContainerHandler::has_sector_signature(&sector));
    // A short buffer cannot carry the signature.
    assert!(!ChdContainerHandler::has_sector_signature(&[0_u8; 100]));
}

#[test]
fn unit_bytes_per_create_kind() {
    let handler = ChdContainerHandler;
    assert_eq!(handler.unit_bytes(&ChdCreateKind::Raw), 1);
    assert_eq!(handler.unit_bytes(&ChdCreateKind::Dvd), 2048);
    let geometry = HdGeometry {
        cylinders: 1,
        heads: 1,
        sectors: 1,
        bytes_per_sector: 512,
    };
    assert_eq!(handler.unit_bytes(&ChdCreateKind::HardDisk(geometry)), 512);
    let disc = ChdCreateKind::Disc(DiscLayout {
        kind: DiscKind::CdRom,
        tracks: Vec::new(),
    });
    assert_eq!(handler.unit_bytes(&disc), 2448);
}

#[test]
fn hunk_bytes_scales_disc_hunks_with_frame_count() {
    let handler = ChdContainerHandler;
    // Non-disc media uses the default hunk size.
    assert_eq!(
        handler.hunk_bytes(&ChdCreateKind::Raw, 100_000, ChdCodec::NONE),
        4096
    );
    let disc = ChdCreateKind::Disc(DiscLayout {
        kind: DiscKind::CdRom,
        tracks: Vec::new(),
    });
    // Uncompressed disc media uses the full 8-frame hunk.
    assert_eq!(handler.hunk_bytes(&disc, 100_000, ChdCodec::NONE), 19584);
    // Four frames compressed: ceil(4/2)=2 frames per hunk.
    assert_eq!(handler.hunk_bytes(&disc, 2448 * 4, ChdCodec::CD_LZMA), 4896);
    // A single frame falls back to the full hunk.
    assert_eq!(handler.hunk_bytes(&disc, 2448, ChdCodec::CD_LZMA), 19584);
    // Large inputs cap at eight frames per hunk.
    assert_eq!(
        handler.hunk_bytes(&disc, 2448 * 100, ChdCodec::CD_LZMA),
        19584
    );
}

#[test]
fn ensure_multiple_of_validates_alignment() {
    let handler = ChdContainerHandler;
    assert!(handler.ensure_multiple_of(4096, 512, "image").is_ok());
    assert!(handler.ensure_multiple_of(4097, 512, "image").is_err());
}

#[test]
fn infer_hd_geometry_synthesizes_chs_layout() {
    let handler = ChdContainerHandler;
    // 255 * 63 sectors per cylinder yields a single cylinder.
    let geometry = handler.infer_hd_geometry(16065 * 512).unwrap();
    assert_eq!(geometry.heads, 255);
    assert_eq!(geometry.sectors, 63);
    assert_eq!(geometry.cylinders, 1);
    assert_eq!(geometry.bytes_per_sector, 512);

    // A single sector falls through to the 1x1 fallback candidate.
    let tiny = handler.infer_hd_geometry(512).unwrap();
    assert_eq!((tiny.heads, tiny.sectors, tiny.cylinders), (1, 1, 1));

    // A size that is not a multiple of the sector size is rejected.
    assert!(handler.infer_hd_geometry(513).is_err());
}

// --- Disk-format inference (partition tables / boot sectors) ---------------

/// A logical size of 100 hard-disk sectors, the volume backdrop most builders
/// below size their declared geometry against.
const HD_VOLUME_BYTES: u64 = 512 * 100;

/// Build a 512-byte sector pre-stamped with the `55 AA` boot signature.
fn signed_sector() -> Vec<u8> {
    let mut sector = vec![0_u8; ChdContainerHandler::HD_SECTOR_BYTES as usize];
    sector[510] = 0x55;
    sector[511] = 0xAA;
    sector
}

/// Stamp one MBR partition entry (16 bytes at `446 + index * 16`).
fn write_mbr_entry(
    sector: &mut [u8],
    index: usize,
    boot_flag: u8,
    partition_type: u8,
    start_lba: u32,
    sector_count: u32,
) {
    let offset = ChdContainerHandler::MBR_PARTITION_TABLE_OFFSET
        + index * ChdContainerHandler::MBR_PARTITION_ENTRY_BYTES;
    sector[offset] = boot_flag;
    sector[offset + 4] = partition_type;
    sector[offset + 8..offset + 12].copy_from_slice(&start_lba.to_le_bytes());
    sector[offset + 12..offset + 16].copy_from_slice(&sector_count.to_le_bytes());
}

#[test]
fn boot_sector_declares_matching_size_validates_geometry() {
    // Declared volume fits exactly within the logical image.
    assert!(ChdContainerHandler::boot_sector_declares_matching_size(
        512,
        100,
        HD_VOLUME_BYTES
    ));
    // Zero declared sectors is never a valid volume.
    assert!(!ChdContainerHandler::boot_sector_declares_matching_size(
        512,
        0,
        HD_VOLUME_BYTES
    ));
    // An unsupported logical sector size is rejected before the multiply.
    assert!(!ChdContainerHandler::boot_sector_declares_matching_size(
        513,
        100,
        HD_VOLUME_BYTES
    ));
    // A declared volume larger than the backing image is rejected.
    assert!(!ChdContainerHandler::boot_sector_declares_matching_size(
        512,
        101,
        HD_VOLUME_BYTES
    ));
    // The multiply must not overflow into a spurious "fits" result.
    assert!(!ChdContainerHandler::boot_sector_declares_matching_size(
        4096,
        u64::MAX,
        HD_VOLUME_BYTES
    ));
}

#[test]
fn has_valid_mbr_partition_table_accepts_and_rejects() {
    let handler = ChdContainerHandler;

    let mut sector = signed_sector();
    write_mbr_entry(&mut sector, 0, 0x80, 0x83, 1, 10);
    assert!(handler.has_valid_mbr_partition_table(&sector, HD_VOLUME_BYTES));

    // A protective-MBR GPT entry (type 0xEE) skips the end-bound check.
    let mut protective = signed_sector();
    write_mbr_entry(&mut protective, 0, 0x00, 0xEE, 1, u32::MAX);
    assert!(handler.has_valid_mbr_partition_table(&protective, HD_VOLUME_BYTES));

    // Missing boot signature.
    let mut unsigned = sector.clone();
    unsigned[511] = 0x00;
    assert!(!handler.has_valid_mbr_partition_table(&unsigned, HD_VOLUME_BYTES));

    // An all-zero table has no populated entries.
    assert!(!handler.has_valid_mbr_partition_table(&signed_sector(), HD_VOLUME_BYTES));

    // A bogus boot flag (neither 0x00 nor 0x80) is rejected.
    let mut bad_flag = signed_sector();
    write_mbr_entry(&mut bad_flag, 0, 0x01, 0x83, 1, 10);
    assert!(!handler.has_valid_mbr_partition_table(&bad_flag, HD_VOLUME_BYTES));

    // A start LBA past the end of the volume is rejected.
    let mut out_of_range = signed_sector();
    write_mbr_entry(&mut out_of_range, 0, 0x80, 0x83, 100, 1);
    assert!(!handler.has_valid_mbr_partition_table(&out_of_range, HD_VOLUME_BYTES));

    // A partition that runs past the end of the volume is rejected.
    let mut overruns = signed_sector();
    write_mbr_entry(&mut overruns, 0, 0x80, 0x83, 50, 60);
    assert!(!handler.has_valid_mbr_partition_table(&overruns, HD_VOLUME_BYTES));
}

/// Build a minimal GPT primary header sector that passes every field check.
fn valid_gpt_sector() -> Vec<u8> {
    let mut sector = vec![0_u8; ChdContainerHandler::HD_SECTOR_BYTES as usize];
    sector[..8].copy_from_slice(b"EFI PART");
    sector[12..16].copy_from_slice(&92_u32.to_le_bytes()); // header_bytes
    sector[24..32].copy_from_slice(&1_u64.to_le_bytes()); // current_lba == GPT_HEADER_LBA
    sector[32..40].copy_from_slice(&99_u64.to_le_bytes()); // backup_lba
    sector[40..48].copy_from_slice(&2_u64.to_le_bytes()); // first_usable_lba
    sector[48..56].copy_from_slice(&98_u64.to_le_bytes()); // last_usable_lba
    sector[72..80].copy_from_slice(&2_u64.to_le_bytes()); // partition_entry_lba
    sector[80..84].copy_from_slice(&128_u32.to_le_bytes()); // partition_entry_count
    sector[84..88].copy_from_slice(&128_u32.to_le_bytes()); // partition_entry_bytes
    sector
}

#[test]
fn has_valid_gpt_header_accepts_and_rejects() {
    let handler = ChdContainerHandler;
    assert!(handler.has_valid_gpt_header(&valid_gpt_sector(), HD_VOLUME_BYTES));

    // Wrong signature.
    let mut bad_magic = valid_gpt_sector();
    bad_magic[..8].copy_from_slice(b"NOT PART");
    assert!(!handler.has_valid_gpt_header(&bad_magic, HD_VOLUME_BYTES));

    // current_lba must be the canonical primary-header LBA of 1.
    let mut wrong_lba = valid_gpt_sector();
    wrong_lba[24..32].copy_from_slice(&2_u64.to_le_bytes());
    assert!(!handler.has_valid_gpt_header(&wrong_lba, HD_VOLUME_BYTES));

    // first_usable_lba may not exceed last_usable_lba.
    let mut inverted = valid_gpt_sector();
    inverted[40..48].copy_from_slice(&99_u64.to_le_bytes());
    assert!(!handler.has_valid_gpt_header(&inverted, HD_VOLUME_BYTES));

    // The partition-entry stride must be a multiple of eight and >= 128.
    let mut bad_stride = valid_gpt_sector();
    bad_stride[84..88].copy_from_slice(&130_u32.to_le_bytes());
    assert!(!handler.has_valid_gpt_header(&bad_stride, HD_VOLUME_BYTES));
}

/// Build a FAT boot sector that satisfies every BPB consistency check.
fn valid_fat_sector() -> Vec<u8> {
    let mut sector = signed_sector();
    sector[11..13].copy_from_slice(&512_u16.to_le_bytes()); // bytes_per_sector
    sector[13] = 8; // sectors_per_cluster (power of two)
    sector[14..16].copy_from_slice(&1_u16.to_le_bytes()); // reserved_sectors
    sector[16] = 2; // fat_count
    sector[19..21].copy_from_slice(&100_u16.to_le_bytes()); // total_sectors_16
    sector[22..24].copy_from_slice(&10_u16.to_le_bytes()); // sectors_per_fat_16
    sector
}

#[test]
fn has_valid_fat_boot_sector_accepts_and_rejects() {
    let handler = ChdContainerHandler;
    assert!(handler.has_valid_fat_boot_sector(&valid_fat_sector(), HD_VOLUME_BYTES));

    // sectors_per_cluster must be a power of two no larger than 128.
    let mut bad_cluster = valid_fat_sector();
    bad_cluster[13] = 3;
    assert!(!handler.has_valid_fat_boot_sector(&bad_cluster, HD_VOLUME_BYTES));

    // fat_count is only ever one or two.
    let mut bad_fats = valid_fat_sector();
    bad_fats[16] = 3;
    assert!(!handler.has_valid_fat_boot_sector(&bad_fats, HD_VOLUME_BYTES));

    // Neither 16- nor 32-bit FAT size set.
    let mut no_fat_size = valid_fat_sector();
    no_fat_size[22..24].copy_from_slice(&0_u16.to_le_bytes());
    assert!(!handler.has_valid_fat_boot_sector(&no_fat_size, HD_VOLUME_BYTES));

    // The 32-bit total-sector count is consulted when the 16-bit field is zero.
    let mut wide = valid_fat_sector();
    wide[19..21].copy_from_slice(&0_u16.to_le_bytes());
    wide[32..36].copy_from_slice(&100_u32.to_le_bytes());
    assert!(handler.has_valid_fat_boot_sector(&wide, HD_VOLUME_BYTES));
}

/// Build an NTFS boot sector that satisfies every check.
fn valid_ntfs_sector() -> Vec<u8> {
    let mut sector = signed_sector();
    sector[3..11].copy_from_slice(b"NTFS    ");
    sector[11..13].copy_from_slice(&512_u16.to_le_bytes()); // bytes_per_sector
    sector[13] = 8; // sectors_per_cluster
    sector[40..48].copy_from_slice(&100_u64.to_le_bytes()); // total_sectors
    sector[48..56].copy_from_slice(&4_u64.to_le_bytes()); // mft_cluster
    sector
}

#[test]
fn has_valid_ntfs_boot_sector_accepts_and_rejects() {
    let handler = ChdContainerHandler;
    assert!(handler.has_valid_ntfs_boot_sector(&valid_ntfs_sector(), HD_VOLUME_BYTES));

    // The "NTFS    " OEM tag is mandatory.
    let mut bad_oem = valid_ntfs_sector();
    bad_oem[3..11].copy_from_slice(b"FAT     ");
    assert!(!handler.has_valid_ntfs_boot_sector(&bad_oem, HD_VOLUME_BYTES));

    // A zero MFT cluster is never valid.
    let mut no_mft = valid_ntfs_sector();
    no_mft[48..56].copy_from_slice(&0_u64.to_le_bytes());
    assert!(!handler.has_valid_ntfs_boot_sector(&no_mft, HD_VOLUME_BYTES));
}

/// Build an exFAT boot sector that satisfies every check. exFAT mandates that
/// bytes 11..64 stay zero, so the geometry lives entirely past offset 64.
fn valid_exfat_sector() -> Vec<u8> {
    let mut sector = signed_sector();
    sector[3..11].copy_from_slice(b"EXFAT   ");
    sector[72..80].copy_from_slice(&100_u64.to_le_bytes()); // volume_length (sectors)
    sector[80..84].copy_from_slice(&1_u32.to_le_bytes()); // fat_offset
    sector[84..88].copy_from_slice(&1_u32.to_le_bytes()); // fat_length
    sector[88..92].copy_from_slice(&10_u32.to_le_bytes()); // cluster_heap_offset
    sector[92..96].copy_from_slice(&80_u32.to_le_bytes()); // cluster_count
    sector[108] = 9; // bytes_per_sector_shift -> 512
    sector[109] = 4; // sectors_per_cluster_shift
    sector
}

#[test]
fn has_valid_exfat_boot_sector_accepts_and_rejects() {
    let handler = ChdContainerHandler;
    assert!(handler.has_valid_exfat_boot_sector(&valid_exfat_sector(), HD_VOLUME_BYTES));

    // The reserved 11..64 region must be all zero.
    let mut dirty_reserved = valid_exfat_sector();
    dirty_reserved[20] = 0x01;
    assert!(!handler.has_valid_exfat_boot_sector(&dirty_reserved, HD_VOLUME_BYTES));

    // The FAT region must fit within the declared volume length.
    let mut fat_overrun = valid_exfat_sector();
    fat_overrun[84..88].copy_from_slice(&200_u32.to_le_bytes());
    assert!(!handler.has_valid_exfat_boot_sector(&fat_overrun, HD_VOLUME_BYTES));

    // A bytes-per-sector shift outside 512..=4096 is rejected.
    let mut huge_sector = valid_exfat_sector();
    huge_sector[108] = 13; // 1 << 13 == 8192
    assert!(!handler.has_valid_exfat_boot_sector(&huge_sector, HD_VOLUME_BYTES));
}

#[test]
fn has_known_volume_boot_sector_recognizes_each_filesystem() {
    let handler = ChdContainerHandler;
    assert!(handler.has_known_volume_boot_sector(&valid_fat_sector(), HD_VOLUME_BYTES));
    assert!(handler.has_known_volume_boot_sector(&valid_ntfs_sector(), HD_VOLUME_BYTES));
    assert!(handler.has_known_volume_boot_sector(&valid_exfat_sector(), HD_VOLUME_BYTES));
    // A signed-but-empty sector matches no known filesystem.
    assert!(!handler.has_known_volume_boot_sector(&signed_sector(), HD_VOLUME_BYTES));
}

#[test]
fn should_auto_infer_single_track_cd_keys_on_extension() {
    let handler = ChdContainerHandler;
    assert!(handler.should_auto_infer_single_track_cd(Path::new("game.bin")));
    assert!(handler.should_auto_infer_single_track_cd(Path::new("game.ISO")));
    assert!(handler.should_auto_infer_single_track_cd(Path::new("disc")));
    assert!(!handler.should_auto_infer_single_track_cd(Path::new("game.cue")));
    assert!(!handler.should_auto_infer_single_track_cd(Path::new("game.img")));
}

#[test]
fn is_cd_sized_iso_bounds_only_iso_inputs() {
    let handler = ChdContainerHandler;
    let max_iso_bytes = ChdContainerHandler::CD_ISO_MAX_FRAMES * 2048;
    // Non-iso extensions are never size-bounded.
    assert!(handler.is_cd_sized_iso(Path::new("game.bin"), max_iso_bytes + 1));
    // An iso at or under the CD ceiling passes.
    assert!(handler.is_cd_sized_iso(Path::new("game.iso"), max_iso_bytes));
    // An iso above the CD ceiling is a DVD-sized image, not a CD.
    assert!(!handler.is_cd_sized_iso(Path::new("game.iso"), max_iso_bytes + 1));
}

#[test]
fn parse_create_mode_override_maps_known_modes() {
    let handler = ChdContainerHandler;
    assert_eq!(handler.parse_create_mode_override("chd").unwrap(), None);
    // Parsing is case- and whitespace-insensitive.
    assert_eq!(
        handler.parse_create_mode_override("  CHD-CD ").unwrap(),
        Some(ChdCreateModeOverride::Cd)
    );
    assert_eq!(
        handler.parse_create_mode_override("chd-hd").unwrap(),
        Some(ChdCreateModeOverride::HardDisk)
    );
    // `av` and `ld` are aliases for the same audio/video mode.
    assert_eq!(
        handler.parse_create_mode_override("chd-av").unwrap(),
        Some(ChdCreateModeOverride::Av)
    );
    assert_eq!(
        handler.parse_create_mode_override("chd-ld").unwrap(),
        Some(ChdCreateModeOverride::Av)
    );
    // A format lacking the `chd-` prefix and an unknown mode both error.
    assert!(handler.parse_create_mode_override("zip").is_err());
    assert!(handler.parse_create_mode_override("chd-xyz").is_err());
}

// --- Create-kind / media mapping -------------------------------------------

#[test]
fn media_kind_and_label_cover_each_create_kind() {
    let handler = ChdContainerHandler;
    let cd = ChdCreateKind::Disc(DiscLayout {
        kind: DiscKind::CdRom,
        tracks: Vec::new(),
    });
    let gd = ChdCreateKind::Disc(DiscLayout {
        kind: DiscKind::GdRom,
        tracks: Vec::new(),
    });
    let hd = ChdCreateKind::HardDisk(HdGeometry {
        cylinders: 1,
        heads: 1,
        sectors: 1,
        bytes_per_sector: 512,
    });

    assert_eq!(
        handler.media_kind_from_create_kind(&ChdCreateKind::Raw),
        ChdMediaKind::Raw
    );
    assert_eq!(
        handler.media_kind_from_create_kind(&hd),
        ChdMediaKind::HardDisk
    );
    assert_eq!(
        handler.media_kind_from_create_kind(&ChdCreateKind::Dvd),
        ChdMediaKind::Dvd
    );
    assert_eq!(
        handler.media_kind_from_create_kind(&cd),
        ChdMediaKind::CdRom
    );
    assert_eq!(
        handler.media_kind_from_create_kind(&gd),
        ChdMediaKind::GdRom
    );

    assert_eq!(handler.media_label(ChdMediaKind::Raw), "raw");
    assert_eq!(handler.media_label(ChdMediaKind::HardDisk), "hd");
    assert_eq!(handler.media_label(ChdMediaKind::CdRom), "cd");
    assert_eq!(handler.media_label(ChdMediaKind::GdRom), "gd");
    assert_eq!(handler.media_label(ChdMediaKind::Dvd), "dvd");
    assert_eq!(handler.media_label(ChdMediaKind::Av), "av");
}

#[test]
fn supports_create_codec_is_scoped_per_media() {
    let handler = ChdContainerHandler;
    let disc = ChdCreateKind::Disc(DiscLayout {
        kind: DiscKind::CdRom,
        tracks: Vec::new(),
    });
    let av = ChdCreateKind::Av(AvProfile {
        frame_bytes: 0,
        fps: 0,
        fpsfrac: 0,
        width: 0,
        height: 0,
        interlaced: 0,
        channels: 0,
        sample_rate: 0,
    });

    // Raw media accepts the general-purpose codecs but not the CD variants.
    assert!(handler.supports_create_codec(&ChdCreateKind::Raw, ChdCodec::LZMA));
    assert!(handler.supports_create_codec(&ChdCreateKind::Raw, ChdCodec::NONE));
    assert!(!handler.supports_create_codec(&ChdCreateKind::Raw, ChdCodec::CD_LZMA));
    assert!(!handler.supports_create_codec(&ChdCreateKind::Raw, ChdCodec::AVHUFF));

    // Disc media only accepts the CD-framed codecs (plus store).
    assert!(handler.supports_create_codec(&disc, ChdCodec::CD_FLAC));
    assert!(handler.supports_create_codec(&disc, ChdCodec::NONE));
    assert!(!handler.supports_create_codec(&disc, ChdCodec::LZMA));

    // AV media is store-or-avhuff only.
    assert!(handler.supports_create_codec(&av, ChdCodec::AVHUFF));
    assert!(handler.supports_create_codec(&av, ChdCodec::NONE));
    assert!(!handler.supports_create_codec(&av, ChdCodec::ZSTD));
}

#[test]
fn supports_rust_encode_codec_excludes_store() {
    let handler = ChdContainerHandler;
    let disc = ChdCreateKind::Disc(DiscLayout {
        kind: DiscKind::CdRom,
        tracks: Vec::new(),
    });

    // `supports_rust_encode_codec` is the encode-capable subset: it drops NONE,
    // which `supports_create_codec` allows as the store passthrough.
    assert!(handler.supports_create_codec(&ChdCreateKind::Raw, ChdCodec::NONE));
    assert!(!handler.supports_rust_encode_codec(&ChdCreateKind::Raw, ChdCodec::NONE));
    assert!(handler.supports_rust_encode_codec(&ChdCreateKind::Raw, ChdCodec::FLAC));
    assert!(handler.supports_rust_encode_codec(&disc, ChdCodec::CD_ZSTD));
    assert!(!handler.supports_rust_encode_codec(&disc, ChdCodec::ZSTD));
}

#[test]
fn normalize_compression_plan_maps_disc_codecs_only() {
    let handler = ChdContainerHandler;
    let plan = ChdCompressionPlan {
        codecs: [
            ChdCodec::LZMA,
            ChdCodec::ZSTD,
            ChdCodec::NONE,
            ChdCodec::NONE,
        ],
        primary_codec: ChdCodec::LZMA,
    };

    // Raw media leaves the plan untouched.
    let raw = handler.normalize_compression_plan_for_create_kind(&ChdCreateKind::Raw, plan);
    assert_eq!(raw, plan);

    // Disc media rewrites the general codecs to their CD-framed counterparts.
    let disc_kind = ChdCreateKind::Disc(DiscLayout {
        kind: DiscKind::CdRom,
        tracks: Vec::new(),
    });
    let disc = handler.normalize_compression_plan_for_create_kind(&disc_kind, plan);
    assert_eq!(disc.primary_codec, ChdCodec::CD_LZMA);
    assert_eq!(disc.codecs[0], ChdCodec::CD_LZMA);
    assert_eq!(disc.codecs[1], ChdCodec::CD_ZSTD);
    assert_eq!(disc.codecs[2], ChdCodec::NONE);
}

// --- Disc layout + track-mode tables ---------------------------------------

/// Build a CD-ROM data track holding `frames` unpadded frames.
fn cd_track(number: u32, mode: DiscTrackMode, frames: u32) -> DiscTrack {
    DiscTrack {
        number,
        mode,
        file_path: std::path::PathBuf::new(),
        memory_source: None,
        file_offset_bytes: 0,
        frames,
        pregap_frames: 0,
        postgap_frames: 0,
        pregap_has_data: false,
        has_subcode: false,
        pad_frames: 0,
        swap_audio_on_read: false,
    }
}

#[test]
fn disc_layout_logical_bytes_sums_padded_frames() {
    let layout = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: vec![
            cd_track(1, DiscTrackMode::Mode1Raw, 10),
            cd_track(2, DiscTrackMode::Audio, 5),
        ],
    };
    // Each frame is CD_FRAME_BYTES regardless of the track's logical mode.
    let expected = 15 * u64::from(ChdContainerHandler::CD_FRAME_BYTES);
    assert_eq!(layout.logical_bytes().unwrap(), expected);

    // An empty layout has zero logical bytes.
    let empty = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: Vec::new(),
    };
    assert_eq!(empty.logical_bytes().unwrap(), 0);
}

#[test]
fn apply_cd_track_padding_rounds_frames_to_multiple() {
    // 10 frames pads up to the next multiple of four (12), recording 2 pad frames.
    let mut layout = DiscLayout {
        kind: DiscKind::CdRom,
        tracks: vec![
            cd_track(1, DiscTrackMode::Mode1Raw, 10),
            cd_track(2, DiscTrackMode::Mode1Raw, 8),
        ],
    };
    layout.apply_cd_track_padding();
    assert_eq!(
        (layout.tracks[0].frames, layout.tracks[0].pad_frames),
        (12, 2)
    );
    // An already-aligned track gains no padding.
    assert_eq!(
        (layout.tracks[1].frames, layout.tracks[1].pad_frames),
        (8, 0)
    );

    // GD-ROM carries explicit pad metadata, so the helper is a no-op there.
    let mut gd = DiscLayout {
        kind: DiscKind::GdRom,
        tracks: vec![cd_track(1, DiscTrackMode::Mode1Raw, 10)],
    };
    gd.apply_cd_track_padding();
    assert_eq!((gd.tracks[0].frames, gd.tracks[0].pad_frames), (10, 0));
}

#[test]
fn disc_kind_metadata_tag_matches_mame_fourcc() {
    assert_eq!(DiscKind::CdRom.metadata_tag().to_be_bytes(), *b"CHT2");
    assert_eq!(DiscKind::GdRom.metadata_tag().to_be_bytes(), *b"CHGD");
}

#[test]
fn disc_track_mode_label_tables_are_exhaustive() {
    assert_eq!(DiscTrackMode::Mode1.cue_label(), "MODE1/2048");
    assert_eq!(DiscTrackMode::Mode2Raw.cue_label(), "MODE2/2352");
    assert_eq!(DiscTrackMode::Audio.cue_label(), "AUDIO");

    assert_eq!(DiscTrackMode::Mode1Raw.metadata_label(), "MODE1_RAW");
    assert_eq!(
        DiscTrackMode::Mode2FormMix.metadata_label(),
        "MODE2_FORM_MIX"
    );

    // Raw modes collapse to their cooked label inside pregap metadata.
    assert_eq!(DiscTrackMode::Mode1Raw.pregap_metadata_label(), "MODE1");
    assert_eq!(DiscTrackMode::Mode2Raw.pregap_metadata_label(), "MODE2");
    assert_eq!(DiscTrackMode::Mode1.pregap_metadata_label(), "MODE1");

    assert_eq!(DiscTrackMode::Mode1.data_bytes(), 2048);
    assert_eq!(DiscTrackMode::Mode2.data_bytes(), 2336);
    assert_eq!(DiscTrackMode::Mode2Form2.data_bytes(), 2324);
    assert_eq!(DiscTrackMode::Audio.data_bytes(), 2352);
}

#[test]
fn gdi_track_descriptor_supports_only_gdrom_modes() {
    assert_eq!(
        DiscTrackMode::Mode1Raw.gdi_track_descriptor().unwrap(),
        (4, 2352)
    );
    assert_eq!(
        DiscTrackMode::Mode1.gdi_track_descriptor().unwrap(),
        (4, 2048)
    );
    assert_eq!(
        DiscTrackMode::Audio.gdi_track_descriptor().unwrap(),
        (0, 2352)
    );
    // GD-ROM output rejects the Mode2 family.
    assert!(DiscTrackMode::Mode2.gdi_track_descriptor().is_err());
    assert!(DiscTrackMode::Mode2Form1.gdi_track_descriptor().is_err());
}

#[test]
fn swap_audio_bytes_only_swaps_audio_tracks() {
    let mut audio = [0x11, 0x22, 0x33, 0x44];
    DiscTrackMode::Audio.swap_audio_bytes(&mut audio);
    assert_eq!(audio, [0x22, 0x11, 0x44, 0x33]);

    // A trailing odd byte is left in place by `chunks_exact`.
    let mut odd = [0x11, 0x22, 0x33];
    DiscTrackMode::Audio.swap_audio_bytes(&mut odd);
    assert_eq!(odd, [0x22, 0x11, 0x33]);

    // Data tracks are never byte-swapped.
    let mut data = [0x11, 0x22, 0x33, 0x44];
    DiscTrackMode::Mode1Raw.swap_audio_bytes(&mut data);
    assert_eq!(data, [0x11, 0x22, 0x33, 0x44]);
}

// --- MSB bit writer + token parsing ----------------------------------------

#[test]
fn msb_bit_writer_packs_most_significant_first() {
    // Whole bytes pass straight through in order.
    let mut writer = MsbBitWriter::new();
    writer.write_bits(0xAB, 8);
    writer.write_bits(0xCD, 8);
    assert_eq!(writer.finish(), vec![0xAB, 0xCD]);

    // Sub-byte writes land in the high bits and a zero-width write is a no-op.
    let mut partial = MsbBitWriter::new();
    partial.write_bits(0b110, 3);
    partial.write_bits(0, 0);
    partial.align_to_byte();
    assert_eq!(partial.finish(), vec![0b1100_0000]);

    // Aligning an already byte-aligned writer adds nothing.
    let mut aligned = MsbBitWriter::new();
    aligned.write_bits(0xFF, 8);
    aligned.align_to_byte();
    assert_eq!(aligned.finish(), vec![0xFF]);

    // Bits spanning a byte boundary split across two bytes.
    let mut spanning = MsbBitWriter::new();
    spanning.write_bits(0b1111, 4);
    spanning.write_bits(0b1111, 4);
    spanning.write_bits(0b1, 1);
    spanning.align_to_byte();
    assert_eq!(spanning.finish(), vec![0xFF, 0b1000_0000]);
}

#[test]
fn split_token_handles_quotes_and_whitespace() {
    assert_eq!(split_token("hello world"), Some(("hello", " world")));
    // Leading whitespace is trimmed before the split.
    assert_eq!(split_token("   solo"), Some(("solo", "")));
    // Quoted tokens may contain spaces and stop at the closing quote.
    assert_eq!(
        split_token("\"two words\" tail"),
        Some(("two words", " tail"))
    );
    // Empty and whitespace-only inputs yield no token.
    assert_eq!(split_token(""), None);
    assert_eq!(split_token("    "), None);
    // An unterminated quote yields no token.
    assert_eq!(split_token("\"oops"), None);
}

// --- FLAC config + avhuff frame encoders -----------------------------------

#[test]
fn build_flac_encoder_config_maps_levels() {
    let handler = ChdContainerHandler;

    // Non-positive levels return the library default untouched.
    let default_lpc_order = flacenc::config::Encoder::default()
        .subframe_coding
        .qlpc
        .lpc_order;
    let zero = handler.build_flac_encoder_config(0);
    assert_eq!(zero.subframe_coding.qlpc.lpc_order, default_lpc_order);
    let negative = handler.build_flac_encoder_config(-5);
    assert_eq!(negative.subframe_coding.qlpc.lpc_order, default_lpc_order);

    // Level 1 is the fixed-only, no-LPC tier.
    let level1 = handler.build_flac_encoder_config(1);
    assert!(!level1.stereo_coding.use_midside);
    assert!(!level1.subframe_coding.use_lpc);
    assert_eq!(level1.subframe_coding.fixed.max_order, 1);
    assert_eq!(level1.subframe_coding.qlpc.lpc_order, 6);
    assert_eq!(level1.subframe_coding.prc.max_parameter, 9);

    // Level 3 turns on mid-side and LPC.
    let level3 = handler.build_flac_encoder_config(3);
    assert!(level3.stereo_coding.use_midside);
    assert!(level3.subframe_coding.use_lpc);
    assert_eq!(level3.subframe_coding.qlpc.lpc_order, 8);

    // Levels above the maximum clamp to the level-9 mapping.
    let level9 = handler.build_flac_encoder_config(9);
    let clamped = handler.build_flac_encoder_config(50);
    assert_eq!(level9.subframe_coding.qlpc.lpc_order, 24);
    assert_eq!(
        clamped.subframe_coding.qlpc.lpc_order,
        level9.subframe_coding.qlpc.lpc_order
    );
    assert_eq!(
        clamped.subframe_coding.prc.max_parameter,
        level9.subframe_coding.prc.max_parameter
    );
}

#[test]
fn encode_avhuff_video_payload_validates_dimensions() {
    let handler = ChdContainerHandler;

    // A zero dimension yields the single-byte "no video" marker.
    assert_eq!(
        handler.encode_avhuff_video_payload(0, 4, &[]).unwrap(),
        vec![0x80]
    );
    assert_eq!(
        handler.encode_avhuff_video_payload(4, 0, &[]).unwrap(),
        vec![0x80]
    );

    // An odd frame width is rejected outright.
    assert!(handler.encode_avhuff_video_payload(3, 1, &[]).is_err());

    // The payload length must equal width * height * 2.
    assert!(handler.encode_avhuff_video_payload(2, 1, &[0; 3]).is_err());

    // A correctly sized frame encodes and leads with the 0x80 frame marker.
    let encoded = handler.encode_avhuff_video_payload(2, 1, &[0; 4]).unwrap();
    assert_eq!(encoded.first(), Some(&0x80));
    assert!(encoded.len() > 1);
}

#[test]
fn encode_avhuff_chav_hunk_validates_and_emits_header() {
    let handler = ChdContainerHandler;

    // Too short / wrong magic are rejected before any geometry is read.
    assert!(handler.encode_avhuff_chav_hunk(&[0; 8]).is_err());
    let mut bad_magic = vec![0_u8; 14];
    bad_magic[..4].copy_from_slice(b"xxxx");
    assert!(handler.encode_avhuff_chav_hunk(&bad_magic).is_err());

    // A header whose declared sizes disagree with the payload length errors.
    let mut mismatched = vec![0_u8; 12];
    mismatched[..4].copy_from_slice(b"chav");
    mismatched[5] = 1; // channels
    mismatched[6..8].copy_from_slice(&1_u16.to_be_bytes()); // samples
    assert!(handler.encode_avhuff_chav_hunk(&mismatched).is_err());

    // A minimal valid frame: no metadata, one channel, one sample, no video.
    // expected_len = 12 header + (1 channel * 1 sample * 2) audio = 14 bytes.
    let mut hunk = vec![0_u8; 14];
    hunk[..4].copy_from_slice(b"chav");
    hunk[4] = 0; // metadata_size
    hunk[5] = 1; // channels
    hunk[6..8].copy_from_slice(&1_u16.to_be_bytes()); // samples
    hunk[8..10].copy_from_slice(&0_u16.to_be_bytes()); // width
    hunk[10..12].copy_from_slice(&0_u16.to_be_bytes()); // height
    hunk[12..14].copy_from_slice(&[0x12, 0x34]); // single audio sample

    let encoded = handler.encode_avhuff_chav_hunk(&hunk).unwrap();
    // Header echo: metadata_size, channels, samples, width, height, tree size 0,
    // then the per-channel byte count (2); the first sample's delta from zero is
    // the sample itself, and the empty-video payload is the lone 0x80 marker.
    assert_eq!(
        encoded,
        vec![0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0x12, 0x34, 0x80]
    );
}
