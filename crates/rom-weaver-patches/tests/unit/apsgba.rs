/* jscpd:ignore-start */
use std::fs;

use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

use super::{ApsGbaPatchHandler, create_apsgba_patch_bytes, parse_apsgba_bytes};
use crate::{
    APSGBA,
    test_support::{TestDir, test_context_with_threads},
};

#[test]
fn parse_rejects_invalid_header() {
    let mut bytes = vec![0u8; super::APS_GBA_HEADER_SIZE + super::APS_GBA_RECORD_SIZE];
    bytes[..4].copy_from_slice(b"BAD!");
    let error = parse_apsgba_bytes(&bytes).expect_err("invalid header");
    assert!(error.to_string().contains("Patch header invalid"));
}

#[test]
fn create_and_apply_round_trip() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let target_path = temp.child("target.gba");
    let patch_path = temp.child("update.apsgba");
    let output_path = temp.child("output.gba");

    let source = build_source_bytes(super::APS_GBA_BLOCK_SIZE + 8192);
    let mut target = source.clone();
    target[0x1234] ^= 0xff;
    target[0x8000] = 0x5a;
    target[super::APS_GBA_BLOCK_SIZE + 127] ^= 0x11;

    fs::write(&source_path, &source).expect("fixture");
    fs::write(&target_path, &target).expect("fixture");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "APSGBA".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");

    let execution = create_report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert!(execution.used_parallelism);
    assert!(execution.effective_threads > 1);

    let apply_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");
    let apply_execution = apply_report.thread_execution.expect("thread execution");
    // apply streams by default; this multi-record patch parallelizes
    assert!(apply_execution.used_parallelism);
    assert!(apply_execution.effective_threads > 1);

    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let patch_path = temp.child("update.apsgba");
    let output_single = temp.child("output-single.gba");
    let output_parallel = temp.child("output-parallel.gba");

    let source = build_source_bytes((super::APS_GBA_BLOCK_SIZE * 2) + 4096);
    let mut target = source.clone();
    target[0x120] ^= 0x5a;
    target[super::APS_GBA_BLOCK_SIZE + 33] ^= 0xa5;

    fs::write(&source_path, &source).expect("fixture");
    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    assert_eq!(created.record_count, 2);
    fs::write(&patch_path, created.bytes).expect("patch");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let single_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_single.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single apply");
    let parallel_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_parallel.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("parallel apply");

    // single-thread budget stays serial; the parallel budget now streams in parallel
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
    assert_eq!(fs::read(&output_single).expect("single"), target);
    assert_eq!(fs::read(&output_parallel).expect("parallel"), target);
    assert_eq!(
        fs::read(output_single).expect("single"),
        fs::read(output_parallel).expect("parallel")
    );
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let target_path = temp.child("target.gba");
    let patch_single = temp.child("single.apsgba");
    let patch_parallel = temp.child("parallel.apsgba");

    let source = build_source_bytes((super::APS_GBA_BLOCK_SIZE * 3) + 4096);
    let mut target = source.clone();
    target[0x101] ^= 0x31;
    target[super::APS_GBA_BLOCK_SIZE + 257] ^= 0x72;
    target[(super::APS_GBA_BLOCK_SIZE * 2) + 33] ^= 0xA4;

    fs::write(&source_path, &source).expect("fixture");
    fs::write(&target_path, &target).expect("fixture");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_single.clone(),
                format: "APSGBA".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single-thread create");
    let parallel_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path,
                modified: target_path,
                output: patch_parallel.clone(),
                format: "APSGBA".into(),
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
        fs::read(patch_single).expect("single patch"),
        fs::read(patch_parallel).expect("parallel patch")
    );
}

#[test]
fn apply_rejects_source_checksum_mismatch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let target_path = temp.child("target.gba");
    let patch_path = temp.child("update.apsgba");
    let output_path = temp.child("output.gba");

    let source = build_source_bytes(super::APS_GBA_BLOCK_SIZE);
    let mut target = source.clone();
    target[0x101] ^= 0x55;

    fs::write(&source_path, &source).expect("fixture");
    fs::write(&target_path, &target).expect("fixture");

    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    let mut patch_bytes = created.bytes;
    let source_crc_offset = super::APS_GBA_HEADER_SIZE + 4;
    patch_bytes[source_crc_offset] ^= 0x01;
    fs::write(&patch_path, patch_bytes).expect("patch");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("checksum mismatch");

    assert!(error.to_string().contains("Source checksum invalid"));
}

#[test]
fn apply_reports_same_checksum_error_in_parallel_and_single_thread_modes() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let patch_path = temp.child("update.apsgba");
    let output_single = temp.child("output-single.gba");
    let output_parallel = temp.child("output-parallel.gba");

    let source = build_source_bytes((super::APS_GBA_BLOCK_SIZE * 2) + 256);
    let mut target = source.clone();
    target[0x200] ^= 0x44;
    target[super::APS_GBA_BLOCK_SIZE + 10] ^= 0x11;

    fs::write(&source_path, &source).expect("fixture");
    let mut patch_bytes = create_apsgba_patch_bytes(&source, &target)
        .expect("create bytes")
        .bytes;
    let source_crc_offset = super::APS_GBA_HEADER_SIZE + 4;
    patch_bytes[source_crc_offset] ^= 0x01;
    fs::write(&patch_path, patch_bytes).expect("patch");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let single_error = handler
        .apply(
            &PatchApplyRequest {
                input: source_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_single,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("single apply should fail");
    let parallel_error = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_parallel,
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect_err("parallel apply should fail");

    let single_message = single_error.to_string();
    let parallel_message = parallel_error.to_string();
    assert!(single_message.contains("Source checksum invalid"));
    assert_eq!(single_message, parallel_message);
}

fn build_source_bytes(size: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; size];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = ((index * 17 + (index >> 5)) & 0xff) as u8;
    }
    bytes
}
/* jscpd:ignore-end */
