#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{
        CancellationToken, CodecOperationRequest, NoopProgressSink, OperationContext,
        OperationStatus, ThreadBudget, ThreadCapability,
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
                ThreadCapability::parallel(None)
            );
        }

        for codec in ["store"] {
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
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.xz");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(19))
            .collect::<Vec<_>>();
        fs::write(&source, payload).expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("lzma2").expect("lzma2 backend");
        let capabilities = backend.capabilities();
        let context = codec_context(temp.path());

        let encode = backend
            .encode(
                &CodecOperationRequest {
                    input: source,
                    output: encoded,
                    level: Some(6),
                },
                &context,
            )
            .expect("encode");
        assert_eq!(encode.status, OperationStatus::Succeeded);

        let execution = encode.thread_execution.expect("thread execution");
        assert!(capabilities.encode_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 8);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn deflate_backend_encode_runtime_threads_match_capability() {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.gz");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(23))
            .collect::<Vec<_>>();
        fs::write(&source, payload).expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("deflate").expect("deflate backend");
        let capabilities = backend.capabilities();
        let context = codec_context(temp.path());

        let encode = backend
            .encode(
                &CodecOperationRequest {
                    input: source,
                    output: encoded,
                    level: Some(6),
                },
                &context,
            )
            .expect("encode");
        assert_eq!(encode.status, OperationStatus::Succeeded);

        let execution = encode.thread_execution.expect("thread execution");
        assert!(capabilities.encode_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 8);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn bzip2_backend_encode_runtime_threads_match_capability() {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.bz2");
        let payload = (0..(3 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(17))
            .collect::<Vec<_>>();
        fs::write(&source, payload).expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("bzip2").expect("bzip2 backend");
        let capabilities = backend.capabilities();
        let context = codec_context(temp.path());

        let encode = backend
            .encode(
                &CodecOperationRequest {
                    input: source,
                    output: encoded,
                    level: Some(6),
                },
                &context,
            )
            .expect("encode");
        assert_eq!(encode.status, OperationStatus::Succeeded);

        let execution = encode.thread_execution.expect("thread execution");
        assert!(capabilities.encode_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 8);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn bzip2_backend_decode_supports_multistream_payloads() {
        let temp = TestDir::new();
        let member_a = temp.path().join("member-a.bz2");
        let member_b = temp.path().join("member-b.bz2");
        let joined = temp.path().join("joined.bz2");
        let decoded = temp.path().join("decoded.bin");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(5).wrapping_add(3))
            .collect::<Vec<_>>();
        let split = payload.len() / 2;

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("bzip2").expect("bzip2 backend");
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
                    output: member_a.clone(),
                    level: Some(6),
                },
                &context,
            )
            .expect("encode member a");
        backend
            .encode(
                &CodecOperationRequest {
                    input: part_b,
                    output: member_b.clone(),
                    level: Some(6),
                },
                &context,
            )
            .expect("encode member b");

        let mut joined_bytes = fs::read(&member_a).expect("read member a");
        joined_bytes.extend(fs::read(&member_b).expect("read member b"));
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
            .expect("decode multistream");
        assert_eq!(decode.status, OperationStatus::Succeeded);
        let execution = decode.thread_execution.expect("thread execution");
        assert!(capabilities.decode_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
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
        assert_eq!(fs::read(decoded).expect("decoded bytes"), payload);
    }

    #[test]
    fn deflate_backend_decode_runtime_threads_match_capability_with_multimember_input() {
        let temp = TestDir::new();
        let member_a = temp.path().join("member-a.gz");
        let member_b = temp.path().join("member-b.gz");
        let joined = temp.path().join("joined.gz");
        let decoded = temp.path().join("decoded.bin");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(13).wrapping_add(11))
            .collect::<Vec<_>>();
        let split = payload.len() / 2;

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("deflate").expect("deflate backend");
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
                    output: member_a.clone(),
                    level: Some(6),
                },
                &context,
            )
            .expect("encode member a");
        backend
            .encode(
                &CodecOperationRequest {
                    input: part_b,
                    output: member_b.clone(),
                    level: Some(6),
                },
                &context,
            )
            .expect("encode member b");

        let mut joined_bytes = fs::read(&member_a).expect("read member a");
        joined_bytes.extend(fs::read(&member_b).expect("read member b"));
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
            .expect("decode multistream");
        assert_eq!(decode.status, OperationStatus::Succeeded);
        let execution = decode.thread_execution.expect("thread execution");
        assert!(capabilities.decode_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
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
        assert_eq!(fs::read(decoded).expect("decoded bytes"), payload);
    }

    #[test]
    fn zstd_backend_decode_runtime_threads_match_capability_with_multiframe_input() {
        let temp = TestDir::new();
        let frame_a = temp.path().join("frame-a.zst");
        let frame_b = temp.path().join("frame-b.zst");
        let joined = temp.path().join("joined.zst");
        let decoded = temp.path().join("decoded.bin");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(19).wrapping_add(7))
            .collect::<Vec<_>>();
        let split = payload.len() / 2;

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("zstd").expect("zstd backend");
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
                    output: frame_a.clone(),
                    level: Some(3),
                },
                &context,
            )
            .expect("encode frame a");
        backend
            .encode(
                &CodecOperationRequest {
                    input: part_b,
                    output: frame_b.clone(),
                    level: Some(3),
                },
                &context,
            )
            .expect("encode frame b");

        let mut joined_bytes = fs::read(&frame_a).expect("read frame a");
        joined_bytes.extend(fs::read(&frame_b).expect("read frame b"));
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
            .expect("decode multiframe");
        assert_eq!(decode.status, OperationStatus::Succeeded);
        let execution = decode.thread_execution.expect("thread execution");
        assert!(capabilities.decode_threads.supports_execution(&execution));
        assert_eq!(execution.requested_threads, 8);
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(decoded).expect("decoded bytes"), payload);
    }

    #[test]
    fn lzma2_backend_decode_runtime_threads_match_capability() {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.xz");
        let decoded = temp.path().join("decoded.bin");
        let payload = (0..(3 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(29))
            .collect::<Vec<_>>();
        fs::write(&source, &payload).expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("lzma2").expect("lzma2 backend");
        let capabilities = backend.capabilities();
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

    #[test]
    fn store_backend_decode_runs_with_parallel_runtime_when_budget_allows() {
        let temp = TestDir::new();
        let source = temp.path().join("source.bin");
        let encoded = temp.path().join("encoded.store");
        let decoded = temp.path().join("decoded.bin");
        let payload = (0..(2 * 1024 * 1024))
            .map(|index| (index as u8).wrapping_mul(7))
            .collect::<Vec<_>>();
        fs::write(&source, &payload).expect("write source");

        let registry = CodecRegistry::new();
        let backend = registry.find_by_name("store").expect("store backend");
        let context = codec_context(temp.path());

        backend
            .encode(
                &CodecOperationRequest {
                    input: source,
                    output: encoded.clone(),
                    level: None,
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
        assert!(
            backend
                .capabilities()
                .decode_threads
                .supports_execution(&execution)
        );
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 8);
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(decoded).expect("decoded bytes"), payload);
    }
}
