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
