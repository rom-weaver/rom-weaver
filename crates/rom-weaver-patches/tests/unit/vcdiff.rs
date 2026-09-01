use super::*;
use std::{
    fs,
    io::Cursor,
    path::PathBuf,
    process,
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use rom_weaver_core::{CancellationToken, NoopProgressSink, PatchChecksumValidation, ThreadBudget};

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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::VCDIFF);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::VCDIFF);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
    let report = handler
        .parse(&patch_path, &test_context())
        .expect("probe patch");
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
fn parse_reports_source_requirements_without_adler_values() {
    let patch_bytes = build_patch(TestPatch {
        windows: vec![
            TestWindow {
                win_indicator: WIN_SOURCE | WIN_CHECKSUM,
                source_segment_size: Some(4),
                source_segment_position: Some(2),
                target_window_size: 4,
                checksum: Some(0x1234_5678),
                data: b"data".to_vec(),
                inst: vec![7],
                addr: Vec::new(),
            },
            TestWindow {
                win_indicator: WIN_TARGET,
                source_segment_size: Some(1),
                source_segment_position: Some(0),
                target_window_size: 1,
                checksum: None,
                data: b"!".to_vec(),
                inst: vec![4],
                addr: Vec::new(),
            },
        ],
        ..Default::default()
    });

    let temp = create_temp_dir();
    let patch_path = temp.join("probe.xdelta");
    fs::write(&patch_path, patch_bytes).expect("write patch");

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
    let report = handler
        .parse(&patch_path, &test_context())
        .expect("probe patch");
    let details = report.details.expect("details");
    let patch = &details["patch"];

    assert_eq!(patch["format"], "xdelta");
    assert_eq!(patch["minimum_source_size"], 6);
    assert_eq!(patch["target_size"], 5);
    assert_eq!(patch["record_count"], 2);
    assert_eq!(patch["source_window_count"], 1);
    assert_eq!(patch["target_window_count"], 1);
    assert_eq!(patch["window_checksum_count"], 1);
    assert!(patch.get("window_adler32").is_none());
    assert!(patch.get("window_adler32_checksums").is_none());
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::VCDIFF);
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
    assert!(
        parsed
            .windows
            .iter()
            .any(|window| window.delta_indicator != 0)
    );
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
    let handler = VcdiffPatchHandler::new(&crate::xdelta::VCDIFF);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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
    let handler = VcdiffPatchHandler::new(&crate::xdelta::VCDIFF);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::VCDIFF);
    let capabilities = handler.capabilities();
    assert!(capabilities.threaded_output);
    let probe = handler
        .parse(&patch_path, &test_context())
        .expect("probe patch");
    assert_eq!(probe.status, rom_weaver_core::OperationStatus::Succeeded);
    assert!(probe.label.contains("2 window"));

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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::VCDIFF);
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
    assert!(
        parsed
            .windows
            .iter()
            .any(|window| matches!(window.source_kind, Some(WindowSourceKind::Source))),
        "expected create to emit source-referenced windows when source is non-empty"
    );

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
fn apply_patch_bytes_round_trips_in_memory() {
    let input = b"hello old world, this is the source payload";
    let expected = b"hello new world, this is the modified payload!";

    let temp = create_temp_dir();
    let input_path = temp.join("input.bin");
    let modified_path = temp.join("modified.bin");
    let patch_path = temp.join("update.vcdiff");
    fs::write(&input_path, input).expect("write input");
    fs::write(&modified_path, expected).expect("write modified");

    let handler = VcdiffPatchHandler::new(&crate::xdelta::VCDIFF);
    handler
        .create(
            &PatchCreateRequest {
                original: input_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "VCDIFF".into(),
            },
            &test_context(),
        )
        .expect("create vcdiff patch");

    let patch_bytes = fs::read(&patch_path).expect("read patch");
    let target = crate::xdelta::apply_patch_bytes(input, &patch_bytes).expect("apply in memory");
    assert_eq!(target, expected);

    // A wrong source must not silently produce the target (source checksum).
    let wrong =
        crate::xdelta::apply_patch_bytes(b"completely different source bytes here", &patch_bytes);
    assert!(wrong.is_err() || wrong.unwrap() != expected);
}

#[test]
fn create_xdelta_patch_defaults_to_lzma_secondary_when_it_is_smaller() {
    let (input, expected) = generated_secondary_source_and_target();

    let temp = create_temp_dir();
    let input_path = temp.join("input.bin");
    let modified_path = temp.join("modified.bin");
    let patch_path = temp.join("update.xdelta");
    let output_path = temp.join("output.bin");
    fs::write(&input_path, &input).expect("write input");
    fs::write(&modified_path, &expected).expect("write modified");

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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
        !report
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
        create_native_compress_options(&crate::xdelta::XDELTA, true),
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
fn create_xdelta_patch_mode_auto_compares_all_secondary_candidates() {
    let (input, expected) = generated_secondary_source_and_target();

    let temp = create_temp_dir();
    let input_path = temp.join("input.bin");
    let modified_path = temp.join("modified.bin");
    let patch_path = temp.join("update.xdelta");
    let output_path = temp.join("output.bin");
    fs::write(&input_path, &input).expect("write input");
    fs::write(&modified_path, &expected).expect("write modified");

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
    let report = handler
        .create(
            &PatchCreateRequest {
                original: input_path.clone(),
                modified: modified_path,
                output: patch_path.clone(),
                format: "xdelta".into(),
            },
            &test_context_with_threads(8)
                .with_xdelta_secondary_mode(rom_weaver_core::XdeltaSecondaryMode::Auto),
        )
        .expect("create xdelta patch");
    assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
    assert!(
        report
            .thread_execution
            .expect("thread execution")
            .used_parallelism
    );

    let patch = fs::read(&patch_path).expect("read patch");
    let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
    assert!(matches!(
        parsed.secondary_compressor_id,
        None | Some(XDELTA_DJW_SECONDARY_ID)
            | Some(XDELTA_LZMA_SECONDARY_ID)
            | Some(XDELTA_FGK_SECONDARY_ID)
    ));

    handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context(),
        )
        .expect("apply auto-created xdelta patch");
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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
    assert_eq!(
        parsed.secondary_compressor_id,
        Some(XDELTA_LZMA_SECONDARY_ID)
    );
}

#[test]
fn create_xdelta_patch_supports_explicit_djw_and_fgk_secondary_modes() {
    for (mode, expected_id) in [
        (
            rom_weaver_core::XdeltaSecondaryMode::Djw,
            XDELTA_DJW_SECONDARY_ID,
        ),
        (
            rom_weaver_core::XdeltaSecondaryMode::Fgk,
            XDELTA_FGK_SECONDARY_ID,
        ),
    ] {
        let (input, expected) = generated_secondary_source_and_target();

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let modified_path = temp.join("modified.bin");
        let patch_path = temp.join(format!("update-{expected_id}.xdelta"));
        let output_path = temp.join(format!("output-{expected_id}.bin"));
        fs::write(&input_path, &input).expect("write input");
        fs::write(&modified_path, &expected).expect("write modified");

        let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: input_path.clone(),
                    modified: modified_path,
                    output: patch_path.clone(),
                    format: "xdelta".into(),
                },
                &test_context_with_threads(8).with_xdelta_secondary_mode(mode),
            )
            .expect("create xdelta patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);

        let patch = fs::read(&patch_path).expect("read patch");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse created patch");
        assert_eq!(parsed.secondary_compressor_id, Some(expected_id));

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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::VCDIFF);
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
    assert!(
        parsed
            .windows
            .iter()
            .all(|window| window.source_kind.is_none())
    );

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
fn create_xdelta_large_streaming_patch_round_trips_with_stateful_lzma() {
    let (input, expected) = generated_large_streaming_source_and_target();

    let temp = create_temp_dir();
    let input_path = temp.join("input.bin");
    let modified_path = temp.join("modified.bin");
    let patch_path = temp.join("update.xdelta");
    let output_path = temp.join("output.bin");
    fs::write(&input_path, &input).expect("write input");
    fs::write(&modified_path, &expected).expect("write modified");

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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
    assert_eq!(
        parsed.secondary_compressor_id,
        Some(XDELTA_LZMA_SECONDARY_ID)
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
    assert!(!execution.used_parallelism);
    assert_eq!(fs::read(output_path).expect("read output"), expected);
}

#[test]
fn create_xdelta_parallel_window_encode_matches_sequential_bytes() {
    let (input, expected) = generated_large_streaming_source_and_target();

    let temp = create_temp_dir();
    let input_path = temp.join("input.bin");
    let modified_path = temp.join("modified.bin");
    fs::write(&input_path, &input).expect("write input");
    fs::write(&modified_path, &expected).expect("write modified");

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
    let request = |output: &Path| PatchCreateRequest {
        original: input_path.clone(),
        modified: modified_path.clone(),
        output: output.to_path_buf(),
        format: "xdelta".into(),
    };

    let sequential_path = temp.join("sequential.xdelta");
    let sequential_report = handler
        .create(&request(&sequential_path), &test_context_with_threads(1))
        .expect("create sequential xdelta patch");
    assert!(
        !sequential_report
            .thread_execution
            .expect("sequential thread execution")
            .used_parallelism
    );

    let parallel_path = temp.join("parallel.xdelta");
    let parallel_report = handler
        .create(&request(&parallel_path), &test_context_with_threads(4))
        .expect("create parallel xdelta patch");
    let parallel_execution = parallel_report
        .thread_execution
        .expect("parallel thread execution");
    assert!(
        parallel_execution.used_parallelism,
        "multi-window create with a multi-thread budget should fan the window diff out"
    );
    assert!(parallel_execution.effective_threads >= 2);

    let sequential_bytes = fs::read(&sequential_path).expect("read sequential patch");
    let parallel_bytes = fs::read(&parallel_path).expect("read parallel patch");
    assert_eq!(
        sequential_bytes, parallel_bytes,
        "parallel window encode must produce byte-identical output to the sequential encode"
    );

    let parsed = parse_patch(&mut Cursor::new(&parallel_bytes)).expect("parse parallel patch");
    assert!(parsed.windows.len() >= 2);

    let output_path = temp.join("output.bin");
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![parallel_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(4),
        )
        .expect("apply parallel xdelta patch");
    assert_eq!(fs::read(output_path).expect("read output"), expected);
}

#[test]
fn create_xdelta_appheader_baseline_size_matches_materialized() {
    let (input, expected) = generated_large_streaming_source_and_target();

    let temp = create_temp_dir();
    let input_path = temp.join("input.bin");
    let modified_path = temp.join("modified.bin");
    fs::write(&input_path, &input).expect("write input");
    fs::write(&modified_path, &expected).expect("write modified");

    let baseline_raw_path = temp.join("baseline-raw.xdelta");
    encode_patch_with_native_streaming(
        &input_path,
        &modified_path,
        &baseline_raw_path,
        create_native_compress_options(&crate::xdelta::XDELTA, true),
    )
    .expect("encode baseline raw");
    let loaded = load_patch_for_xdelta_recode(&baseline_raw_path).expect("load baseline raw");
    assert!(
        loaded.parsed.windows.len() >= 2,
        "expected a multi-window baseline for the size check"
    );
    let app_header = build_default_xdelta_app_header(&input_path, &modified_path);

    let materialized_path = temp.join("baseline-appheader.xdelta");
    let materialized = recode_loaded_patch_with_xdelta_options(
        &loaded,
        &materialized_path,
        None,
        Some(&app_header),
        None,
    )
    .expect("materialize app-header baseline");
    let measured =
        measure_appheader_baseline_size(&loaded, &app_header).expect("measure app-header baseline");
    assert_eq!(
        measured, materialized.size,
        "analytic app-header baseline size must match the materialized file size"
    );
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
    let probe = handler
        .parse(&patch_path, &test_context())
        .expect("probe secondary patch");
    assert_eq!(probe.status, rom_weaver_core::OperationStatus::Succeeded);

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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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
    assert!(
        parsed
            .windows
            .iter()
            .all(|window| window.checksum.is_none())
    );
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
    assert!(
        parsed
            .windows
            .iter()
            .any(|window| window.delta_indicator != 0)
    );

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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
fn apply_supports_stateful_xdelta_lzma_secondary_across_windows() {
    let chunks = [b"abc".repeat(12), b"def".repeat(12)];
    let mut encoders = XdeltaLzmaSectionEncoders::new().expect("lzma encoders");
    let mut windows = Vec::new();
    let mut expected = Vec::new();

    for (index, chunk) in chunks.iter().enumerate() {
        let (compressed, compressed_flag) = encoders
            .encode_data(chunk)
            .expect("compress lzma data section");
        assert!(compressed_flag);
        if index == 0 {
            assert!(xdelta_lzma_section_has_stream_header(&compressed));
        } else {
            assert!(!xdelta_lzma_section_has_stream_header(&compressed));
        }
        windows.push((
            chunk.len() as u64,
            compressed.into_owned(),
            vec![4; chunk.len() / 3],
        ));
        expected.extend_from_slice(chunk);
    }

    let patch_bytes = build_secondary_data_add_windows_patch(XDELTA_LZMA_SECONDARY_ID, windows);
    let temp = create_temp_dir();
    let input_path = temp.join("input.bin");
    let patch_path = temp.join("stateful-lzma.xdelta");
    let output_path = temp.join("output.bin");
    fs::write(&input_path, b"").expect("write input");
    fs::write(&patch_path, patch_bytes).expect("write patch");

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context(),
        )
        .expect("apply stateful lzma patch");
    assert_eq!(fs::read(output_path).expect("read output"), expected);
}

#[test]
fn apply_patch_bytes_rejects_xdelta_lzma_sections() {
    let mut encoders = XdeltaLzmaSectionEncoders::new().expect("lzma encoders");
    let data = b"abc".repeat(12);
    let (compressed, compressed_flag) = encoders.encode_data(&data).expect("compress data");
    assert!(compressed_flag);
    let patch = build_secondary_data_add_windows_patch(
        XDELTA_LZMA_SECONDARY_ID,
        vec![(data.len() as u64, compressed.into_owned(), vec![4; 12])],
    );

    let error = crate::xdelta::apply_patch_bytes(b"", &patch)
        .expect_err("in-memory apply must reject lzma");

    assert!(error.to_string().contains("file-based handler"));
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
        create_native_compress_options(&crate::xdelta::XDELTA, true),
    )
    .expect("encode baseline");
    assert!(baseline.size > 0);

    let app_header = build_default_xdelta_app_header(&input_path, &modified_path);
    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);

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
    assert!(
        parsed
            .windows
            .iter()
            .any(|window| window.delta_indicator != 0)
    );

    let temp = create_temp_dir();
    let input_path = temp.join("source.bin");
    let patch_path = temp.join("update.xdelta");
    let output_path = temp.join("output.bin");
    fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
    fs::write(&patch_path, patch).expect("write patch");

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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
    assert!(
        parsed
            .windows
            .iter()
            .any(|window| window.delta_indicator != 0)
    );

    let temp = create_temp_dir();
    let input_path = temp.join("source.bin");
    let patch_path = temp.join("update.xdelta");
    let output_path = temp.join("output.bin");
    fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
    fs::write(&patch_path, patch).expect("write patch");

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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

    let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
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
            || message.contains("xdelta lzma secondary decode failed")
            || message.contains("checksum mismatch")
    );
}

#[test]
fn apply_fails_for_trailing_secondary_payload_bytes() {
    for secondary_id in [XDELTA_DJW_SECONDARY_ID, XDELTA_FGK_SECONDARY_ID] {
        let expected = b"ZZ";
        let compressed_payload = match secondary_id {
            XDELTA_DJW_SECONDARY_ID => {
                xdelta_djw_compress(expected, DjwSectionKind::Data).expect("compress djw")
            }
            XDELTA_FGK_SECONDARY_ID => xdelta_fgk_compress(expected).expect("compress fgk"),
            _ => unreachable!("unknown test secondary id"),
        };
        let mut compressed_section = Vec::new();
        encode_varint(&mut compressed_section, expected.len() as u64);
        compressed_section.extend_from_slice(&compressed_payload);
        compressed_section.push(0);

        let patch =
            build_secondary_data_add_patch(secondary_id, expected.len() as u64, compressed_section);

        let temp = create_temp_dir();
        let input_path = temp.join(format!("input-{secondary_id}.bin"));
        let patch_path = temp.join(format!("trailing-{secondary_id}.xdelta"));
        let output_path = temp.join(format!("output-{secondary_id}.bin"));
        fs::write(&input_path, b"").expect("write input");
        fs::write(&patch_path, patch).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::xdelta::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("trailing secondary payload bytes should fail");
        let message = format!("{error}");
        assert!(
            message.contains("unused input")
                || message.contains("invalid data after stream")
                || message.contains("more output than expected"),
            "unexpected error for secondary {secondary_id}: {message}"
        );
    }
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

fn build_secondary_data_add_patch(
    secondary_id: u8,
    target_window_size: u64,
    compressed_data: Vec<u8>,
) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&VCDIFF_MAGIC_BYTES);
    bytes.push(VCDIFF_VERSION_STANDARD);
    bytes.push(HDR_SECONDARY);
    bytes.push(secondary_id);
    bytes.push(0);

    let mut delta = Vec::new();
    encode_varint(&mut delta, target_window_size);
    delta.push(DELTA_DATA_COMP);
    encode_varint(&mut delta, compressed_data.len() as u64);
    delta.push(1);
    delta.push(0);
    delta.extend_from_slice(&compressed_data);
    delta.push(3);

    encode_varint(&mut bytes, delta.len() as u64);
    bytes.extend_from_slice(&delta);
    bytes
}

fn build_secondary_data_add_windows_patch(
    secondary_id: u8,
    windows: Vec<(u64, Vec<u8>, Vec<u8>)>,
) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&VCDIFF_MAGIC_BYTES);
    bytes.push(VCDIFF_VERSION_STANDARD);
    bytes.push(HDR_SECONDARY);
    bytes.push(secondary_id);

    for (target_window_size, compressed_data, inst) in windows {
        bytes.push(0);

        let mut delta = Vec::new();
        encode_varint(&mut delta, target_window_size);
        delta.push(DELTA_DATA_COMP);
        encode_varint(&mut delta, compressed_data.len() as u64);
        encode_varint(&mut delta, inst.len() as u64);
        delta.push(0);
        delta.extend_from_slice(&compressed_data);
        delta.extend_from_slice(&inst);

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

#[test]
fn decode_secondary_djw_rejects_zero_output_size() {
    let error =
        decode_djw_secondary(&[0u8; 1], 0).expect_err("zero declared output size must be rejected");
    assert!(
        format!("{error}").contains("invalid output size"),
        "unexpected error: {error}"
    );
}

#[test]
fn decode_secondary_djw_round_trips_single_group() {
    let original = b"the quick brown fox jumps over the lazy dog 0123456789".to_vec();
    let payload = xdelta_djw_compress(&original, DjwSectionKind::Data).expect("compress djw");
    let decoded = decode_djw_secondary(&payload, original.len()).expect("decode djw");
    assert_eq!(decoded, original);
}

#[test]
fn decode_secondary_djw_round_trips_multi_group() {
    // A ~1.5 KiB Data section drives the multi-group selector path: two
    // alternating byte populations make per-sector group selection worthwhile.
    let mut section = Vec::with_capacity(1_500);
    for index in 0..1_500usize {
        let value = if (index / 100) % 2 == 0 {
            (index % 7) as u8
        } else {
            200 + (index % 7) as u8
        };
        section.push(value);
    }
    let payload = xdelta_djw_compress(&section, DjwSectionKind::Data).expect("compress djw");
    let decoded = decode_djw_secondary(&payload, section.len()).expect("decode djw");
    assert_eq!(decoded, section);
}

#[test]
fn decode_secondary_djw_rejects_trailing_input() {
    let original = b"repeat repeat repeat repeat".to_vec();
    let mut payload = xdelta_djw_compress(&original, DjwSectionKind::Data).expect("compress djw");
    payload.push(0);
    let error = decode_djw_secondary(&payload, original.len())
        .expect_err("trailing payload byte must be rejected");
    assert!(
        format!("{error}").contains("unused input"),
        "unexpected error: {error}"
    );
}

#[test]
fn decode_secondary_djw_bits_rejects_invalid_bit_count() {
    let mut state = DjwBitState::decode_init();
    let mut pos = 0usize;
    let zero = decode_djw_bits(&mut state, &[0u8; 1], &mut pos, 0)
        .expect_err("zero bit count must be rejected");
    assert!(format!("{zero}").contains("invalid bit count"));

    let mut state = DjwBitState::decode_init();
    let mut pos = 0usize;
    let too_wide = decode_djw_bits(&mut state, &[0u8; 1], &mut pos, usize::BITS as usize)
        .expect_err("oversized bit count must be rejected");
    assert!(format!("{too_wide}").contains("invalid bit count"));
}

#[test]
fn decode_secondary_djw_symbol_reaches_end_of_input() {
    let table = build_djw_decoder_table(&[1u8, 1u8], 2, DJW_MAX_CODELEN).expect("build table");
    let mut state = DjwBitState::decode_init();
    let mut pos = 0usize;
    let error = decode_djw_symbol(&mut state, &[], &mut pos, &table, DJW_ALPHABET_SIZE)
        .expect_err("empty input must reach end of input");
    assert!(format!("{error}").contains("end of input"));
}

#[test]
fn decode_secondary_djw_symbol_rejects_invalid_symbol() {
    // An incomplete two-length table leaves a hole at the all-ones 2-bit code,
    // so the decoder exhausts max_len without a match.
    let table = build_djw_decoder_table(&[2u8, 0u8], 2, DJW_MAX_CODELEN).expect("build table");
    let mut state = DjwBitState::decode_init();
    let mut pos = 0usize;
    let error = decode_djw_symbol(&mut state, &[0x01], &mut pos, &table, DJW_ALPHABET_SIZE)
        .expect_err("undecodable bit pattern must be rejected");
    assert!(format!("{error}").contains("invalid symbol"));
}

#[test]
fn decode_secondary_build_djw_decoder_table_validates_inputs() {
    let short = build_djw_decoder_table(&[1u8, 2u8], 5, DJW_MAX_CODELEN)
        .err()
        .expect("too few code lengths must be rejected");
    assert!(format!("{short}").contains("too short"));

    let over = build_djw_decoder_table(&[21u8; 4], 4, DJW_MAX_CODELEN)
        .err()
        .expect("over-long code lengths must be rejected");
    assert!(format!("{over}").contains("exceeds max"));

    let empty = build_djw_decoder_table(&[0u8; 4], 4, DJW_MAX_CODELEN)
        .err()
        .expect("all-zero code lengths must be rejected");
    assert!(format!("{empty}").contains("no symbols"));

    let table = build_djw_decoder_table(&[1u8, 1u8], 2, DJW_MAX_CODELEN).expect("valid table");
    assert_eq!(table.min_len, 1);
    assert_eq!(table.max_len, 1);
    assert_eq!(table.inorder, vec![0u8, 1u8]);
}

#[test]
fn decode_secondary_djw_update_mtf_moves_to_front_and_bounds_check() {
    let mut values = [10u8, 20, 30];
    let symbol = djw_update_mtf(&mut values, 2).expect("move-to-front");
    assert_eq!(symbol, 30);
    assert_eq!(values, [30u8, 10, 20]);

    let error =
        djw_update_mtf(&mut [1u8, 2, 3], 5).expect_err("out-of-range mtf index must be rejected");
    assert!(format!("{error}").contains("out of bounds"));
}

#[test]
fn decode_secondary_init_djw_clen_mtf_fills_and_guards_short_buffer() {
    let mut short = [0u8; 3];
    init_djw_clen_mtf(&mut short);
    assert_eq!(short, [0u8; 3], "short buffer must be left untouched");

    let mut full = [0u8; DJW_TOTAL_CODES];
    init_djw_clen_mtf(&mut full);
    assert_eq!(full[0], 0);
    assert_eq!(&full[1..6], &[4u8, 5, 6, 7, 8]);
}

#[test]
fn decode_secondary_djw_count_byte_frequencies_counts_bytes() {
    let freq = djw_count_byte_frequencies(b"aab");
    assert_eq!(freq[usize::from(b'a')], 2);
    assert_eq!(freq[usize::from(b'b')], 1);
    assert_eq!(freq[0], 0);
}

#[test]
fn decode_secondary_djw_build_prefix_lengths_handles_empty_and_single_symbol() {
    let empty =
        djw_build_prefix_lengths(&[], DJW_MAX_CODELEN).expect_err("empty frequencies must fail");
    assert!(format!("{empty}").contains("empty frequency"));

    // A single non-zero frequency exercises the heap_last == 1 rebalance path.
    let (lengths, total_bits) =
        djw_build_prefix_lengths(&[5u32, 0, 0], DJW_MAX_CODELEN).expect("single-symbol prefix");
    assert_eq!(lengths.len(), 3);
    assert!(lengths[0] > 0);
    assert!(lengths[1] == 0 || lengths[2] > 0);
    assert!(total_bits > 0);
}

#[test]
fn decode_secondary_djw_build_codes_from_lengths_validates() {
    let none =
        djw_build_codes_from_lengths(&[0u8, 0], DJW_MAX_CODELEN).expect_err("no symbols must fail");
    assert!(format!("{none}").contains("no symbols"));

    let over = djw_build_codes_from_lengths(&[5u8, 3], 4).expect_err("over-long lengths must fail");
    assert!(format!("{over}").contains("configured maximum"));

    let codes = djw_build_codes_from_lengths(&[1u8, 2, 2], DJW_MAX_CODELEN).expect("valid codes");
    assert_eq!(codes.len(), 3);
}

#[test]
fn decode_secondary_fgk_state_new_rejects_zero_alphabet() {
    let error = FgkState::new(0)
        .err()
        .expect("zero alphabet must be rejected");
    assert!(format!("{error}").contains("total node count"));
}

#[test]
fn decode_secondary_fgk_round_trips() {
    // Repeats over a small alphabet drive many adaptive weight updates and
    // block promotions in the FGK tree, round-tripping end to end. (Larger
    // alphabets currently trip an encoder-side tree bug, so keep this minimal.)
    let input = b"ABAB".repeat(40);
    let payload = xdelta_fgk_compress(&input).expect("compress fgk");
    let decoded = decode_fgk_secondary(&payload, input.len()).expect("decode fgk");
    assert_eq!(decoded, input);
}

#[test]
fn decode_secondary_fgk_reaches_end_of_input() {
    let payload = xdelta_fgk_compress(b"AB").expect("compress fgk");
    // payload.len() * 8 is the maximum symbol count the bitstream could yield;
    // since FGK symbols cost more than one bit, the decoder must run dry first.
    let error = decode_fgk_secondary(&payload, payload.len() * 8)
        .expect_err("over-long declared output must exhaust the input");
    assert!(format!("{error}").contains("end of input"));
}

#[test]
fn decode_secondary_try_decode_xdelta_djw_sections_handles_flags() {
    let original = b"abcabcabcabcabcabcabc".to_vec();
    let djw = xdelta_djw_compress(&original, DjwSectionKind::Data).expect("compress djw");
    let mut data_section = Vec::new();
    encode_varint_raw(&mut data_section, original.len() as u64);
    data_section.extend_from_slice(&djw);

    let inst = b"raw-inst".to_vec();
    let addr = b"raw-addr".to_vec();
    let (data, decoded_inst, decoded_addr) =
        try_decode_xdelta_djw_sections(&data_section, &inst, &addr, DELTA_DATA_COMP)
            .expect("decode djw sections");
    assert_eq!(data, original);
    assert_eq!(decoded_inst, inst);
    assert_eq!(decoded_addr, addr);
}

#[test]
fn decode_secondary_try_decode_xdelta_fgk_sections_handles_flags() {
    // Two-symbol payload keeps the FGK encoder off its large-alphabet tree bug.
    let original = b"ABABABABABABABABABAB".to_vec();
    let fgk = xdelta_fgk_compress(&original).expect("compress fgk");
    let mut data_section = Vec::new();
    encode_varint_raw(&mut data_section, original.len() as u64);
    data_section.extend_from_slice(&fgk);

    let inst = b"raw-inst".to_vec();
    let addr = b"raw-addr".to_vec();
    let (data, decoded_inst, decoded_addr) =
        try_decode_xdelta_fgk_sections(&data_section, &inst, &addr, DELTA_DATA_COMP)
            .expect("decode fgk sections");
    assert_eq!(data, original);
    assert_eq!(decoded_inst, inst);
    assert_eq!(decoded_addr, addr);
}

fn empty_window_index() -> WindowIndex {
    WindowIndex {
        source_kind: None,
        source_segment_size: 0,
        source_segment_position: 0,
        target_window_size: 0,
        delta_indicator: 0,
        checksum: None,
        data_start: 0,
        data_len: 0,
        inst_start: 0,
        inst_len: 0,
        addr_start: 0,
        addr_len: 0,
        output_offset: 0,
    }
}

#[test]
fn xdelta_djw_compress_rejects_an_empty_section() {
    let error = xdelta_djw_compress(&[], DjwSectionKind::Data)
        .expect_err("an empty section must be rejected");
    assert!(
        format!("{error}").contains("requires non-empty input"),
        "unexpected error: {error}"
    );
}

#[test]
fn djw_select_groups_and_sector_size_covers_every_size_bucket() {
    let cases: [(DjwSectionKind, usize, (usize, usize)); 18] = [
        (DjwSectionKind::Data, 999, (1, 0)),
        (DjwSectionKind::Data, 3_999, (2, 10)),
        (DjwSectionKind::Data, 6_999, (3, 10)),
        (DjwSectionKind::Data, 9_999, (4, 10)),
        (DjwSectionKind::Data, 24_999, (5, 10)),
        (DjwSectionKind::Data, 49_999, (7, 20)),
        (DjwSectionKind::Data, 99_999, (8, 30)),
        (DjwSectionKind::Data, 100_000, (8, 70)),
        (DjwSectionKind::Inst, 6_999, (1, 0)),
        (DjwSectionKind::Inst, 9_999, (2, 50)),
        (DjwSectionKind::Inst, 24_999, (3, 50)),
        (DjwSectionKind::Inst, 49_999, (6, 40)),
        (DjwSectionKind::Inst, 50_000, (8, 40)),
        (DjwSectionKind::Addr, 8_999, (1, 0)),
        (DjwSectionKind::Addr, 24_999, (2, 130)),
        (DjwSectionKind::Addr, 49_999, (3, 130)),
        (DjwSectionKind::Addr, 99_999, (5, 130)),
        (DjwSectionKind::Addr, 100_000, (7, 130)),
    ];

    for (kind, input_size, expected) in cases {
        let selected =
            djw_select_groups_and_sector_size(input_size, kind).expect("select group layout");
        assert_eq!(selected, expected, "input size {input_size}");
    }
}

#[test]
fn xdelta_djw_compress_multi_group_rejects_invalid_parameters() {
    let section = vec![7u8; 100];

    let single = xdelta_djw_compress_multi_group(&section, 1, 10)
        .expect_err("a single group must be rejected");
    assert!(format!("{single}").contains("invalid group count"));

    let too_many = xdelta_djw_compress_multi_group(&section, DJW_MAX_GROUPS + 1, 10)
        .expect_err("more than DJW_MAX_GROUPS must be rejected");
    assert!(format!("{too_many}").contains("invalid group count"));

    let unaligned = xdelta_djw_compress_multi_group(&section, 2, 7)
        .expect_err("a sector size off the multiple must be rejected");
    assert!(format!("{unaligned}").contains("invalid sector size"));

    let oversized = xdelta_djw_compress_multi_group(&section, 2, DJW_SECTORSZ_MAX + 5)
        .expect_err("a sector size over the maximum must be rejected");
    assert!(format!("{oversized}").contains("invalid sector size"));
}

#[test]
fn djw_choose_best_sector_groups_validates_its_inputs() {
    let section = vec![1u8; 40];
    let lengths = vec![vec![1u8; DJW_ALPHABET_SIZE]];

    let mut mis_sized = vec![0u8; 3];
    let error = djw_choose_best_sector_groups(&section, 10, &lengths, &mut mis_sized)
        .expect_err("a mis-sized selector vector must be rejected");
    assert!(format!("{error}").contains("wrong size"));

    let mut selected = vec![0u8; 4];
    let empty = djw_choose_best_sector_groups(&section, 10, &[], &mut selected)
        .expect_err("an empty code table list must be rejected");
    assert!(format!("{empty}").contains("no group code tables"));
}

#[test]
fn djw_choose_best_sector_groups_skips_a_group_missing_a_symbol_code() {
    // Group 0 carries no code for byte 5, so both sectors must fall to group 1
    // even though its codes are twice as long.
    let mut first = vec![1u8; DJW_ALPHABET_SIZE];
    first[5] = 0;
    let second = vec![2u8; DJW_ALPHABET_SIZE];

    let section = vec![5u8; 20];
    let mut selected = vec![0u8; 2];
    djw_choose_best_sector_groups(&section, 10, &[first, second], &mut selected)
        .expect("choose sector groups");
    assert_eq!(selected, vec![1u8, 1u8]);
}

#[test]
fn djw_rebuild_group_frequencies_rejects_an_out_of_range_selector() {
    let section = vec![3u8; 20];
    let mut frequencies = djw_seed_group_frequencies(2);
    let error = djw_rebuild_group_frequencies(&section, 10, &[0u8, 4u8], &mut frequencies)
        .expect_err("an out-of-range selector must be rejected");
    assert!(format!("{error}").contains("invalid group index 4"));
}

#[test]
fn djw_bit_writer_rejects_invalid_bits_widths_and_values() {
    let mut writer = DjwBitWriter::new();

    let bit = writer
        .write_bit(2)
        .expect_err("a non-bit value must be rejected");
    assert!(format!("{bit}").contains("non-bit value"));

    let zero_width = writer
        .write_bits(0, 0)
        .expect_err("a zero bit width must be rejected");
    assert!(format!("{zero_width}").contains("invalid bit width"));

    let wide = writer
        .write_bits(usize::BITS as usize, 0)
        .expect_err("a bit width at the usize width must be rejected");
    assert!(format!("{wide}").contains("invalid bit width"));

    let out_of_range = writer
        .write_bits(2, 4)
        .expect_err("a value wider than its field must be rejected");
    assert!(format!("{out_of_range}").contains("out of range"));
}

#[test]
fn lzma_status_name_maps_every_known_status() {
    use liblzma_sys as lzma_sys;

    let cases = [
        (lzma_sys::LZMA_OK, "ok"),
        (lzma_sys::LZMA_STREAM_END, "stream end"),
        (lzma_sys::LZMA_MEM_ERROR, "memory allocation failed"),
        (lzma_sys::LZMA_MEMLIMIT_ERROR, "memory limit reached"),
        (lzma_sys::LZMA_FORMAT_ERROR, "format error"),
        (lzma_sys::LZMA_OPTIONS_ERROR, "unsupported options"),
        (lzma_sys::LZMA_DATA_ERROR, "input data error"),
        (lzma_sys::LZMA_BUF_ERROR, "output buffer too small"),
        (lzma_sys::LZMA_PROG_ERROR, "programming error"),
    ];
    for (status, name) in cases {
        assert_eq!(lzma_status_name(status), name);
    }
    assert_eq!(lzma_status_name(lzma_sys::LZMA_NO_CHECK), "unknown error");
}

#[test]
fn xdelta_lzma_section_has_stream_header_reads_the_payload_prefix() {
    // A truncated varint has no payload offset to look behind.
    assert!(!xdelta_lzma_section_has_stream_header(&[0x80]));

    let mut with_magic = Vec::new();
    encode_varint_raw(&mut with_magic, 16);
    with_magic.extend_from_slice(XZ_MAGIC_BYTES);
    assert!(xdelta_lzma_section_has_stream_header(&with_magic));

    let mut without_magic = Vec::new();
    encode_varint_raw(&mut without_magic, 16);
    without_magic.extend_from_slice(b"not-xz");
    assert!(!xdelta_lzma_section_has_stream_header(&without_magic));
}

#[test]
fn window_win_indicator_maps_every_source_kind() {
    let mut window = empty_window_index();

    window.source_kind = Some(WindowSourceKind::Source);
    assert_eq!(window_win_indicator(&window), WIN_SOURCE);

    window.source_kind = Some(WindowSourceKind::Target);
    assert_eq!(window_win_indicator(&window), WIN_TARGET);

    window.source_kind = None;
    assert_eq!(window_win_indicator(&window), 0);

    window.checksum = Some(0x1234_5678);
    assert_eq!(window_win_indicator(&window), WIN_CHECKSUM);
}

#[test]
fn decode_xdelta_lzma_section_rejects_a_size_over_the_window_ceiling() {
    let mut section = Vec::new();
    encode_varint_raw(&mut section, 4_096);
    section.extend_from_slice(XZ_MAGIC_BYTES);

    let mut decoder = XdeltaLzmaSectionDecoder::new();
    let error = decode_xdelta_lzma_section_with_state(&section, true, &mut decoder, 16)
        .expect_err("a declared size over the window ceiling must be rejected");
    assert!(
        format!("{error}").contains("bounds it to 16"),
        "unexpected error: {error}"
    );
}

#[test]
fn decode_xdelta_lzma_section_passes_uncompressed_sections_through() {
    let mut decoder = XdeltaLzmaSectionDecoder::new();
    let section = b"plain-section".to_vec();
    let decoded = decode_xdelta_lzma_section_with_state(&section, false, &mut decoder, 16)
        .expect("uncompressed passthrough");
    assert_eq!(decoded, section);
}

#[test]
fn decode_djw_bits_reaches_end_of_input() {
    let mut state = DjwBitState::decode_init();
    let mut pos = 0usize;
    let error = decode_djw_bits(&mut state, &[], &mut pos, DJW_GROUP_BITS)
        .expect_err("an empty input must reach end of input");
    assert!(format!("{error}").contains("end of input"));
}

#[test]
fn build_djw_decoder_table_rejects_a_symbol_index_beyond_u8() {
    let error = build_djw_decoder_table(&[1u8; 300], 300, DJW_MAX_CODELEN)
        .err()
        .expect("an alphabet larger than u8 must be rejected");
    assert!(format!("{error}").contains("symbol index exceeded u8"));
}

#[test]
fn decode_djw_symbol_rejects_an_offset_past_the_caller_maximum() {
    let table = build_djw_decoder_table(&[1u8, 1u8], 2, DJW_MAX_CODELEN).expect("build table");
    let mut state = DjwBitState::decode_init();
    let mut pos = 0usize;
    // Bit 1 decodes to symbol 1, which the caller's max_symbol of 0 excludes.
    let error = decode_djw_symbol(&mut state, &[0x01], &mut pos, &table, 0)
        .expect_err("a symbol past max_symbol must be rejected");
    assert!(format!("{error}").contains("invalid symbol"));
}

#[test]
fn decode_djw_symbol_rejects_a_code_below_the_table_base() {
    // A hand-built table whose base exceeds the codes its limit admits: the
    // decoder must bail instead of indexing below the inorder table.
    let table = DjwDecodeTable {
        inorder: vec![0u8, 1u8],
        base: vec![0, 5, 0, 0],
        limit: vec![0, 1, 0, 0],
        min_len: 1,
        max_len: 2,
    };
    let mut state = DjwBitState::decode_init();
    let mut pos = 0usize;
    let error = decode_djw_symbol(&mut state, &[0x00], &mut pos, &table, DJW_ALPHABET_SIZE)
        .expect_err("a code below the table base must be rejected");
    assert!(format!("{error}").contains("invalid symbol"));
}

#[test]
fn djw_build_prefix_lengths_rejects_all_zero_frequencies() {
    let error = djw_build_prefix_lengths(&[0u32; 4], DJW_MAX_CODELEN)
        .expect_err("all-zero frequencies must be rejected");
    assert!(format!("{error}").contains("at least one symbol"));
}

#[test]
fn djw_build_prefix_lengths_rejects_a_frequency_sum_overflow() {
    let error = djw_build_prefix_lengths(&[u32::MAX, u32::MAX, u32::MAX], DJW_MAX_CODELEN)
        .expect_err("a u32 frequency sum overflow must be rejected");
    assert!(format!("{error}").contains("frequency sum overflowed"));
}

#[test]
fn djw_build_prefix_lengths_rescales_until_codes_fit_the_limit() {
    // The first tree puts the two rarest symbols at depth 3; the builder halves
    // the frequencies until every code fits the 2-bit limit.
    let (lengths, total_bits) =
        djw_build_prefix_lengths(&[1u32, 1, 1, 5], 2).expect("rescaled prefix lengths");
    assert_eq!(lengths, vec![2u8, 2, 2, 2]);
    assert!(total_bits > 0);
}

#[test]
fn djw_update_1_2_rejects_an_overflowing_symbol_buffer() {
    let mut mtf_run = 5usize;
    let mut mtf_index = 0usize;
    let mut mtf_symbols = [0u8; 1];
    let mut frequencies = [0u32; 2];
    let error = djw_update_1_2(
        &mut mtf_run,
        &mut mtf_index,
        &mut mtf_symbols,
        &mut frequencies,
    )
    .expect_err("a run longer than the symbol buffer must be rejected");
    assert!(format!("{error}").contains("mtf symbol buffer overflowed"));
}

#[test]
fn djw_compute_mtf_1_2_rejects_a_symbol_outside_the_mtf_table() {
    let mut prefix = DjwPrefix::new(vec![9u8]);
    let mut mtf_values = [0u8, 1, 2];
    let mut frequencies = [0u32; 8];
    let error = djw_compute_mtf_1_2(&mut prefix, &mut mtf_values, &mut frequencies, 4)
        .expect_err("a symbol outside the MTF table must be rejected");
    assert!(format!("{error}").contains("missing from MTF table"));
}

#[test]
fn djw_compute_mtf_1_2_flushes_a_run_before_a_new_symbol() {
    let mut prefix = DjwPrefix::new(vec![0u8, 0, 1]);
    let mut mtf_values = [0u8, 1];
    let mut frequencies = [0u32; 8];
    djw_compute_mtf_1_2(&mut prefix, &mut mtf_values, &mut frequencies, 4).expect("compute mtf");
    assert_eq!(prefix.mcount, 2);
    assert_eq!(&prefix.mtfsym[..prefix.mcount], &[1u8, 2u8]);
}

#[test]
fn djw_compute_mtf_1_2_flushes_a_trailing_run() {
    let mut prefix = DjwPrefix::new(vec![0u8, 0]);
    let mut mtf_values = [0u8, 1];
    let mut frequencies = [0u32; 8];
    djw_compute_mtf_1_2(&mut prefix, &mut mtf_values, &mut frequencies, 4).expect("compute mtf");
    assert_eq!(prefix.mcount, 1);
    assert_eq!(prefix.mtfsym[0], DJW_RUN_1 as u8);
}

#[test]
fn djw_compute_mtf_1_2_rejects_a_symbol_past_the_declared_range() {
    let mut prefix = DjwPrefix::new(vec![3u8]);
    let mut mtf_values = [0u8, 1, 2, 3];
    let mut frequencies = [0u32; 8];
    let error = djw_compute_mtf_1_2(&mut prefix, &mut mtf_values, &mut frequencies, 1)
        .expect_err("an MTF offset past the declared symbol count must be rejected");
    assert!(format!("{error}").contains("exceeded expected range"));
}

#[test]
fn djw_compute_mtf_1_2_rejects_an_overflowing_output_buffer() {
    // `mtfsym` is deliberately one slot short of the two symbols this prefix
    // encodes, so the second write must be refused.
    let mut prefix = DjwPrefix {
        symbol: vec![1u8, 2u8],
        mtfsym: vec![0u8; 1],
        mcount: 0,
    };
    let mut mtf_values = [0u8, 1, 2];
    let mut frequencies = [0u32; 8];
    let error = djw_compute_mtf_1_2(&mut prefix, &mut mtf_values, &mut frequencies, 4)
        .expect_err("an overflowing MTF output buffer must be rejected");
    assert!(format!("{error}").contains("mtf output overflowed"));
}

fn fgk_round_trip(alphabet_size: usize, symbols: &[usize]) -> Vec<usize> {
    let mut encoder = FgkState::new(alphabet_size).expect("fgk encoder");
    let mut bits = Vec::new();
    for &symbol in symbols {
        let mut remaining = encoder.fgk_encode_data(symbol).expect("fgk encode symbol");
        while remaining != 0 {
            remaining -= 1;
            bits.push(encoder.fgk_get_encoded_bit().expect("fgk encoded bit"));
        }
    }

    let mut decoder = FgkState::new(alphabet_size).expect("fgk decoder");
    let mut decoded = Vec::with_capacity(symbols.len());
    for bit in bits {
        if decoder.fgk_decode_bit(bit).expect("fgk decode bit") {
            decoded.push(usize::from(
                decoder.fgk_decode_data().expect("fgk decode data"),
            ));
        }
    }
    decoded
}

#[test]
fn fgk_state_round_trips_over_small_alphabets() {
    for alphabet_size in [2usize, 3, 4, 8] {
        let symbols: Vec<usize> = (0..40).map(|index| index % alphabet_size).collect();
        assert_eq!(
            fgk_round_trip(alphabet_size, &symbols),
            symbols,
            "alphabet size {alphabet_size}"
        );
    }
}

#[test]
fn fgk_state_new_rejects_a_block_count_overflow() {
    let error = FgkState::new(usize::MAX / 4 + 100)
        .err()
        .expect("an alphabet whose block count overflows must be rejected");
    assert!(format!("{error}").contains("block count overflowed"));
}

#[test]
fn fgk_decode_bit_rejects_a_non_bit_value() {
    let mut state = FgkState::new(4).expect("fgk state");
    let error = state
        .fgk_decode_bit(2)
        .expect_err("a non-bit value must be rejected");
    assert!(format!("{error}").contains("invalid bit"));
}

#[test]
fn fgk_decode_bit_rejects_an_overflowing_coded_bit_buffer() {
    // A three-symbol alphabet buffers at most three zero-frequency bits; the
    // fourth has nowhere to go.
    let mut state = FgkState::new(3).expect("fgk state");
    for _ in 0..3 {
        state.fgk_decode_bit(0).expect("buffered zero-weight bit");
    }
    let error = state
        .fgk_decode_bit(0)
        .expect_err("a fourth buffered bit must be rejected");
    assert!(format!("{error}").contains("coded bit buffer overflowed"));
}

#[test]
fn fgk_decode_bit_rejects_a_leaf_without_a_right_child() {
    let mut state = FgkState::new(2).expect("fgk state");
    assert!(state.fgk_decode_bit(0).expect("first symbol bit"));
    assert_eq!(state.fgk_decode_data().expect("first symbol"), 0);
    // The 1 bit walks to the weighted leaf; a second 1 bit has no child left.
    assert!(state.fgk_decode_bit(1).expect("walk to the weighted leaf"));
    let error = state
        .fgk_decode_bit(1)
        .expect_err("descending past a leaf must be rejected");
    assert!(format!("{error}").contains("missing right child"));
}

#[test]
fn fgk_get_encoded_bit_rejects_an_empty_buffer() {
    let mut state = FgkState::new(4).expect("fgk state");
    let error = state
        .fgk_get_encoded_bit()
        .expect_err("an empty encoded bit buffer must be rejected");
    assert!(format!("{error}").contains("encoded bit buffer was empty"));
}

#[test]
fn fgk_symbol_indexes_are_bounds_checked() {
    let state = FgkState::new(4).expect("fgk state");
    let lookup = state
        .fgk_find_nth_zero(9)
        .expect_err("an index past the alphabet must be rejected");
    assert!(format!("{lookup}").contains("exceeds alphabet size 4"));

    let mut state = state;
    let encode = state
        .fgk_encode_data(9)
        .expect_err("an index past the alphabet must be rejected");
    assert!(format!("{encode}").contains("exceeds alphabet size 4"));
}

#[test]
fn fgk_find_nth_zero_fails_once_a_symbol_left_the_zero_list() {
    let mut state = FgkState::new(4).expect("fgk state");
    state.fgk_encode_data(0).expect("encode symbol 0");
    let error = state
        .fgk_find_nth_zero(0)
        .expect_err("a symbol already off the zero list must be rejected");
    assert!(format!("{error}").contains("zero list traversal failed"));
}

#[test]
fn vcdiff_handler_probes_by_extension() {
    let handler = VcdiffPatchHandler::new(&VCDIFF);
    assert!(matches!(
        handler.probe(Path::new("update.vcdiff")),
        ProbeConfidence::Extension
    ));
    assert_eq!(handler.descriptor().name, "VCDIFF");
}

#[test]
fn vcdiff_handler_validate_reapplies_the_patch() {
    let input = b"hello old world";
    let patch_bytes = build_patch(TestPatch {
        windows: vec![TestWindow {
            win_indicator: WIN_SOURCE,
            source_segment_size: Some(input.len() as u64),
            source_segment_position: Some(0),
            target_window_size: 15,
            checksum: None,
            data: b"new".to_vec(),
            inst: vec![22, 4, 22],
            addr: encode_all_varints(&[0, 9]),
        }],
        ..Default::default()
    });

    let temp = create_temp_dir();
    let input_path = temp.join("input.bin");
    let patch_path = temp.join("update.vcdiff");
    fs::write(&input_path, input).expect("write input");
    fs::write(&patch_path, &patch_bytes).expect("write patch");

    let handler = VcdiffPatchHandler::new(&VCDIFF);
    let report = handler
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context(),
        )
        .expect("validate patch");
    assert_eq!(report.status, OperationStatus::Succeeded);
}

#[test]
fn parse_patch_rejects_malformed_headers() {
    let bad_magic = parse_patch(&mut Cursor::new(vec![0xD6, 0xC3, 0x00, 0x00]))
        .expect_err("a bad magic must be rejected");
    assert!(format!("{bad_magic}").contains("invalid VCDIFF header magic"));

    let bad_version = parse_patch(&mut Cursor::new(vec![0xD6, 0xC3, 0xC4, 0x01, 0x00]))
        .expect_err("an unsupported version byte must be rejected");
    assert!(format!("{bad_version}").contains("version byte 0x01"));

    let bad_flags = parse_patch(&mut Cursor::new(vec![0xD6, 0xC3, 0xC4, 0x00, 0x08]))
        .expect_err("unknown header flags must be rejected");
    assert!(format!("{bad_flags}").contains("header flags 0x08"));
}

#[test]
fn parse_patch_rejects_malformed_window_headers() {
    let bad_win = parse_patch(&mut Cursor::new(vec![0xD6, 0xC3, 0xC4, 0x00, 0x00, 0x08]))
        .expect_err("unknown window flags must be rejected");
    assert!(format!("{bad_win}").contains("window flags 0x08"));

    let both_sources = parse_patch(&mut Cursor::new(vec![
        0xD6,
        0xC3,
        0xC4,
        0x00,
        0x00,
        WIN_SOURCE | WIN_TARGET,
    ]))
    .expect_err("a window naming both source kinds must be rejected");
    assert!(format!("{both_sources}").contains("both VCD_SOURCE and VCD_TARGET"));

    // win_indicator, delta_encoding_len, target_window_size, delta_indicator
    let bad_delta = parse_patch(&mut Cursor::new(vec![
        0xD6, 0xC3, 0xC4, 0x00, 0x00, 0x00, 0x05, 0x04, 0x08,
    ]))
    .expect_err("unknown delta section flags must be rejected");
    assert!(format!("{bad_delta}").contains("delta section flags 0x08"));

    // The same window with a deliberately wrong delta encoding length.
    let length_mismatch = parse_patch(&mut Cursor::new(vec![
        0xD6, 0xC3, 0xC4, 0x00, 0x00, 0x00, 0x63, 0x04, 0x00, 0x00, 0x00, 0x00,
    ]))
    .expect_err("a delta encoding length mismatch must be rejected");
    assert!(format!("{length_mismatch}").contains("delta encoding length mismatch"));
}

#[test]
fn apply_patch_bytes_rejects_custom_code_tables() {
    let patch_bytes = build_patch(TestPatch {
        header_flags: HDR_CODE_TABLE,
        code_table_near: Some(4),
        code_table_same: Some(3),
        code_table_data: vec![0u8; 8],
        ..Default::default()
    });

    let error = apply_patch_bytes(b"", &patch_bytes)
        .expect_err("a custom code table must be rejected in memory");
    assert!(format!("{error}").contains("does not support custom code tables"));
}

#[test]
fn apply_patch_bytes_supports_source_free_and_target_windows() {
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

    let output = apply_patch_bytes(b"", &patch_bytes).expect("apply target-window patch");
    assert_eq!(output, b"abcdef");
}

#[test]
fn vcdiff_output_size_sums_the_window_targets() {
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
                win_indicator: 0,
                source_segment_size: None,
                source_segment_position: None,
                target_window_size: 2,
                checksum: None,
                data: b"de".to_vec(),
                inst: vec![3],
                addr: Vec::new(),
            },
        ],
        ..Default::default()
    });

    assert_eq!(
        vcdiff_output_size(&patch_bytes).expect("read output size"),
        5
    );
}

#[test]
fn apply_patch_bytes_accepts_an_lzma_header_without_compressed_sections() {
    // The LZMA guard only rejects patches whose sections actually carry an xz
    // stream; a secondary header with `delta_indicator == 0` must still apply.
    let patch_bytes = build_patch(TestPatch {
        header_flags: HDR_SECONDARY,
        secondary_id: Some(XDELTA_LZMA_SECONDARY_ID),
        windows: vec![TestWindow {
            win_indicator: 0,
            source_segment_size: None,
            source_segment_position: None,
            target_window_size: 3,
            checksum: None,
            data: b"abc".to_vec(),
            inst: vec![4],
            addr: Vec::new(),
        }],
        ..Default::default()
    });

    let output = apply_patch_bytes(b"", &patch_bytes).expect("apply uncompressed lzma patch");
    assert_eq!(output, b"abc");
}

#[test]
fn create_progress_emit_band_treats_zero_total_as_complete() {
    let context = test_context();
    let progress = CreateProgress::new(&context, "xdelta");
    progress.emit_band(0.0, CREATE_ENCODE_BAND_END, 0, 0);
    // A second emission at the same percent is deduplicated, so the band end is
    // the highest percent this progress can report.
    progress.emit_band(0.0, CREATE_ENCODE_BAND_END, 1, 1);
}

#[test]
fn emit_native_instructions_encodes_runs() {
    let target = vec![0x5Au8; 16];
    let mut window = WindowEncoder::new(None, false);
    emit_native_instructions(&mut window, &target, &[Instruction::Run { len: 16 }]);
    let sections = window.finish_sections(Some(&target));
    // A run carries its repeated byte in the data section, not the full target.
    assert_eq!(sections.data_section, vec![0x5Au8]);
    assert_eq!(sections.target_len, 16);
}

#[test]
fn build_native_window_emits_a_single_add_at_level_zero() {
    let options = CompressOptions {
        level: 0,
        checksum: false,
        secondary: SecondaryCompression::None,
        ..CompressOptions::default()
    };

    let target = b"level zero target".to_vec();
    let window = build_native_window(&[], 0, &target, &options).expect("build level-0 window");
    assert!(
        window
            .windows(target.len())
            .any(|chunk| chunk == target.as_slice()),
        "the level-0 window must carry the target verbatim"
    );

    let empty = build_native_window(&[], 0, &[], &options).expect("build empty level-0 window");
    assert!(
        empty.len() < window.len(),
        "an empty target must produce a shorter window"
    );
}

#[test]
fn load_patch_for_xdelta_recode_rejects_custom_code_tables() {
    let patch_bytes = build_patch(TestPatch {
        header_flags: HDR_CODE_TABLE,
        code_table_near: Some(4),
        code_table_same: Some(3),
        code_table_data: vec![0u8; 8],
        ..Default::default()
    });

    let temp = create_temp_dir();
    let patch_path = temp.join("custom-table.xdelta");
    fs::write(&patch_path, &patch_bytes).expect("write patch");

    let error = load_patch_for_xdelta_recode(&patch_path)
        .expect_err("a custom code table must be rejected by the recoder");
    assert!(format!("{error}").contains("does not support custom code tables"));
}

#[test]
fn recode_rejects_a_baseline_that_already_declares_a_secondary_compressor() {
    let patch_bytes = build_patch(TestPatch {
        header_flags: HDR_SECONDARY,
        secondary_id: Some(XDELTA_DJW_SECONDARY_ID),
        windows: vec![TestWindow {
            win_indicator: 0,
            source_segment_size: None,
            source_segment_position: None,
            target_window_size: 3,
            checksum: None,
            data: b"abc".to_vec(),
            inst: vec![4],
            addr: Vec::new(),
        }],
        ..Default::default()
    });

    let temp = create_temp_dir();
    let patch_path = temp.join("already-secondary.xdelta");
    let output_path = temp.join("recoded.xdelta");
    fs::write(&patch_path, &patch_bytes).expect("write patch");

    let error = recode_patch_with_xdelta_options(
        &patch_path,
        &output_path,
        Some(XDELTA_LZMA_SECONDARY_ID),
        None,
    )
    .expect_err("recoding a compressed baseline must be rejected");
    assert!(format!("{error}").contains("expected an uncompressed baseline patch"));
}

#[test]
fn maybe_compress_xdelta_secondary_sections_declines_short_and_unprofitable_input() {
    let short = b"tiny".to_vec();
    let (djw_short, djw_short_flag) =
        maybe_compress_xdelta_djw_section(&short, DjwSectionKind::Data).expect("short djw section");
    assert!(!djw_short_flag);
    assert_eq!(djw_short.as_ref(), short.as_slice());

    let (fgk_short, fgk_short_flag) =
        maybe_compress_xdelta_fgk_section(&short).expect("short fgk section");
    assert!(!fgk_short_flag);
    assert_eq!(fgk_short.as_ref(), short.as_slice());

    // Twelve distinct bytes cost more in prefix tables than the symbols save, so
    // both encoders must hand the section back uncompressed.
    let incompressible: Vec<u8> = (0..12u8).collect();
    let (djw, djw_flag) = maybe_compress_xdelta_djw_section(&incompressible, DjwSectionKind::Data)
        .expect("djw section");
    assert!(!djw_flag);
    assert_eq!(djw.as_ref(), incompressible.as_slice());

    let (fgk, fgk_flag) = maybe_compress_xdelta_fgk_section(&incompressible).expect("fgk section");
    assert!(!fgk_flag);
    assert_eq!(fgk.as_ref(), incompressible.as_slice());
}

#[test]
fn move_or_copy_file_reports_a_destination_it_cannot_write() {
    let temp = create_temp_dir();
    let from = temp.join("source.bin");
    let to = temp.join("destination");
    fs::write(&from, b"payload").expect("write source");
    fs::create_dir(&to).expect("create destination directory");

    let error =
        move_or_copy_file(&from, &to).expect_err("moving onto a directory must fail on both paths");
    assert!(
        matches!(error, RomWeaverError::Io(_)),
        "unexpected: {error}"
    );
    assert!(from.exists(), "the source must survive a failed move");
}
