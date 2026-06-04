/* jscpd:ignore-start */
use std::{fs, sync::Arc};

use rom_weaver_core::{
    CancellationToken, OperationContext, PatchApplyRequest, PatchChecksumValidation,
    PatchCreateRequest, PatchHandler, RecordingProgressSink, ThreadBudget,
};

use super::{
    BPS_CREATE_MEMORY_LIMIT_BYTES, BPS_MAGIC, BpsAction, BpsCombinedSuffixMatcher, BpsCreateData,
    BpsCreateProgress, BpsPatchHandler, BpsSuffixIndexMode, bps_create_copy_match_is_worth,
    bps_create_estimated_low_memory_suffix_bytes, bps_create_estimated_suffix_memory_bytes,
    bps_create_suffix_index_mode, crc32_bytes, encode_signed_offset, initial_bps_sorted_target_len,
    next_bps_sorted_target_len, parse_bps_bytes, push_varint,
};
use crate::{
    BPS,
    test_support::{TestDir, test_context_with_threads},
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
    // in-memory path uses a single thread (no per-action file I/O needed)
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
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
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    fs::write(&original_path, b"hello old world").expect("fixture");
    fs::write(&modified_path, b"hello new world").expect("fixture");

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

    let patch = parse_bps_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
    assert!(!patch.actions.is_empty());

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

    assert_eq!(
        fs::read(output_path).expect("output"),
        fs::read(modified_path).expect("modified")
    );
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
    let mut bytes = BPS_MAGIC.to_vec();
    push_varint(&mut bytes, source.len() as u64);
    push_varint(&mut bytes, target.len() as u64);
    push_varint(&mut bytes, 0);

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
/* jscpd:ignore-end */
