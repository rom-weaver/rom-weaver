use std::fs;

use rom_weaver_core::{
    PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
    PatchValidateRequest, ProbeConfidence,
};

use super::{ApsGbaPatchHandler, create_apsgba_patch_bytes, parse_apsgba_bytes};
use crate::{
    APSGBA,
    test_support::{TestDir, report_endpoints, test_context_with_threads},
};

#[test]
fn parse_reports_normalized_size_endpoints() {
    let temp = TestDir::new();
    let patch_path = temp.child("probe.aps");
    let created = create_apsgba_patch_bytes(b"abcdefgh", b"abcdefghij").expect("patch");
    fs::write(&patch_path, created.bytes).expect("fixture");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");

    let endpoints = report_endpoints(&report);
    assert_eq!(endpoints.len(), 1);
    assert_eq!(endpoints[0]["input"]["size"].as_u64(), Some(8));
    assert_eq!(endpoints[0]["output"]["size"].as_u64(), Some(10));
    // Per-block CRC16s are not whole-file identifiers.
    assert!(endpoints[0]["input"].get("checksums").is_none());
    assert!(endpoints[0]["output"].get("checksums").is_none());
}

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
    // The test context forces streaming apply; this multi-record patch parallelizes
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

/// Fixture pair whose target differs from the source in three blocks, so the
/// created patch carries more than one record.
fn multi_record_fixture() -> (Vec<u8>, Vec<u8>) {
    let source = build_source_bytes(super::APS_GBA_BLOCK_SIZE + 8192);
    let mut target = source.clone();
    target[0x1234] ^= 0xff;
    target[0x8000] = 0x5a;
    target[super::APS_GBA_BLOCK_SIZE + 127] ^= 0x11;
    (source, target)
}

#[test]
fn probe_reports_extension_confidence() {
    let handler = ApsGbaPatchHandler::new(&APSGBA);
    assert!(matches!(
        handler.probe(std::path::Path::new("update.aps")),
        ProbeConfidence::Extension
    ));
}

#[test]
fn capabilities_report_a_threaded_create() {
    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let capabilities = handler.capabilities();
    assert!(capabilities.create);
}

#[test]
fn apply_in_memory_matches_the_streaming_output() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let patch_path = temp.child("update.apsgba");
    let streamed_path = temp.child("streamed.gba");
    let in_memory_path = temp.child("in-memory.gba");

    let (source, target) = multi_record_fixture();
    fs::write(&source_path, &source).expect("fixture");
    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    fs::write(&patch_path, &created.bytes).expect("patch");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    handler
        .apply(
            &PatchApplyRequest {
                input: source_path.clone(),
                patches: vec![patch_path.clone()],
                output: streamed_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("streaming apply");

    let report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: in_memory_path.clone(),
            },
            &test_context_with_threads(&temp, 4).with_patch_apply_in_memory_limit(1 << 24),
        )
        .expect("in-memory apply");

    // The in-memory path writes the whole output at once, so it always reports
    // serial execution however many threads the budget offered.
    let execution = report.thread_execution.expect("thread execution");
    assert!(!execution.used_parallelism);
    assert_eq!(execution.effective_threads, 1);

    let streamed = fs::read(streamed_path).expect("streamed output");
    assert_eq!(streamed, target);
    assert_eq!(
        fs::read(in_memory_path).expect("in-memory output"),
        streamed
    );
}

#[test]
fn apply_in_memory_rejects_a_source_checksum_mismatch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let patch_path = temp.child("update.apsgba");
    let output_path = temp.child("output.gba");

    let source = build_source_bytes(super::APS_GBA_BLOCK_SIZE);
    let mut target = source.clone();
    target[0x101] ^= 0x55;
    fs::write(&source_path, &source).expect("fixture");

    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    let mut patch_bytes = created.bytes;
    patch_bytes[super::APS_GBA_HEADER_SIZE + 4] ^= 0x01;
    fs::write(&patch_path, patch_bytes).expect("patch");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1).with_patch_apply_in_memory_limit(1 << 24),
        )
        .expect_err("in-memory apply must reject a bad source crc16");
    assert!(error.to_string().contains("Source checksum invalid"));
}

#[test]
fn apply_in_memory_rejects_a_target_checksum_mismatch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let patch_path = temp.child("update.apsgba");
    let output_path = temp.child("output.gba");

    let source = build_source_bytes(super::APS_GBA_BLOCK_SIZE);
    let mut target = source.clone();
    target[0x101] ^= 0x55;
    fs::write(&source_path, &source).expect("fixture");

    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    let mut patch_bytes = created.bytes;
    // The target crc16 sits two bytes past the source crc16 in the record header.
    patch_bytes[super::APS_GBA_HEADER_SIZE + 6] ^= 0x01;
    fs::write(&patch_path, patch_bytes).expect("patch");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1).with_patch_apply_in_memory_limit(1 << 24),
        )
        .expect_err("in-memory apply must reject a bad target crc16");
    assert!(error.to_string().contains("Target checksum invalid"));
}

#[test]
fn apply_rejects_an_input_size_mismatch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let patch_path = temp.child("update.apsgba");
    let output_path = temp.child("output.gba");

    let (source, target) = multi_record_fixture();
    // One byte short of the size the patch header declares.
    fs::write(&source_path, &source[..source.len() - 1]).expect("fixture");
    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    fs::write(&patch_path, &created.bytes).expect("patch");

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
        .expect_err("a short input must be rejected");
    assert!(error.to_string().contains("APSGBA input size invalid"));
}

#[test]
fn validate_accepts_a_matching_source() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let patch_path = temp.child("update.apsgba");

    let (source, target) = multi_record_fixture();
    fs::write(&source_path, &source).expect("fixture");
    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    fs::write(&patch_path, &created.bytes).expect("patch");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let report = handler
        .validate(
            &PatchValidateRequest {
                input: source_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("validate");
    assert_eq!(report.stage, "validate");
    assert!(report.label.contains("validated APSGBA patch source"));
    assert!(report.label.contains("record(s)"));
}

#[test]
fn validate_rejects_a_source_checksum_mismatch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let patch_path = temp.child("update.apsgba");

    let source = build_source_bytes(super::APS_GBA_BLOCK_SIZE);
    let mut target = source.clone();
    target[0x101] ^= 0x55;
    fs::write(&source_path, &source).expect("fixture");

    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    let mut patch_bytes = created.bytes;
    patch_bytes[super::APS_GBA_HEADER_SIZE + 4] ^= 0x01;
    fs::write(&patch_path, patch_bytes).expect("patch");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let error = handler
        .validate(
            &PatchValidateRequest {
                input: source_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("validate must reject a bad source crc16");
    assert!(error.to_string().contains("Source checksum invalid"));
}

#[test]
fn validate_rejects_an_input_size_mismatch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let patch_path = temp.child("update.apsgba");

    let (source, target) = multi_record_fixture();
    fs::write(&source_path, &source[..source.len() - 1]).expect("fixture");
    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    fs::write(&patch_path, &created.bytes).expect("patch");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let error = handler
        .validate(
            &PatchValidateRequest {
                input: source_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("a short input must be rejected");
    assert!(error.to_string().contains("APSGBA input size invalid"));
}

#[test]
fn parse_apsgba_bytes_round_trips_a_created_patch() {
    let (source, target) = multi_record_fixture();
    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    let parsed = parse_apsgba_bytes(&created.bytes).expect("parse bytes");

    assert_eq!(parsed.source_size as usize, source.len());
    assert_eq!(parsed.target_size as usize, target.len());
    assert_eq!(parsed.records.len(), created.record_count);
    assert!(
        parsed
            .records
            .iter()
            .all(|record| record.xor_bytes.len() == super::APS_GBA_BLOCK_SIZE)
    );
}

#[test]
fn parse_apsgba_bytes_rejects_truncated_and_misaligned_input() {
    let short_header = parse_apsgba_bytes(&[0u8; 4]).expect_err("a short header must be rejected");
    assert!(
        short_header
            .to_string()
            .contains("too small to contain a valid header")
    );

    let mut no_record = vec![0u8; super::APS_GBA_HEADER_SIZE];
    no_record[..4].copy_from_slice(b"APS1");
    let error = parse_apsgba_bytes(&no_record).expect_err("a record-free patch must be rejected");
    assert!(
        error
            .to_string()
            .contains("too small to contain at least one record")
    );

    let mut misaligned = vec![0u8; super::APS_GBA_HEADER_SIZE + super::APS_GBA_RECORD_SIZE + 1];
    misaligned[..4].copy_from_slice(b"APS1");
    let error =
        parse_apsgba_bytes(&misaligned).expect_err("a partial trailing record must be rejected");
    assert!(error.to_string().contains("invalid record payload length"));
}

#[test]
fn parse_apsgba_file_rejects_truncated_misaligned_and_unlabelled_patches() {
    let temp = TestDir::new();
    let handler = ApsGbaPatchHandler::new(&APSGBA);
    let context = test_context_with_threads(&temp, 1);

    let short_header = temp.child("short-header.aps");
    fs::write(&short_header, [0u8; 4]).expect("fixture");
    let error = handler
        .parse(&short_header, &context)
        .expect_err("a short header must be rejected");
    assert!(
        error
            .to_string()
            .contains("too small to contain a valid header")
    );

    let no_record = temp.child("no-record.aps");
    fs::write(&no_record, [0u8; super::APS_GBA_HEADER_SIZE]).expect("fixture");
    let error = handler
        .parse(&no_record, &context)
        .expect_err("a record-free patch must be rejected");
    assert!(
        error
            .to_string()
            .contains("too small to contain at least one record")
    );

    let misaligned = temp.child("misaligned.aps");
    fs::write(
        &misaligned,
        vec![0u8; super::APS_GBA_HEADER_SIZE + super::APS_GBA_RECORD_SIZE + 1],
    )
    .expect("fixture");
    let error = handler
        .parse(&misaligned, &context)
        .expect_err("a partial trailing record must be rejected");
    assert!(error.to_string().contains("invalid record payload length"));

    let bad_magic = temp.child("bad-magic.aps");
    let mut bytes = vec![0u8; super::APS_GBA_HEADER_SIZE + super::APS_GBA_RECORD_SIZE];
    bytes[..4].copy_from_slice(b"BAD!");
    fs::write(&bad_magic, bytes).expect("fixture");
    let error = handler
        .parse(&bad_magic, &context)
        .expect_err("a bad magic must be rejected");
    assert!(error.to_string().contains("Patch header invalid"));
}

#[test]
fn create_emits_one_empty_record_when_the_files_match() {
    let source = build_source_bytes(1024);
    let created = create_apsgba_patch_bytes(&source, &source).expect("create bytes");
    assert_eq!(created.record_count, 1);

    let parsed = parse_apsgba_bytes(&created.bytes).expect("parse bytes");
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].offset, 0);
    assert!(
        parsed.records[0].xor_bytes.iter().all(|byte| *byte == 0),
        "an unchanged file must produce an all-zero xor record"
    );
}

#[test]
fn apply_streaming_rejects_a_target_checksum_mismatch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let patch_path = temp.child("update.apsgba");
    let output_path = temp.child("output.gba");

    let source = build_source_bytes(super::APS_GBA_BLOCK_SIZE);
    let mut target = source.clone();
    target[0x101] ^= 0x55;
    fs::write(&source_path, &source).expect("fixture");

    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    let mut patch_bytes = created.bytes;
    // The target crc16 sits two bytes past the source crc16 in the record header.
    patch_bytes[super::APS_GBA_HEADER_SIZE + 6] ^= 0x01;
    fs::write(&patch_path, patch_bytes).expect("patch");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    for threads in [1usize, 4] {
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, threads),
            )
            .expect_err("a bad target crc16 must be rejected");
        assert!(
            error.to_string().contains("Target checksum invalid"),
            "unexpected error at {threads} thread(s): {error}"
        );
    }
}

#[test]
fn apply_in_memory_zero_fills_output_past_the_end_of_the_source() {
    let temp = TestDir::new();
    let source_path = temp.child("grow-source.gba");
    let patch_path = temp.child("grow.apsgba");
    let output_path = temp.child("grow-output.gba");

    // The target adds a second block, so the trailing record has no source
    // bytes to xor against past the end of the first.
    let source = build_source_bytes(super::APS_GBA_BLOCK_SIZE + 4096);
    let mut target = source.clone();
    target.resize(2 * super::APS_GBA_BLOCK_SIZE, 0);
    for (index, byte) in target
        .iter_mut()
        .enumerate()
        .skip(super::APS_GBA_BLOCK_SIZE + 4096)
    {
        *byte = (index % 211) as u8;
    }

    fs::write(&source_path, &source).expect("fixture");
    let created = create_apsgba_patch_bytes(&source, &target).expect("create bytes");
    fs::write(&patch_path, &created.bytes).expect("patch");

    ApsGbaPatchHandler::new(&APSGBA)
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1).with_patch_apply_in_memory_limit(1 << 24),
        )
        .expect("in-memory apply");
    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn past_eof_growth_matches_across_apply_paths() {
    let block = super::APS_GBA_BLOCK_SIZE;
    for source_len in [0, block, block + 17] {
        let source = build_source_bytes(source_len);
        let mut target = source.clone();
        target.resize(3 * block + 31, 0);
        if source_len > 0 {
            target[source_len - 1] ^= 0x37;
        }
        target[source_len] = 0x26;
        target[2 * block + 7] = 0x59;
        target[3 * block + 30] = 0xa7;
        let patch = create_apsgba_patch_bytes(&source, &target).expect("patch");
        assert_past_eof_paths(&source, &target, &patch.bytes, None);
    }
}

#[test]
fn past_eof_shrink_matches_across_apply_paths() {
    let block = super::APS_GBA_BLOCK_SIZE;
    let source = build_source_bytes(3 * block + 31);
    for target_len in [0, block, block + 17] {
        let mut target = source[..target_len].to_vec();
        if let Some(byte) = target.first_mut() {
            *byte ^= 0x57;
        }
        let patch = create_apsgba_patch_bytes(&source, &target).expect("patch");
        assert_past_eof_paths(&source, &target, &patch.bytes, None);
    }
}

#[test]
fn past_eof_records_match_across_apply_paths() {
    let source = build_source_bytes(73);
    for offset in [73, 74, u32::MAX] {
        let patch = past_eof_record_patch(&source, offset);
        assert_past_eof_paths(&source, &source, &patch, None);
    }
}

#[test]
fn past_eof_source_checksum_errors_match_across_apply_paths() {
    let source = build_source_bytes(73);
    let mut patch = past_eof_record_patch(&source, 74);
    patch[super::APS_GBA_HEADER_SIZE + 4] ^= 1;
    assert_past_eof_paths(
        &source,
        &source,
        &patch,
        Some(
            "validation failed: Source checksum invalid at offset 74; expected: fffe, Actual: ffff",
        ),
    );
}

#[test]
fn past_eof_target_checksum_errors_match_across_apply_paths() {
    let source = build_source_bytes(73);
    let mut patch = past_eof_record_patch(&source, 74);
    patch[super::APS_GBA_HEADER_SIZE + 6] ^= 1;
    assert_past_eof_paths(
        &source,
        &source,
        &patch,
        Some(
            "validation failed: Target checksum invalid at offset 74; expected: fffe, Actual: ffff",
        ),
    );
}

fn past_eof_record_patch(source: &[u8], offset: u32) -> Vec<u8> {
    let mut patch = b"APS1".to_vec();
    patch.extend_from_slice(&(source.len() as u32).to_le_bytes());
    patch.extend_from_slice(&(source.len() as u32).to_le_bytes());
    patch.extend_from_slice(&offset.to_le_bytes());
    // Empty endpoint CRCs MUST match the creator's initial CRC16 value, 0xffff.
    patch.extend_from_slice(&0xffff_u16.to_le_bytes());
    patch.extend_from_slice(&0xffff_u16.to_le_bytes());
    patch.extend_from_slice(&vec![0x5a; super::APS_GBA_BLOCK_SIZE]);
    patch.extend_from_slice(&0_u32.to_le_bytes());
    let unchanged_crc = super::crc16_bytes(source).to_le_bytes();
    patch.extend_from_slice(&unchanged_crc);
    patch.extend_from_slice(&unchanged_crc);
    patch.extend_from_slice(&vec![0; super::APS_GBA_BLOCK_SIZE]);
    patch
}

fn assert_past_eof_paths(source: &[u8], target: &[u8], patch: &[u8], error: Option<&str>) {
    let temp = TestDir::new();
    let source_path = temp.child("source.gba");
    let patch_path = temp.child("update.apsgba");
    fs::write(&source_path, source).expect("source");
    fs::write(&patch_path, patch).expect("patch");
    let parsed = parse_apsgba_bytes(patch).expect("parse");
    let handler = ApsGbaPatchHandler::new(&APSGBA);
    for (limit, threads, checksums) in [
        (0, 1, PatchChecksumValidation::Strict),
        (0, 4, PatchChecksumValidation::Strict),
        (1 << 24, 4, PatchChecksumValidation::Strict),
        (0, 1, PatchChecksumValidation::Ignore),
        (0, 4, PatchChecksumValidation::Ignore),
        (1 << 24, 4, PatchChecksumValidation::Ignore),
    ] {
        let context = test_context_with_threads(&temp, threads)
            .with_patch_apply_in_memory_limit(limit)
            .with_patch_checksum_validation(checksums);
        let error = error.filter(|_| checksums == PatchChecksumValidation::Strict);
        assert_eq!(
            crate::can_apply_sparse_in_memory(
                &context,
                source.len() as u64,
                target.len() as u64,
                parsed.records.len(),
                crate::APSGBA_SPARSE_STREAMING,
            ),
            limit != 0,
        );
        let output = temp.child(&format!("output-{limit}-{threads}.gba"));
        let result = handler.apply(
            &PatchApplyRequest {
                input: source_path.clone(),
                patches: vec![patch_path.clone()],
                output: output.clone(),
            },
            &context,
        );
        if let Some(expected) = error {
            let actual = result.expect_err("invalid checksum must fail");
            assert!(matches!(
                actual,
                rom_weaver_core::RomWeaverError::Validation(_)
            ));
            assert_eq!(
                actual.to_string(),
                expected,
                "limit {limit}, threads {threads}"
            );
        } else {
            let report = result.unwrap_or_else(|err| {
                panic!("past-EOF apply must succeed: limit {limit}, threads {threads}: {err}")
            });
            let execution = report.thread_execution.expect("thread execution");
            assert_eq!(
                execution.used_parallelism,
                limit == 0 && threads > 1 && parsed.records.len() > 1,
            );
            assert_eq!(fs::read(output).expect("output"), target);
        }
        let validation = handler.validate(
            &PatchValidateRequest {
                input: source_path.clone(),
                patches: vec![patch_path.clone()],
            },
            &context,
        );
        if let Some(expected) = error {
            assert_eq!(
                validation.expect_err("invalid checksum").to_string(),
                expected
            );
        } else {
            validation.expect("past-EOF validate must succeed");
        }
    }
}
