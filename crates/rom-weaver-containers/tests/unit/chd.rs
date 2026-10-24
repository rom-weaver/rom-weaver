//! Unit coverage for the CHD module internals.
//!
//! Exercises the `pub(super)` primitives behind CHD's byte-parity guarantees
//! (V5 compressed-map huffman/RLE/CRC, CD sector ECC) plus codec-routing edge
//! branches unreachable through the public `*_for_tests` helpers, so a
//! regression fails here instead of as a deep round-trip parity mismatch.

use super::*;
use crate::chd_rs::cdrom::CD_MAX_SECTOR_DATA;
use crate::chd_rs::compression::ecc::ErrorCorrectedSector;

#[test]
fn split_checksum_workers_share_the_operation_thread_budget() {
    assert_eq!(disc_extract::split_checksum_thread_budget(10, 8), 1);
    assert_eq!(disc_extract::split_checksum_thread_budget(10, 4), 2);
    assert_eq!(disc_extract::split_checksum_thread_budget(10, 3), 3);
}

// --- CD sector ECC ---------------------------------------------------------

/// MAME CD sync header that prefixes every reconstructable 2352-byte sector.
const SYNC_HEADER: [u8; 12] = [
    0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00,
];

/// Build a Mode 1 raw sector with a deterministic data payload and freshly
/// generated P/Q ECC so it round-trips through verification.
fn mode1_sector_with_ecc() -> [u8; CD_MAX_SECTOR_DATA as usize] {
    let mut sector = [0_u8; CD_MAX_SECTOR_DATA as usize];
    sector[..12].copy_from_slice(&SYNC_HEADER);
    sector[0x0f] = 1; // Mode 1.
    for (index, byte) in sector.iter_mut().enumerate().skip(16) {
        *byte = (index % 251) as u8;
    }
    (&mut sector).generate_ecc();
    sector
}

/// `ErrorCorrectedSector` is implemented for `&mut` sectors only.
fn verify_ecc(sector: &mut [u8; CD_MAX_SECTOR_DATA as usize]) -> bool {
    sector.verify_ecc()
}

/// Known-answer P/Q parity (bytes 0x81c..0x930) for `mode1_sector_with_ecc()`,
/// computed independently of chd_rs from the ECMA-130 Annex A definition
/// (GF(2^8) with polynomial 0x11d; P over 86 columns of 24 bytes, Q over 52
/// diagonals of 43 bytes including P), so a wrong chd_rs table entry fails here.
const MODE1_SECTOR_P_PARITY_HEX: &str = "3edcdd22e3cd2df9b58ad5a692e7c0498fbdab99d967e8bbc414b0e6cef051a1055fb27d43671e3bc8eef19a5ea7d0744ea5216804937ba7b5e013f11f2cbde97000c1d79371aa1b0db38a0a07408c66fcf95b526ecafa718b1cdbcd15c9ed2a1d767a0728b987dd28347eda4beefbca4e24142677f3b4cc03e2d2f4ff37e4e2ddae6a930fb5ad64c699f7996999abda31a7b28b305ae58f243f73896af3fd2bea726728cc3ecc31fbface52";
const MODE1_SECTOR_Q_PARITY_HEX: &str = "4c3f271c197053de2091bfdaa7d92aeeaa2bc0963e3392a4781bb837ccedcd8609c74203412e5e471406a32fbcbd3924465714d6a160eb5e3d38f5e924c3fce916676b4163ffb5e1fc72c7857c173c63f81bc27b8f111e63ee1d57832e32afeccaff86f02b377e14";

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex digit pair"))
        .collect()
}

#[test]
fn cd_sector_ecc_matches_known_answer_parity() {
    let sector = mode1_sector_with_ecc();
    assert_eq!(
        &sector[0x81c..0x81c + 172],
        hex_bytes(MODE1_SECTOR_P_PARITY_HEX)
    );
    assert_eq!(&sector[0x81c + 172..], hex_bytes(MODE1_SECTOR_Q_PARITY_HEX));
}

#[test]
fn cd_sector_ecc_round_trips_through_verification() {
    let mut sector = mode1_sector_with_ecc();
    assert!(verify_ecc(&mut sector));
}

#[test]
fn cd_sector_ecc_rejects_corrupted_payload() {
    let mut sector = mode1_sector_with_ecc();
    // Flip a byte inside the ECC-covered data region.
    sector[100] ^= 0xff;
    assert!(!verify_ecc(&mut sector));
}

#[test]
fn cd_sector_ecc_ignores_sync_header() {
    let mut sector = mode1_sector_with_ecc();
    // ECC covers only the bytes after the sync header, so clearing it leaves
    // the ECC valid; callers check the header separately.
    sector[1] = 0;
    assert!(verify_ecc(&mut sector));
}

#[test]
fn cd_sector_clear_ecc_zeroes_only_ecc() {
    let mut sector = mode1_sector_with_ecc();
    let before = sector;
    (&mut sector).clear_ecc();
    assert!(sector[0x81c..].iter().all(|byte| *byte == 0));
    // Sync header and user data are left intact.
    assert_eq!(&sector[..0x81c], &before[..0x81c]);
    assert!(!verify_ecc(&mut sector));
}

// --- V5 compressed-map CRC and integer writers -----------------------------

// --- V5 compressed-map huffman / RLE ---------------------------------------

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
fn msf_parsing_rejects_minute_overflow() {
    let handler = ChdContainerHandler;
    // The frame total is `minutes * 4500 + ...`; it overflows u32 at 954438
    // minutes. An attacker-controllable cue must error rather than wrap.
    assert!(handler.parse_msf("954437:00:00").is_ok());
    let err = handler.parse_msf("954438:00:00").unwrap_err();
    assert!(
        err.to_string().contains("out of range"),
        "unexpected error: {err}"
    );
    // u32::MAX minutes (far past the limit) must not panic on overflow.
    assert!(handler.parse_msf("4294967295:00:00").is_err());
}

#[test]
fn parse_wave_file_rejects_oversized_fmt_chunk() {
    let handler = ChdContainerHandler;
    let path = crate::test_support::TempPath::new(std::env::temp_dir().join(format!(
        "rw-chd-unit-{}-oversized-fmt.wav",
        std::process::id()
    )));

    // A valid RIFF/WAVE header followed by a fmt chunk that declares a ~4 GiB
    // length. The parser must reject it before allocating a read buffer.
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&0xFFFF_FFF0_u32.to_le_bytes());
    std::fs::write(&path, &bytes).unwrap();

    let err = handler.parse_wave_file(&path).unwrap_err();
    let _ = std::fs::remove_file(&path);
    assert!(
        err.to_string().contains("fmt chunk"),
        "unexpected error: {err}"
    );
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

// --- V5 header / metadata builders -----------------------------------------

fn v5_header_for_map_test(
    logical_bytes: u64,
    map_offset: u64,
    hunk_bytes: u32,
    compressed: bool,
) -> [u8; 124] {
    let mut header = [0_u8; 124];
    header[0..8].copy_from_slice(&CHD_SIGNATURE);
    header[8..12].copy_from_slice(&124_u32.to_be_bytes());
    header[12..16].copy_from_slice(&5_u32.to_be_bytes());
    if compressed {
        header[16..20].copy_from_slice(&ChdCodec::ZLIB.raw().to_be_bytes());
    }
    header[32..40].copy_from_slice(&logical_bytes.to_be_bytes());
    header[40..48].copy_from_slice(&map_offset.to_be_bytes());
    header[56..60].copy_from_slice(&hunk_bytes.to_be_bytes());
    header[60..64].copy_from_slice(&1_u32.to_be_bytes());
    header
}

#[test]
fn v5_map_preflight_rejects_impossible_uncompressed_map_before_open() {
    let bytes = v5_header_for_map_test(1 << 28, 124, 1, false);
    let error = ChdReadSession::validate_v5_map_allocation(
        &mut Cursor::new(bytes),
        Path::new("hostile.chd"),
        124,
    )
    .unwrap_err();
    assert!(
        error.contains("past the 124-byte file"),
        "unexpected error: {error}"
    );
}

#[test]
fn v5_map_preflight_rejects_uncompressed_map_past_eof() {
    let bytes = v5_header_for_map_test(4, 124, 1, false);
    let error = ChdReadSession::validate_v5_map_allocation(
        &mut Cursor::new(bytes),
        Path::new("truncated-map.chd"),
        124,
    )
    .unwrap_err();
    assert!(
        error.contains("past the 124-byte file"),
        "unexpected error: {error}"
    );
}

#[test]
fn v5_map_preflight_rejects_oversized_compressed_map_expansion() {
    let mut bytes = v5_header_for_map_test(1 << 28, 124, 1, true).to_vec();
    bytes.extend_from_slice(&[0_u8; 16]);
    let file_len = bytes.len() as u64;
    let error = ChdReadSession::validate_v5_map_allocation(
        &mut Cursor::new(bytes),
        Path::new("hostile-compressed.chd"),
        file_len,
    )
    .unwrap_err();
    assert!(
        error.contains("can encode at most 0"),
        "unexpected error: {error}"
    );
}

#[test]
fn v5_map_preflight_rejects_compressed_payload_past_eof() {
    let mut bytes = v5_header_for_map_test(1, 124, 1, true).to_vec();
    bytes.extend_from_slice(&32_u32.to_be_bytes());
    bytes.extend_from_slice(&[0_u8; 12]);
    let file_len = bytes.len() as u64;
    let error = ChdReadSession::validate_v5_map_allocation(
        &mut Cursor::new(bytes),
        Path::new("truncated-compressed-map.chd"),
        file_len,
    )
    .unwrap_err();
    assert!(
        error.contains("past the 140-byte file"),
        "unexpected error: {error}"
    );
}

#[test]
fn v5_map_preflight_allows_compressed_expansion_larger_than_file() {
    let mut bytes = v5_header_for_map_test(4384, 124, 1, true).to_vec();
    bytes.extend_from_slice(&2_u32.to_be_bytes());
    bytes.extend_from_slice(&[0_u8; 12]);
    bytes.extend_from_slice(&[0_u8; 2]);
    let file_len = bytes.len() as u64;
    ChdReadSession::validate_v5_map_allocation(
        &mut Cursor::new(bytes),
        Path::new("valid-span.chd"),
        file_len,
    )
    .unwrap();
}

#[test]
fn v5_map_preflight_rejects_hunk_count_above_encoding_boundary() {
    let mut bytes = v5_header_for_map_test(4385, 124, 1, true).to_vec();
    bytes.extend_from_slice(&2_u32.to_be_bytes());
    bytes.extend_from_slice(&[0_u8; 12]);
    bytes.extend_from_slice(&[0_u8; 2]);
    let file_len = bytes.len() as u64;
    let error = ChdReadSession::validate_v5_map_allocation(
        &mut Cursor::new(bytes),
        Path::new("impossible-expansion.chd"),
        file_len,
    )
    .unwrap_err();
    assert!(
        error.contains("can encode at most 4384"),
        "unexpected error: {error}"
    );
}

#[test]
fn v5_map_preflight_accepts_in_file_uncompressed_map() {
    let mut bytes = v5_header_for_map_test(4, 124, 1, false).to_vec();
    bytes.extend_from_slice(&[0_u8; 16]);
    let file_len = bytes.len() as u64;
    ChdReadSession::validate_v5_map_allocation(
        &mut Cursor::new(bytes),
        Path::new("valid-uncompressed.chd"),
        file_len,
    )
    .unwrap();
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
fn hunk_bytes_uses_chdman_hunk_sizes() {
    let handler = ChdContainerHandler;
    // Non-disc media uses the default hunk size.
    assert_eq!(handler.hunk_bytes(&ChdCreateKind::Raw), 4096);
    let disc = ChdCreateKind::Disc(DiscLayout {
        kind: DiscKind::CdRom,
        tracks: Vec::new(),
    });
    // chdman 0.289 `createcd` always writes 8-frame hunks, even for a disc
    // shorter than one hunk (verified for 1..16 frames with cdlz).
    assert_eq!(handler.hunk_bytes(&disc), 19584);
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

/// Runs the shared cases on the same prefix the webapp used to check itself.
#[test]
fn hard_disk_headers_match_the_shared_cases() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/chd-hard-disk-headers.json"))
            .expect("hard-disk header cases");
    let handler = ChdContainerHandler;
    let path = crate::test_support::TempPath::new(std::env::temp_dir().join(format!(
        "rw-chd-unit-{}-hard-disk-header.img",
        std::process::id()
    )));
    for case in cases.as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let size = case["size"].as_u64().expect("size");
        let mut prefix = vec![0_u8; 1024];
        for write in case["writes"].as_array().expect("writes") {
            let at = usize::try_from(write["at"].as_u64().expect("at")).expect("offset");
            let hex = write["hex"].as_str().expect("hex");
            for (index, pair) in hex.as_bytes().chunks(2).enumerate() {
                let pair = std::str::from_utf8(pair).expect("ascii hex");
                prefix[at + index] = u8::from_str_radix(pair, 16).expect("hex byte");
            }
        }
        // The webapp reads at most the first two sectors of the image.
        prefix.truncate(usize::try_from(size.min(1024)).expect("prefix length"));
        std::fs::write(&path, &prefix).expect("write prefix");
        assert_eq!(
            handler.should_auto_infer_hard_disk(&path, size),
            case["hardDisk"].as_bool().expect("hardDisk"),
            "{name}"
        );
    }
}

/// Writes `bytes` to a scratch file named `name` and returns the auto-inferred create mode.
fn auto_create_mode(name: &str, bytes: &[u8]) -> Option<&'static str> {
    let path = crate::test_support::TempPath::new(
        std::env::temp_dir().join(format!("rw-chd-unit-{}-auto-{name}", std::process::id())),
    );
    std::fs::write(&path, bytes).expect("write image");
    ChdContainerHandler.infer_auto_create_mode_label(&path)
}

fn cooked_image(sectors: usize, descriptors: &[(usize, u8, &[u8])]) -> Vec<u8> {
    let mut bytes = vec![0_u8; sectors * 2048];
    for (sector, kind, id) in descriptors {
        bytes[sector * 2048] = *kind;
        bytes[sector * 2048 + 1..sector * 2048 + 1 + id.len()].copy_from_slice(id);
    }
    bytes
}

#[test]
fn auto_create_mode_label_follows_native_cooked_image_rules() {
    let bridge = cooked_image(
        40,
        &[
            (16, 1, b"CD001"),
            (17, 255, b"CD001"),
            (18, 0, b"BEA01"),
            (19, 0, b"NSR02"),
        ],
    );
    for name in ["bridge.bin", "bridge.iso", "bridge"] {
        assert_eq!(auto_create_mode(name, &bridge), Some("dvd"), "{name}");
    }
    let udf = cooked_image(40, &[(16, 0, b"BEA01"), (17, 0, b"NSR03")]);
    assert_eq!(auto_create_mode("udf.bin", &udf), Some("dvd"));
    let plain = cooked_image(
        40,
        &[(16, 1, b"CD001"), (17, 0, b"BEA01"), (18, 1, b"NSR02")],
    );
    assert_eq!(auto_create_mode("plain.bin", &plain), Some("cd"));
    assert_eq!(auto_create_mode("plain.iso", &plain), Some("cd"));
    // UDF announced past the scanned volume recognition window is not UDF evidence.
    let late = cooked_image(40, &[(16, 1, b"CD001"), (32, 0, b"NSR02")]);
    assert_eq!(auto_create_mode("late.bin", &late), Some("cd"));
    // A ragged tail is not whole sectors, so there is no CD evidence.
    let mut ragged = bridge.clone();
    ragged.push(0);
    assert_eq!(auto_create_mode("ragged.bin", &ragged), Some("raw"));
}

#[test]
fn auto_create_mode_label_recognizes_raw_cd_and_unrecognized_bins() {
    let mut raw = vec![0_u8; 40 * 2352];
    raw[1..11].fill(255);
    assert_eq!(auto_create_mode("raw.bin", &raw), Some("cd"));
    for size in [13_usize, 4096, 32768, 2352, 2352 * 20] {
        assert_eq!(
            auto_create_mode("blank.bin", &vec![0_u8; size]),
            Some("raw"),
            "{size}-byte blank bin"
        );
    }
    // A cooked ISO without an ISO9660 descriptor is still a CD-sized single track.
    assert_eq!(auto_create_mode("disc.iso", &vec![0_u8; 2048]), Some("cd"));
}

#[test]
fn auto_create_mode_label_prefers_hard_disk_headers_over_cd_evidence() {
    let mut bytes = vec![0_u8; 204_800];
    bytes[32_769..32_774].copy_from_slice(b"CD001");
    // A boot signature alone is not hard-disk evidence.
    bytes[510] = 0x55;
    bytes[511] = 0xaa;
    assert_eq!(auto_create_mode("hybrid.bin", &bytes), Some("cd"));
    // One valid MBR partition entry makes it a hard disk.
    bytes[450] = 0x83;
    bytes[454..458].copy_from_slice(&1_u32.to_le_bytes());
    bytes[458..462].copy_from_slice(&399_u32.to_le_bytes());
    for name in ["hybrid.bin", "hybrid"] {
        assert_eq!(auto_create_mode(name, &bytes), Some("hd"), "{name}");
    }
}

#[test]
fn auto_create_mode_label_skips_other_extensions() {
    assert_eq!(auto_create_mode("game.nes", &[0_u8; 4096]), None);
    assert_eq!(auto_create_mode("game.cue", &[0_u8; 4096]), None);
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
        align_pad_frames: 0,
        pgtype_track_mode: false,
        tail: None,
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

    // GD-ROM tracks are aligned the same way (chdman pads every track).
    let mut gd = DiscLayout {
        kind: DiscKind::GdRom,
        tracks: vec![cd_track(1, DiscTrackMode::Mode1Raw, 10)],
    };
    gd.apply_cd_track_padding();
    assert_eq!((gd.tracks[0].frames, gd.tracks[0].pad_frames), (12, 2));
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

    assert_eq!(DiscTrackMode::Mode1.data_bytes(), 2048);
    assert_eq!(DiscTrackMode::Mode2.data_bytes(), 2336);
    assert_eq!(DiscTrackMode::Mode2Form2.data_bytes(), 2324);
    assert_eq!(DiscTrackMode::Audio.data_bytes(), 2352);
}

#[test]
fn gdi_track_descriptor_matches_chdman_extractcd() {
    // chdman writes track type 0 for audio and 4 for every other track type,
    // with the track's own data size.
    for (mode, expected) in [
        (DiscTrackMode::Mode1Raw, (4, 2352)),
        (DiscTrackMode::Mode1, (4, 2048)),
        (DiscTrackMode::Audio, (0, 2352)),
        (DiscTrackMode::Mode2Raw, (4, 2352)),
        (DiscTrackMode::Mode2, (4, 2336)),
        (DiscTrackMode::Mode2Form1, (4, 2048)),
        (DiscTrackMode::Mode2Form2, (4, 2324)),
        (DiscTrackMode::Mode2FormMix, (4, 2336)),
    ] {
        assert_eq!(mode.gdi_track_descriptor(), expected, "{mode:?}");
    }
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

// --- Partial-output cleanup guard ------------------------------------------

/// The CHD extract/create paths wrap their produced outputs in
/// [`ChdOutputCleanup`]: an uncommitted drop (the error/panic path) removes the
/// partial files, while a committed drop (the success path) leaves them intact
/// so success output stays byte-identical.
#[test]
fn chd_output_cleanup_removes_partials_only_when_uncommitted() {
    let dir = crate::test_support::TempPath::new(
        std::env::temp_dir().join(format!("rw-chd-unit-{}-cleanup-guard", std::process::id())),
    );
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let dropped = dir.join("dropped.bin");
    let kept = dir.join("kept.bin");

    // Uncommitted: dropping the guard removes an output it created.
    let guard = ChdOutputCleanup::new();
    guard.create_output(&dropped, false).unwrap();
    drop(guard);
    assert!(
        !dropped.exists(),
        "uncommitted guard must remove the output it created"
    );

    // Committed: the created output survives.
    let guard = ChdOutputCleanup::new();
    guard.create_output(&kept, false).unwrap();
    guard.commit();
    drop(guard);
    assert!(
        kept.exists(),
        "committed guard must leave the output in place"
    );

    let _ = fs::remove_dir_all(&dir);
}

/// Regression: under `--no-overwrite` (`overwrite = false`) `create_output` must
/// refuse a pre-existing target WITHOUT tracking it, so dropping the uncommitted
/// guard never deletes the file the user explicitly asked to keep. Tracking the
/// path before the (failing) create would have destroyed protected data.
#[test]
fn chd_output_cleanup_never_deletes_refused_preexisting_output() {
    let dir = crate::test_support::TempPath::new(std::env::temp_dir().join(format!(
        "rw-chd-unit-{}-cleanup-no-overwrite",
        std::process::id()
    )));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let existing = dir.join("existing.bin");
    fs::write(&existing, b"valuable").unwrap();

    let guard = ChdOutputCleanup::new();
    let refused = guard.create_output(&existing, false);
    assert!(
        refused.is_err(),
        "create_output must refuse a pre-existing target under --no-overwrite"
    );
    drop(guard);

    assert!(
        existing.exists(),
        "a refused pre-existing output must survive the guard drop"
    );
    assert_eq!(
        fs::read(&existing).unwrap(),
        b"valuable",
        "the protected file must be left byte-identical"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn chd_raw_extract_sizes_output_before_streaming() {
    struct OutputSizes {
        path: PathBuf,
        lengths: std::sync::Mutex<Vec<u64>>,
    }
    impl rom_weaver_core::ProgressSink for OutputSizes {
        fn emit(&self, event: rom_weaver_core::ProgressEvent) {
            if event.stage == "extract" && self.path.exists() {
                self.lengths
                    .lock()
                    .unwrap()
                    .push(fs::metadata(&self.path).unwrap().len());
            }
        }
    }
    let dir = crate::test_support::TempPath::new(
        std::env::temp_dir().join(format!("rw-chd-unit-{}-sized-output", std::process::id())),
    );
    fs::create_dir_all(&dir).unwrap();
    let source = vec![0x5a; 1024 * 1024 + 123];
    let input = dir.join("input.bin");
    let archive = dir.join("output.chd");
    let out_dir = dir.join("extracted");
    fs::write(&input, &source).unwrap();
    let handler = ChdContainerHandler;
    handler
        .create_raw_store_with_rust_backend_for_tests(&input, &archive)
        .unwrap();
    let observed = Arc::new(OutputSizes {
        path: out_dir.join("output.bin"),
        lengths: std::sync::Mutex::new(Vec::new()),
    });
    let context = OperationContext::new(
        rom_weaver_core::ThreadBudget::Fixed(1),
        dir.join("temp"),
        observed.clone(),
        rom_weaver_core::CancellationToken::new(),
    );
    handler
        .extract(
            &ContainerExtractRequest {
                source: archive,
                selections: Vec::new(),
                kind_filter: Default::default(),
                out_dir,
                split_bin: false,
                ignore_common_files: false,
                overwrite: false,
                parent: None,
                containing_archive: None,
            },
            &context,
        )
        .unwrap();
    assert_eq!(fs::read(&observed.path).unwrap(), source);
    let lengths = observed.lengths.lock().unwrap();
    assert!(
        !lengths.is_empty(),
        "extraction must emit progress during streaming"
    );
    assert!(
        lengths.iter().all(|length| *length == source.len() as u64),
        "known-size output must have its final length throughout streaming: {lengths:?}"
    );
    fs::remove_dir_all(&dir).unwrap();
}
