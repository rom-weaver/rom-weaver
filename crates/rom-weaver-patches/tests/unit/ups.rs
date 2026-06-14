use std::fs;

use rom_weaver_core::{
    PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
};

use super::{UpsPatchHandler, create_ups_patch_bytes, parse_ups_bytes};
use crate::{
    UPS,
    test_support::{RoundTripCase, TestDir, assert_round_trip, test_context_with_threads},
};

#[test]
fn parse_reports_source_target_and_patch_crc32() {
    let temp = TestDir::new();
    let patch_path = temp.child("probe.ups");
    let patch = create_ups_patch_bytes(b"source-data", b"target-data")
        .expect("patch")
        .bytes;
    let parsed = parse_ups_bytes(&patch).expect("parse");
    fs::write(&patch_path, patch).expect("fixture");

    let handler = UpsPatchHandler::new(&UPS);
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
fn parse_rejects_invalid_patch_checksum() {
    let mut patch = create_ups_patch_bytes(b"source", b"target")
        .expect("patch")
        .bytes;
    patch[5] ^= 0x01;

    let error = parse_ups_bytes(&patch).expect_err("checksum mismatch should fail");
    assert!(error.to_string().contains("Patch checksum invalid"));
}

#[test]
fn create_and_apply_round_trip_in_both_directions() {
    let handler = UpsPatchHandler::new(&UPS);
    let create_report = assert_round_trip(
        &handler,
        &RoundTripCase {
            patch_extension: "ups",
            reverse: true,
            ..RoundTripCase::new(b"abcabcabcabc", b"abcabcZZabcabc", "UPS")
        },
    );

    let execution = create_report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
}

#[test]
fn apply_rejects_inputs_that_match_neither_side() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.ups");
    let bad_input_path = temp.child("wrong.bin");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"expected source").expect("fixture");
    fs::write(&target_path, b"expected target").expect("fixture");
    fs::write(&bad_input_path, b"something else").expect("fixture");

    let handler = UpsPatchHandler::new(&UPS);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path,
                modified: target_path,
                output: patch_path.clone(),
                format: "UPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let error = handler
        .apply(
            &PatchApplyRequest {
                input: bad_input_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("apply should fail");

    assert!(error.to_string().contains("UPS input validation failed"));
}

#[test]
fn apply_can_ignore_patch_checksum_mismatch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.ups");
    let output_path = temp.child("output.bin");
    fs::write(&source_path, b"hello old world").expect("fixture");
    fs::write(&target_path, b"hello new world").expect("fixture");

    let handler = UpsPatchHandler::new(&UPS);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "UPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let mut patch_bytes = fs::read(&patch_path).expect("patch bytes");
    let footer_index = patch_bytes.len().checked_sub(1).expect("patch footer");
    patch_bytes[footer_index] ^= 0x01;
    fs::write(&patch_path, patch_bytes).expect("patch bytes");

    let strict_error = handler
        .apply(
            &PatchApplyRequest {
                input: source_path.clone(),
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
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("ignore checksum validation should apply patch");

    assert_eq!(
        fs::read(output_path).expect("output"),
        fs::read(target_path).expect("target")
    );
}

#[test]
fn create_omits_zero_filled_truncation_records() {
    let source = b"\xff\xee\xdd\xcc\xbb\xaa\x99\0\0\0\0";
    let target = b"\xff\xee\xdd\xcc\xbb\xaa\x99";

    let created = create_ups_patch_bytes(source, target).expect("patch");
    let parsed = parse_ups_bytes(&created.bytes).expect("parse");

    assert_eq!(created.record_count, 0);
    assert!(parsed.changes.is_empty());
}

#[test]
fn create_preserves_nonzero_truncation_suffix_for_reverse_apply() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("truncate.ups");
    let output_path = temp.child("output.bin");
    let reverse_output_path = temp.child("reverse.bin");

    let source = b"ABCDEFGH\x91\x92\x93\x94";
    let target = b"ABCDEFGH";
    fs::write(&source_path, source).expect("source fixture");
    fs::write(&target_path, target).expect("target fixture");

    let handler = UpsPatchHandler::new(&UPS);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "UPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let parsed = parse_ups_bytes(&fs::read(&patch_path).expect("patch bytes")).expect("parse");
    assert_eq!(parsed.changes.len(), 1);
    assert_eq!(parsed.changes[0].offset, target.len() as u64);
    assert_eq!(parsed.changes[0].xor_bytes, source[target.len()..]);

    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("forward apply");
    assert_eq!(fs::read(&output_path).expect("output"), target);

    handler
        .apply(
            &PatchApplyRequest {
                input: target_path,
                patches: vec![patch_path],
                output: reverse_output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("reverse apply");
    assert_eq!(
        fs::read(reverse_output_path).expect("reverse output"),
        source
    );
}

#[test]
fn apply_accepts_flips_style_truncation_record_past_target_size() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("flips-truncate.ups");
    let output_path = temp.child("output.bin");
    let reverse_output_path = temp.child("reverse.bin");

    let source = b"ABCDEFGH\x91\x92\x93\x94";
    let target = b"ABCDEFGH";
    let mut patch = super::UPS_MAGIC.to_vec();
    super::push_varint(&mut patch, source.len() as u64);
    super::push_varint(&mut patch, target.len() as u64);
    super::push_varint(&mut patch, target.len() as u64);
    patch.extend_from_slice(&source[target.len()..]);
    patch.push(0);
    patch.extend_from_slice(&super::crc32_bytes(source).to_le_bytes());
    patch.extend_from_slice(&super::crc32_bytes(target).to_le_bytes());
    let patch_checksum = super::crc32_bytes(&patch);
    patch.extend_from_slice(&patch_checksum.to_le_bytes());

    fs::write(&source_path, source).expect("source fixture");
    fs::write(&target_path, target).expect("target fixture");
    fs::write(&patch_path, patch).expect("patch fixture");

    let handler = UpsPatchHandler::new(&UPS);
    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("forward apply");
    assert_eq!(fs::read(&output_path).expect("output"), target);

    handler
        .apply(
            &PatchApplyRequest {
                input: target_path,
                patches: vec![patch_path],
                output: reverse_output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("reverse apply");
    assert_eq!(
        fs::read(reverse_output_path).expect("reverse output"),
        source
    );
}

#[test]
fn create_parallel_preserves_nonzero_truncation_suffix_across_chunk_boundary() {
    let temp = TestDir::new();
    let source_path = temp.child("source-boundary-truncate.bin");
    let target_path = temp.child("target-boundary-truncate.bin");
    let patch_path = temp.child("boundary-truncate.ups");
    let reverse_output_path = temp.child("reverse-boundary-truncate.bin");

    let target_len = super::CREATE_THREAD_SCAN_CHUNK_BYTES - 8;
    let source_len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 16;
    let mut source = vec![0u8; source_len];
    source[target_len..].fill(0x3c);
    let target = source[..target_len].to_vec();

    fs::write(&source_path, &source).expect("source fixture");
    fs::write(&target_path, &target).expect("target fixture");

    let handler = UpsPatchHandler::new(&UPS);
    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "UPS".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");
    assert!(
        create_report
            .thread_execution
            .expect("thread execution")
            .used_parallelism
    );

    let parsed = parse_ups_bytes(&fs::read(&patch_path).expect("patch bytes")).expect("parse");
    assert_eq!(parsed.changes.len(), 1);
    assert_eq!(parsed.changes[0].offset, target_len as u64);
    assert_eq!(parsed.changes[0].xor_bytes.len(), source_len - target_len);
    assert!(parsed.changes[0].xor_bytes.iter().all(|byte| *byte == 0x3c));

    handler
        .apply(
            &PatchApplyRequest {
                input: target_path,
                patches: vec![patch_path],
                output: reverse_output_path.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("reverse apply");
    assert_eq!(
        fs::read(reverse_output_path).expect("reverse output"),
        source
    );
}

#[test]
fn create_merges_change_that_crosses_thread_chunk_boundary() {
    let temp = TestDir::new();
    let source_path = temp.child("source-boundary.bin");
    let target_path = temp.child("target-boundary.bin");
    let patch_path = temp.child("boundary.ups");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 32;
    let source = vec![0u8; len];
    let mut target = source.clone();
    let run_start = super::CREATE_THREAD_SCAN_CHUNK_BYTES - 6;
    let run_len = 18usize;
    target[run_start..run_start + run_len].fill(0x7f);

    fs::write(&source_path, &source).expect("source fixture");
    fs::write(&target_path, &target).expect("target fixture");

    let handler = UpsPatchHandler::new(&UPS);
    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path,
                modified: target_path,
                output: patch_path.clone(),
                format: "UPS".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");

    assert!(
        create_report
            .thread_execution
            .expect("thread execution")
            .used_parallelism
    );

    let parsed = parse_ups_bytes(&fs::read(patch_path).expect("patch bytes")).expect("parse");
    assert_eq!(parsed.changes.len(), 1);
    assert_eq!(parsed.changes[0].offset, run_start as u64);
    assert_eq!(parsed.changes[0].xor_bytes.len(), run_len);
    assert!(parsed.changes[0].xor_bytes.iter().all(|byte| *byte == 0x7f));
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let source_path = temp.child("source-large.bin");
    let target_path = temp.child("target-large.bin");
    let single_patch = temp.child("single.ups");
    let parallel_patch = temp.child("parallel.ups");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 64 * 1024;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 19 + (index >> 3)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(8191) {
        target[index] ^= 0x5a;
    }

    fs::write(&source_path, &source).expect("source fixture");
    fs::write(&target_path, &target).expect("target fixture");

    let handler = UpsPatchHandler::new(&UPS);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: single_patch.clone(),
                format: "UPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single-thread create");
    let parallel_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path,
                modified: target_path,
                output: parallel_patch.clone(),
                format: "UPS".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("parallel-thread create");

    assert!(
        parallel_report
            .thread_execution
            .expect("parallel execution")
            .used_parallelism
    );
    assert!(
        !single_report
            .thread_execution
            .expect("single execution")
            .used_parallelism
    );

    assert_eq!(
        fs::read(single_patch).expect("single patch"),
        fs::read(parallel_patch).expect("parallel patch")
    );
}

#[test]
fn apply_runtime_threads_match_capabilities_for_multi_record_patch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.ups");
    let output_path = temp.child("output.bin");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 128 * 1024;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 11 + (index >> 1)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(4093) {
        target[index] ^= 0x5a;
    }

    fs::write(&source_path, &source).expect("source fixture");
    fs::write(&target_path, &target).expect("target fixture");

    let handler = UpsPatchHandler::new(&UPS);
    let capabilities = handler.capabilities();
    assert!(capabilities.threaded_output);

    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "ups".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");

    let apply_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");

    let execution = apply_report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 8);
    assert!(execution.used_parallelism);
    assert_eq!(fs::read(output_path).expect("output"), target);
}
