use std::fs;

use rom_weaver_core::{
    PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
};

use super::{CREATE_SCAN_CHUNK_BYTES, PmsrPatchHandler, create_pmsr_patch_bytes, parse_pmsr_bytes};
use crate::{
    MOD,
    test_support::{
        RoundTripCase, TestDir, assert_round_trip, report_endpoints, test_context_with_threads,
    },
};

#[test]
fn parse_rejects_invalid_header() {
    let mut bytes = vec![0u8; super::PMSR_HEADER_SIZE];
    bytes[..4].copy_from_slice(b"BAD!");
    let error = parse_pmsr_bytes(&bytes).expect_err("invalid header");
    assert!(error.to_string().contains("Patch header invalid"));
}

#[test]
fn parse_report_includes_expected_crc32() {
    let temp = TestDir::new();
    let patch_path = temp.child("update.mod");
    let mut patch = Vec::new();
    patch.extend_from_slice(b"PMSR");
    patch.extend_from_slice(&0u32.to_be_bytes());
    fs::write(&patch_path, patch).expect("fixture");

    let handler = PmsrPatchHandler::new(&MOD);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");
    assert!(report.label.contains("CRC32 0xA7F5CD7E"));
}

#[test]
fn parse_reports_normalized_source_endpoint() {
    let temp = TestDir::new();
    let patch_path = temp.child("update.mod");
    let mut patch = Vec::new();
    patch.extend_from_slice(b"PMSR");
    patch.extend_from_slice(&0u32.to_be_bytes());
    fs::write(&patch_path, patch).expect("fixture");

    let handler = PmsrPatchHandler::new(&MOD);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");

    let endpoints = report_endpoints(&report);
    assert_eq!(endpoints.len(), 1);
    assert_eq!(
        endpoints[0]["input"]["checksums"]["crc32"].as_str(),
        Some("a7f5cd7e")
    );
    assert_eq!(endpoints[0]["input"]["size"].as_u64(), Some(41_943_040));
    // A record-less patch grows nothing: no output bound is reported.
    assert!(
        endpoints[0]["output"]
            .as_object()
            .expect("output")
            .is_empty()
    );
}

#[test]
fn apply_supports_minimal_mod_patch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("update.mod");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"ORIGINAL").expect("fixture");

    let mut patch = Vec::new();
    patch.extend_from_slice(b"PMSR");
    patch.extend_from_slice(&1u32.to_be_bytes());
    patch.extend_from_slice(&1u32.to_be_bytes());
    patch.extend_from_slice(&1u32.to_be_bytes());
    patch.push(b'X');
    fs::write(&patch_path, patch).expect("fixture");

    let handler = PmsrPatchHandler::new(&MOD);
    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), b"OXIGINAL");
}

#[test]
fn create_and_apply_round_trip_with_growth() {
    let handler = PmsrPatchHandler::new(&MOD);
    assert_round_trip(
        &handler,
        &RoundTripCase {
            patch_extension: "mod",
            create_threads: 4,
            apply_threads: 1,
            apply_checksum_validation: Some(PatchChecksumValidation::Ignore),
            ..RoundTripCase::new(b"\x01\x02", b"\x01\x02\x00\x00", "MOD")
        },
    );
}

#[test]
fn create_uses_parallel_threads_for_large_input() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.mod");
    let output_path = temp.child("output.bin");

    let len = CREATE_SCAN_CHUNK_BYTES + 64;
    let source = vec![0u8; len];
    let mut target = source.clone();
    target[CREATE_SCAN_CHUNK_BYTES - 16..CREATE_SCAN_CHUNK_BYTES + 16].fill(0x5A);
    fs::write(&source_path, &source).expect("fixture");
    fs::write(&target_path, &target).expect("fixture");

    let handler = PmsrPatchHandler::new(&MOD);
    let report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "MOD".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");
    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 2);
    assert!(execution.used_parallelism);

    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("apply");
    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_uses_parallel_threads_for_non_overlapping_records() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.mod");
    let output_path = temp.child("output.bin");

    let len = 512 * 1024 + 13;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 9 + (index >> 1)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(701) {
        target[index] ^= 0x5A;
    }

    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let handler = PmsrPatchHandler::new(&MOD);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path,
                output: patch_path.clone(),
                format: "MOD".into(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("create");

    let report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("apply");
    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    // apply streams by default; non-overlapping records parallelize (matches the name)
    assert!(execution.used_parallelism);
    assert!(execution.effective_threads > 1);
    assert!(!execution.thread_fallback);
    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_falls_back_to_single_thread_when_records_overlap() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("overlap.mod");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"abcd").expect("source");
    let mut patch = Vec::new();
    patch.extend_from_slice(b"PMSR");
    patch.extend_from_slice(&2u32.to_be_bytes());
    patch.extend_from_slice(&1u32.to_be_bytes());
    patch.extend_from_slice(&2u32.to_be_bytes());
    patch.extend_from_slice(b"XY");
    patch.extend_from_slice(&2u32.to_be_bytes());
    patch.extend_from_slice(&2u32.to_be_bytes());
    patch.extend_from_slice(b"ZZ");
    fs::write(&patch_path, patch).expect("patch");

    let handler = PmsrPatchHandler::new(&MOD);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("apply");
    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert!(!execution.used_parallelism);
    assert_eq!(execution.effective_threads, 1);
    assert_eq!(fs::read(output_path).expect("output"), b"aXZZ");
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let single_patch = temp.child("single.mod");
    let parallel_patch = temp.child("parallel.mod");

    let len = CREATE_SCAN_CHUNK_BYTES + 64;
    let source = vec![0u8; len];
    let mut target = source.clone();
    target[CREATE_SCAN_CHUNK_BYTES - 16..CREATE_SCAN_CHUNK_BYTES + 16].fill(0x5A);
    fs::write(&source_path, &source).expect("fixture");
    fs::write(&target_path, &target).expect("fixture");

    let handler = PmsrPatchHandler::new(&MOD);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: single_patch.clone(),
                format: "MOD".into(),
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
                format: "MOD".into(),
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

#[test]
fn create_rejects_shrinking_outputs() {
    let source = b"\x01\x02\x03\x04";
    let target = b"\x01\x02\x03";
    let error = create_pmsr_patch_bytes(source, target).expect_err("shrinking output");
    assert!(
        error
            .to_string()
            .contains("MOD create does not support shrinking outputs")
    );
}

#[test]
fn apply_strict_rejects_non_paper_mario_source() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("update.mod");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"ORIGINAL").expect("fixture");
    let mut patch = Vec::new();
    patch.extend_from_slice(b"PMSR");
    patch.extend_from_slice(&0u32.to_be_bytes());
    fs::write(&patch_path, patch).expect("fixture");

    let handler = PmsrPatchHandler::new(&MOD);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Strict),
        )
        .expect_err("strict validation should fail");
    assert!(error.to_string().contains("Source ROM checksum mismatch"));
}
