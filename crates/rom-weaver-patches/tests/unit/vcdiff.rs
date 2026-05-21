#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Cursor,
        path::PathBuf,
        process,
        sync::atomic::{AtomicU64, Ordering},
        sync::Arc,
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{CancellationToken, NoopProgressSink, ThreadBudget};

    use super::*;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Clone)]
    struct TestWindow {
        win_indicator: u8,
        source_segment_size: Option<u64>,
        source_segment_position: Option<u64>,
        target_window_size: u64,
        checksum: Option<u32>,
        data: Vec<u8>,
        inst: Vec<u8>,
        addr: Vec<u8>,
    }

    #[derive(Default)]
    struct TestPatch {
        version: u8,
        header_flags: u8,
        secondary_id: Option<u8>,
        code_table_near: Option<u8>,
        code_table_same: Option<u8>,
        code_table_data: Vec<u8>,
        app_header: Vec<u8>,
        windows: Vec<TestWindow>,
    }

    #[test]
    fn parse_and_apply_basic_source_patch() {
        let input = b"hello old world";
        let expected = b"hello new world";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: expected.len() as u64,
                checksum: None,
                data: b"new".to_vec(),
                inst: vec![22, 4, 22],
                addr: encode_all_varints(&[0, 9]),
            }],
            ..Default::default()
        });

        let mut reader = Cursor::new(&patch_bytes);
        let parsed = parse_patch(&mut reader).expect("parse patch");
        assert_eq!(parsed.windows.len(), 1);

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let capabilities = handler.capabilities();
        assert!(capabilities.threaded_diff);
        assert!(capabilities.threaded_output);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path.clone(),
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_supports_overlapping_target_copy() {
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: 0,
                source_segment_size: None,
                source_segment_position: None,
                target_window_size: 9,
                checksum: None,
                data: b"abc".to_vec(),
                inst: vec![4, 22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, b"unused").expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply patch");

        assert_eq!(fs::read(output_path).expect("read output"), b"abcabcabc");
    }

    #[test]
    fn parse_supports_xdelta_app_header_and_checksum() {
        let input = b"abcabcabcabc";
        let expected = b"abcabcZZabcabc";
        let checksum = adler32(expected);
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_APP_HEADER,
            app_header: b"xdelta-test".to_vec(),
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE | WIN_CHECKSUM,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: expected.len() as u64,
                checksum: Some(checksum),
                data: b"ZZ".to_vec(),
                inst: vec![22, 3, 22],
                addr: encode_all_varints(&[0, 6]),
            }],
            ..Default::default()
        });

        let mut reader = Cursor::new(&patch_bytes);
        let parsed = parse_patch(&mut reader).expect("parse patch");
        assert_eq!(parsed.windows.len(), 1);
        assert_eq!(parsed.windows[0].checksum, Some(checksum));
        assert_eq!(
            parsed.app_header.as_deref(),
            Some(b"xdelta-test".as_slice())
        );

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .parse(&patch_path, &test_context())
            .expect("inspect patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);

        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_supports_vcd_target_windows_with_thread_fallback() {
        let input = b"unused";
        let expected = b"abcdef";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![
                TestWindow {
                    win_indicator: 0,
                    source_segment_size: None,
                    source_segment_position: None,
                    target_window_size: 3,
                    checksum: None,
                    data: b"abc".to_vec(),
                    inst: vec![4],
                    addr: Vec::new(),
                },
                TestWindow {
                    win_indicator: WIN_TARGET,
                    source_segment_size: Some(3),
                    source_segment_position: Some(0),
                    target_window_size: 3,
                    checksum: None,
                    data: b"def".to_vec(),
                    inst: vec![4],
                    addr: Vec::new(),
                },
            ],
            ..Default::default()
        });

        let parsed = parse_patch(&mut Cursor::new(&patch_bytes)).expect("parse target windows");
        assert_eq!(parsed.windows.len(), 2);
        assert!(matches!(
            parsed.windows[1].source_kind,
            Some(WindowSourceKind::Target)
        ));

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(8),
            )
            .expect("apply target-window patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(!execution.used_parallelism);
        assert_eq!(execution.effective_threads, 1);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn parse_supports_secondary_fixture() {
        let patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");

        let parsed = parse_patch(&mut Cursor::new(patch)).expect("parse secondary patch");
        assert!(parsed.secondary_compressor_id.is_some());
        assert_eq!(parsed.windows.len(), 1);
        assert!(parsed
            .windows
            .iter()
            .any(|window| window.delta_indicator != 0));
    }

    #[test]
    fn parse_accepts_custom_code_table_headers() {
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_CODE_TABLE,
            code_table_near: Some(4),
            code_table_same: Some(3),
            code_table_data: vec![0x00],
            ..Default::default()
        });

        let parsed = parse_patch(&mut Cursor::new(&patch_bytes)).expect("parse custom code table");
        assert!(parsed.windows.is_empty());
        let code_table = parsed
            .custom_code_table
            .as_ref()
            .expect("custom code table metadata");
        assert_eq!(code_table.near_size, 4);
        assert_eq!(code_table.same_size, 3);
        assert_eq!(code_table.data_len, 1);

        let temp = create_temp_dir();
        let patch_path = temp.join("custom-table.vcdiff");
        fs::write(&patch_path, &patch_bytes).expect("write patch");
        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let report = handler
            .parse(&patch_path, &test_context())
            .expect("parse report");
        assert!(report.label.contains("custom code table declared"));
    }

    #[test]
    fn parse_rejects_custom_code_table_header_without_table_data() {
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_CODE_TABLE,
            code_table_near: Some(4),
            code_table_same: Some(3),
            code_table_data: Vec::new(),
            ..Default::default()
        });

        let error = parse_patch(&mut Cursor::new(&patch_bytes))
            .expect_err("custom code table without payload should fail");
        assert!(format!("{error}").contains("invalid custom code table size"));
    }

    #[test]
    fn apply_rejects_custom_code_table_headers() {
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_CODE_TABLE,
            code_table_near: Some(4),
            code_table_same: Some(3),
            code_table_data: vec![0x00],
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE,
                source_segment_size: Some(4),
                source_segment_position: Some(0),
                target_window_size: 4,
                checksum: None,
                data: Vec::new(),
                inst: vec![22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, b"abcd").expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("custom code table should be rejected");
        assert!(format!("{error}").contains("does not support custom code tables"));
    }

    #[test]
    fn apply_fails_on_checksum_mismatch() {
        let input = b"abcabcabcabc";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE | WIN_CHECKSUM,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: 6,
                checksum: Some(0xDEADBEEF),
                data: Vec::new(),
                inst: vec![22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("checksum mismatch");
        assert!(format!("{error}").contains("checksum mismatch"));
    }

    #[test]
    fn apply_can_ignore_checksum_mismatch() {
        let input = b"abcabcabcabc";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE | WIN_CHECKSUM,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: 6,
                checksum: Some(0xDEADBEEF),
                data: Vec::new(),
                inst: vec![22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context().with_patch_checksum_validation(PatchChecksumValidation::Ignore),
            )
            .expect("checksum validation ignored");

        assert!(report.label.contains("checksum validation skipped"));
        assert_eq!(fs::read(output_path).expect("read output"), b"abcabc");
    }

    #[test]
    fn apply_rejects_multiple_patch_files() {
        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: PathBuf::from("input.bin"),
                    patches: vec![PathBuf::from("a.vcdiff"), PathBuf::from("b.vcdiff")],
                    output: PathBuf::from("output.bin"),
                },
                &test_context(),
            )
            .expect_err("multiple patches");
        assert!(format!("{error}").contains("exactly one patch"));
    }

    #[test]
    fn multi_window_patch_round_trips() {
        let input = b"hello old world";
        let expected = b"hello new world";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 6,
                    checksum: None,
                    data: Vec::new(),
                    inst: vec![22],
                    addr: encode_all_varints(&[0]),
                },
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 9,
                    checksum: None,
                    data: b"new".to_vec(),
                    inst: vec![4, 22],
                    addr: encode_all_varints(&[9]),
                },
            ],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let capabilities = handler.capabilities();
        assert!(capabilities.threaded_output);
        let inspect = handler
            .parse(&patch_path, &test_context())
            .expect("inspect patch");
        assert_eq!(inspect.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(inspect.label.contains("2 window"));

        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(4),
            )
            .expect("apply patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn multi_window_xdelta_patch_round_trips_with_parallel_decoder() {
        let input = b"hello old world";
        let expected = b"hello new world";
        let patch_bytes = build_patch(TestPatch {
            app_header: b"xdelta-cli".to_vec(),
            windows: vec![
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 6,
                    checksum: None,
                    data: Vec::new(),
                    inst: vec![22],
                    addr: encode_all_varints(&[0]),
                },
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 9,
                    checksum: None,
                    data: b"new".to_vec(),
                    inst: vec![4, 22],
                    addr: encode_all_varints(&[9]),
                },
            ],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let capabilities = handler.capabilities();
        assert!(capabilities.threaded_diff);
        assert!(capabilities.threaded_output);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(4),
            )
            .expect("apply xdelta patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn create_vcdiff_patch_round_trips() {
        let input = b"hello old world";
        let expected = b"hello new world";

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&modified_path, expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "VCDIFF".into(),
                },
                &test_context(),
            )
            .expect("create vcdiff patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);

        let patch = fs::read(&patch_path).expect("read patch");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert_eq!(parsed.secondary_compressor_id, None);
        assert_eq!(parsed.app_header, None);

        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply created vcdiff patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn create_xdelta_patch_prefers_secondary_when_it_is_smaller() {
        let (input, expected) = generated_secondary_source_and_target();

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context_with_threads(8),
            )
            .expect("create xdelta patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(
            report
                .thread_execution
                .expect("thread execution")
                .used_parallelism
        );
        assert!(report.label.contains("secondary compression"));

        let baseline_probe = temp.join("baseline-probe.xdelta");
        let baseline_with_header_probe = temp.join("baseline-header-probe.xdelta");
        let secondary_probe = temp.join("secondary-probe.xdelta");
        let expected_app_header = build_default_xdelta_app_header(&input_path, &modified_path);
        let baseline = encode_patch_with_native_streaming(
            &input_path,
            &modified_path,
            &baseline_probe,
            create_native_compress_options(&crate::XDELTA, true),
        )
        .expect("encode baseline xdelta patch");
        let baseline_with_header = recode_patch_with_xdelta_options(
            &baseline.path,
            &baseline_with_header_probe,
            None,
            Some(expected_app_header.as_slice()),
        )
        .expect("add xdelta app header");
        let secondary = recode_patch_with_xdelta_options(
            &baseline_with_header.path,
            &secondary_probe,
            Some(XDELTA_LZMA_SECONDARY_ID),
            Some(expected_app_header.as_slice()),
        )
        .expect("encode secondary xdelta patch");
        let should_choose_secondary = secondary.size < baseline_with_header.size;

        let patch = fs::read(&patch_path).expect("read patch");
        assert_eq!(
            patch.len() as u64,
            secondary.size.min(baseline_with_header.size),
            "created patch should match the smallest native candidate"
        );
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert_eq!(
            parsed.app_header.as_deref(),
            Some(expected_app_header.as_slice())
        );
        if should_choose_secondary {
            assert_eq!(parsed.secondary_compressor_id, Some(2));
        } else {
            assert_eq!(parsed.secondary_compressor_id, None);
        }

        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply created xdelta patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn create_xdelta_patch_mode_none_disables_secondary_candidates() {
        let (input, expected) = generated_secondary_source_and_target();

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.xdelta");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context_with_threads(8)
                    .with_xdelta_secondary_mode(rom_weaver_core::XdeltaSecondaryMode::None),
            )
            .expect("create xdelta patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(
            !report
                .thread_execution
                .expect("thread execution")
                .used_parallelism
        );
        assert!(!report.label.contains("secondary compression"));

        let patch = fs::read(&patch_path).expect("read patch");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert_eq!(parsed.secondary_compressor_id, None);
    }

    #[test]
    fn create_xdelta_patch_mode_lzma_only_uses_lzma_secondary() {
        let (input, expected) = generated_secondary_source_and_target();

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.xdelta");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context_with_threads(8)
                    .with_xdelta_secondary_mode(rom_weaver_core::XdeltaSecondaryMode::Lzma),
            )
            .expect("create xdelta patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(
            !report
                .thread_execution
                .expect("thread execution")
                .used_parallelism
        );

        let patch = fs::read(&patch_path).expect("read patch");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert!(matches!(
            parsed.secondary_compressor_id,
            None | Some(XDELTA_LZMA_SECONDARY_ID)
        ));
    }

    #[test]
    fn create_xdelta_patch_mode_auto_fast_skips_secondary_for_high_entropy_input() {
        let (input, expected) = generated_high_entropy_source_and_target();

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.xdelta");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path,
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context_with_threads(8)
                    .with_xdelta_secondary_mode(rom_weaver_core::XdeltaSecondaryMode::AutoFast),
            )
            .expect("create xdelta patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(
            !report
                .thread_execution
                .expect("thread execution")
                .used_parallelism
        );

        let patch = fs::read(&patch_path).expect("read patch");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert_eq!(parsed.secondary_compressor_id, None);
    }

    #[test]
    fn create_vcdiff_patch_from_empty_source_round_trips() {
        let input = Vec::new();
        let expected = b"streamed-from-empty-source".repeat(1024);

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "VCDIFF".into(),
                },
                &test_context(),
            )
            .expect("create vcdiff patch from empty source");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);

        let patch = fs::read(&patch_path).expect("read patch");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert_eq!(parsed.secondary_compressor_id, None);
        assert!(!parsed.windows.is_empty());
        assert!(parsed
            .windows
            .iter()
            .all(|window| window.source_kind.is_none()));

        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply created vcdiff patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn create_xdelta_large_streaming_patch_round_trips_with_parallel_apply() {
        let (input, expected) = generated_large_streaming_source_and_target();

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context(),
            )
            .expect("create xdelta patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);

        let patch = fs::read(&patch_path).expect("read patch");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        let expected_app_header = build_default_xdelta_app_header(&input_path, &modified_path);
        assert_eq!(
            parsed.app_header.as_deref(),
            Some(expected_app_header.as_slice())
        );
        assert!(
            parsed.windows.len() >= 2,
            "expected streaming create to produce multiple windows for >8 MiB input"
        );

        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(8),
            )
            .expect("apply created xdelta patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn secondary_fixture_applies_with_parallel_fallback() {
        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::copy(fixture_path("secondary-djw.xdelta"), &patch_path).expect("copy patch fixture");
        let expected = fs::read(fixture_path("secondary-target.bin")).expect("read target fixture");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let inspect = handler
            .parse(&patch_path, &test_context())
            .expect("inspect secondary patch");
        assert_eq!(inspect.status, rom_weaver_core::OperationStatus::Succeeded);

        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(8),
            )
            .expect("apply secondary patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(!execution.used_parallelism);
        assert_eq!(execution.effective_threads, 1);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn create_xdelta_patch_can_skip_checksums_via_context_toggle() {
        let input = b"hello old world";
        let expected = b"hello new world";

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("update.xdelta");
        fs::write(&input_path, input).expect("write input");
        fs::write(&modified_path, expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context().with_patch_checksum_validation(PatchChecksumValidation::Ignore),
            )
            .expect("create xdelta patch without checksums");

        let parsed = parse_patch(&mut Cursor::new(fs::read(&patch_path).expect("read patch")))
            .expect("parse created xdelta patch");
        assert!(!parsed.windows.is_empty());
        assert!(parsed
            .windows
            .iter()
            .all(|window| window.checksum.is_none()));
        let expected_app_header = build_default_xdelta_app_header(&input_path, &modified_path);
        assert_eq!(
            parsed.app_header.as_deref(),
            Some(expected_app_header.as_slice())
        );
    }

    #[test]
    fn apply_supports_oxidelta_style_lzma_secondary_patch() {
        let (input, expected) = generated_secondary_source_and_target();

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join("oxidelta-style.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let patch = encode_patch_with_native_streaming(
            &input_path,
            &modified_path,
            &patch_path,
            CompressOptions {
                checksum: true,
                secondary: SecondaryCompression::Lzma,
                ..CompressOptions::default()
            },
        )
        .expect("encode oxidelta lzma patch");
        assert!(patch.size > 0);

        let parsed = parse_patch(&mut Cursor::new(fs::read(&patch_path).expect("read patch")))
            .expect("parse oxidelta patch");
        assert_eq!(
            parsed.secondary_compressor_id,
            Some(XDELTA_LZMA_SECONDARY_ID)
        );
        assert!(parsed
            .windows
            .iter()
            .any(|window| window.delta_indicator != 0));

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(8),
            )
            .expect("apply oxidelta lzma patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn recode_supports_all_xdelta_secondary_encoders() {
        let (input, expected) = generated_secondary_source_and_target();
        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let baseline_path = temp.join("baseline.xdelta");
        let baseline = encode_patch_with_native_streaming(
            &input_path,
            &modified_path,
            &baseline_path,
            create_native_compress_options(&crate::XDELTA, true),
        )
        .expect("encode baseline");
        assert!(baseline.size > 0);

        let app_header = build_default_xdelta_app_header(&input_path, &modified_path);
        let handler = VcdiffPatchHandler::new(&crate::XDELTA);

        for secondary_id in XDELTA_SECONDARY_CANDIDATES {
            let patch_path = temp.join(format!("secondary-{secondary_id}.xdelta"));
            let output_path = temp.join(format!("output-{secondary_id}.bin"));
            let recoded = recode_patch_with_xdelta_options(
                &baseline.path,
                &patch_path,
                Some(secondary_id),
                Some(app_header.as_slice()),
            )
            .expect("recode patch");
            assert!(recoded.size > 0);

            let parsed = parse_patch(&mut Cursor::new(fs::read(&patch_path).expect("read patch")))
                .expect("parse recoded patch");
            assert_eq!(parsed.secondary_compressor_id, Some(secondary_id));
            assert_eq!(parsed.app_header.as_deref(), Some(app_header.as_slice()));

            handler
                .apply(
                    &PatchApplyRequest {
                        input: input_path.clone(),
                        patches: vec![patch_path],
                        output: output_path.clone(),
                    },
                    &test_context(),
                )
                .expect("apply recoded patch");
            assert_eq!(fs::read(output_path).expect("read output"), expected);
        }
    }

    #[test]
    fn apply_fails_for_mismatched_djw_header_and_lzma_payload() {
        let mut patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");
        patch[5] = XDELTA_DJW_SECONDARY_ID;

        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse djw patch");
        assert_eq!(
            parsed.secondary_compressor_id,
            Some(XDELTA_DJW_SECONDARY_ID)
        );
        assert!(parsed
            .windows
            .iter()
            .any(|window| window.delta_indicator != 0));

        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::write(&patch_path, patch).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("mismatched DJW header should fail");
        assert!(
            format!("{error}").contains("xdelta djw")
                || format!("{error}").contains("secondary decompression")
        );
    }

    #[test]
    fn apply_supports_legacy_djw_fixture() {
        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::copy(fixture_path("secondary-djw-legacy.xdelta"), &patch_path)
            .expect("copy legacy djw fixture");
        let expected = fs::read(fixture_path("secondary-target.bin")).expect("read target fixture");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("legacy djw fixture should apply");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_fails_for_mismatched_fgk_header_and_lzma_payload() {
        let mut patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");
        patch[5] = XDELTA_FGK_SECONDARY_ID;

        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse fgk patch");
        assert_eq!(
            parsed.secondary_compressor_id,
            Some(XDELTA_FGK_SECONDARY_ID)
        );
        assert!(parsed
            .windows
            .iter()
            .any(|window| window.delta_indicator != 0));

        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::write(&patch_path, patch).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("mismatched FGK header should fail");
        assert!(
            format!("{error}").contains("xdelta fgk")
                || format!("{error}").contains("secondary decompression")
        );
    }

    #[test]
    fn apply_supports_legacy_fgk_fixture() {
        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::copy(fixture_path("secondary-fgk-legacy.xdelta"), &patch_path)
            .expect("copy legacy fgk fixture");
        let expected = fs::read(fixture_path("secondary-target.bin")).expect("read target fixture");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("legacy fgk fixture should apply");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_supports_legacy_lzma_fixture() {
        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::copy(fixture_path("secondary-lzma-legacy.xdelta"), &patch_path)
            .expect("copy legacy lzma fixture");
        let expected = fs::read(fixture_path("secondary-target.bin")).expect("read target fixture");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("legacy lzma fixture should apply");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_fails_for_unknown_secondary_compressor_id() {
        let mut patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");
        patch[5] = 0x7F;

        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::write(&patch_path, patch).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("unknown secondary compressor should fail");
        assert!(format!("{error}").contains("secondary compressor ID"));
    }

    #[test]
    fn apply_fails_for_unknown_secondary_id_without_compressed_sections() {
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_SECONDARY,
            secondary_id: Some(0x7F),
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE,
                source_segment_size: Some(4),
                source_segment_position: Some(0),
                target_window_size: 4,
                checksum: None,
                data: Vec::new(),
                inst: vec![22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, b"abcd").expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("unknown secondary header id should fail");
        assert!(format!("{error}").contains("secondary compressor ID"));
    }

    #[test]
    fn apply_fails_when_compressed_sections_lack_secondary_header() {
        let mut patch = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: 0,
                source_segment_size: None,
                source_segment_position: None,
                target_window_size: 4,
                checksum: None,
                data: Vec::new(),
                inst: vec![22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });
        patch[8] = DELTA_DATA_COMP;

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, b"abcd").expect("write input");
        fs::write(&patch_path, patch).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("compressed sections without secondary header should fail");
        assert!(format!("{error}").contains("compressed sections"));
    }

    #[test]
    fn apply_fails_for_corrupted_secondary_stream() {
        let mut patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse secondary patch");
        let data_offset = parsed.windows[0].data_start as usize;
        patch[data_offset + 8] ^= 0x20;

        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::write(&patch_path, patch).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("corrupted secondary stream should fail");
        let message = format!("{error}");
        assert!(
            message.contains("native VCDIFF secondary decompression failed")
                || message.contains("native VCDIFF decoder failed")
                || message.contains("checksum mismatch")
        );
    }

    fn create_temp_dir() -> PathBuf {
        let unique = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "rom-weaver-vcdiff-tests-{}-{timestamp}-{unique}",
            process::id()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn test_context() -> OperationContext {
        test_context_with_threads(1)
    }

    fn test_context_with_threads(threads: usize) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            create_temp_dir().join("context"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/vcdiff")
            .join(name)
    }

    fn generated_secondary_source_and_target() -> (Vec<u8>, Vec<u8>) {
        let source: Vec<u8> = (0..65_536)
            .map(|index| ((index * 31) & 0xFF) as u8)
            .collect();
        let mut target = Vec::new();
        let chunk = b"PATCH-DATA-BLOCK-ALPHA-BETA-GAMMA-";
        while target.len() < 70_000 {
            target.extend_from_slice(chunk);
            target.extend_from_slice(format!("{:04}", target.len() % 10_000).as_bytes());
        }
        target.truncate(70_000);
        (source, target)
    }

    fn generated_large_streaming_source_and_target() -> (Vec<u8>, Vec<u8>) {
        let source_len = (9 * 1024 * 1024) + 32_768;
        let mut source: Vec<u8> = (0..source_len)
            .map(|index| ((index * 31 + (index / 97)) & 0xFF) as u8)
            .collect();
        let mut target = source.clone();

        for (offset, replacement) in [
            (64_000usize, b"FIRST-WINDOW-PATCH-BLOCK".as_slice()),
            (4_200_000usize, b"MIDDLE-WINDOW-MUTATION".as_slice()),
            (8_600_000usize, b"SECOND-WINDOW-PATCH-BLOCK".as_slice()),
            (source_len - 8_192, b"TAIL-BLOCK-FOR-STREAMING".as_slice()),
        ] {
            target[offset..offset + replacement.len()].copy_from_slice(replacement);
        }

        source[128_000..128_000 + b"SOURCE-ONLY-DATA".len()].copy_from_slice(b"SOURCE-ONLY-DATA");

        (source, target)
    }

    fn generated_high_entropy_source_and_target() -> (Vec<u8>, Vec<u8>) {
        let len = 2 * 1024 * 1024;
        let mut state = 0xA5A5_5A5A_DEAD_BEEFu64;
        let mut source = Vec::with_capacity(len);
        for _ in 0..len {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            let value = state.wrapping_mul(0x2545_F491_4F6C_DD1Du64);
            source.push((value >> 56) as u8);
        }
        let mut target = source.clone();
        for (index, byte) in target.iter_mut().step_by(4096).enumerate() {
            *byte ^= ((index * 73) & 0xFF) as u8;
        }

        (source, target)
    }

    fn build_patch(patch: TestPatch) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&VCDIFF_MAGIC_BYTES);
        bytes.push(patch.version);
        bytes.push(patch.header_flags);

        if patch.header_flags & HDR_SECONDARY != 0 {
            bytes.push(patch.secondary_id.expect("secondary id"));
        }
        if patch.header_flags & HDR_CODE_TABLE != 0 {
            let code_table_len = patch.code_table_data.len() as u64 + 2;
            encode_varint(&mut bytes, code_table_len);
            bytes.push(patch.code_table_near.expect("near size"));
            bytes.push(patch.code_table_same.expect("same size"));
            bytes.extend_from_slice(&patch.code_table_data);
        }
        if patch.header_flags & HDR_APP_HEADER != 0 {
            encode_varint(&mut bytes, patch.app_header.len() as u64);
            bytes.extend_from_slice(&patch.app_header);
        }

        for window in patch.windows {
            bytes.push(window.win_indicator);
            if let (Some(size), Some(position)) =
                (window.source_segment_size, window.source_segment_position)
            {
                encode_varint(&mut bytes, size);
                encode_varint(&mut bytes, position);
            }

            let mut delta = Vec::new();
            encode_varint(&mut delta, window.target_window_size);
            delta.push(0);
            encode_varint(&mut delta, window.data.len() as u64);
            encode_varint(&mut delta, window.inst.len() as u64);
            encode_varint(&mut delta, window.addr.len() as u64);
            if let Some(checksum) = window.checksum {
                delta.extend_from_slice(&checksum.to_be_bytes());
            }
            delta.extend_from_slice(&window.data);
            delta.extend_from_slice(&window.inst);
            delta.extend_from_slice(&window.addr);

            encode_varint(&mut bytes, delta.len() as u64);
            bytes.extend_from_slice(&delta);
        }

        bytes
    }

    fn encode_all_varints(values: &[u64]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for &value in values {
            encode_varint(&mut bytes, value);
        }
        bytes
    }

    fn encode_varint(bytes: &mut Vec<u8>, mut value: u64) {
        if value == 0 {
            bytes.push(0);
            return;
        }

        let mut stack = Vec::new();
        while value > 0 {
            stack.push((value % 128) as u8);
            value /= 128;
        }

        for (index, digit) in stack.iter().rev().enumerate() {
            let is_last = index + 1 == stack.len();
            bytes.push(if is_last { *digit } else { *digit | 0x80 });
        }
    }
}
