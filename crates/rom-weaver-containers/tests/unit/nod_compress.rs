//! Coverage for `src/nod/util/compress.rs`: the `DecompressionKind` /
//! `Compressor` dispatch plus each vendored codec wrapper (zlib, bzip2,
//! zstd, LZMA and LZMA2), including the "output buffer too small" signal that
//! tells a caller to store a block uncompressed.

use std::io;

use zerocopy::FromZeros;

use super::*;

/// Incompressible bytes, so a codec never shrinks the payload below the tiny
/// output buffers the "does not fit" tests hand it.
fn incompressible(len: usize) -> Vec<u8> {
    let mut state = 0x1234_5678u32;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state & 0xff) as u8
        })
        .collect()
}

fn repetitive(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 7) as u8).collect()
}

fn wia_disc(compression: WIACompression, compr_data: &[u8]) -> WIADisc {
    let mut disc = WIADisc::new_zeroed();
    disc.compression = u32::from(compression).into();
    disc.compr_data_len = compr_data.len() as u8;
    disc.compr_data[..compr_data.len()].copy_from_slice(compr_data);
    disc
}

// --- DecompressionKind ----------------------------------------------------

#[test]
fn decompression_none_copies_the_input_and_reports_its_length() {
    let kind = DecompressionKind::None;
    let input = repetitive(64);
    let mut out = vec![0u8; 128];
    let len = kind.decompress(&input, &mut out).expect("copy fits");
    assert_eq!(len, 64);
    assert_eq!(&out[..64], input.as_slice());
    assert!(out[64..].iter().all(|&b| b == 0));
}

#[test]
fn decompression_none_rejects_an_input_larger_than_the_output() {
    let kind = DecompressionKind::None;
    let mut out = vec![0u8; 8];
    let error = kind
        .decompress(&repetitive(9), &mut out)
        .expect_err("input does not fit");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error
            .to_string()
            .contains("Decompressed data too large: 9 > 8"),
        "unexpected message: {error}"
    );
}

#[test]
fn get_content_size_reads_the_zstandard_frame_header_and_defers_otherwise() {
    assert_eq!(
        DecompressionKind::None
            .get_content_size(&repetitive(40))
            .expect("None reports the raw length"),
        Some(40)
    );
    assert_eq!(
        DecompressionKind::Deflate
            .get_content_size(&repetitive(40))
            .expect("Deflate has no frame header"),
        None
    );

    let input = repetitive(4096);
    let mut buffer = Vec::with_capacity(zstd_api::compress_bound(input.len()));
    assert!(
        zstd_api::compress(&input, 3, &mut buffer).expect("zstd compresses"),
        "the compress bound must be enough room"
    );
    assert_eq!(
        DecompressionKind::Zstandard
            .get_content_size(&buffer)
            .expect("frame header parses"),
        Some(4096)
    );
}

#[test]
fn get_content_size_rejects_a_malformed_zstandard_frame() {
    let error = DecompressionKind::Zstandard
        .get_content_size(&[0u8; 8])
        .expect_err("not a zstd frame");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error.to_string().contains("Invalid Zstandard frame header"),
        "unexpected message: {error}"
    );
}

#[test]
fn decompression_kind_from_wia_maps_each_supported_algorithm() {
    assert!(matches!(
        DecompressionKind::from_wia(&wia_disc(WIACompression::None, &[])).expect("none"),
        DecompressionKind::None
    ));
    assert!(matches!(
        DecompressionKind::from_wia(&wia_disc(WIACompression::Bzip2, &[])).expect("bzip2"),
        DecompressionKind::Bzip2
    ));
    assert!(matches!(
        DecompressionKind::from_wia(&wia_disc(WIACompression::Zstandard, &[])).expect("zstd"),
        DecompressionKind::Zstandard
    ));

    let props = [0x5du8, 0x00, 0x00, 0x10, 0x00];
    let kind = DecompressionKind::from_wia(&wia_disc(WIACompression::Lzma, &props)).expect("lzma");
    let DecompressionKind::Lzma(data) = kind else {
        panic!("expected LZMA, got {kind:?}");
    };
    assert_eq!(data.as_ref(), props.as_slice());

    let kind =
        DecompressionKind::from_wia(&wia_disc(WIACompression::Lzma2, &[0x18])).expect("lzma2");
    let DecompressionKind::Lzma2(data) = kind else {
        panic!("expected LZMA2, got {kind:?}");
    };
    assert_eq!(data.as_ref(), [0x18].as_slice());
}

#[test]
fn decompression_kind_from_wia_rejects_purge() {
    let error = DecompressionKind::from_wia(&wia_disc(WIACompression::Purge, &[]))
        .expect_err("purge is unsupported");
    assert!(
        error
            .to_string()
            .contains("Unsupported WIA/RVZ compression: Purge"),
        "unexpected message: {error}"
    );
}

// --- Compressor -----------------------------------------------------------

#[test]
fn compressor_none_stores_the_input_when_the_buffer_can_hold_it() {
    let input = repetitive(256);
    let mut compressor = Compressor::new(Compression::None, 1024);
    assert!(compressor.compress(&input).expect("stored"));
    assert_eq!(compressor.buffer, input);
}

#[test]
fn compressor_none_bails_when_the_buffer_is_too_small() {
    let input = repetitive(4096);
    let mut compressor = Compressor::new(Compression::None, 16);
    assert!(!compressor.compress(&input).expect("bails without erroring"));
    assert!(compressor.buffer.is_empty());
}

#[test]
fn compressor_clone_keeps_the_algorithm_and_capacity_but_not_the_data() {
    let mut compressor = Compressor::new(Compression::Zstandard(3), 4096);
    compressor.compress(&repetitive(2048)).expect("compresses");
    assert!(!compressor.buffer.is_empty());

    let clone = compressor.clone();
    assert_eq!(clone.kind, Compression::Zstandard(3));
    assert!(clone.buffer.is_empty());
    assert!(clone.buffer.capacity() >= compressor.buffer.capacity());
}

#[test]
fn compressor_round_trips_every_supported_algorithm() {
    let input = repetitive(8192);
    let cases = [
        (Compression::Deflate(6), DecompressionKind::Deflate),
        (Compression::Bzip2(9), DecompressionKind::Bzip2),
        (Compression::Zstandard(5), DecompressionKind::Zstandard),
        (
            Compression::Lzma(6),
            DecompressionKind::Lzma(Box::from(
                lzma_api::lzma_props_encode_preset(6)
                    .expect("lzma props")
                    .as_slice(),
            )),
        ),
        (
            Compression::Lzma2(6),
            DecompressionKind::Lzma2(Box::from(
                lzma_api::lzma2_props_encode_preset(6)
                    .expect("lzma2 props")
                    .as_slice(),
            )),
        ),
    ];

    for (compression, kind) in cases {
        let mut compressor = Compressor::new(compression, input.len() * 2);
        assert!(
            compressor
                .compress(&input)
                .unwrap_or_else(|e| panic!("{compression:?} failed to compress: {e}")),
            "{compression:?} did not fit in a doubled buffer"
        );

        let mut out = vec![0u8; input.len()];
        let len = kind
            .decompress(&compressor.buffer, &mut out)
            .unwrap_or_else(|e| panic!("{compression:?} failed to decompress: {e}"));
        assert_eq!(len, input.len(), "{compression:?} length mismatch");
        assert_eq!(out, input, "{compression:?} payload mismatch");
    }
}

#[test]
fn compressor_bails_instead_of_erroring_when_output_does_not_fit() {
    // BZIP2 is absent on purpose: `bzip2_api::compress` calls BZ2_bzCompress
    // again after the output buffer is exhausted, and libbzip2 answers
    // BZ_SEQUENCE_ERROR, so that codec reports an error instead of bailing.
    let input = incompressible(16 * 1024);
    for compression in [
        Compression::Deflate(6),
        Compression::Zstandard(3),
        Compression::Lzma(1),
        Compression::Lzma2(1),
    ] {
        let mut compressor = Compressor::new(compression, 64);
        assert!(
            !compressor
                .compress(&input)
                .unwrap_or_else(|e| panic!("{compression:?} must bail, not error: {e}")),
            "{compression:?} unexpectedly fit in 64 bytes"
        );
        assert!(
            compressor.buffer.is_empty(),
            "{compression:?} left data in the buffer after bailing"
        );
    }
}

// --- zlib -----------------------------------------------------------------

#[test]
fn zlib_decompress_rejects_data_that_is_not_a_zlib_stream() {
    let mut out = vec![0u8; 256];
    let error = zlib_api::decompress(&[0xffu8; 32], &mut out).expect_err("not a zlib stream");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error.to_string().contains("zlib decompression failed"),
        "unexpected message: {error}"
    );
}

// --- bzip2 ----------------------------------------------------------------

#[test]
fn bzip2_decompress_rejects_data_that_is_not_a_bzip2_stream() {
    let mut out = vec![0u8; 256];
    let error = bzip2_api::decompress(&[0xffu8; 32], &mut out).expect_err("not a bzip2 stream");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
}

#[test]
fn bzip2_decompress_reports_an_output_buffer_that_is_too_small() {
    let input = repetitive(4096);
    let mut buffer = Vec::with_capacity(input.len() * 2);
    assert!(bzip2_api::compress(&input, 9, &mut buffer).expect("compresses"));

    let mut out = vec![0u8; 16];
    let error = bzip2_api::decompress(&buffer, &mut out).expect_err("output is too small");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error
            .to_string()
            .contains("bzip2 decompression output buffer too small"),
        "unexpected message: {error}"
    );
}

// --- zstd -----------------------------------------------------------------

#[test]
fn zstd_compress_bound_leaves_room_for_incompressible_input() {
    let input = incompressible(4096);
    assert!(zstd_api::compress_bound(input.len()) >= input.len());

    let mut buffer = Vec::with_capacity(zstd_api::compress_bound(input.len()));
    assert!(zstd_api::compress(&input, 1, &mut buffer).expect("fits within the bound"));

    let mut out = vec![0u8; input.len()];
    assert_eq!(
        zstd_api::decompress(&buffer, &mut out).expect("decompresses"),
        input.len()
    );
    assert_eq!(out, input);
}

#[test]
fn zstd_decompress_rejects_data_that_is_not_a_frame() {
    let mut out = vec![0u8; 256];
    let error = zstd_api::decompress(&[0xffu8; 32], &mut out).expect_err("not a zstd frame");
    assert!(!error.to_string().is_empty());
}

// --- LZMA / LZMA2 ---------------------------------------------------------

#[test]
fn lzma_props_presets_encode_the_dictionary_size() {
    let props = lzma_api::lzma_props_encode_preset(6).expect("preset 6");
    // Preset 6 uses lc=3, lp=0, pb=2, so the packed byte is (2*5+0)*9+3.
    assert_eq!(props[0], 0x5d);
    let dict_size = u32::from_le_bytes([props[1], props[2], props[3], props[4]]);
    assert!(dict_size.is_power_of_two(), "dict size was {dict_size:#x}");

    let props2 = lzma_api::lzma2_props_encode_preset(6).expect("preset 6");
    assert!(props2[0] <= 40, "props byte out of range: {}", props2[0]);
}

#[test]
fn lzma_preset_options_reject_an_out_of_range_level() {
    let error = lzma_api::lzma_props_encode_preset(10).expect_err("preset 10 is invalid");
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert!(
        error.to_string().contains("Invalid LZMA preset level 10"),
        "unexpected message: {error}"
    );

    let error = lzma_api::lzma2_props_encode_preset(10).expect_err("preset 10 is invalid");
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn lzma_decompress_rejects_malformed_props() {
    let mut out = vec![0u8; 64];

    let error = lzma_api::decompress_lzma(&[], &[0u8; 8], &mut out).expect_err("props too short");
    assert!(
        error.to_string().contains("Invalid LZMA props length: 0"),
        "unexpected message: {error}"
    );

    let error = lzma_api::decompress_lzma(&[0xff, 0, 0, 0, 0], &[0u8; 8], &mut out)
        .expect_err("props byte out of range");
    assert!(
        error.to_string().contains("Invalid LZMA props byte: 255"),
        "unexpected message: {error}"
    );
}

#[test]
fn lzma2_decompress_rejects_malformed_props() {
    let mut out = vec![0u8; 64];

    let error = lzma_api::decompress_lzma2(&[], &[0u8; 8], &mut out).expect_err("props too short");
    assert!(
        error.to_string().contains("Invalid LZMA2 props length: 0"),
        "unexpected message: {error}"
    );

    let error =
        lzma_api::decompress_lzma2(&[41], &[0u8; 8], &mut out).expect_err("props byte too large");
    assert!(
        error.to_string().contains("Invalid LZMA2 props byte: 41"),
        "unexpected message: {error}"
    );
}

#[test]
fn lzma2_props_byte_40_selects_the_maximum_dictionary_size() {
    // Props byte 40 is the `Ordering::Equal` arm of the dictionary decoder; the
    // payload is still garbage, so decoding must fail rather than succeed.
    let mut out = vec![0u8; 64];
    let error =
        lzma_api::decompress_lzma2(&[40], &[0xffu8; 16], &mut out).expect_err("payload is garbage");
    assert!(
        error.to_string().contains("LZMA decompression failed"),
        "unexpected message: {error}"
    );
}

#[test]
fn lzma_decompress_rejects_trailing_input() {
    let input = repetitive(2048);
    let mut buffer = Vec::with_capacity(input.len() * 2);
    assert!(lzma_api::compress_lzma(6, &input, &mut buffer).expect("compresses"));
    buffer.extend_from_slice(&[0u8; 4]);

    let props = lzma_api::lzma_props_encode_preset(6).expect("props");
    let mut out = vec![0u8; input.len()];
    let error = lzma_api::decompress_lzma(&props, &buffer, &mut out)
        .expect_err("trailing bytes are rejected");
    assert!(
        error.to_string().contains("LZMA decompression consumed"),
        "unexpected message: {error}"
    );
}
