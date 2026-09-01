use std::fs;

use rom_weaver_core::{
    PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
    PatchValidateRequest, ProbeConfidence,
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

/// Builds a UPS patch from raw record bytes, stamping both endpoint checksums
/// and the trailing patch checksum so only the field under test is wrong.
fn build_ups_patch(source: &[u8], target: &[u8], records: &[u8]) -> Vec<u8> {
    let mut patch = super::UPS_MAGIC.to_vec();
    super::push_varint(&mut patch, source.len() as u64);
    super::push_varint(&mut patch, target.len() as u64);
    patch.extend_from_slice(records);
    patch.extend_from_slice(&super::crc32_bytes(source).to_le_bytes());
    patch.extend_from_slice(&super::crc32_bytes(target).to_le_bytes());
    let patch_checksum = super::crc32_bytes(&patch);
    patch.extend_from_slice(&patch_checksum.to_le_bytes());
    patch
}

#[test]
fn probe_reports_extension_confidence_and_header_magic() {
    let handler = UpsPatchHandler::new(&UPS);
    assert!(matches!(
        handler.probe(std::path::Path::new("update.ups")),
        ProbeConfidence::Extension
    ));
    assert_eq!(handler.header_magic(), Some(super::UPS_MAGIC.as_slice()));
}

#[test]
fn validate_reports_the_planned_output_size() {
    let temp = TestDir::new();
    let source_path = temp.child("validate-source.bin");
    let patch_path = temp.child("validate.ups");

    let source = b"source-data";
    let target = b"target-data";
    fs::write(&source_path, source).expect("source fixture");
    let patch = create_ups_patch_bytes(source, target).expect("patch").bytes;
    fs::write(&patch_path, &patch).expect("patch fixture");

    let report = UpsPatchHandler::new(&UPS)
        .validate(
            &PatchValidateRequest {
                input: source_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("validate");

    assert_eq!(report.stage, "validate");
    assert!(
        report
            .label
            .contains(&format!("output would be {} byte(s)", target.len())),
        "unexpected label: {}",
        report.label
    );
}

#[test]
fn validate_rejects_an_input_that_matches_neither_side() {
    let temp = TestDir::new();
    let source_path = temp.child("wrong-source.bin");
    let patch_path = temp.child("wrong.ups");

    fs::write(&source_path, b"not-the-source-at-all").expect("source fixture");
    let patch = create_ups_patch_bytes(b"source-data", b"target-data")
        .expect("patch")
        .bytes;
    fs::write(&patch_path, &patch).expect("patch fixture");

    let error = UpsPatchHandler::new(&UPS)
        .validate(
            &PatchValidateRequest {
                input: source_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("an unrelated input must be rejected");
    assert!(error.to_string().contains("UPS input validation failed"));
}

#[test]
fn validate_rejects_a_change_past_the_declared_sizes() {
    let temp = TestDir::new();
    let source_path = temp.child("range-source.bin");
    let patch_path = temp.child("range.ups");

    let source = b"ABCDEFGH";
    let target = b"ABCDEFGH";
    // A record at offset 6 carrying four xor bytes runs two bytes past the
    // eight-byte working size.
    let mut records = Vec::new();
    super::push_varint(&mut records, 6);
    records.extend_from_slice(&[1, 2, 3, 4]);
    records.push(0);

    fs::write(&source_path, source).expect("source fixture");
    fs::write(&patch_path, build_ups_patch(source, target, &records)).expect("patch fixture");

    let error = UpsPatchHandler::new(&UPS)
        .validate(
            &PatchValidateRequest {
                input: source_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("an out-of-bounds change must be rejected");
    assert!(
        error
            .to_string()
            .contains("UPS change exceeds declared patch file bounds")
    );
}

#[test]
fn parse_rejects_truncated_patches_and_bad_magic() {
    let temp = TestDir::new();
    let handler = UpsPatchHandler::new(&UPS);
    let context = test_context_with_threads(&temp, 1);

    let too_small = temp.child("tiny.ups");
    fs::write(&too_small, [0u8; 8]).expect("fixture");
    let error = handler
        .parse(&too_small, &context)
        .expect_err("a patch below the header/footer size must be rejected");
    assert!(
        error
            .to_string()
            .contains("too small to contain a valid header and footer")
    );

    let bad_magic = temp.child("bad-magic.ups");
    let mut bytes = create_ups_patch_bytes(b"source-data", b"target-data")
        .expect("patch")
        .bytes;
    bytes[..4].copy_from_slice(b"BAD1");
    fs::write(&bad_magic, bytes).expect("fixture");
    let error = handler
        .parse(&bad_magic, &context)
        .expect_err("a bad magic must be rejected");
    assert!(error.to_string().contains("Patch header invalid"));
}

#[test]
fn parse_ups_bytes_rejects_truncated_patches_and_bad_magic() {
    let too_small = parse_ups_bytes(&[0u8; 8]).expect_err("a short patch must be rejected");
    assert!(
        too_small
            .to_string()
            .contains("too small to contain a valid header and footer")
    );

    let mut bytes = create_ups_patch_bytes(b"source-data", b"target-data")
        .expect("patch")
        .bytes;
    bytes[..4].copy_from_slice(b"BAD1");
    let error = parse_ups_bytes(&bytes).expect_err("a bad magic must be rejected");
    assert!(error.to_string().contains("Patch header invalid"));
}

#[test]
fn parse_rejects_a_record_that_runs_past_the_footer() {
    let temp = TestDir::new();
    let source = b"ABCDEFGH";
    let target = b"ABCDEFGH";
    // A record whose xor run has no terminator before the 12-byte footer.
    let mut records = Vec::new();
    super::push_varint(&mut records, 0);
    records.extend_from_slice(&[1, 2, 3, 4]);
    let patch = build_ups_patch(source, target, &records);

    let error = parse_ups_bytes(&patch).expect_err("an unterminated record must be rejected");
    assert!(
        error
            .to_string()
            .contains("UPS patch ended unexpectedly while reading record data")
    );

    let patch_path = temp.child("unterminated.ups");
    fs::write(&patch_path, &patch).expect("fixture");
    let error = UpsPatchHandler::new(&UPS)
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("an unterminated record must be rejected");
    assert!(
        error
            .to_string()
            .contains("UPS patch ended unexpectedly while reading record data")
    );
}

#[test]
fn apply_without_source_checks_falls_back_to_the_matching_size() {
    let temp = TestDir::new();
    let source_path = temp.child("relaxed-source.bin");
    let patch_path = temp.child("relaxed.ups");
    let output_path = temp.child("relaxed-output.bin");

    let source = b"source-data";
    let target = b"target-data";
    let patch = create_ups_patch_bytes(source, target).expect("patch").bytes;
    fs::write(&patch_path, &patch).expect("patch fixture");
    // Same length as the declared source, but a different checksum.
    fs::write(&source_path, b"SOURCE-DATA").expect("source fixture");

    let error = UpsPatchHandler::new(&UPS)
        .apply(
            &PatchApplyRequest {
                input: source_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("a checksum mismatch must be rejected by default");
    assert!(error.to_string().contains("UPS input validation failed"));

    // With checksum validation off, the size match alone selects the forward
    // direction and the patch's xor records apply to the mismatched input.
    UpsPatchHandler::new(&UPS)
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("apply with checksum validation off");

    let expected: Vec<u8> = b"SOURCE-DATA"
        .iter()
        .zip(source.iter().zip(target.iter()))
        .map(|(input, (source_byte, target_byte))| input ^ source_byte ^ target_byte)
        .collect();
    assert_eq!(fs::read(output_path).expect("output"), expected);
}

#[test]
fn apply_rejects_an_output_that_misses_the_declared_target_checksum() {
    let temp = TestDir::new();
    let source_path = temp.child("checksum-source.bin");
    let patch_path = temp.child("checksum.ups");
    let output_path = temp.child("checksum-output.bin");

    let source = b"ABCDEFGH";
    let target = b"ABCDEFGH";
    fs::write(&source_path, source).expect("source fixture");

    // Correct source checksum, deliberately wrong target checksum, then a valid
    // patch checksum over the result so only the target check can fail.
    let mut patch = super::UPS_MAGIC.to_vec();
    super::push_varint(&mut patch, source.len() as u64);
    super::push_varint(&mut patch, target.len() as u64);
    patch.extend_from_slice(&super::crc32_bytes(source).to_le_bytes());
    patch.extend_from_slice(&super::crc32_bytes(target).wrapping_add(1).to_le_bytes());
    let patch_checksum = super::crc32_bytes(&patch);
    patch.extend_from_slice(&patch_checksum.to_le_bytes());
    fs::write(&patch_path, &patch).expect("patch fixture");

    let error = UpsPatchHandler::new(&UPS)
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("a wrong target checksum must be rejected");
    assert!(
        error.to_string().contains("Output checksum invalid"),
        "unexpected error: {error}"
    );
}

#[test]
fn create_handles_two_empty_files() {
    let temp = TestDir::new();
    let source_path = temp.child("empty-source.bin");
    let target_path = temp.child("empty-target.bin");
    let patch_path = temp.child("empty.ups");

    fs::write(&source_path, b"").expect("source fixture");
    fs::write(&target_path, b"").expect("target fixture");

    UpsPatchHandler::new(&UPS)
        .create(
            &PatchCreateRequest {
                original: source_path,
                modified: target_path,
                output: patch_path.clone(),
                format: "UPS".into(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("create");

    let parsed = parse_ups_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
    assert_eq!(parsed.source_size, 0);
    assert_eq!(parsed.target_size, 0);
    assert!(parsed.changes.is_empty());
}

#[test]
fn apply_zero_fills_target_bytes_past_the_end_of_a_shorter_source() {
    let temp = TestDir::new();
    let source_path = temp.child("grow-source.bin");
    let target_path = temp.child("grow-target.bin");
    let patch_path = temp.child("grow.ups");
    let output_path = temp.child("grow-output.bin");

    let source = b"ABCD".to_vec();
    let mut target = source.clone();
    target.extend_from_slice(b"EFGHIJ");

    fs::write(&source_path, &source).expect("source fixture");
    fs::write(&target_path, &target).expect("target fixture");

    let handler = UpsPatchHandler::new(&UPS);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path,
                output: patch_path.clone(),
                format: "UPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");
    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_without_source_checks_falls_back_to_the_target_size_and_to_equal_sizes() {
    let temp = TestDir::new();
    let relaxed = |threads: usize| {
        test_context_with_threads(&temp, threads)
            .with_patch_checksum_validation(PatchChecksumValidation::Ignore)
    };

    // Input length matches the declared target, so the reverse direction wins.
    let reverse_patch = temp.child("reverse.ups");
    let reverse_input = temp.child("reverse-input.bin");
    let reverse_output = temp.child("reverse-output.bin");
    let patch = create_ups_patch_bytes(b"ABCD", b"ABCDEFGHIJ")
        .expect("patch")
        .bytes;
    fs::write(&reverse_patch, &patch).expect("patch fixture");
    fs::write(&reverse_input, b"0123456789").expect("input fixture");
    UpsPatchHandler::new(&UPS)
        .apply(
            &PatchApplyRequest {
                input: reverse_input,
                patches: vec![reverse_patch],
                output: reverse_output.clone(),
            },
            &relaxed(1),
        )
        .expect("reverse apply with checksum validation off");
    assert_eq!(fs::read(reverse_output).expect("output").len(), 4);

    // Neither length matches, but the patch declares equal source and target
    // sizes, so the forward direction is assumed.
    let equal_patch = temp.child("equal.ups");
    let equal_input = temp.child("equal-input.bin");
    let equal_output = temp.child("equal-output.bin");
    let patch = create_ups_patch_bytes(b"ABCDEFGH", b"IJKLMNOP")
        .expect("patch")
        .bytes;
    fs::write(&equal_patch, &patch).expect("patch fixture");
    fs::write(&equal_input, b"12345").expect("input fixture");
    UpsPatchHandler::new(&UPS)
        .apply(
            &PatchApplyRequest {
                input: equal_input,
                patches: vec![equal_patch],
                output: equal_output.clone(),
            },
            &relaxed(1),
        )
        .expect("equal-size apply with checksum validation off");
    assert_eq!(fs::read(equal_output).expect("output").len(), 8);
}

#[test]
fn apply_rejects_a_change_past_the_output_length() {
    let temp = TestDir::new();
    let source = b"ABCDEFGH";
    let target = b"ABCDEFGH";

    // The record starts inside the file but its four xor bytes run past the end.
    let mut records = Vec::new();
    super::push_varint(&mut records, 6);
    records.extend_from_slice(&[1, 2, 3, 4]);
    records.push(0);
    let patch = build_ups_patch(source, target, &records);

    // Both the single-threaded and the pooled apply path must refuse it.
    for threads in [1usize, 4] {
        let source_path = temp.child(&format!("oob-source-{threads}.bin"));
        let patch_path = temp.child(&format!("oob-{threads}.ups"));
        let output_path = temp.child(&format!("oob-output-{threads}.bin"));
        fs::write(&source_path, source).expect("source fixture");
        fs::write(&patch_path, &patch).expect("patch fixture");

        let error = UpsPatchHandler::new(&UPS)
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, threads),
            )
            .expect_err("an out-of-bounds change must be rejected");
        assert!(
            error
                .to_string()
                .contains("UPS change exceeds declared patch file bounds"),
            "unexpected error at {threads} thread(s): {error}"
        );
    }
}

#[test]
fn create_in_parallel_zero_fills_past_the_end_of_a_shorter_source() {
    let temp = TestDir::new();
    let source_path = temp.child("parallel-grow-source.bin");
    let target_path = temp.child("parallel-grow-target.bin");
    let patch_path = temp.child("parallel-grow.ups");
    let output_path = temp.child("parallel-grow-output.bin");

    // The create scan splits at 4 MiB, so the target must clear two chunk
    // boundaries for a whole chunk to sit past the end of the source.
    let source: Vec<u8> = (0..4 * 1024 * 1024 + 1)
        .map(|index| (index % 251) as u8)
        .collect();
    let mut target = source.clone();
    target.extend((0..4 * 1024 * 1024).map(|index| (index % 97) as u8 | 1));

    fs::write(&source_path, &source).expect("source fixture");
    fs::write(&target_path, &target).expect("target fixture");

    let handler = UpsPatchHandler::new(&UPS);
    let report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path,
                output: patch_path.clone(),
                format: "UPS".into(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("create");
    assert!(
        report
            .thread_execution
            .expect("thread execution")
            .used_parallelism
    );

    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");
    assert_eq!(fs::read(output_path).expect("output"), target);
}
