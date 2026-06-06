/* jscpd:ignore-start */
#[cfg(test)]
mod tests {
    use std::{
        fs::{self, File},
        io::Write,
        path::{Path, PathBuf},
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use proptest::prelude::*;
    use rom_weaver_core::{
        CancellationToken, ChecksumEngine, ChecksumRequest, NoopProgressSink, OperationContext,
        ThreadBudget,
    };

    use super::{
        ADLER32_PARALLEL_MIN_BYTES_PER_THREAD, ADLER32_PARALLEL_THRESHOLD, ARC,
        BLAKE3_PARALLEL_MIN_BYTES_PER_THREAD, BLAKE3_PARALLEL_THRESHOLD,
        CRC16_PARALLEL_MIN_BYTES_PER_THREAD, CRC16_PARALLEL_THRESHOLD,
        CRC32_PARALLEL_MIN_BYTES_PER_THREAD, CRC32_PARALLEL_THRESHOLD,
        CRC32C_PARALLEL_MIN_BYTES_PER_THREAD, CRC32C_PARALLEL_THRESHOLD, ChecksumMode, Crc16State,
        FANOUT_PARALLEL_THRESHOLD, NativeChecksumEngine, ResolvedRange, adler32_checksum,
        combine_adler32_partials, combine_crc16_partials, combine_crc32c_partials, crc32c_append,
        plan_checksum, supported_algorithms,
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
                "rom-weaver-checksum-tests-{}-{unique}-{sequence}",
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

    fn checksum_context(root: &Path, threads: ThreadBudget) -> OperationContext {
        OperationContext::new(
            threads,
            root.join("op"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }

    fn write_patterned_file(path: &Path, len: usize) {
        let pattern = (0..(64 * 1024))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let mut file = File::create(path).expect("fixture");
        let mut remaining = len;
        while remaining > 0 {
            let chunk = remaining.min(pattern.len());
            file.write_all(&pattern[..chunk]).expect("write fixture");
            remaining -= chunk;
        }
    }

    fn chunk_boundaries(data_len: usize, split_hints: &[u16]) -> Vec<usize> {
        let mut boundaries = Vec::with_capacity(split_hints.len() + 2);
        boundaries.push(0);
        boundaries.push(data_len);
        for hint in split_hints {
            boundaries.push(usize::from(*hint) % (data_len.saturating_add(1)));
        }
        boundaries.sort_unstable();
        boundaries.dedup();
        if boundaries.first().copied() != Some(0) {
            boundaries.insert(0, 0);
        }
        if boundaries.last().copied() != Some(data_len) {
            boundaries.push(data_len);
        }
        boundaries
    }

    fn assert_parallel_range_for_algorithm(
        algorithm: &str,
        file_name: &str,
        threshold: u64,
        min_bytes_per_thread: u64,
    ) {
        let temp = TestDir::new();
        let source = temp.path().join(file_name);
        let range_start = 1_u64 << 20;
        let range_len = threshold + min_bytes_per_thread;
        let file_len = range_start + range_len + (1_u64 << 20);
        write_patterned_file(
            &source,
            usize::try_from(file_len).expect("range fixture length fits usize"),
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec![algorithm.into()],
            start: Some(range_start),
            length: Some(range_len),
        };

        let sequential = NativeChecksumEngine
            .checksum_range(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_range(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        assert!(parallel.label.contains(&format!(
            "range={}..{}",
            range_start,
            range_start + range_len
        )));
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    proptest! {
        #[test]
        fn crc32c_chunk_combine_matches_sequential(
            data in proptest::collection::vec(any::<u8>(), 0..(512 * 1024)),
            split_hints in proptest::collection::vec(any::<u16>(), 0..32),
        ) {
            let boundaries = chunk_boundaries(data.len(), &split_hints);
            let mut partials = Vec::with_capacity(boundaries.len().saturating_sub(1));
            for window in boundaries.windows(2) {
                let start = window[0];
                let end = window[1];
                let chunk = &data[start..end];
                partials.push(Ok((crc32c_append(0, chunk), chunk.len())));
            }

            let combined = combine_crc32c_partials(partials).expect("combine");
            let sequential = crc32c_append(0, &data);
            prop_assert_eq!(combined, sequential);
        }
    }

    proptest! {
        #[test]
        fn crc16_chunk_combine_matches_sequential(
            data in proptest::collection::vec(any::<u8>(), 0..(512 * 1024)),
            split_hints in proptest::collection::vec(any::<u16>(), 0..32),
        ) {
            let boundaries = chunk_boundaries(data.len(), &split_hints);
            let mut partials = Vec::with_capacity(boundaries.len().saturating_sub(1));
            for window in boundaries.windows(2) {
                let start = window[0];
                let end = window[1];
                let chunk = &data[start..end];
                let mut state = Crc16State::<ARC>::new();
                state.update(chunk);
                partials.push(Ok((state.get(), chunk.len())));
            }

            let combined = combine_crc16_partials(partials).expect("combine");
            let mut sequential_state = Crc16State::<ARC>::new();
            sequential_state.update(&data);
            let sequential = sequential_state.get();
            prop_assert_eq!(combined, sequential);
        }
    }

    proptest! {
        #[test]
        fn adler32_chunk_combine_matches_sequential(
            data in proptest::collection::vec(any::<u8>(), 0..(512 * 1024)),
            split_hints in proptest::collection::vec(any::<u16>(), 0..32),
        ) {
            let boundaries = chunk_boundaries(data.len(), &split_hints);
            let mut partials = Vec::with_capacity(boundaries.len().saturating_sub(1));
            for window in boundaries.windows(2) {
                let start = window[0];
                let end = window[1];
                let chunk = &data[start..end];
                partials.push(Ok((adler32_checksum(chunk), chunk.len())));
            }

            let combined = combine_adler32_partials(partials).expect("combine");
            let sequential = adler32_checksum(&data);
            prop_assert_eq!(combined, sequential);
        }
    }

    #[test]
    fn registry_contains_planned_algorithms() {
        assert_eq!(
            supported_algorithms(),
            &[
                "crc32", "md5", "sha1", "sha256", "blake3", "crc32c", "crc16", "adler32",
            ]
        );
    }

    #[test]
    fn checksum_file_reports_expected_digests() {
        let temp = TestDir::new();
        let source = temp.path().join("sample.bin");
        fs::write(&source, b"hello world").expect("fixture");

        let context = checksum_context(temp.path(), ThreadBudget::Fixed(4));
        let request = ChecksumRequest {
            source,
            algorithms: vec![
                "crc32".into(),
                "md5".into(),
                "sha1".into(),
                "sha256".into(),
                "blake3".into(),
                "crc32c".into(),
            ],
            start: None,
            length: None,
        };

        let report = NativeChecksumEngine
            .checksum_file(&request, &context)
            .expect("checksum report");

        assert_eq!(report.stage, "checksum");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(report.label.contains("crc32=0d4a1185"));
        assert!(
            report
                .label
                .contains("md5=5eb63bbbe01eeed093cb22bb8f5acdc3")
        );
        assert!(
            report
                .label
                .contains("sha1=2aae6c35c94fcfb415dbe95f408b9ce91ee846ed")
        );
        assert!(
            report.label.contains(
                "sha256=b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
            )
        );
        assert!(
            report.label.contains(
                "blake3=d74981efa70a0c880b8d8c1985d075dbcbf679b99a5f9914e5aaf96b831a9e24"
            )
        );
        assert!(report.label.contains("crc32c=c99465aa"));
        let execution = report.thread_execution.expect("thread execution");
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);
    }

    #[test]
    fn large_multi_algorithm_request_uses_parallel_fanout() {
        let temp = TestDir::new();
        let source = temp.path().join("large.bin");
        write_patterned_file(&source, FANOUT_PARALLEL_THRESHOLD as usize + (1 << 20));

        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc32".into(), "md5".into(), "sha1".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert_eq!(execution.effective_threads, 3);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn checksum_report_with_progress_emits_incremental_updates() {
        let temp = TestDir::new();
        let source = temp.path().join("progress.bin");
        write_patterned_file(&source, (FANOUT_PARALLEL_THRESHOLD + (4 << 20)) as usize);

        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc32".into(), "md5".into(), "sha1".into()],
            start: None,
            length: None,
        };

        let context = checksum_context(temp.path(), ThreadBudget::Fixed(1));
        let mut checkpoints = Vec::new();
        let report = NativeChecksumEngine
            .checksum_report_with_progress(&request, &context, "checksum", &mut |progress| {
                checkpoints.push(progress.percent())
            })
            .expect("checksum report");

        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(!checkpoints.is_empty());
        assert!((checkpoints.last().copied().unwrap_or_default() - 100.0).abs() < 0.001);
        assert!(checkpoints.windows(2).all(|window| window[0] <= window[1]));
    }

    #[test]
    fn standalone_crc32_uses_parallel_chunks_on_large_files() {
        let temp = TestDir::new();
        let source = temp.path().join("large-crc32.bin");
        write_patterned_file(
            &source,
            (CRC32_PARALLEL_THRESHOLD + CRC32_PARALLEL_MIN_BYTES_PER_THREAD) as usize,
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc32".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn standalone_blake3_uses_parallel_mode_on_large_files() {
        let temp = TestDir::new();
        let source = temp.path().join("large-blake3.bin");
        write_patterned_file(
            &source,
            (BLAKE3_PARALLEL_THRESHOLD + BLAKE3_PARALLEL_MIN_BYTES_PER_THREAD) as usize,
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec!["blake3".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn standalone_crc32c_uses_parallel_mode_on_large_files() {
        let temp = TestDir::new();
        let source = temp.path().join("large-crc32c.bin");
        write_patterned_file(
            &source,
            (CRC32C_PARALLEL_THRESHOLD + CRC32C_PARALLEL_MIN_BYTES_PER_THREAD) as usize,
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc32c".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn standalone_crc16_uses_parallel_mode_on_large_files() {
        let temp = TestDir::new();
        let source = temp.path().join("large-crc16.bin");
        write_patterned_file(
            &source,
            (CRC16_PARALLEL_THRESHOLD + CRC16_PARALLEL_MIN_BYTES_PER_THREAD) as usize,
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc16".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn standalone_adler32_uses_parallel_mode_on_large_files() {
        let temp = TestDir::new();
        let source = temp.path().join("large-adler32.bin");
        write_patterned_file(
            &source,
            (ADLER32_PARALLEL_THRESHOLD + ADLER32_PARALLEL_MIN_BYTES_PER_THREAD) as usize,
        );

        let request = ChecksumRequest {
            source,
            algorithms: vec!["adler32".into()],
            start: None,
            length: None,
        };

        let sequential = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("seq"), ThreadBudget::Fixed(1)),
            )
            .expect("sequential report");
        let parallel = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(&temp.path().join("par"), ThreadBudget::Fixed(8)),
            )
            .expect("parallel report");

        assert_eq!(parallel.label, sequential.label);
        let execution = parallel.thread_execution.expect("thread execution");
        assert!(execution.effective_threads > 1);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn standalone_crc32c_range_uses_parallel_mode_on_large_files() {
        assert_parallel_range_for_algorithm(
            "crc32c",
            "large-range-crc32c.bin",
            CRC32C_PARALLEL_THRESHOLD,
            CRC32C_PARALLEL_MIN_BYTES_PER_THREAD,
        );
    }

    #[test]
    fn standalone_crc16_range_uses_parallel_mode_on_large_files() {
        assert_parallel_range_for_algorithm(
            "crc16",
            "large-range-crc16.bin",
            CRC16_PARALLEL_THRESHOLD,
            CRC16_PARALLEL_MIN_BYTES_PER_THREAD,
        );
    }

    #[test]
    fn standalone_adler32_range_uses_parallel_mode_on_large_files() {
        assert_parallel_range_for_algorithm(
            "adler32",
            "large-range-adler32.bin",
            ADLER32_PARALLEL_THRESHOLD,
            ADLER32_PARALLEL_MIN_BYTES_PER_THREAD,
        );
    }

    #[test]
    fn planner_keeps_standalone_algorithms_sequential_below_threshold() {
        let cases: &[(Vec<String>, u64)] = &[
            (vec!["crc32".into()], CRC32_PARALLEL_THRESHOLD - 1),
            (vec!["crc32c".into()], CRC32C_PARALLEL_THRESHOLD - 1),
            (vec!["crc16".into()], CRC16_PARALLEL_THRESHOLD - 1),
            (vec!["adler32".into()], ADLER32_PARALLEL_THRESHOLD - 1),
            (vec!["blake3".into()], BLAKE3_PARALLEL_THRESHOLD - 1),
        ];
        for (values, len) in cases {
            let algorithms = super::resolve_algorithms(values).expect("algorithms");
            let range = ResolvedRange {
                start: 0,
                len: *len,
                file_len: *len,
                explicit: false,
            };
            let plan = plan_checksum(&algorithms, &range);
            assert_eq!(plan.mode, ChecksumMode::Sequential);
        }
    }

    #[test]
    fn checksum_range_respects_requested_slice() {
        let temp = TestDir::new();
        let source = temp.path().join("sample.bin");
        fs::write(&source, b"hello world").expect("fixture");

        let context = checksum_context(temp.path(), ThreadBudget::Fixed(8));
        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc32".into(), "md5".into(), "sha1".into()],
            start: Some(6),
            length: Some(5),
        };

        let report = NativeChecksumEngine
            .checksum_range(&request, &context)
            .expect("checksum report");

        assert_eq!(report.stage, "checksum-range");
        assert!(report.label.contains("range=6..11"));
        assert!(report.label.contains("crc32=3a771143"));
        assert!(
            report
                .label
                .contains("md5=7d793037a0760186574b0282f2f435e7")
        );
        assert!(
            report
                .label
                .contains("sha1=7c211433f02071597741e6ff5a8ea34789abbf43")
        );
    }

    #[test]
    fn checksum_requests_do_not_write_on_disk_cache() {
        let temp = TestDir::new();
        let source = temp.path().join("sample.bin");
        fs::write(&source, b"hello world").expect("fixture");

        let request = ChecksumRequest {
            source,
            algorithms: vec!["crc32".into(), "md5".into()],
            start: None,
            length: None,
        };

        let first = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(temp.path(), ThreadBudget::Fixed(4)),
            )
            .expect("first report");
        let second_context = checksum_context(temp.path(), ThreadBudget::Fixed(4));
        let second = NativeChecksumEngine
            .checksum_file(
                &request,
                &second_context,
            )
            .expect("second report");

        assert!(!first.label.contains("cache=hit"));
        assert!(!first.label.contains("cache=partial"));
        assert!(!second.label.contains("cache=hit"));
        assert!(!second.label.contains("cache=partial"));
        assert!(
            !temp.path().join("op/cache/checksums-v1").exists(),
            "checksum operations should not persist on-disk cache files"
        );
        assert!(second.thread_execution.is_some());
    }

    #[test]
    fn checksum_recomputes_when_source_changes() {
        let temp = TestDir::new();
        let source = temp.path().join("sample.bin");
        fs::write(&source, b"hello world").expect("fixture");

        let request = ChecksumRequest {
            source: source.clone(),
            algorithms: vec!["crc32".into()],
            start: None,
            length: None,
        };

        let first = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(temp.path(), ThreadBudget::Fixed(2)),
            )
            .expect("first report");

        fs::write(&source, b"hello world!").expect("updated fixture");

        let second = NativeChecksumEngine
            .checksum_file(
                &request,
                &checksum_context(temp.path(), ThreadBudget::Fixed(2)),
            )
            .expect("second report");

        assert_ne!(first.label, second.label);
        assert!(!second.label.contains("cache=hit"));
        assert!(!second.label.contains("cache=partial"));
    }

    #[test]
    fn checksum_range_rejects_out_of_bounds_requests() {
        let temp = TestDir::new();
        let source = temp.path().join("sample.bin");
        fs::write(&source, b"hello").expect("fixture");

        let request = ChecksumRequest {
            source,
            algorithms: vec!["sha1".into()],
            start: Some(6),
            length: Some(1),
        };

        let error = NativeChecksumEngine
            .checksum_range(
                &request,
                &checksum_context(temp.path(), ThreadBudget::Fixed(1)),
            )
            .expect_err("range should fail");

        assert!(
            error
                .to_string()
                .contains("checksum range start 6 is past the end")
        );
    }
}
/* jscpd:ignore-end */
