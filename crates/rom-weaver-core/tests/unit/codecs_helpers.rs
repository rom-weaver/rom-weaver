use super::*;

// --- Deterministic payload generators -------------------------------------
//
// No `rand` dev-dependency exists for this crate, so payloads are generated
// with small hand-rolled PRNGs. `pattern_bytes` is a simple LCG (mildly
// compressible, like real ROM data); `noise_bytes` is a splitmix64 stream
// (high entropy, representative of data that resists compression).

fn pattern_bytes(len: usize) -> Vec<u8> {
    let mut state: u32 = 0x1234_5678;
    (0..len)
        .map(|_| {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12345);
            (state >> 16) as u8
        })
        .collect()
}

fn noise_bytes(len: usize) -> Vec<u8> {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    (0..len)
        .map(|_| {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            (z ^ (z >> 31)) as u8
        })
        .collect()
}

fn round_trip_payloads() -> Vec<Vec<u8>> {
    vec![
        Vec::new(),
        vec![0x42],
        pattern_bytes(4096),
        noise_bytes(4096),
    ]
}

// --- Encoders for codecs that only expose a decode_*_exact helper ---------

fn encode_bzip2(payload: &[u8]) -> Vec<u8> {
    let mut encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::best());
    encoder.write_all(payload).expect("bzip2 encode write");
    encoder.finish().expect("bzip2 encode finish")
}

fn encode_deflate(payload: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(payload).expect("deflate encode write");
    encoder.finish().expect("deflate encode finish")
}

fn encode_zlib(payload: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(payload).expect("zlib encode write");
    encoder.finish().expect("zlib encode finish")
}

/// Returns `(compressed, props_byte, dict_size)` so the caller can feed the
/// exact parameters `decode_lzma_with_props` needs.
fn encode_lzma(payload: &[u8]) -> (Vec<u8>, u8, u32) {
    let options = lzma_rust2::LzmaOptions::with_preset(6);
    let dict_size = options.dict_size;
    let mut writer = lzma_rust2::LzmaWriter::new(Vec::new(), &options, false, true, None)
        .expect("lzma writer init");
    writer.write_all(payload).expect("lzma encode write");
    let props = writer.props();
    let compressed = writer.finish().expect("lzma encode finish");
    (compressed, props, dict_size)
}

/// Returns `(compressed, dict_size)` for `decode_lzma2`.
fn encode_lzma2(payload: &[u8]) -> (Vec<u8>, u32) {
    let options = lzma_rust2::Lzma2Options::with_preset(6);
    let dict_size = options.lzma_options.dict_size;
    let mut writer = lzma_rust2::Lzma2Writer::new(Vec::new(), options);
    writer.write_all(payload).expect("lzma2 encode write");
    let compressed = writer.finish().expect("lzma2 encode finish");
    (compressed, dict_size)
}

// --- bzip2 -------------------------------------------------------------

#[test]
fn bzip2_round_trips_across_payload_shapes() {
    for payload in round_trip_payloads() {
        let compressed = encode_bzip2(&payload);
        let decoded = decode_bzip2_exact(&compressed, payload.len() as u64)
            .expect("bzip2 decode must succeed");
        assert_eq!(decoded, payload);
    }
}

#[test]
fn bzip2_decodes_a_known_vector_pinned_to_the_c_backend() {
    // Backend swap canary: the workspace pins `bzip2` to the `bzip2-sys` (C)
    // backend over the pure-Rust `libbz2-rs-sys` one specifically so BDF
    // patch bytes stay reproducible. These bytes were captured from that
    // pinned backend; a silent backend swap would still decode successfully
    // per-spec but could produce different bytes on re-encode, so this test
    // only needs to catch decode drift or outright backend incompatibility.
    const PLAINTEXT: &[u8] = b"rom-weaver bzip2 known-vector fixture payload!";
    const COMPRESSED: &[u8] = &[
        0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0x42, 0xe8, 0x89, 0xfb, 0x00,
        0x00, 0x11, 0x99, 0x80, 0x60, 0x02, 0x10, 0x00, 0x3f, 0x2f, 0xd7, 0xf0, 0x20, 0x00, 0x22,
        0xa6, 0xd4, 0xc9, 0xa7, 0xea, 0x09, 0xea, 0x7a, 0x8d, 0xa6, 0x42, 0x80, 0x01, 0xa0, 0x64,
        0xc8, 0x48, 0x48, 0x03, 0x34, 0x49, 0x97, 0x65, 0x60, 0xab, 0x09, 0xba, 0x13, 0xd7, 0xac,
        0xa8, 0xd1, 0xe8, 0x78, 0x1b, 0x2c, 0xe1, 0xbf, 0x8d, 0x2b, 0xcb, 0xec, 0x5d, 0xc9, 0x14,
        0xe1, 0x42, 0x41, 0x0b, 0xa2, 0x27, 0xec,
    ];

    let decoded =
        decode_bzip2_exact(COMPRESSED, PLAINTEXT.len() as u64).expect("known vector decodes");
    assert_eq!(decoded, PLAINTEXT);
}

#[test]
fn bzip2_rejects_truncated_input() {
    let payload = pattern_bytes(4096);
    let compressed = encode_bzip2(&payload);
    let truncated = &compressed[..compressed.len() - 4];
    assert!(decode_bzip2_exact(truncated, payload.len() as u64).is_err());
}

#[test]
fn bzip2_rejects_expected_len_smaller_than_actual() {
    let payload = pattern_bytes(4096);
    let compressed = encode_bzip2(&payload);
    assert!(decode_bzip2_exact(&compressed, payload.len() as u64 - 5).is_err());
}

#[test]
fn bzip2_rejects_expected_len_larger_than_actual() {
    let payload = pattern_bytes(4096);
    let compressed = encode_bzip2(&payload);
    assert!(decode_bzip2_exact(&compressed, payload.len() as u64 + 5).is_err());
}

// --- deflate -------------------------------------------------------------

#[test]
fn deflate_round_trips_across_payload_shapes() {
    for payload in round_trip_payloads() {
        let compressed = encode_deflate(&payload);
        let decoded = decode_deflate_exact(&compressed, payload.len() as u64)
            .expect("deflate decode must succeed");
        assert_eq!(decoded, payload);
    }
}

#[test]
fn deflate_decodes_a_known_vector_pinned_to_the_c_backend() {
    // Same rationale as the bzip2 known vector: the workspace pins `flate2`
    // to the `zlib` (C) backend over `zlib-rs` to keep CHD decode bytes
    // reproducible under feature unification.
    const PLAINTEXT: &[u8] = b"rom-weaver deflate known-vector fixture payload!";
    const COMPRESSED: &[u8] = &[
        0x05, 0xc1, 0x8b, 0x09, 0x00, 0x20, 0x08, 0x05, 0xc0, 0x55, 0x6c, 0x80, 0x86, 0x92, 0x7a,
        0x42, 0xf4, 0x31, 0xc4, 0x7e, 0xdb, 0x77, 0x67, 0xda, 0xe3, 0x01, 0x6f, 0x18, 0x65, 0x48,
        0x63, 0x07, 0xd5, 0xa1, 0x67, 0xc4, 0x8d, 0xe4, 0x6a, 0x24, 0xe5, 0xfa, 0x32, 0xd0, 0xe4,
        0xd7, 0x94, 0x73, 0xf8,
    ];

    let decoded =
        decode_deflate_exact(COMPRESSED, PLAINTEXT.len() as u64).expect("known vector decodes");
    assert_eq!(decoded, PLAINTEXT);
}

#[test]
fn deflate_rejects_truncated_input() {
    let payload = pattern_bytes(4096);
    let compressed = encode_deflate(&payload);
    let truncated = &compressed[..compressed.len() - 4];
    assert!(decode_deflate_exact(truncated, payload.len() as u64).is_err());
}

#[test]
fn deflate_rejects_expected_len_smaller_than_actual() {
    let payload = pattern_bytes(4096);
    let compressed = encode_deflate(&payload);
    assert!(decode_deflate_exact(&compressed, payload.len() as u64 - 5).is_err());
}

#[test]
fn deflate_rejects_expected_len_larger_than_actual() {
    let payload = pattern_bytes(4096);
    let compressed = encode_deflate(&payload);
    assert!(decode_deflate_exact(&compressed, payload.len() as u64 + 5).is_err());
}

#[test]
fn deflate_into_buffer_fills_an_exact_size_buffer_with_no_trailing_bytes() {
    let payload = pattern_bytes(2048);
    let compressed = encode_deflate(&payload);
    let mut output = vec![0u8; payload.len()];
    let result = decode_deflate_into_buffer(&compressed, &mut output)
        .expect("decode into exact buffer must succeed");
    assert_eq!(result.bytes_written, payload.len());
    assert!(!result.has_trailing_bytes);
    assert_eq!(output, payload);
}

#[test]
fn deflate_into_buffer_reports_trailing_bytes_when_buffer_is_smaller_than_payload() {
    let payload = pattern_bytes(2048);
    let compressed = encode_deflate(&payload);
    let mut output = vec![0u8; payload.len() - 10];
    let result = decode_deflate_into_buffer(&compressed, &mut output)
        .expect("decode into undersized buffer must succeed");
    assert_eq!(result.bytes_written, output.len());
    assert!(result.has_trailing_bytes);
    assert_eq!(output, payload[..payload.len() - 10]);
}

#[test]
fn deflate_into_buffer_stops_short_when_buffer_is_larger_than_payload() {
    let payload = pattern_bytes(2048);
    let compressed = encode_deflate(&payload);
    let mut output = vec![0u8; payload.len() + 256];
    let result = decode_deflate_into_buffer(&compressed, &mut output)
        .expect("decode into oversized buffer must succeed");
    // `has_trailing_bytes` is only computed when `bytes_written == output.len()`;
    // here the decoder runs dry before filling the buffer, so it must stay false.
    assert_eq!(result.bytes_written, payload.len());
    assert!(!result.has_trailing_bytes);
    assert_eq!(&output[..payload.len()], payload.as_slice());
}

// --- zlib ------------------------------------------------------------------

#[test]
fn zlib_round_trips_across_payload_shapes() {
    for payload in round_trip_payloads() {
        let compressed = encode_zlib(&payload);
        let decoded =
            decode_zlib_exact(&compressed, payload.len() as u64).expect("zlib decode must succeed");
        assert_eq!(decoded, payload);
    }
}

#[test]
fn zlib_decodes_a_known_vector_pinned_to_the_c_backend() {
    const PLAINTEXT: &[u8] = b"rom-weaver zlib known-vector fixture payload!";
    const COMPRESSED: &[u8] = &[
        0x78, 0xda, 0x2b, 0xca, 0xcf, 0xd5, 0x2d, 0x4f, 0x4d, 0x2c, 0x4b, 0x2d, 0x52, 0xa8, 0xca,
        0xc9, 0x4c, 0x52, 0xc8, 0xce, 0xcb, 0x2f, 0xcf, 0xd3, 0x2d, 0x4b, 0x4d, 0x2e, 0xc9, 0x2f,
        0x52, 0x48, 0xcb, 0xac, 0x28, 0x29, 0x2d, 0x4a, 0x55, 0x28, 0x48, 0xac, 0xcc, 0xc9, 0x4f,
        0x4c, 0x51, 0x04, 0x00, 0x8f, 0x1c, 0x11, 0x36,
    ];

    let decoded =
        decode_zlib_exact(COMPRESSED, PLAINTEXT.len() as u64).expect("known vector decodes");
    assert_eq!(decoded, PLAINTEXT);
}

#[test]
fn zlib_rejects_truncated_input() {
    // Stripping only the last few bytes just removes the trailing Adler-32
    // checksum, which `decode_exact`'s read loop never inspects - the
    // deflate stream itself still decodes to a full, correct payload, so the
    // read_exact succeeds. Cutting the payload in half corrupts the deflate
    // bitstream itself, which is what actually surfaces as a decode error.
    let payload = pattern_bytes(4096);
    let compressed = encode_zlib(&payload);
    let truncated = &compressed[..compressed.len() / 2];
    assert!(decode_zlib_exact(truncated, payload.len() as u64).is_err());
}

#[test]
fn zlib_rejects_expected_len_smaller_than_actual() {
    let payload = pattern_bytes(4096);
    let compressed = encode_zlib(&payload);
    assert!(decode_zlib_exact(&compressed, payload.len() as u64 - 5).is_err());
}

#[test]
fn zlib_rejects_expected_len_larger_than_actual() {
    let payload = pattern_bytes(4096);
    let compressed = encode_zlib(&payload);
    assert!(decode_zlib_exact(&compressed, payload.len() as u64 + 5).is_err());
}

// --- zstd --------------------------------------------------------------

#[test]
fn zstd_round_trips_across_payload_shapes_and_levels() {
    for payload in round_trip_payloads() {
        for level in [1, 19] {
            let compressed = encode_zstd(&payload, level).expect("zstd encode must succeed");
            let decoded = decode_zstd_exact(&compressed, payload.len() as u64)
                .expect("zstd decode must succeed");
            assert_eq!(decoded, payload);
        }
    }
}

#[test]
fn zstd_rejects_truncated_input() {
    let payload = pattern_bytes(4096);
    let compressed = encode_zstd(&payload, 3).expect("zstd encode must succeed");
    let truncated = &compressed[..compressed.len() - 4];
    assert!(decode_zstd_exact(truncated, payload.len() as u64).is_err());
}

#[test]
fn zstd_rejects_expected_len_smaller_than_actual() {
    let payload = pattern_bytes(4096);
    let compressed = encode_zstd(&payload, 3).expect("zstd encode must succeed");
    assert!(decode_zstd_exact(&compressed, payload.len() as u64 - 5).is_err());
}

#[test]
fn zstd_rejects_expected_len_larger_than_actual() {
    let payload = pattern_bytes(4096);
    let compressed = encode_zstd(&payload, 3).expect("zstd encode must succeed");
    assert!(decode_zstd_exact(&compressed, payload.len() as u64 + 5).is_err());
}

// --- lzma ------------------------------------------------------------------

#[test]
fn lzma_round_trips_across_payload_shapes() {
    for payload in round_trip_payloads() {
        let (compressed, props, dict_size) = encode_lzma(&payload);
        let decoded = decode_lzma_with_props(&compressed, payload.len() as u64, props, dict_size)
            .expect("lzma decode must succeed");
        assert_eq!(decoded, payload);
    }
}

#[test]
fn lzma_rejects_truncated_input() {
    // Unlike bzip2/deflate/zlib, `LzmaReader::new_with_props` is handed
    // `expected_len` up front and stops emitting bytes once it has produced
    // that many, so it does not depend on reaching an end-of-stream marker to
    // know when to stop. Trimming only the last few bytes (which hold the end
    // marker) therefore still decodes cleanly - the corruption has to land in
    // the range that actually encodes the requested output, so this cuts the
    // payload in half.
    let payload = pattern_bytes(4096);
    let (compressed, props, dict_size) = encode_lzma(&payload);
    let truncated = &compressed[..compressed.len() / 2];
    assert!(decode_lzma_with_props(truncated, payload.len() as u64, props, dict_size).is_err());
}

#[test]
fn lzma_with_smaller_expected_len_returns_a_truncated_prefix_instead_of_erroring() {
    // `expected_len` is a constructor argument to `LzmaReader`, not just a
    // post-hoc size check like it is for bzip2/deflate/zlib/zstd/xz: the
    // reader stops decoding as soon as it has produced `expected_len` bytes,
    // so `decode_exact`'s trailing-byte check never sees the remaining
    // decoded data and never fires. This is documented, intentional
    // `lzma_rust2` behavior, not a bug in `decode_lzma_with_props` - so unlike
    // every other codec here, asking for fewer bytes than were encoded
    // succeeds with a truncated prefix rather than erroring.
    let payload = pattern_bytes(4096);
    let (compressed, props, dict_size) = encode_lzma(&payload);
    let short_len = payload.len() as u64 - 5;
    let decoded = decode_lzma_with_props(&compressed, short_len, props, dict_size)
        .expect("lzma decode with a smaller expected_len must still succeed");
    assert_eq!(decoded, payload[..short_len as usize]);
}

#[test]
fn lzma_rejects_expected_len_larger_than_actual() {
    let payload = pattern_bytes(4096);
    let (compressed, props, dict_size) = encode_lzma(&payload);
    assert!(
        decode_lzma_with_props(&compressed, payload.len() as u64 + 5, props, dict_size).is_err()
    );
}

// --- lzma2 -----------------------------------------------------------------

#[test]
fn lzma2_round_trips_across_payload_shapes() {
    for payload in round_trip_payloads() {
        let (compressed, dict_size) = encode_lzma2(&payload);
        let decoded = decode_lzma2(&compressed, payload.len() as u64, dict_size)
            .expect("lzma2 decode must succeed");
        assert_eq!(decoded, payload);
    }
}

#[test]
fn lzma2_rejects_truncated_input() {
    let payload = pattern_bytes(4096);
    let (compressed, dict_size) = encode_lzma2(&payload);
    let truncated = &compressed[..compressed.len() - 4];
    assert!(decode_lzma2(truncated, payload.len() as u64, dict_size).is_err());
}

#[test]
fn lzma2_rejects_expected_len_smaller_than_actual() {
    let payload = pattern_bytes(4096);
    let (compressed, dict_size) = encode_lzma2(&payload);
    assert!(decode_lzma2(&compressed, payload.len() as u64 - 5, dict_size).is_err());
}

#[test]
fn lzma2_rejects_expected_len_larger_than_actual() {
    let payload = pattern_bytes(4096);
    let (compressed, dict_size) = encode_lzma2(&payload);
    assert!(decode_lzma2(&compressed, payload.len() as u64 + 5, dict_size).is_err());
}

// --- xz --------------------------------------------------------------------

#[test]
fn xz_round_trips_across_payload_shapes() {
    for payload in round_trip_payloads() {
        let compressed = encode_xz_preset(&payload, 6).expect("xz encode must succeed");
        let decoded =
            decode_xz_exact(&compressed, payload.len() as u64).expect("xz decode must succeed");
        assert_eq!(decoded, payload);
    }
}

#[test]
fn xz_decodes_a_known_vector() {
    // lzma_rust2 is not backend-pinned like bzip2/flate2 (it is the only
    // implementation used, there is no C alternative to unify against), but a
    // fixed vector still catches accidental container-format drift (e.g. a
    // change to header/footer handling) that a round-trip test would miss.
    const PLAINTEXT: &[u8] = b"rom-weaver xz known-vector fixture payload!";
    const COMPRESSED: &[u8] = &[
        0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04, 0xe6, 0xd6, 0xb4, 0x46, 0x02, 0x00, 0x21,
        0x01, 0x16, 0x00, 0x00, 0x00, 0x74, 0x2f, 0xe5, 0xa3, 0x01, 0x00, 0x2a, 0x72, 0x6f, 0x6d,
        0x2d, 0x77, 0x65, 0x61, 0x76, 0x65, 0x72, 0x20, 0x78, 0x7a, 0x20, 0x6b, 0x6e, 0x6f, 0x77,
        0x6e, 0x2d, 0x76, 0x65, 0x63, 0x74, 0x6f, 0x72, 0x20, 0x66, 0x69, 0x78, 0x74, 0x75, 0x72,
        0x65, 0x20, 0x70, 0x61, 0x79, 0x6c, 0x6f, 0x61, 0x64, 0x21, 0x00, 0x00, 0xe5, 0x00, 0xa9,
        0x6d, 0x9e, 0xf0, 0x15, 0xe8, 0x00, 0x01, 0x43, 0x2b, 0xad, 0x50, 0x6e, 0x57, 0x1f, 0xb6,
        0xf3, 0x7d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x04, 0x59, 0x5a,
    ];

    let decoded =
        decode_xz_exact(COMPRESSED, PLAINTEXT.len() as u64).expect("known vector decodes");
    assert_eq!(decoded, PLAINTEXT);
}

#[test]
fn xz_rejects_truncated_input() {
    let payload = pattern_bytes(4096);
    let compressed = encode_xz_preset(&payload, 6).expect("xz encode must succeed");
    let truncated = &compressed[..compressed.len() - 4];
    assert!(decode_xz_exact(truncated, payload.len() as u64).is_err());
}

#[test]
fn xz_rejects_expected_len_smaller_than_actual() {
    let payload = pattern_bytes(4096);
    let compressed = encode_xz_preset(&payload, 6).expect("xz encode must succeed");
    assert!(decode_xz_exact(&compressed, payload.len() as u64 - 5).is_err());
}

#[test]
fn xz_rejects_expected_len_larger_than_actual() {
    let payload = pattern_bytes(4096);
    let compressed = encode_xz_preset(&payload, 6).expect("xz encode must succeed");
    assert!(decode_xz_exact(&compressed, payload.len() as u64 + 5).is_err());
}
