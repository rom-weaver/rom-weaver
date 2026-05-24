use std::fs;

use rom_weaver_core::{
    PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
};

use super::{
    BPS_MAGIC, BpsAction, BpsPatchHandler, CREATE_THREAD_SCAN_CHUNK_BYTES, crc32_bytes,
    encode_signed_offset, parse_bps_bytes, push_varint,
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
    let patch_path = temp.child("inspect.bps");
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
fn create_uses_parallel_threads_for_large_patch() {
    let temp = TestDir::new();
    let original_path = temp.child("original-large.bin");
    let modified_path = temp.child("modified-large.bin");
    let patch_path = temp.child("update-large.bps");
    let output_path = temp.child("output-large.bin");

    let mut original = vec![0u8; (CREATE_THREAD_SCAN_CHUNK_BYTES * 2) + 4096];
    for (index, byte) in original.iter_mut().enumerate() {
        *byte = (index as u8).wrapping_mul(11);
    }
    let mut modified = original.clone();
    modified[0] = modified[0].wrapping_add(1);
    let boundary = CREATE_THREAD_SCAN_CHUNK_BYTES;
    for byte in &mut modified[(boundary - 64)..(boundary + 64)] {
        *byte = byte.wrapping_add(2);
    }

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
    assert!(execution.effective_threads >= 2);
    assert!(execution.used_parallelism);

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
fn create_uses_source_copy_to_resync_after_insertion() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.bps");
    let output_path = temp.child("output.bin");
    let tail = vec![b'A'; 8192];
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
    let tail = vec![b'C'; 4096];
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
