use std::fs;

use rom_weaver_core::{
    PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
};

use super::{
    RUP_COMMAND_OPEN_NEW_FILE, RupFile, RupMetadata, RupPatchHandler, create_rup_patch_bytes,
    encode_rup_patch, format_md5_hex, md5_bytes, parse_rup_bytes,
};
use crate::{
    RUP,
    test_support::{TestDir, test_context_with_threads},
};

#[test]
fn parse_rejects_invalid_magic() {
    let mut bytes = create_rup_patch_bytes(b"source", b"target")
        .expect("patch")
        .bytes;
    bytes[0] ^= 0x01;

    let error = parse_rup_bytes(&bytes).expect_err("invalid magic should fail");
    assert!(error.to_string().contains("Patch header invalid"));
}

#[test]
fn parse_rejects_invalid_overflow_mode() {
    let mut bytes = create_rup_patch_bytes(b"short", b"this-is-longer")
        .expect("patch")
        .bytes;

    let command_offset = bytes
        .iter()
        .position(|byte| *byte == RUP_COMMAND_OPEN_NEW_FILE)
        .expect("open command");

    let mut cursor = command_offset + 1;

    let name_len = usize::from(bytes[cursor]);
    cursor += 1 + name_len;
    cursor += 1;

    let source_size_len = usize::from(bytes[cursor]);
    cursor += 1 + source_size_len;

    let target_size_len = usize::from(bytes[cursor]);
    cursor += 1 + target_size_len;

    cursor += 32;
    bytes[cursor] = b'Z';

    let error = parse_rup_bytes(&bytes).expect_err("invalid overflow mode should fail");
    assert!(error.to_string().contains("invalid overflow mode"));
}

#[test]
fn parse_reports_md5_for_each_variant() {
    let temp = TestDir::new();
    let patch_path = temp.child("multi-variant.rup");
    let source_md5_a = md5_bytes(b"source-a");
    let target_md5_a = md5_bytes(b"target-a");
    let source_md5_b = md5_bytes(b"source-b");
    let target_md5_b = md5_bytes(b"target-b");
    let patch = encode_rup_patch(
        &RupMetadata::default(),
        &[
            RupFile {
                file_name: "variant-a.bin".to_string(),
                rom_type: 0,
                source_file_size: 8,
                target_file_size: 8,
                source_md5: source_md5_a,
                target_md5: target_md5_a,
                overflow_mode: None,
                overflow_data: Vec::new(),
                records: Vec::new(),
            },
            RupFile {
                file_name: "variant-b.bin".to_string(),
                rom_type: 0,
                source_file_size: 8,
                target_file_size: 8,
                source_md5: source_md5_b,
                target_md5: target_md5_b,
                overflow_mode: None,
                overflow_data: Vec::new(),
                records: Vec::new(),
            },
        ],
    )
    .expect("patch");
    fs::write(&patch_path, patch).expect("fixture");

    let handler = RupPatchHandler::new(&RUP);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse report");

    assert!(report.label.contains(&format!(
        "variant 1 source md5 {}; target md5 {}",
        format_md5_hex(source_md5_a),
        format_md5_hex(target_md5_a)
    )));
    assert!(report.label.contains(&format!(
        "variant 2 source md5 {}; target md5 {}",
        format_md5_hex(source_md5_b),
        format_md5_hex(target_md5_b)
    )));
}

#[test]
fn create_and_apply_round_trip_with_append_overflow() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.rup");
    let output_path = temp.child("output.bin");
    let reverse_path = temp.child("reverse.bin");

    let source = b"abcabcabcabc";
    let target = b"abcabcZZabcabcTAIL";
    fs::write(&source_path, source).expect("source");
    fs::write(&target_path, target).expect("target");

    let handler = RupPatchHandler::new(&RUP);
    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "RUP".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");

    let execution = create_report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);

    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");

    assert_eq!(fs::read(&output_path).expect("output"), target);

    handler
        .apply(
            &PatchApplyRequest {
                input: output_path,
                patches: vec![patch_path],
                output: reverse_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("undo");

    assert_eq!(fs::read(reverse_path).expect("reverse"), source);
}

#[test]
fn create_and_apply_round_trip_with_minify_overflow() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.rup");
    let output_path = temp.child("output.bin");

    let source = b"long-source-with-tail";
    let target = b"long-source";
    fs::write(&source_path, source).expect("source");
    fs::write(&target_path, target).expect("target");

    let handler = RupPatchHandler::new(&RUP);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "RUP".into(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("create");

    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_rejects_input_that_matches_neither_source_nor_target() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.rup");
    let wrong_path = temp.child("wrong.bin");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"source bytes").expect("source");
    fs::write(&target_path, b"target bytes").expect("target");
    fs::write(&wrong_path, b"not matching md5").expect("wrong");

    let handler = RupPatchHandler::new(&RUP);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path,
                modified: target_path,
                output: patch_path.clone(),
                format: "RUP".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let error = handler
        .apply(
            &PatchApplyRequest {
                input: wrong_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("expected mismatch");

    assert!(error.to_string().contains("RUP input validation failed"));
}

#[test]
fn apply_uses_source_bytes_for_each_record_even_when_records_overlap() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("overlap.rup");
    let output_path = temp.child("output.bin");

    let source = vec![0u8; 8];
    let target = vec![0u8, 1, 2, 2, 0, 0, 0, 0];
    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let mut patch = create_rup_patch_bytes(&source, &target)
        .expect("patch")
        .bytes;

    let command_offset = patch
        .iter()
        .position(|byte| *byte == RUP_COMMAND_OPEN_NEW_FILE)
        .expect("open command");
    let mut cursor = command_offset + 1;

    let name_len = usize::from(patch[cursor]);
    cursor += 1 + name_len;
    cursor += 1;

    let source_size_len = usize::from(patch[cursor]);
    cursor += 1 + source_size_len;

    let target_size_len = usize::from(patch[cursor]);
    cursor += 1 + target_size_len;

    cursor += 32;

    patch.truncate(cursor);
    patch.push(0x02);
    patch.extend_from_slice(&[0x01, 0x01, 0x01, 0x02, 0x01, 0x01]);
    patch.push(0x02);
    patch.extend_from_slice(&[0x01, 0x02, 0x01, 0x02, 0x02, 0x02]);
    patch.push(0x00);

    fs::write(&patch_path, &patch).expect("patch file");

    let handler = RupPatchHandler::new(&RUP);
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
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_is_deterministic_across_thread_budgets_for_overlapping_records() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("overlap.rup");
    let output_single = temp.child("output-single.bin");
    let output_parallel = temp.child("output-parallel.bin");

    let source = vec![0u8; 8];
    let target = vec![0u8, 1, 2, 2, 0, 0, 0, 0];
    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let mut patch = create_rup_patch_bytes(&source, &target)
        .expect("patch")
        .bytes;
    let command_offset = patch
        .iter()
        .position(|byte| *byte == RUP_COMMAND_OPEN_NEW_FILE)
        .expect("open command");
    let mut cursor = command_offset + 1;
    let name_len = usize::from(patch[cursor]);
    cursor += 1 + name_len;
    cursor += 1;
    let source_size_len = usize::from(patch[cursor]);
    cursor += 1 + source_size_len;
    let target_size_len = usize::from(patch[cursor]);
    cursor += 1 + target_size_len;
    cursor += 32;
    patch.truncate(cursor);
    patch.push(0x02);
    patch.extend_from_slice(&[0x01, 0x01, 0x01, 0x02, 0x01, 0x01]);
    patch.push(0x02);
    patch.extend_from_slice(&[0x01, 0x02, 0x01, 0x02, 0x02, 0x02]);
    patch.push(0x00);
    fs::write(&patch_path, &patch).expect("patch file");

    let handler = RupPatchHandler::new(&RUP);
    let single_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_single.clone(),
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("single apply");
    let parallel_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_parallel.clone(),
            },
            &test_context_with_threads(&temp, 8)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("parallel apply");

    assert!(
        !single_report
            .thread_execution
            .expect("single execution")
            .used_parallelism
    );
    assert!(
        parallel_report
            .thread_execution
            .expect("parallel execution")
            .used_parallelism
    );
    assert_eq!(
        fs::read(output_single).expect("single output"),
        fs::read(output_parallel).expect("parallel output")
    );
}

#[test]
fn apply_runtime_threads_match_capabilities_for_multi_record_patch() {
    let temp = TestDir::new();
    let source_path = temp.child("source-large.bin");
    let target_path = temp.child("target-large.bin");
    let patch_path = temp.child("update.rup");
    let output_path = temp.child("output.bin");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 128 * 1024;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 23 + (index >> 4)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(6143) {
        target[index] ^= 0x44;
    }
    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let handler = RupPatchHandler::new(&RUP);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path,
                output: patch_path.clone(),
                format: "RUP".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let capabilities = handler.capabilities();
    let apply_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");
    let execution = apply_report.thread_execution.expect("thread execution");
    assert!(capabilities.threaded_output);
    assert_eq!(execution.requested_threads, 8);
    assert!(execution.used_parallelism);
}

#[test]
fn create_merges_record_that_crosses_thread_chunk_boundary() {
    let temp = TestDir::new();
    let source_path = temp.child("source-boundary.bin");
    let target_path = temp.child("target-boundary.bin");
    let patch_path = temp.child("boundary.rup");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 64;
    let source = vec![0x33u8; len];
    let mut target = source.clone();
    let run_start = super::CREATE_THREAD_SCAN_CHUNK_BYTES - 9;
    let run_len = 23usize;
    target[run_start..run_start + run_len].fill(0xcc);

    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let handler = RupPatchHandler::new(&RUP);
    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path,
                modified: target_path,
                output: patch_path.clone(),
                format: "RUP".into(),
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

    let parsed = parse_rup_bytes(&fs::read(patch_path).expect("patch bytes")).expect("parse");
    assert_eq!(parsed.files.len(), 1);
    assert_eq!(parsed.files[0].records.len(), 1);
    assert_eq!(parsed.files[0].records[0].offset, run_start as u64);
    assert_eq!(parsed.files[0].records[0].xor.len(), run_len);
    assert!(
        parsed.files[0].records[0]
            .xor
            .iter()
            .all(|byte| *byte == 0xff)
    );
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let source_path = temp.child("source-large.bin");
    let target_path = temp.child("target-large.bin");
    let single_patch = temp.child("single.rup");
    let parallel_patch = temp.child("parallel.rup");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 128 * 1024;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 23 + (index >> 4)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(6143) {
        target[index] ^= 0x44;
    }

    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let handler = RupPatchHandler::new(&RUP);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: single_patch.clone(),
                format: "RUP".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single create");
    let parallel_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path,
                modified: target_path,
                output: parallel_patch.clone(),
                format: "RUP".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("parallel create");

    assert!(
        !single_report
            .thread_execution
            .expect("single execution")
            .used_parallelism
    );
    assert!(
        parallel_report
            .thread_execution
            .expect("parallel execution")
            .used_parallelism
    );

    assert_eq!(
        fs::read(single_patch).expect("single patch"),
        fs::read(parallel_patch).expect("parallel patch")
    );
}
