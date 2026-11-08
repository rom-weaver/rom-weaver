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
fn create_emits_a_header_only_patch_when_the_files_match() {
    let source = build_source_bytes(1024);
    let created = create_apsgba_patch_bytes(&source, &source).expect("create bytes");
    assert_eq!(created.record_count, 0);
    assert_eq!(created.bytes.len(), super::APS_GBA_HEADER_SIZE);

    let parsed = parse_apsgba_bytes(&created.bytes).expect("parse bytes");
    assert!(parsed.records.is_empty());
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
            "validation failed: Source checksum invalid at offset 74; expected: 1d0e, Actual: 1d0f [patch.checksum_mismatch]",
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
            "validation failed: Target checksum invalid at offset 74; expected: 1d0e, Actual: 1d0f [patch.checksum_mismatch]",
        ),
    );
}

fn past_eof_record_patch(source: &[u8], offset: u32) -> Vec<u8> {
    let mut patch = b"APS1".to_vec();
    patch.extend_from_slice(&(source.len() as u32).to_le_bytes());
    patch.extend_from_slice(&(source.len() as u32).to_le_bytes());
    patch.extend_from_slice(&offset.to_le_bytes());
    // A block past EOF is CRCed as 64 KiB of zeros.
    patch.extend_from_slice(&ZERO_BLOCK_CRC16.to_le_bytes());
    patch.extend_from_slice(&ZERO_BLOCK_CRC16.to_le_bytes());
    patch.extend_from_slice(&vec![0x5a; super::APS_GBA_BLOCK_SIZE]);
    patch.extend_from_slice(&0_u32.to_le_bytes());
    let unchanged_crc = reference_block_crc16(source).to_le_bytes();
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
            assert_eq!(
                actual.code(),
                Some(rom_weaver_core::ERROR_CODE_PATCH_CHECKSUM_MISMATCH)
            );
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

#[test]
fn identical_inputs_round_trip_with_valid_block_checksums() {
    for size in [
        0,
        1,
        8,
        super::APS_GBA_BLOCK_SIZE,
        super::APS_GBA_BLOCK_SIZE + 1,
        super::APS_GBA_BLOCK_SIZE * 2,
    ] {
        for threads in [1, 8] {
            let temp = TestDir::new();
            let source = temp.child("source.gba");
            let patch = temp.child("identity.apsgba");
            let output = temp.child("output.gba");
            let bytes = build_source_bytes(size);
            fs::write(&source, &bytes).expect("source");
            let handler = ApsGbaPatchHandler::new(&APSGBA);
            let context = test_context_with_threads(&temp, threads);
            handler
                .create(
                    &PatchCreateRequest {
                        original: source.clone(),
                        modified: source.clone(),
                        output: patch.clone(),
                        format: "APSGBA".into(),
                    },
                    &context,
                )
                .expect("create identity patch");
            let expected = create_apsgba_patch_bytes(&bytes, &bytes).expect("create bytes");
            assert_eq!(fs::read(&patch).expect("patch"), expected.bytes);
            for memory_limit in [0, u64::MAX] {
                handler
                    .apply(
                        &PatchApplyRequest {
                            input: source.clone(),
                            patches: vec![patch.clone()],
                            output: output.clone(),
                        },
                        &test_context_with_threads(&temp, threads)
                            .with_patch_apply_in_memory_limit(memory_limit),
                    )
                    .expect("apply identity patch with default validation");
                assert_eq!(
                    fs::read(&output).expect("output"),
                    bytes,
                    "size {size}, threads {threads}, memory {memory_limit}"
                );
            }
        }
    }
}

proptest::proptest! {
    #[test]
    fn identity_patch_has_no_records(source in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..4097)) {
        let created = create_apsgba_patch_bytes(&source, &source).expect("create");
        let parsed = parse_apsgba_bytes(&created.bytes).expect("parse");
        proptest::prop_assert!(parsed.records.is_empty());
        proptest::prop_assert_eq!(created.bytes.len(), super::APS_GBA_HEADER_SIZE);
    }
}

#[test]
fn zero_xor_resizes_round_trip_with_valid_checksums() {
    for (source_size, target_size) in [
        (0, 8),
        (8, 0),
        (8, 3),
        (3, 8),
        (super::APS_GBA_BLOCK_SIZE + 1, 8),
    ] {
        for threads in [1, 8] {
            let temp = TestDir::new();
            let source = temp.child("source.gba");
            let target = temp.child("target.gba");
            let patch = temp.child("change.apsgba");
            let output = temp.child("output.gba");
            fs::write(&source, vec![0; source_size]).expect("source");
            fs::write(&target, vec![0; target_size]).expect("target");
            let handler = ApsGbaPatchHandler::new(&APSGBA);
            let context = test_context_with_threads(&temp, threads);
            handler
                .create(
                    &PatchCreateRequest {
                        original: source.clone(),
                        modified: target,
                        output: patch.clone(),
                        format: "APSGBA".into(),
                    },
                    &context,
                )
                .expect("create zero XOR resize");
            handler
                .apply(
                    &PatchApplyRequest {
                        input: source,
                        patches: vec![patch],
                        output: output.clone(),
                    },
                    &context,
                )
                .expect("apply zero XOR resize");
            assert_eq!(fs::read(output).expect("output"), vec![0; target_size]);
        }
    }
}

/// CRC16 (poly 0x1021, init 0xffff, no reflection) of 64 KiB of zeros, worked bitwise from A-Ptch.
const ZERO_BLOCK_CRC16: u16 = 0x1d0f;

/// A-Ptch's CRC16 of one record block: the bytes zero-padded to a full 64 KiB buffer.
fn reference_block_crc16(bytes: &[u8]) -> u16 {
    let mut padded = bytes.to_vec();
    padded.resize(super::APS_GBA_BLOCK_SIZE, 0);
    ccitt_false_crc16(&padded)
}

/// CRC16/CCITT-FALSE (poly 0x1021, init 0xffff, no reflection, no final xor), worked bitwise.
fn ccitt_false_crc16(bytes: &[u8]) -> u16 {
    let mut crc = 0xffff_u16;
    for byte in bytes {
        crc ^= u16::from(*byte) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// A patch built the way A-Ptch and UniPatcher define it: one record per 64 KiB block that
/// differs, CRCs over the zero-padded blocks.
fn reference_patch(source: &[u8], target: &[u8]) -> Vec<u8> {
    let block = super::APS_GBA_BLOCK_SIZE;
    let mut patch = b"APS1".to_vec();
    patch.extend_from_slice(&(source.len() as u32).to_le_bytes());
    patch.extend_from_slice(&(target.len() as u32).to_le_bytes());
    for index in 0..source.len().max(target.len()).div_ceil(block) {
        let slice = |bytes: &[u8]| {
            bytes[(index * block).min(bytes.len())..((index + 1) * block).min(bytes.len())].to_vec()
        };
        let (source_block, target_block) = (slice(source), slice(target));
        let xor = (0..block)
            .map(|offset| {
                source_block.get(offset).copied().unwrap_or(0)
                    ^ target_block.get(offset).copied().unwrap_or(0)
            })
            .collect::<Vec<u8>>();
        if xor.iter().all(|byte| *byte == 0) {
            continue;
        }
        patch.extend_from_slice(&((index * block) as u32).to_le_bytes());
        patch.extend_from_slice(&reference_block_crc16(&source_block).to_le_bytes());
        patch.extend_from_slice(&reference_block_crc16(&target_block).to_le_bytes());
        patch.extend_from_slice(&xor);
    }
    patch
}

/// Source and target sizes whose blocks end short of, or past, EOF.
fn partial_block_cases() -> Vec<(Vec<u8>, Vec<u8>)> {
    let block = super::APS_GBA_BLOCK_SIZE;
    [
        (block + 100, block + 100),
        (block + 100, 2 * block + 50),
        (2 * block + 50, block + 100),
        (block, 2 * block + 7),
        (2 * block, block),
        (0, 100),
        (100, 0),
    ]
    .into_iter()
    .map(|(source_len, target_len)| {
        let source = build_source_bytes(source_len);
        let mut target = source.clone();
        target.resize(target_len, 0);
        for (index, byte) in target.iter_mut().enumerate().skip(source_len) {
            *byte = ((index * 7 + 3) & 0xff) as u8;
        }
        if let Some(byte) = target.get_mut(5) {
            *byte ^= 0x5a;
        }
        (source, target)
    })
    .collect()
}

#[test]
fn handler_crc16_matches_the_ccitt_false_check_value() {
    // The padded block ends in zeros, so only the unpadded check value 0x29b1 pins the algorithm.
    assert_eq!(super::crc16_bytes(b"123456789"), 0x29b1);
    assert_eq!(reference_block_crc16(&[]), ZERO_BLOCK_CRC16);
}

#[test]
fn created_patches_carry_the_crc16_of_the_zero_padded_64kib_block() {
    for (source, target) in partial_block_cases() {
        let temp = TestDir::new();
        let source_path = temp.child("source.gba");
        let target_path = temp.child("target.gba");
        fs::write(&source_path, &source).expect("source");
        fs::write(&target_path, &target).expect("target");
        let expected = reference_patch(&source, &target);
        for threads in [1, 8] {
            let patch_path = temp.child(&format!("created-{threads}.apsgba"));
            ApsGbaPatchHandler::new(&APSGBA)
                .create(
                    &PatchCreateRequest {
                        original: source_path.clone(),
                        modified: target_path.clone(),
                        output: patch_path.clone(),
                        format: "APSGBA".into(),
                    },
                    &test_context_with_threads(&temp, threads),
                )
                .expect("create");
            assert!(
                fs::read(patch_path).expect("patch") == expected,
                "source {} target {} threads {threads}",
                source.len(),
                target.len()
            );
        }
    }
}

#[test]
fn apply_and_validate_accept_patches_with_zero_padded_block_crcs() {
    for (source, target) in partial_block_cases() {
        assert_past_eof_paths(&source, &target, &reference_patch(&source, &target), None);
    }
}

#[test]
fn header_only_patch_applies_and_validates_as_a_no_op() {
    let source = build_source_bytes(100);
    let mut patch = b"APS1".to_vec();
    patch.extend_from_slice(&100_u32.to_le_bytes());
    patch.extend_from_slice(&100_u32.to_le_bytes());
    assert_eq!(patch.len(), super::APS_GBA_HEADER_SIZE);
    assert_past_eof_paths(&source, &source, &patch, None);
}

#[test]
fn create_writes_a_header_only_patch_when_no_block_differs() {
    for size in [0, 100, super::APS_GBA_BLOCK_SIZE] {
        for threads in [1, 8] {
            let temp = TestDir::new();
            let source = temp.child("source.gba");
            let patch = temp.child("identity.apsgba");
            fs::write(&source, build_source_bytes(size)).expect("source");
            ApsGbaPatchHandler::new(&APSGBA)
                .create(
                    &PatchCreateRequest {
                        original: source.clone(),
                        modified: source,
                        output: patch.clone(),
                        format: "APSGBA".into(),
                    },
                    &test_context_with_threads(&temp, threads),
                )
                .expect("create");
            let mut expected = b"APS1".to_vec();
            expected.extend_from_slice(&(size as u32).to_le_bytes());
            expected.extend_from_slice(&(size as u32).to_le_bytes());
            assert_eq!(
                fs::read(patch).expect("patch"),
                expected,
                "size {size}, threads {threads}"
            );
        }
    }
}

#[test]
fn rejects_an_implausible_declared_target_size() {
    let temp = TestDir::new();
    let input_path = temp.child("input.gba");
    let patch_path = temp.child("huge.apsgba");
    let output_path = temp.child("output.gba");
    fs::write(&input_path, build_source_bytes(4)).expect("input");
    let mut patch = b"APS1".to_vec();
    patch.extend_from_slice(&4_u32.to_le_bytes());
    patch.extend_from_slice(&u32::MAX.to_le_bytes());
    fs::write(&patch_path, patch).expect("patch");

    let handler = ApsGbaPatchHandler::new(&APSGBA);
    for memory_limit in [0, u64::MAX] {
        let result = handler.apply(
            &PatchApplyRequest {
                input: input_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2).with_patch_apply_in_memory_limit(memory_limit),
        );
        crate::test_support::assert_implausible_output_rejected(result, &output_path);
    }
    let result = handler.validate(
        &PatchValidateRequest {
            input: input_path,
            patches: vec![patch_path],
        },
        &test_context_with_threads(&temp, 2),
    );
    crate::test_support::assert_implausible_output_rejected(result, &output_path);
}

/// How a test patch stores one block CRC16.
#[derive(Clone, Copy)]
enum StoredCrc {
    /// CRC of the zero-padded 64 KiB block (A-Ptch, UniPatcher).
    ZeroPadded,
    /// CRC of only the bytes present, 0xffff when none (rom-weaver 0.24.0).
    PresentBytes,
    /// CRC of the first n bytes of the block, which no convention defines.
    Prefix(usize),
    /// The zero-padded CRC with one bit flipped.
    Corrupt,
}

impl StoredCrc {
    fn value(self, present: &[u8]) -> u16 {
        match self {
            Self::ZeroPadded => reference_block_crc16(present),
            Self::PresentBytes => ccitt_false_crc16(present),
            Self::Prefix(len) => ccitt_false_crc16(&present[..len]),
            Self::Corrupt => reference_block_crc16(present) ^ 1,
        }
    }

    fn is_refused(self) -> bool {
        matches!(self, Self::Prefix(_) | Self::Corrupt)
    }
}

struct StoredCrcCase {
    name: &'static str,
    source_len: usize,
    target_len: usize,
    offsets: &'static [u32],
    source_crc: StoredCrc,
    target_crc: StoredCrc,
}

/// A patch with one 16-byte XOR run per record offset whose block CRC16s are stored as the case
/// says, the target it produces, and the strict-mode error it must raise (if any).
fn stored_crc_patch(case: &StoredCrcCase) -> (Vec<u8>, Vec<u8>, Vec<u8>, Option<String>) {
    let block = super::APS_GBA_BLOCK_SIZE;
    let source = build_source_bytes(case.source_len);
    let mut xor = vec![0u8; block];
    xor[..16].fill(0x5a);
    let mut target = source.clone();
    target.resize(case.target_len, 0);
    for offset in case.offsets {
        for (index, xor_byte) in xor.iter().enumerate() {
            let position = *offset as usize + index;
            if position < case.target_len {
                target[position] = source.get(position).copied().unwrap_or(0) ^ xor_byte;
            }
        }
    }
    let present = |bytes: &[u8], offset: u32| {
        let start = (offset as usize).min(bytes.len());
        bytes[start..(start + block).min(bytes.len())].to_vec()
    };
    let mut patch = b"APS1".to_vec();
    patch.extend_from_slice(&(source.len() as u32).to_le_bytes());
    patch.extend_from_slice(&(target.len() as u32).to_le_bytes());
    let mut error = None;
    for offset in case.offsets {
        let (source_block, target_block) = (present(&source, *offset), present(&target, *offset));
        let source_crc = case.source_crc.value(&source_block);
        let target_crc = case.target_crc.value(&target_block);
        patch.extend_from_slice(&offset.to_le_bytes());
        patch.extend_from_slice(&source_crc.to_le_bytes());
        patch.extend_from_slice(&target_crc.to_le_bytes());
        patch.extend_from_slice(&xor);
        let refused = [
            (
                case.source_crc.is_refused(),
                "Source",
                source_crc,
                &source_block,
            ),
            (
                case.target_crc.is_refused(),
                "Target",
                target_crc,
                &target_block,
            ),
        ]
        .into_iter()
        .find(|(refused, ..)| *refused);
        if let (None, Some((_, label, stored, bytes))) = (&error, refused) {
            error = Some(format!(
                "validation failed: {label} checksum invalid at offset {offset}; expected: {stored:04x}, Actual: {:04x} [patch.checksum_mismatch]",
                reference_block_crc16(bytes)
            ));
        }
    }
    (source, target, patch, error)
}

#[test]
fn block_crc16_accepts_the_legacy_convention_only_for_blocks_not_wholly_inside_the_file() {
    let block = super::APS_GBA_BLOCK_SIZE;
    let cases = [
        StoredCrcCase {
            name: "partial block, legacy source and target",
            source_len: 73,
            target_len: 73,
            offsets: &[0],
            source_crc: StoredCrc::PresentBytes,
            target_crc: StoredCrc::PresentBytes,
        },
        StoredCrcCase {
            name: "blocks wholly past EOF, 0xffff on both sides",
            source_len: 73,
            target_len: 73,
            offsets: &[0, 74],
            source_crc: StoredCrc::PresentBytes,
            target_crc: StoredCrc::PresentBytes,
        },
        StoredCrcCase {
            name: "source block past EOF, target block partial",
            source_len: 100,
            target_len: block + 10,
            offsets: &[0, 0x1_0000],
            source_crc: StoredCrc::PresentBytes,
            target_crc: StoredCrc::PresentBytes,
        },
        StoredCrcCase {
            name: "legacy source with a zero-padded target",
            source_len: 73,
            target_len: 73,
            offsets: &[0],
            source_crc: StoredCrc::PresentBytes,
            target_crc: StoredCrc::ZeroPadded,
        },
        StoredCrcCase {
            name: "partial block matching neither convention, source",
            source_len: 73,
            target_len: 73,
            offsets: &[0],
            source_crc: StoredCrc::Corrupt,
            target_crc: StoredCrc::ZeroPadded,
        },
        StoredCrcCase {
            name: "partial block matching neither convention, target",
            source_len: 73,
            target_len: 73,
            offsets: &[0],
            source_crc: StoredCrc::ZeroPadded,
            target_crc: StoredCrc::Corrupt,
        },
        StoredCrcCase {
            name: "block wholly inside the file, prefix CRC source",
            source_len: 2 * block,
            target_len: 2 * block,
            offsets: &[0],
            source_crc: StoredCrc::Prefix(100),
            target_crc: StoredCrc::ZeroPadded,
        },
        StoredCrcCase {
            name: "block wholly inside the file, empty-input CRC source",
            source_len: 2 * block,
            target_len: 2 * block,
            offsets: &[0],
            source_crc: StoredCrc::Prefix(0),
            target_crc: StoredCrc::ZeroPadded,
        },
        StoredCrcCase {
            name: "block wholly inside the file, prefix CRC target",
            source_len: 2 * block,
            target_len: 2 * block,
            offsets: &[0],
            source_crc: StoredCrc::ZeroPadded,
            target_crc: StoredCrc::Prefix(100),
        },
    ];
    for case in &cases {
        let (source, target, patch, error) = stored_crc_patch(case);
        assert_eq!(
            error.is_some(),
            case.source_crc.is_refused() || case.target_crc.is_refused(),
            "{}",
            case.name
        );
        assert_past_eof_paths(&source, &target, &patch, error.as_deref());
    }
}
