use std::{fs, sync::Arc};

use rom_weaver_core::{
    CancellationToken, OperationContext, OperationStatus, PatchApplyRequest,
    PatchChecksumValidation, PatchCreateRequest, PatchHandler, PatchValidateRequest,
    RecordingProgressSink, ThreadBudget,
};

use super::{
    BPS_CREATE_MEMORY_LIMIT_BYTES, BPS_MAGIC, BpsAction, BpsApplyProgress,
    BpsCombinedSuffixMatcher, BpsCreateData, BpsCreateMode, BpsCreateProgress, BpsPatchHandler,
    BpsSuffixIndexMode, ParsedBpsPatch, PreparedBpsWrite, adjust_relative_offset,
    apply_patch_actions, apply_patch_actions_in_memory, apply_prepared_bps_writes,
    bps_create_copy_match_is_worth, bps_create_estimated_low_memory_suffix_bytes,
    bps_create_estimated_suffix_memory_bytes, bps_create_match_is_worth,
    bps_create_suffix_index_mode, bps_create_usize_len, collect_parallel_bps_write_plans,
    common_prefix_len_limited, copy_target_range, crc32_bytes, encode_action_header,
    encode_signed_offset, initial_bps_sorted_target_len, next_bps_sorted_target_len,
    parse_bps_bytes, parse_bps_bytes_with_checksum_validation, push_varint, read_bps_create_data,
    repeated_byte_run_len, validate_output_file,
};
use crate::{
    BPS,
    test_support::{
        RoundTripCase, TestDir, assert_round_trip, report_endpoints, test_context_with_threads,
    },
};

#[derive(Debug)]
enum TestAction {
    SourceRead(u64),
    TargetRead(Vec<u8>),
    SourceCopy { length: u64, relative_offset: i128 },
    TargetCopy { length: u64, relative_offset: i128 },
}

#[test]
fn parse_reports_source_target_and_patch_crc32() {
    let temp = TestDir::new();
    let patch_path = temp.child("probe.bps");
    let patch = build_bps_patch(
        b"source-data",
        b"target-data",
        vec![TestAction::TargetRead(b"target-data".to_vec())],
    );
    let parsed = parse_bps_bytes(&patch).expect("parse");
    fs::write(&patch_path, patch).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse report");

    assert!(
        report
            .label
            .contains(&format!("source crc32 {:08x}", parsed.source_checksum))
    );
    assert!(
        report
            .label
            .contains(&format!("target crc32 {:08x}", parsed.target_checksum))
    );
    assert!(
        report
            .label
            .contains(&format!("patch crc32 {:08x}", parsed.patch_checksum))
    );
}

#[test]
fn parse_and_describe_report_normalized_endpoints() {
    let temp = TestDir::new();
    let patch_path = temp.child("probe.bps");
    let patch = build_bps_patch(
        b"source-data",
        b"target-data",
        vec![TestAction::TargetRead(b"target-data".to_vec())],
    );
    let parsed = parse_bps_bytes(&patch).expect("parse");
    fs::write(&patch_path, patch).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let context = test_context_with_threads(&temp, 1);
    for report in [
        handler.parse(&patch_path, &context).expect("parse report"),
        handler
            .describe_metadata(&patch_path, &context)
            .expect("describe report"),
    ] {
        let endpoints = report_endpoints(&report);
        assert_eq!(endpoints.len(), 1);
        assert_eq!(endpoints[0]["input"]["size"].as_u64(), Some(11));
        assert_eq!(endpoints[0]["output"]["size"].as_u64(), Some(11));
        assert_eq!(
            endpoints[0]["input"]["checksums"]["crc32"].as_str(),
            Some(format!("{:08x}", parsed.source_checksum).as_str())
        );
        assert_eq!(
            endpoints[0]["output"]["checksums"]["crc32"].as_str(),
            Some(format!("{:08x}", parsed.target_checksum).as_str())
        );
    }
}

#[test]
fn parse_and_apply_round_trip_for_bps() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    let source = b"abcabcabcabc";
    let target = b"abcabcZZabcabc";
    fs::write(&input_path, source).expect("fixture");
    fs::write(
        &patch_path,
        build_bps_patch(
            source,
            target,
            vec![
                TestAction::SourceRead(6),
                TestAction::TargetRead(b"ZZ".to_vec()),
                TestAction::SourceCopy {
                    length: 6,
                    relative_offset: 6,
                },
            ],
        ),
    )
    .expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("report");

    assert!(handler.capabilities().threaded_output);
    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 4);
    // apply streams by default; this multi-action patch (no TargetCopy) parallelizes
    assert!(execution.used_parallelism);
    assert!(execution.effective_threads > 1);
    assert!(!execution.thread_fallback);
    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_supports_overlapping_target_copy() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, []).expect("fixture");
    fs::write(
        &patch_path,
        build_bps_patch(
            b"",
            b"AAAAAA",
            vec![
                TestAction::TargetRead(vec![b'A']),
                TestAction::TargetCopy {
                    length: 5,
                    relative_offset: 0,
                },
            ],
        ),
    )
    .expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");

    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
    assert!(!execution.thread_fallback);
    assert!(execution.thread_fallback_reason.is_none());
    assert_eq!(fs::read(output_path).expect("output"), b"AAAAAA");
}

#[test]
fn apply_rejects_multiple_patch_files() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_a = temp.child("a.bps");
    let patch_b = temp.child("b.bps");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, b"input").expect("fixture");
    fs::write(&patch_a, []).expect("fixture");
    fs::write(&patch_b, []).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_a, patch_b],
                output: output_path,
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect_err("multiple patch files should fail");

    assert!(error.to_string().contains("expects exactly one patch file"));
}

#[test]
fn apply_fails_when_input_checksum_does_not_match() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, b"wrong input").expect("fixture");
    fs::write(
        &patch_path,
        build_bps_patch(
            b"expected input",
            b"expected output",
            vec![TestAction::TargetRead(b"expected output".to_vec())],
        ),
    )
    .expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("checksum mismatch should fail");

    assert!(
        error.to_string().contains("Input size invalid")
            || error.to_string().contains("Input checksum invalid")
    );
}

#[test]
fn apply_can_ignore_patch_checksum_mismatch() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    let source = b"hello old world";
    let target = b"hello new world";
    fs::write(&input_path, source).expect("fixture");

    let mut patch = build_bps_patch(
        source,
        target,
        vec![TestAction::TargetRead(target.to_vec())],
    );
    let footer_index = patch.len().checked_sub(1).expect("patch footer");
    patch[footer_index] ^= 0x01;
    fs::write(&patch_path, patch).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);

    let strict_error = handler
        .apply(
            &PatchApplyRequest {
                input: input_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("strict patch checksum validation should fail");
    assert!(strict_error.to_string().contains("Patch checksum invalid"));

    handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("ignore checksum validation should apply patch");

    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn create_round_trips_for_small_patch() {
    let handler = BpsPatchHandler::new(&BPS);
    let report = assert_round_trip(
        &handler,
        &RoundTripCase {
            patch_extension: "bps",
            patch_assert: Some(|patch| {
                let parsed = parse_bps_bytes(patch).expect("parse");
                assert!(!parsed.actions.is_empty());
            }),
            ..RoundTripCase::new(b"hello old world", b"hello new world", "BPS")
        },
    );

    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
}

#[test]
fn create_reports_single_threaded_when_threads_are_requested() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");

    let mut original = vec![0u8; 4096];
    for (index, byte) in original.iter_mut().enumerate() {
        *byte = (index as u8).wrapping_mul(11);
    }
    let mut modified = original.clone();
    modified[0] = modified[0].wrapping_add(1);
    modified[2048] = modified[2048].wrapping_add(2);

    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let report = handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_path.clone(),
                format: "BPS".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");
    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);

    handler
        .apply(
            &PatchApplyRequest {
                input: original_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");
    assert_eq!(fs::read(output_path).expect("output"), modified);
}

#[test]
fn create_uses_target_copy_for_repeated_target_data() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    let mut original = b"prefix-".to_vec();
    original.extend_from_slice(b"source-only");
    let mut modified = b"prefix-".to_vec();
    modified.extend(vec![b'Z'; 8192]);
    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_path.clone(),
                format: "BPS".into(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("create");

    let patch_bytes = fs::read(&patch_path).expect("patch");
    let patch = parse_bps_bytes(&patch_bytes).expect("parse");
    assert!(
        patch
            .actions
            .iter()
            .any(|action| matches!(action, BpsAction::TargetCopy { .. }))
    );
    assert!(
        patch_bytes.len() < modified.len() / 4,
        "target-copy patch should be much smaller than literal target data"
    );

    handler
        .apply(
            &PatchApplyRequest {
                input: original_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), modified);
}

#[test]
fn create_rejects_inputs_that_exceed_suffix_memory_budget_before_reading() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.bps");
    let sparse_len = 128 * 1024 * 1024;
    fs::File::create(&original_path)
        .expect("original")
        .set_len(sparse_len)
        .expect("original len");
    fs::File::create(&modified_path)
        .expect("modified")
        .set_len(sparse_len)
        .expect("modified len");
    assert!(
        bps_create_estimated_suffix_memory_bytes(sparse_len, sparse_len).expect("estimate")
            > u128::from(BPS_CREATE_MEMORY_LIMIT_BYTES)
    );
    assert!(
        bps_create_estimated_low_memory_suffix_bytes(sparse_len, sparse_len).expect("estimate")
            > u128::from(BPS_CREATE_MEMORY_LIMIT_BYTES)
    );

    let handler = BpsPatchHandler::new(&BPS);
    let error = handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path,
                format: "BPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("oversized suffix index should fail before reading sparse files");

    assert!(
        error
            .to_string()
            .contains("lower-memory suffix-index memory")
    );
}

#[test]
fn create_uses_lower_memory_suffix_lookup_when_reverse_index_exceeds_budget() {
    let source_len = 64 * 1024 * 1024;
    let target_len = 64 * 1024 * 1024;

    assert!(
        bps_create_estimated_suffix_memory_bytes(source_len, target_len).expect("fast estimate")
            > u128::from(BPS_CREATE_MEMORY_LIMIT_BYTES)
    );
    assert!(
        bps_create_estimated_low_memory_suffix_bytes(source_len, target_len)
            .expect("low-memory estimate")
            <= u128::from(BPS_CREATE_MEMORY_LIMIT_BYTES)
    );
    assert_eq!(
        bps_create_suffix_index_mode(source_len, target_len).expect("mode"),
        BpsSuffixIndexMode::LowMemory
    );
}

#[test]
fn lower_memory_suffix_lookup_matches_reverse_index_candidates() {
    let temp = TestDir::new();
    let target = b"abcabcZZabcabcYYYYabcabc".to_vec();
    let source = b"----abcabc----YYYYabcabc".to_vec();
    let mut bytes = target.clone();
    bytes.extend_from_slice(&source);
    let data = BpsCreateData {
        bytes,
        target_len: target.len(),
        source_len: source.len(),
    };
    let context = test_context_with_threads(&temp, 1);
    let mut fast_progress = BpsCreateProgress::new(&context, "BPS", target.len() as u64);
    let mut low_progress = BpsCreateProgress::new(&context, "BPS", target.len() as u64);
    let mut fast = BpsCombinedSuffixMatcher::new(
        &data,
        BpsSuffixIndexMode::FastReverse,
        &context,
        &mut fast_progress,
    )
    .expect("fast matcher");
    let mut low = BpsCombinedSuffixMatcher::new(
        &data,
        BpsSuffixIndexMode::LowMemory,
        &context,
        &mut low_progress,
    )
    .expect("low-memory matcher");

    for output_offset in 0..target.len() {
        fast.ensure_indexed(output_offset, &context, &mut fast_progress)
            .expect("fast reindex");
        low.ensure_indexed(output_offset, &context, &mut low_progress)
            .expect("low reindex");
        assert_eq!(
            low.find(output_offset).expect("low candidate"),
            fast.find(output_offset).expect("fast candidate"),
            "candidate mismatch at output offset {output_offset}"
        );
    }
}

#[test]
fn create_reports_progress_during_suffix_indexing_and_output() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.bps");
    fs::write(&original_path, patterned_tail(4096)).expect("fixture");
    let mut modified = patterned_tail(4096);
    modified.splice(128..128, b"inserted-data".iter().copied());
    fs::write(&modified_path, &modified).expect("fixture");

    let progress = Arc::new(RecordingProgressSink::default());
    let context = OperationContext::new(
        ThreadBudget::Fixed(1),
        temp.child("progress-temp"),
        progress.clone(),
        CancellationToken::new(),
    );
    BpsPatchHandler::new(&BPS)
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path,
                format: "BPS".into(),
            },
            &context,
        )
        .expect("create");

    let events = progress.snapshot();
    assert!(events.iter().any(|event| event.command == "patch-create"));
    assert!(
        events
            .iter()
            .any(|event| event.label == "indexing BPS copy candidates")
    );
    assert!(
        events
            .iter()
            .any(|event| event.label == "creating BPS patch")
    );
    assert!(
        events
            .windows(2)
            .all(|pair| pair[0].percent.unwrap_or(0.0) <= pair[1].percent.unwrap_or(0.0))
    );
}

#[test]
fn sorted_target_window_grows_like_flips() {
    assert_eq!(initial_bps_sorted_target_len(64, 8192), 512);
    assert_eq!(next_bps_sorted_target_len(128, 512, 8192), 512);
    assert_eq!(next_bps_sorted_target_len(256, 512, 8192), 2051);
    assert_eq!(next_bps_sorted_target_len(2048, 2051, 8192), 8192);
}

#[test]
fn copy_match_threshold_matches_flips_use_match_shape() {
    assert!(!bps_create_copy_match_is_worth(2, 0, false).expect("threshold"));
    assert!(bps_create_copy_match_is_worth(3, 0, false).expect("threshold"));
    assert!(!bps_create_copy_match_is_worth(3, 0, true).expect("threshold"));
    assert!(bps_create_copy_match_is_worth(4, 0, true).expect("threshold"));
}

#[test]
fn create_round_trips_when_target_growth_forces_suffix_reindex() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    let original = patterned_tail(64);
    let mut modified = patterned_tail(8192);
    modified[1536..1600].copy_from_slice(&original);
    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_path.clone(),
                format: "BPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");
    handler
        .apply(
            &PatchApplyRequest {
                input: original_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), modified);
}

#[test]
fn create_uses_source_copy_to_resync_after_insertion() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    let tail = patterned_tail(8192);
    let mut modified = b"prefix-".to_vec();
    modified.extend_from_slice(b"INSERT-");
    modified.extend_from_slice(&tail);
    let mut original = b"prefix-".to_vec();
    original.extend_from_slice(&tail);
    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_path.clone(),
                format: "BPS".into(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("create");

    let patch = parse_bps_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
    assert!(
        patch
            .actions
            .iter()
            .any(|action| matches!(action, BpsAction::SourceCopy { .. }))
    );

    handler
        .apply(
            &PatchApplyRequest {
                input: original_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), modified);
}

#[test]
fn create_uses_source_copy_to_resync_after_deletion() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    let head = vec![b'B'; 4096];
    let tail = patterned_tail(4096);
    let mut original = head.clone();
    original.extend_from_slice(b"REMOVE-ME");
    original.extend_from_slice(&tail);
    let mut modified = head;
    modified.extend_from_slice(&tail);
    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_path.clone(),
                format: "BPS".into(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("create");

    let patch = parse_bps_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
    assert!(
        patch
            .actions
            .iter()
            .any(|action| matches!(action, BpsAction::SourceCopy { .. }))
    );

    handler
        .apply(
            &PatchApplyRequest {
                input: original_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), modified);
}

fn patterned_tail(len: usize) -> Vec<u8> {
    (0..len)
        .map(|index| ((index.wrapping_mul(37) + (index / 251)) & 0xff) as u8)
        .collect()
}

fn build_bps_patch(source: &[u8], target: &[u8], actions: Vec<TestAction>) -> Vec<u8> {
    build_bps_patch_with_metadata(source, target, &[], actions)
}

fn build_bps_patch_with_metadata(
    source: &[u8],
    target: &[u8],
    metadata: &[u8],
    actions: Vec<TestAction>,
) -> Vec<u8> {
    let mut bytes = BPS_MAGIC.to_vec();
    push_varint(&mut bytes, source.len() as u64);
    push_varint(&mut bytes, target.len() as u64);
    push_varint(&mut bytes, metadata.len() as u64);
    bytes.extend_from_slice(metadata);

    for action in actions {
        match action {
            TestAction::SourceRead(length) => {
                push_varint(&mut bytes, ((length - 1) << 2) & !0x03);
            }
            TestAction::TargetRead(data) => {
                push_varint(&mut bytes, (((data.len() as u64) - 1) << 2) | 1);
                bytes.extend_from_slice(&data);
            }
            TestAction::SourceCopy {
                length,
                relative_offset,
            } => {
                push_varint(&mut bytes, ((length - 1) << 2) | 2);
                push_varint(
                    &mut bytes,
                    encode_signed_offset(relative_offset).expect("offset"),
                );
            }
            TestAction::TargetCopy {
                length,
                relative_offset,
            } => {
                push_varint(&mut bytes, ((length - 1) << 2) | 3);
                push_varint(
                    &mut bytes,
                    encode_signed_offset(relative_offset).expect("offset"),
                );
            }
        }
    }

    bytes.extend_from_slice(&crc32_bytes(source).to_le_bytes());
    bytes.extend_from_slice(&crc32_bytes(target).to_le_bytes());
    let patch_checksum = crc32_bytes(&bytes);
    bytes.extend_from_slice(&patch_checksum.to_le_bytes());
    bytes
}

/// Builds a structurally-truncated patch: a `TargetRead` action header promising
/// `claimed` literal bytes while only `present` are written before the 12-byte footer,
/// so the action decoder runs off the end of the stream.
fn truncated_target_read_patch(claimed: u64, present: &[u8]) -> Vec<u8> {
    let mut bytes = BPS_MAGIC.to_vec();
    push_varint(&mut bytes, 0); // source size
    push_varint(&mut bytes, claimed); // target size
    push_varint(&mut bytes, 0); // metadata size
    push_varint(&mut bytes, ((claimed - 1) << 2) | 1); // TargetRead header
    bytes.extend_from_slice(present);
    bytes.extend_from_slice(&[0u8; 12]); // footer placeholder (never reached)
    bytes
}

#[test]
fn apply_fails_when_input_checksum_mismatches_at_matching_size() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    // Same length as the patch's declared source but different bytes: the size check
    // passes so the source-checksum footer comparison is what rejects the apply.
    fs::write(&input_path, b"BBBB").expect("fixture");
    fs::write(
        &patch_path,
        build_bps_patch(b"AAAA", b"AAAA", vec![TestAction::SourceRead(4)]),
    )
    .expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("input checksum mismatch should fail");
    assert!(error.to_string().contains("Input checksum invalid"));
}

#[test]
fn apply_fails_when_output_checksum_mismatches() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, []).expect("fixture");
    // The target-checksum footer is crc32("AAAA") but the action stream writes "BBBB"
    // of the same length: parse + size checks pass, so the target-checksum footer
    // comparison is what rejects the produced output.
    fs::write(
        &patch_path,
        build_bps_patch(b"", b"AAAA", vec![TestAction::TargetRead(b"BBBB".to_vec())]),
    )
    .expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let validation = handler
        .validate(
            &PatchValidateRequest {
                input: input_path.clone(),
                patches: vec![patch_path.clone()],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("preflight should defer target checksum validation");
    assert!(
        validation
            .label
            .contains("target checksum deferred to apply")
    );

    let error = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("output checksum mismatch should fail");
    assert!(error.to_string().contains("Output checksum invalid"));
}

#[test]
fn validate_rejects_invalid_action_ranges_without_rendering_output() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    fs::write(&input_path, []).expect("fixture");
    fs::write(
        &patch_path,
        build_bps_patch(
            b"",
            b"A",
            vec![TestAction::TargetCopy {
                length: 1,
                relative_offset: 0,
            }],
        ),
    )
    .expect("fixture");

    let error = BpsPatchHandler::new(&BPS)
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("invalid TargetCopy should fail preflight");
    assert!(
        error
            .to_string()
            .contains("target relative offset exceeded available data")
    );
}

#[test]
fn validate_accepts_a_matching_source_and_defers_the_target_checksum() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    let source = b"source bytes";
    let target = b"target bytes";
    fs::write(&input_path, source).expect("input");
    fs::write(
        &patch_path,
        build_bps_patch(
            source,
            target,
            vec![TestAction::TargetRead(target.to_vec())],
        ),
    )
    .expect("patch");

    let report = BpsPatchHandler::new(&BPS)
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("validate");

    assert_eq!(report.status, OperationStatus::Succeeded);
    assert!(report.label.contains("target checksum deferred to apply"));
}

#[test]
fn parse_rejects_truncated_action_stream() {
    let bytes = truncated_target_read_patch(8, b"XY");
    let error = parse_bps_bytes(&bytes).expect_err("truncated action stream should fail");
    assert!(error.to_string().contains("ended unexpectedly"));
}

#[test]
fn apply_rejects_truncated_action_stream_in_file() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, []).expect("fixture");
    fs::write(&patch_path, truncated_target_read_patch(8, b"XY")).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("truncated action stream should fail");
    assert!(error.to_string().contains("ended unexpectedly"));
}

#[test]
fn parse_reads_non_zero_metadata_block() {
    // A patch carrying a non-empty metadata block still decodes its sizes and action.
    let patch = build_bps_patch_with_metadata(
        b"abc",
        b"abc",
        b"<metadata>x</metadata>",
        vec![TestAction::SourceRead(3)],
    );
    let parsed = parse_bps_bytes(&patch).expect("parse with metadata");
    assert_eq!(parsed.source_size, 3);
    assert_eq!(parsed.target_size, 3);
    assert_eq!(parsed.actions.len(), 1);
}

#[test]
fn describe_metadata_reports_sizes_and_checksums_without_decoding_actions() {
    let temp = TestDir::new();
    let patch_path = temp.child("probe.bps");
    let patch = build_bps_patch_with_metadata(
        b"abc",
        b"abc",
        b"author=test",
        vec![TestAction::SourceRead(3)],
    );
    let parsed = parse_bps_bytes(&patch).expect("parse");
    fs::write(&patch_path, patch).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let report = handler
        .describe_metadata(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("describe metadata");

    assert!(report.label.contains("patch metadata"));
    assert!(
        report
            .label
            .contains(&format!("source crc32 {:08x}", parsed.source_checksum))
    );
    assert!(
        report
            .label
            .contains(&format!("target crc32 {:08x}", parsed.target_checksum))
    );
    assert!(
        report
            .label
            .contains(&format!("patch crc32 {:08x}", parsed.patch_checksum))
    );
}

#[test]
fn describe_metadata_rejects_patch_checksum_mismatch() {
    let temp = TestDir::new();
    let patch_path = temp.child("probe.bps");
    let mut patch = build_bps_patch(b"abc", b"abc", vec![TestAction::SourceRead(3)]);
    let last = patch.len().checked_sub(1).expect("patch footer");
    patch[last] ^= 0x01; // corrupt the trailing patch-checksum footer
    fs::write(&patch_path, patch).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    let error = handler
        .describe_metadata(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("corrupt patch checksum should fail");
    assert!(error.to_string().contains("Patch checksum invalid"));
}

#[test]
fn describe_metadata_rejects_patch_smaller_than_header_and_footer() {
    let temp = TestDir::new();
    let patch_path = temp.child("tiny.bps");
    fs::write(&patch_path, b"BPS1").expect("fixture"); // 4 bytes < magic + 12-byte footer
    let handler = BpsPatchHandler::new(&BPS);
    let error = handler
        .describe_metadata(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("undersized patch should fail");
    assert!(
        error
            .to_string()
            .contains("too small to contain a valid header and footer")
    );
}

#[test]
fn describe_metadata_rejects_invalid_header_magic() {
    let temp = TestDir::new();
    let patch_path = temp.child("bad.bps");
    // At least magic + footer bytes, but the leading magic is wrong.
    fs::write(&patch_path, vec![0u8; 16]).expect("fixture");
    let handler = BpsPatchHandler::new(&BPS);
    let error = handler
        .describe_metadata(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("bad magic should fail");
    assert!(error.to_string().contains("Patch header invalid"));
}

/// A hand-built parsed patch, used to reach the apply-time and plan-time range
/// checks that the file parser rejects before an apply can ever see them. The
/// checksums are not exercised by these paths.
fn parsed_patch(source_size: u64, target_size: u64, actions: Vec<BpsAction>) -> ParsedBpsPatch {
    ParsedBpsPatch {
        source_size,
        target_size,
        source_checksum: 0,
        target_checksum: 0,
        patch_checksum: 0,
        actions,
    }
}

/// Source `abcdefgh` rewritten as `abcdZZefghabcd`: one action of every kind,
/// in an order that leaves each relative offset non-zero.
fn every_action_patch() -> Vec<u8> {
    build_bps_patch(
        b"abcdefgh",
        b"abcdZZefghabcd",
        vec![
            TestAction::SourceRead(4),
            TestAction::TargetRead(b"ZZ".to_vec()),
            TestAction::SourceCopy {
                length: 4,
                relative_offset: 4,
            },
            TestAction::TargetCopy {
                length: 4,
                relative_offset: 0,
            },
        ],
    )
}

fn open_output(path: &std::path::Path) -> fs::File {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .expect("open output")
}

#[test]
fn header_magic_and_probe_describe_the_bps_container() {
    let temp = TestDir::new();
    let patch = temp.child("probe.bps");
    fs::write(&patch, BPS_MAGIC).expect("fixture");

    let handler = BpsPatchHandler::new(&BPS);
    assert_eq!(handler.header_magic(), Some(&BPS_MAGIC[..]));
    assert_eq!(
        handler.probe(&patch),
        rom_weaver_core::ProbeConfidence::Extension
    );
}

#[test]
fn apply_runs_every_action_kind_on_the_serial_streaming_path() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, b"abcdefgh").expect("fixture");
    fs::write(&patch_path, every_action_patch()).expect("fixture");

    let report = BpsPatchHandler::new(&BPS)
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    // The TargetCopy action forces the sequential writer, so no pool is built.
    let execution = report.thread_execution.expect("thread execution");
    assert!(!execution.used_parallelism);
    assert_eq!(fs::read(&output_path).expect("output"), b"abcdZZefghabcd");
}

#[test]
fn apply_runs_every_action_kind_on_the_in_memory_path() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, b"abcdefgh").expect("fixture");
    fs::write(&patch_path, every_action_patch()).expect("fixture");

    let report = BpsPatchHandler::new(&BPS)
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4).with_patch_apply_in_memory_limit(1 << 20),
        )
        .expect("apply");

    // The in-memory path always reports serial execution, whatever was planned.
    let execution = report.thread_execution.expect("thread execution");
    assert!(!execution.used_parallelism);
    assert_eq!(fs::read(&output_path).expect("output"), b"abcdZZefghabcd");
}

#[test]
fn in_memory_apply_expands_an_overlapping_target_copy_run() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, []).expect("fixture");
    fs::write(
        &patch_path,
        build_bps_patch(
            b"",
            b"AAAAAA",
            vec![
                TestAction::TargetRead(vec![b'A']),
                TestAction::TargetCopy {
                    length: 5,
                    relative_offset: 0,
                },
            ],
        ),
    )
    .expect("fixture");

    BpsPatchHandler::new(&BPS)
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1).with_patch_apply_in_memory_limit(1 << 20),
        )
        .expect("apply");
    assert_eq!(fs::read(&output_path).expect("output"), b"AAAAAA");
}

#[test]
fn in_memory_apply_reports_actions_that_read_past_the_source() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 1);
    let source = b"abcd";

    let read_patch = parsed_patch(8, 8, vec![BpsAction::SourceRead { length: 8 }]);
    let mut output = vec![0u8; 8];
    let read_error =
        apply_patch_actions_in_memory(&read_patch, source, &mut output, &context, "BPS")
            .expect_err("a SourceRead past the source should fail");
    assert!(
        read_error
            .to_string()
            .contains("SourceRead exceeded input size"),
        "unexpected error: {read_error}"
    );

    let copy_patch = parsed_patch(
        8,
        4,
        vec![BpsAction::SourceCopy {
            length: 4,
            relative_offset: 2,
        }],
    );
    let mut output = vec![0u8; 4];
    let copy_error =
        apply_patch_actions_in_memory(&copy_patch, source, &mut output, &context, "BPS")
            .expect_err("a SourceCopy past the source should fail");
    assert!(
        copy_error
            .to_string()
            .contains("SourceCopy exceeded input size"),
        "unexpected error: {copy_error}"
    );
}

#[test]
fn in_memory_apply_reports_a_short_action_stream() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 1);
    let patch = parsed_patch(
        0,
        4,
        vec![BpsAction::TargetRead {
            data: b"AB".to_vec(),
        }],
    );
    let mut output = vec![0u8; 4];

    let error = apply_patch_actions_in_memory(&patch, b"", &mut output, &context, "BPS")
        .expect_err("actions that stop short of the target size should fail");
    assert!(
        error.to_string().contains("Output size invalid"),
        "unexpected error: {error}"
    );
}

#[test]
fn streaming_apply_reports_actions_that_read_past_the_source() {
    let temp = TestDir::new();
    let output_path = temp.child("streamed.bin");
    fs::write(&output_path, [0u8; 8]).expect("fixture");
    let context = test_context_with_threads(&temp, 1);

    let read_patch = parsed_patch(4, 8, vec![BpsAction::SourceRead { length: 8 }]);
    let mut source = std::io::Cursor::new(b"abcd".to_vec());
    let mut output = open_output(&output_path);
    let read_error = apply_patch_actions(&read_patch, &mut source, &mut output, &context, "BPS")
        .expect_err("a SourceRead past the source should fail");
    assert!(
        read_error
            .to_string()
            .contains("SourceRead exceeded input size"),
        "unexpected error: {read_error}"
    );

    let copy_patch = parsed_patch(
        4,
        4,
        vec![BpsAction::SourceCopy {
            length: 4,
            relative_offset: 2,
        }],
    );
    let mut source = std::io::Cursor::new(b"abcd".to_vec());
    let copy_error = apply_patch_actions(&copy_patch, &mut source, &mut output, &context, "BPS")
        .expect_err("a SourceCopy past the source should fail");
    assert!(
        copy_error
            .to_string()
            .contains("SourceCopy exceeded input size"),
        "unexpected error: {copy_error}"
    );
}

#[test]
fn streaming_apply_reports_an_action_stream_that_does_not_fill_the_target() {
    let temp = TestDir::new();
    let output_path = temp.child("short.bin");
    fs::write(&output_path, [0u8; 8]).expect("fixture");
    let context = test_context_with_threads(&temp, 1);

    let long_patch = parsed_patch(
        8,
        2,
        vec![BpsAction::TargetRead {
            data: b"ABCD".to_vec(),
        }],
    );
    let mut source = std::io::Cursor::new(b"abcdefgh".to_vec());
    let mut output = open_output(&output_path);
    let long_error = apply_patch_actions(&long_patch, &mut source, &mut output, &context, "BPS")
        .expect_err("writing past the target size should fail");
    assert!(
        long_error.to_string().contains("Output size invalid"),
        "unexpected error: {long_error}"
    );

    let short_patch = parsed_patch(
        8,
        8,
        vec![BpsAction::TargetRead {
            data: b"ABCD".to_vec(),
        }],
    );
    let mut source = std::io::Cursor::new(b"abcdefgh".to_vec());
    let short_error = apply_patch_actions(&short_patch, &mut source, &mut output, &context, "BPS")
        .expect_err("stopping short of the target size should fail");
    assert!(
        short_error.to_string().contains("Output size invalid"),
        "unexpected error: {short_error}"
    );
}

#[test]
fn apply_copies_a_target_run_whose_period_exceeds_the_copy_buffer() {
    let temp = TestDir::new();
    let input_path = temp.child("large-input.bin");
    let patch_path = temp.child("large.bps");
    let output_path = temp.child("large-output.bin");
    // The period is the whole 40000-byte prefix, which is larger than the
    // 32 KiB copy buffer, so `copy_target_range` takes its chunked branch.
    let source = patterned_tail(40000);
    let mut target = source.clone();
    target.extend_from_slice(&source[..100]);
    fs::write(&input_path, &source).expect("fixture");
    fs::write(
        &patch_path,
        build_bps_patch(
            &source,
            &target,
            vec![
                TestAction::SourceRead(40000),
                TestAction::TargetCopy {
                    length: 100,
                    relative_offset: 0,
                },
            ],
        ),
    )
    .expect("fixture");

    BpsPatchHandler::new(&BPS)
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");
    assert_eq!(fs::read(&output_path).expect("output"), target);
}

#[test]
fn target_range_copies_are_range_checked() {
    let temp = TestDir::new();
    let output_path = temp.child("range.bin");
    fs::write(&output_path, b"abcd").expect("fixture");
    let context = test_context_with_threads(&temp, 1);
    let mut progress = BpsApplyProgress::new(&context, "BPS", 8);
    let mut output = open_output(&output_path);

    let mut output_offset = 4u64;
    copy_target_range(&mut output, &mut output_offset, 0, 0, &mut progress)
        .expect("a zero-length copy is a no-op");
    assert_eq!(output_offset, 4);

    let error = copy_target_range(&mut output, &mut output_offset, 4, 2, &mut progress)
        .expect_err("a copy from unwritten output should fail");
    assert!(
        error
            .to_string()
            .contains("TargetCopy referenced unavailable output"),
        "unexpected error: {error}"
    );
}

#[test]
fn ordered_writes_skip_empty_records_and_seek_over_gaps() {
    let temp = TestDir::new();
    let output_path = temp.child("ordered.bin");
    fs::write(&output_path, [0u8; 8]).expect("fixture");
    let context = test_context_with_threads(&temp, 1);
    let mut progress = BpsApplyProgress::new(&context, "BPS", 8);
    let mut output = open_output(&output_path);

    apply_prepared_bps_writes(
        &mut output,
        &[
            PreparedBpsWrite {
                output_offset: 0,
                data: Vec::new(),
            },
            PreparedBpsWrite {
                output_offset: 4,
                data: b"WXYZ".to_vec(),
            },
        ],
        &mut progress,
    )
    .expect("ordered writes");
    drop(output);

    assert_eq!(fs::read(&output_path).expect("output"), b"\0\0\0\0WXYZ");
}

#[test]
fn apply_progress_stays_silent_for_a_zero_length_target() {
    let temp = TestDir::new();
    let progress_sink = Arc::new(RecordingProgressSink::default());
    let context = OperationContext::new(
        ThreadBudget::Fixed(1),
        temp.child("progress-temp"),
        progress_sink.clone(),
        CancellationToken::new(),
    );

    BpsApplyProgress::new(&context, "BPS", 0).report(16);
    assert!(progress_sink.snapshot().is_empty());
}

#[test]
fn create_progress_reports_fixed_percentages_for_a_zero_length_target() {
    let temp = TestDir::new();
    let progress_sink = Arc::new(RecordingProgressSink::default());
    let context = OperationContext::new(
        ThreadBudget::Fixed(1),
        temp.child("progress-temp"),
        progress_sink.clone(),
        CancellationToken::new(),
    );

    let mut progress = BpsCreateProgress::new(&context, "BPS", 0);
    progress.report_indexed(0);
    progress.report_output(0);

    let events = progress_sink.snapshot();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].percent, Some(40.0));
    assert_eq!(events[0].label, "indexing BPS copy candidates");
    // `report` clamps to 99, so the 100% output report lands at 99.
    assert_eq!(events[1].percent, Some(99.0));
    assert_eq!(events[1].label, "creating BPS patch");
}

#[test]
fn parallel_write_plans_reject_actions_that_leave_the_declared_ranges() {
    let source_read = parsed_patch(4, 8, vec![BpsAction::SourceRead { length: 8 }]);
    let Err(error) = collect_parallel_bps_write_plans(&source_read) else {
        panic!("a SourceRead past the source should fail");
    };
    assert!(
        error.to_string().contains("SourceRead exceeded input size"),
        "unexpected error: {error}"
    );

    let source_copy = parsed_patch(
        4,
        4,
        vec![BpsAction::SourceCopy {
            length: 4,
            relative_offset: 2,
        }],
    );
    let Err(error) = collect_parallel_bps_write_plans(&source_copy) else {
        panic!("a SourceCopy past the source should fail");
    };
    assert!(
        error.to_string().contains("SourceCopy exceeded input size"),
        "unexpected error: {error}"
    );

    let target_copy = parsed_patch(
        4,
        4,
        vec![BpsAction::TargetCopy {
            length: 4,
            relative_offset: 0,
        }],
    );
    let Err(error) = collect_parallel_bps_write_plans(&target_copy) else {
        panic!("TargetCopy cannot be planned in parallel");
    };
    assert!(
        error
            .to_string()
            .contains("TargetCopy actions require sequential apply"),
        "unexpected error: {error}"
    );
}

#[test]
fn parallel_write_plans_reject_a_stream_that_misses_the_target_size() {
    let too_long = parsed_patch(
        8,
        2,
        vec![BpsAction::TargetRead {
            data: b"ABCD".to_vec(),
        }],
    );
    let Err(error) = collect_parallel_bps_write_plans(&too_long) else {
        panic!("writing past the target size should fail");
    };
    assert!(
        error.to_string().contains("Output size invalid"),
        "unexpected error: {error}"
    );

    let too_short = parsed_patch(
        8,
        8,
        vec![BpsAction::TargetRead {
            data: b"ABCD".to_vec(),
        }],
    );
    let Err(error) = collect_parallel_bps_write_plans(&too_short) else {
        panic!("stopping short of the target size should fail");
    };
    assert!(
        error.to_string().contains("Output size invalid"),
        "unexpected error: {error}"
    );

    let exact = parsed_patch(
        8,
        4,
        vec![BpsAction::TargetRead {
            data: b"ABCD".to_vec(),
        }],
    );
    assert_eq!(
        collect_parallel_bps_write_plans(&exact)
            .map(|plans| plans.len())
            .expect("an exact stream plans one write"),
        1
    );
}

#[test]
fn parse_rejects_action_ranges_that_leave_the_declared_sizes() {
    let temp = TestDir::new();
    let handler = BpsPatchHandler::new(&BPS);
    let context = test_context_with_threads(&temp, 1);

    let source_read = temp.child("source-read.bps");
    fs::write(
        &source_read,
        build_bps_patch(b"ab", b"abcd", vec![TestAction::SourceRead(4)]),
    )
    .expect("fixture");
    let error = handler
        .parse(&source_read, &context)
        .expect_err("a SourceRead past the source should fail");
    assert!(
        error.to_string().contains("SourceRead exceeded input size"),
        "unexpected error: {error}"
    );

    let source_copy = temp.child("source-copy.bps");
    fs::write(
        &source_copy,
        build_bps_patch(
            b"abcd",
            b"cdef",
            vec![TestAction::SourceCopy {
                length: 4,
                relative_offset: 2,
            }],
        ),
    )
    .expect("fixture");
    let error = handler
        .parse(&source_copy, &context)
        .expect_err("a SourceCopy past the source should fail");
    assert!(
        error.to_string().contains("SourceCopy exceeded input size"),
        "unexpected error: {error}"
    );

    let short_stream = temp.child("short-stream.bps");
    fs::write(
        &short_stream,
        build_bps_patch(b"abcd", b"abcdefgh", vec![TestAction::SourceRead(4)]),
    )
    .expect("fixture");
    let error = handler
        .parse(&short_stream, &context)
        .expect_err("an action stream shorter than the target should fail");
    assert!(
        error.to_string().contains("Output size invalid"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_an_undersized_file_and_a_bad_magic() {
    let temp = TestDir::new();
    let handler = BpsPatchHandler::new(&BPS);
    let context = test_context_with_threads(&temp, 1);

    let tiny = temp.child("tiny.bps");
    fs::write(&tiny, b"BPS1").expect("fixture");
    let tiny_error = handler
        .parse(&tiny, &context)
        .expect_err("a file shorter than magic plus footer should fail");
    assert!(
        tiny_error
            .to_string()
            .contains("too small to contain a valid header and footer"),
        "unexpected error: {tiny_error}"
    );

    let bad_magic = temp.child("bad-magic.bps");
    fs::write(&bad_magic, vec![0u8; 16]).expect("fixture");
    let magic_error = handler
        .parse(&bad_magic, &context)
        .expect_err("a wrong magic should fail");
    assert!(
        magic_error.to_string().contains("Patch header invalid"),
        "unexpected error: {magic_error}"
    );
}

#[test]
fn byte_parser_rejects_undersized_input_bad_magic_and_a_short_stream() {
    let tiny = parse_bps_bytes(&[0u8; 8]).expect_err("an undersized patch should fail");
    assert!(
        tiny.to_string()
            .contains("too small to contain a valid header and footer"),
        "unexpected error: {tiny}"
    );

    let magic = parse_bps_bytes(&[0u8; 32]).expect_err("a wrong magic should fail");
    assert!(
        magic.to_string().contains("Patch header invalid"),
        "unexpected error: {magic}"
    );

    let short = parse_bps_bytes(&build_bps_patch(
        b"abcd",
        b"abcdefgh",
        vec![TestAction::SourceRead(4)],
    ))
    .expect_err("an action stream shorter than the target should fail");
    assert!(
        short.to_string().contains("Output size invalid"),
        "unexpected error: {short}"
    );
}

#[test]
fn byte_parser_checks_the_patch_checksum_unless_it_is_told_not_to() {
    let mut bytes = build_bps_patch(b"abc", b"abc", vec![TestAction::SourceRead(3)]);
    let last = bytes.len() - 1;
    bytes[last] ^= 0x01;

    let error = parse_bps_bytes(&bytes).expect_err("a corrupt patch checksum should fail");
    assert!(
        error.to_string().contains("Patch checksum invalid"),
        "unexpected error: {error}"
    );

    let parsed = parse_bps_bytes_with_checksum_validation(&bytes, false)
        .expect("the checksum check is skipped");
    assert_eq!(parsed.actions.len(), 1);
}

#[test]
fn output_validation_reports_a_size_that_does_not_match_the_patch() {
    let temp = TestDir::new();
    let output_path = temp.child("validated.bin");
    fs::write(&output_path, b"abcd").expect("fixture");
    let context = test_context_with_threads(&temp, 1);
    let mut output = open_output(&output_path);

    let error = validate_output_file(&output_path, &mut output, 8, 0, false, &context)
        .expect_err("a short output should fail");
    assert!(
        error.to_string().contains("Output size invalid"),
        "unexpected error: {error}"
    );

    validate_output_file(&output_path, &mut output, 4, 0, false, &context)
        .expect("the size matches and the checksum check is skipped");
}

#[test]
fn relative_offsets_stay_inside_the_file() {
    let error =
        adjust_relative_offset(0, -1, 10, "source").expect_err("a negative offset should fail");
    assert!(
        error
            .to_string()
            .contains("source relative offset moved before the start of the file"),
        "unexpected error: {error}"
    );

    let beyond = adjust_relative_offset(8, 4, 10, "target")
        .expect_err("an offset at or past the limit should fail");
    assert!(
        beyond
            .to_string()
            .contains("target relative offset exceeded available data"),
        "unexpected error: {beyond}"
    );

    let past_u64 = adjust_relative_offset(i128::from(u64::MAX), 1, 10, "source")
        .expect_err("an offset past u64 should fail");
    assert!(
        past_u64
            .to_string()
            .contains("source relative offset exceeded u64"),
        "unexpected error: {past_u64}"
    );

    assert_eq!(
        adjust_relative_offset(4, -2, 10, "source").expect("an in-range offset"),
        2
    );
}

#[test]
fn signed_offsets_and_action_headers_reject_unencodable_values() {
    let magnitude =
        encode_signed_offset(i128::MIN).expect_err("the most negative delta has no magnitude");
    assert!(
        magnitude
            .to_string()
            .contains("relative offset magnitude overflowed"),
        "unexpected error: {magnitude}"
    );

    let zero_length =
        encode_action_header(0, 1).expect_err("a zero-length action is not encodable");
    assert!(
        zero_length
            .to_string()
            .contains("cannot encode a zero-length action"),
        "unexpected error: {zero_length}"
    );

    assert_eq!(
        encode_action_header(4, 3).expect("a four-byte TargetCopy header"),
        (3 << 2) | 3
    );
}

#[test]
fn create_input_lengths_are_rejected_before_any_file_is_read() {
    let too_large = bps_create_usize_len(u64::from(u32::MAX), "source")
        .expect_err("a 4 GiB source cannot be indexed");
    assert!(
        too_large
            .to_string()
            .contains("BPS create source file is too large for copy-aware indexing"),
        "unexpected error: {too_large}"
    );
    assert_eq!(
        bps_create_usize_len(16, "target").expect("a small length"),
        16
    );

    let temp = TestDir::new();
    let missing = temp.child("never-opened.bin");
    // `BpsCreateData` is not `Debug`, so the success arm cannot use `expect_err`.
    let Err(combined) = read_bps_create_data(&missing, 0x8000_0000, &missing, 0x8000_0000) else {
        panic!("a combined size past the 32-bit index should fail");
    };
    assert!(
        combined
            .to_string()
            .contains("BPS create files are too large for copy-aware indexing"),
        "unexpected error: {combined}"
    );
}

#[test]
fn create_input_reads_report_a_file_that_changed_size() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    fs::write(&original_path, b"abcd").expect("fixture");
    fs::write(&modified_path, b"abcdef").expect("fixture");

    let Err(target_error) = read_bps_create_data(&original_path, 4, &modified_path, 8) else {
        panic!("a modified file shorter than its declared length should fail");
    };
    assert!(
        target_error
            .to_string()
            .contains("BPS create target size changed during processing"),
        "unexpected error: {target_error}"
    );

    let Err(source_error) = read_bps_create_data(&original_path, 8, &modified_path, 6) else {
        panic!("an original file shorter than its declared length should fail");
    };
    assert!(
        source_error
            .to_string()
            .contains("BPS create source size changed during processing"),
        "unexpected error: {source_error}"
    );

    let Ok(data) = read_bps_create_data(&original_path, 4, &modified_path, 6) else {
        panic!("matching sizes should read both files");
    };
    assert_eq!(data.target(), b"abcdef");
    assert_eq!(data.source(), b"abcd");
}

#[test]
fn match_scoring_declines_target_reads_and_displaced_source_reads() {
    assert!(
        !bps_create_match_is_worth(BpsCreateMode::TargetRead, 8, 0, 0, 0, 0, 0)
            .expect("a target read is never a match")
    );
    assert!(
        !bps_create_match_is_worth(BpsCreateMode::SourceCopy, 0, 0, 0, 0, 0, 0)
            .expect("a zero-length match is never worth it")
    );
    // A SourceRead only pays off at the offset it already sits at.
    assert!(
        !bps_create_match_is_worth(BpsCreateMode::SourceRead, 64, 4, 0, 0, 0, 0)
            .expect("a displaced source read is not encodable")
    );
    assert!(
        bps_create_match_is_worth(BpsCreateMode::SourceRead, 4, 0, 0, 0, 0, 0)
            .expect("an aligned source read is worth it")
    );
}

#[test]
fn prefix_scans_stop_at_out_of_range_offsets() {
    assert_eq!(common_prefix_len_limited(b"abcabc", 9, 0, 3), 0);
    assert_eq!(common_prefix_len_limited(b"abcabc", 0, 9, 3), 0);
    assert_eq!(common_prefix_len_limited(b"abcabc", 0, 3, 0), 0);
    assert_eq!(common_prefix_len_limited(b"abcabc", 0, 3, 3), 3);

    assert_eq!(repeated_byte_run_len(b"abc", 9), 0);
    assert_eq!(repeated_byte_run_len(b"aaab", 0), 3);
}

#[test]
fn streaming_apply_seeks_when_the_source_and_output_positions_diverge() {
    let temp = TestDir::new();
    let input_path = temp.child("seek-input.bin");
    let patch_path = temp.child("seek.bps");
    let output_path = temp.child("seek-output.bin");
    fs::write(&input_path, b"abcdefgh").expect("fixture");
    // The SourceCopy jumps the read head forward to offset 4, so the following
    // SourceRead has to seek back to the output offset it reads from.
    fs::write(
        &patch_path,
        build_bps_patch(
            b"abcdefgh",
            b"Zefdef",
            vec![
                TestAction::TargetRead(vec![b'Z']),
                TestAction::SourceCopy {
                    length: 2,
                    relative_offset: 4,
                },
                TestAction::SourceRead(3),
            ],
        ),
    )
    .expect("fixture");

    let report = BpsPatchHandler::new(&BPS)
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    assert!(
        !report
            .thread_execution
            .expect("thread execution")
            .used_parallelism
    );
    assert_eq!(fs::read(&output_path).expect("output"), b"Zefdef");
}

#[test]
fn create_rejects_inputs_larger_than_the_in_memory_encoder_limit() {
    let temp = TestDir::new();
    let original_path = temp.child("huge-original.bin");
    let modified_path = temp.child("huge-modified.bin");
    let patch_path = temp.child("huge.bps");
    // Sparse files one byte over the in-memory cap: create refuses them on the
    // declared lengths alone, so nothing is ever read.
    let sparse_len = crate::IN_MEMORY_APPLY_LIMIT_BYTES + 1;
    for path in [&original_path, &modified_path] {
        fs::File::create(path)
            .expect("sparse file")
            .set_len(sparse_len)
            .expect("sparse len");
    }

    let error = BpsPatchHandler::new(&BPS)
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path,
                format: "BPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("inputs over the in-memory cap should fail");
    assert!(
        error
            .to_string()
            .contains("BPS create requires copy-aware in-memory encoding"),
        "unexpected error: {error}"
    );
}
