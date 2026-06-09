/* jscpd:ignore-start */
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use rom_weaver_core::{
    CancellationToken, CodecOperationRequest, NoopProgressSink, OperationContext, OperationStatus,
    ThreadBudget, ThreadCapability,
};

use super::{
    CanonicalCodec, CodecRegistry, RequestedCodec, normalize_codec_label, parse_requested_codec,
};

static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let sequence = TEST_DIR_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "rom-weaver-codecs-tests-{}-{unique}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn codec_context(root: &Path) -> OperationContext {
    OperationContext::new(
        ThreadBudget::Fixed(8),
        root.join("op"),
        Arc::new(NoopProgressSink),
        CancellationToken::new(),
    )
}

fn codec_round_trip(codec: &str, level: Option<i32>) {
    let temp = TestDir::new();
    let source = temp.path().join("source.bin");
    let encoded = temp.path().join("encoded.bin");
    let decoded = temp.path().join("decoded.bin");
    let bytes = (0..32_768)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(&source, &bytes).expect("write source");

    let registry = CodecRegistry::new();
    let backend = registry.find_by_name(codec).expect("codec backend");
    let context = codec_context(temp.path());

    let encode = backend
        .encode(
            &CodecOperationRequest {
                input: source,
                output: encoded.clone(),
                level,
            },
            &context,
        )
        .expect("encode");
    assert_eq!(encode.status, OperationStatus::Succeeded);

    let decode = backend
        .decode(
            &CodecOperationRequest {
                input: encoded,
                output: decoded.clone(),
                level: None,
            },
            &context,
        )
        .expect("decode");
    assert_eq!(decode.status, OperationStatus::Succeeded);

    let decoded_bytes = fs::read(decoded).expect("read decoded");
    assert_eq!(decoded_bytes, bytes);
}

fn codec_rejects_level(codec: &str, level: i32, expected_message: &str) {
    let temp = TestDir::new();
    let source = temp.path().join("source.bin");
    let encoded = temp.path().join("encoded.bin");
    fs::write(&source, b"abc").expect("write source");

    let registry = CodecRegistry::new();
    let backend = registry.find_by_name(codec).expect("codec backend");
    let context = codec_context(temp.path());

    let error = backend
        .encode(
            &CodecOperationRequest {
                input: source,
                output: encoded,
                level: Some(level),
            },
            &context,
        )
        .expect_err("level should fail");
    assert!(error.to_string().contains(expected_message));
}

fn patterned_payload(byte_len: usize, multiplier: u8, add: u8) -> Vec<u8> {
    (0..byte_len)
        .map(|index| (index as u8).wrapping_mul(multiplier).wrapping_add(add))
        .collect::<Vec<_>>()
}

fn assert_encode_runtime_threads_match_capability(
    codec: &str,
    encoded_name: &str,
    level: i32,
    payload_len: usize,
    payload_multiplier: u8,
    payload_add: u8,
) {
    let temp = TestDir::new();
    let source = temp.path().join("source.bin");
    let encoded = temp.path().join(encoded_name);
    let payload = patterned_payload(payload_len, payload_multiplier, payload_add);
    fs::write(&source, payload).expect("write source");

    let registry = CodecRegistry::new();
    let backend = registry.find_by_name(codec).expect("codec backend");
    let capabilities = backend.capabilities();
    let context = codec_context(temp.path());

    let encode = backend
        .encode(
            &CodecOperationRequest {
                input: source,
                output: encoded,
                level: Some(level),
            },
            &context,
        )
        .expect("encode");
    assert_eq!(encode.status, OperationStatus::Succeeded);

    let execution = encode.thread_execution.expect("thread execution");
    assert!(capabilities.encode_threads.supports_execution(&execution));
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
}

fn assert_decode_runtime_threads_match_capability(
    codec: &str,
    encoded_name: &str,
    encode_level: Option<i32>,
    payload_len: usize,
    payload_multiplier: u8,
    payload_add: u8,
) {
    let temp = TestDir::new();
    let source = temp.path().join("source.bin");
    let encoded = temp.path().join(encoded_name);
    let decoded = temp.path().join("decoded.bin");
    let payload = patterned_payload(payload_len, payload_multiplier, payload_add);
    fs::write(&source, &payload).expect("write source");

    let registry = CodecRegistry::new();
    let backend = registry.find_by_name(codec).expect("codec backend");
    let capabilities = backend.capabilities();
    let context = codec_context(temp.path());

    backend
        .encode(
            &CodecOperationRequest {
                input: source,
                output: encoded.clone(),
                level: encode_level,
            },
            &context,
        )
        .expect("encode");

    let decode = backend
        .decode(
            &CodecOperationRequest {
                input: encoded,
                output: decoded.clone(),
                level: None,
            },
            &context,
        )
        .expect("decode");
    assert_eq!(decode.status, OperationStatus::Succeeded);

    let execution = decode.thread_execution.expect("thread execution");
    assert!(capabilities.decode_threads.supports_execution(&execution));
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 8);
    assert!(execution.used_parallelism);
    assert_eq!(fs::read(decoded).expect("decoded bytes"), payload);
}

struct JoinedStreamDecodeCase<'a> {
    codec: &'a str,
    segment_ext: &'a str,
    level: i32,
    payload_len: usize,
    payload_multiplier: u8,
    payload_add: u8,
    decode_expect: &'a str,
    include_fallback_context: bool,
}

fn assert_joined_stream_decode_runtime_threads(case: JoinedStreamDecodeCase<'_>) {
    let temp = TestDir::new();
    let segment_a = temp.path().join(format!("segment-a.{}", case.segment_ext));
    let segment_b = temp.path().join(format!("segment-b.{}", case.segment_ext));
    let joined = temp.path().join(format!("joined.{}", case.segment_ext));
    let decoded = temp.path().join("decoded.bin");
    let payload = patterned_payload(case.payload_len, case.payload_multiplier, case.payload_add);
    let split = payload.len() / 2;

    let registry = CodecRegistry::new();
    let backend = registry.find_by_name(case.codec).expect("codec backend");
    let capabilities = backend.capabilities();
    let context = codec_context(temp.path());

    let part_a = temp.path().join("part-a.bin");
    let part_b = temp.path().join("part-b.bin");
    fs::write(&part_a, &payload[..split]).expect("write part a");
    fs::write(&part_b, &payload[split..]).expect("write part b");

    backend
        .encode(
            &CodecOperationRequest {
                input: part_a,
                output: segment_a.clone(),
                level: Some(case.level),
            },
            &context,
        )
        .expect("encode segment a");
    backend
        .encode(
            &CodecOperationRequest {
                input: part_b,
                output: segment_b.clone(),
                level: Some(case.level),
            },
            &context,
        )
        .expect("encode segment b");

    let mut joined_bytes = fs::read(&segment_a).expect("read segment a");
    joined_bytes.extend(fs::read(&segment_b).expect("read segment b"));
    fs::write(&joined, joined_bytes).expect("write joined");

    let decode = backend
        .decode(
            &CodecOperationRequest {
                input: joined,
                output: decoded.clone(),
                level: None,
            },
            &context,
        )
        .expect(case.decode_expect);
    assert_eq!(decode.status, OperationStatus::Succeeded);

    let execution = decode.thread_execution.expect("thread execution");
    assert!(capabilities.decode_threads.supports_execution(&execution));
    assert_eq!(execution.requested_threads, 8);
    if case.include_fallback_context {
        assert!(
            execution.effective_threads > 1,
            "fallback: {:?}",
            execution.thread_fallback_reason
        );
        assert!(
            execution.used_parallelism,
            "fallback: {:?}",
            execution.thread_fallback_reason
        );
    } else {
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }
    assert_eq!(fs::read(decoded).expect("decoded bytes"), payload);
}

#[test]
fn registry_contains_planned_backends() {
    let registry = CodecRegistry::new();
    let names = registry
        .backends()
        .iter()
        .map(|backend| backend.descriptor().name)
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["store", "deflate", "zstd", "lzma2", "bzip2"]);
}

#[test]
fn parses_shared_codec_aliases() {
    assert_eq!(
        parse_requested_codec(Some("xz")),
        RequestedCodec::Known(CanonicalCodec::Lzma2)
    );
    assert_eq!(
        parse_requested_codec(Some("gzip")),
        RequestedCodec::Known(CanonicalCodec::Deflate)
    );
    assert_eq!(
        parse_requested_codec(Some("zst")),
        RequestedCodec::Known(CanonicalCodec::Zstd)
    );
    assert_eq!(
        parse_requested_codec(Some("lz4")),
        RequestedCodec::Known(CanonicalCodec::Lz4)
    );
    assert_eq!(
        parse_requested_codec(Some("br")),
        RequestedCodec::Known(CanonicalCodec::Brotli)
    );
    assert_eq!(
        parse_requested_codec(Some("ppmd")),
        RequestedCodec::Known(CanonicalCodec::Ppmd)
    );
    assert_eq!(
        parse_requested_codec(Some("huff")),
        RequestedCodec::Known(CanonicalCodec::Huffman)
    );
}

#[test]
fn unknown_codec_is_preserved() {
    assert_eq!(
        parse_requested_codec(Some("foo-codec")),
        RequestedCodec::Unknown("foo-codec".to_string())
    );
}

#[test]
fn normalizes_codec_labels_for_reporting() {
    assert_eq!(normalize_codec_label("LZMA2 (6)"), "lzma2 (6)");
    assert_eq!(normalize_codec_label("xz(9)"), "lzma2(9)");
    assert_eq!(normalize_codec_label("Zstandard level=3"), "zstd level=3");
    assert_eq!(normalize_codec_label("BR q=11"), "brotli q=11");
    assert_eq!(normalize_codec_label("mystery-codec"), "mystery-codec");
}

#[test]
fn codec_backends_round_trip_supported_formats() {
    codec_round_trip("store", None);
    codec_round_trip("deflate", Some(6));
    codec_round_trip("zstd", Some(3));
    codec_round_trip("lzma2", Some(6));
    codec_round_trip("bzip2", Some(6));
}

#[test]
fn codec_backends_apply_default_levels() {
    codec_round_trip("deflate", None);
    codec_round_trip("zstd", None);
    codec_round_trip("lzma2", None);
    codec_round_trip("bzip2", None);
}

#[test]
fn store_backend_rejects_levels() {
    codec_rejects_level(
        "store",
        1,
        "store codec does not accept a compression level",
    );
}

#[test]
fn deflate_backend_rejects_invalid_level() {
    codec_rejects_level("deflate", 10, "deflate level `10` is out of range (0..=9)");
}

#[test]
fn zstd_backend_rejects_invalid_level() {
    codec_rejects_level("zstd", 23, "zstd level `23` is out of range (-7..=22)");
}

#[test]
fn lzma2_backend_rejects_invalid_level() {
    codec_rejects_level("lzma2", 10, "lzma2 level `10` is out of range (0..=9)");
}

#[test]
fn bzip2_backend_rejects_invalid_level() {
    codec_rejects_level("bzip2", 0, "bzip2 level `0` is out of range (1..=9)");
}

#[test]
fn decode_rejects_level_parameter() {
    let temp = TestDir::new();
    let source = temp.path().join("source.bin");
    let encoded = temp.path().join("encoded.bin");
    let decoded = temp.path().join("decoded.bin");
    fs::write(&source, b"hello").expect("write source");

    let registry = CodecRegistry::new();
    let backend = registry.find_by_name("deflate").expect("deflate backend");
    let context = codec_context(temp.path());

    backend
        .encode(
            &CodecOperationRequest {
                input: source,
                output: encoded.clone(),
                level: Some(6),
            },
            &context,
        )
        .expect("encode");

    let error = backend
        .decode(
            &CodecOperationRequest {
                input: encoded,
                output: decoded,
                level: Some(6),
            },
            &context,
        )
        .expect_err("decode level should fail");
    assert!(
        error
            .to_string()
            .contains("deflate decode does not accept a compression level")
    );
}

#[test]
fn capabilities_report_thread_support_per_codec_backend() {
    let registry = CodecRegistry::new();

    for codec in ["deflate", "zstd", "lzma2", "bzip2"] {
        let backend = registry.find_by_name(codec).expect("codec backend");
        assert_eq!(
            backend.capabilities().encode_threads,
            ThreadCapability::single_threaded()
        );
    }

    {
        let codec = "store";
        let backend = registry.find_by_name(codec).expect("codec backend");
        assert_eq!(
            backend.capabilities().encode_threads,
            ThreadCapability::single_threaded()
        );
    }

    for codec in ["store", "deflate", "zstd", "lzma2", "bzip2"] {
        let backend = registry.find_by_name(codec).expect("codec backend");
        assert_eq!(
            backend.capabilities().decode_threads,
            ThreadCapability::parallel(None)
        );
    }
}

#[test]
fn lzma2_backend_encode_runtime_threads_match_capability() {
    assert_encode_runtime_threads_match_capability(
        "lzma2",
        "encoded.xz",
        6,
        2 * 1024 * 1024,
        19,
        0,
    );
}

#[test]
fn deflate_backend_encode_runtime_threads_match_capability() {
    assert_encode_runtime_threads_match_capability(
        "deflate",
        "encoded.gz",
        6,
        2 * 1024 * 1024,
        23,
        0,
    );
}

#[test]
fn bzip2_backend_encode_runtime_threads_match_capability() {
    assert_encode_runtime_threads_match_capability(
        "bzip2",
        "encoded.bz2",
        6,
        3 * 1024 * 1024,
        17,
        0,
    );
}

#[test]
fn bzip2_backend_decode_supports_multistream_payloads() {
    assert_joined_stream_decode_runtime_threads(JoinedStreamDecodeCase {
        codec: "bzip2",
        segment_ext: "bz2",
        level: 6,
        payload_len: 2 * 1024 * 1024,
        payload_multiplier: 5,
        payload_add: 3,
        decode_expect: "decode multistream",
        include_fallback_context: true,
    });
}

#[test]
fn deflate_backend_decode_runtime_threads_match_capability_with_multimember_input() {
    assert_joined_stream_decode_runtime_threads(JoinedStreamDecodeCase {
        codec: "deflate",
        segment_ext: "gz",
        level: 6,
        payload_len: 2 * 1024 * 1024,
        payload_multiplier: 13,
        payload_add: 11,
        decode_expect: "decode multistream",
        include_fallback_context: true,
    });
}

#[test]
fn zstd_backend_decode_runtime_threads_match_capability_with_multiframe_input() {
    assert_joined_stream_decode_runtime_threads(JoinedStreamDecodeCase {
        codec: "zstd",
        segment_ext: "zst",
        level: 3,
        payload_len: 2 * 1024 * 1024,
        payload_multiplier: 19,
        payload_add: 7,
        decode_expect: "decode multiframe",
        include_fallback_context: false,
    });
}

#[test]
fn lzma2_backend_decode_runtime_threads_match_capability() {
    assert_decode_runtime_threads_match_capability(
        "lzma2",
        "encoded.xz",
        Some(6),
        3 * 1024 * 1024,
        29,
        0,
    );
}

#[test]
fn store_backend_decode_runs_with_parallel_runtime_when_budget_allows() {
    assert_decode_runtime_threads_match_capability(
        "store",
        "encoded.store",
        None,
        2 * 1024 * 1024,
        7,
        0,
    );
}
/* jscpd:ignore-end */
