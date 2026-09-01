use std::{
    fs::{self, File, OpenOptions},
    path::Path,
};

use rom_weaver_core::{
    PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
    PatchValidateRequest, ProbeConfidence, ThreadCapability,
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

/// A well-formed MOD patch carrying `records` as `(offset, data)` pairs.
fn pmsr_patch_bytes(records: &[(u32, &[u8])]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"PMSR");
    bytes.extend_from_slice(&(records.len() as u32).to_be_bytes());
    for (offset, data) in records {
        bytes.extend_from_slice(&offset.to_be_bytes());
        bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
        bytes.extend_from_slice(data);
    }
    bytes
}

#[test]
fn probe_reports_extension_confidence() {
    let handler = PmsrPatchHandler::new(&MOD);
    assert_eq!(
        handler.probe(Path::new("update.mod")),
        ProbeConfidence::Extension
    );
}

#[test]
fn validate_reports_record_count_when_checksums_are_ignored() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("update.mod");

    fs::write(&source_path, b"ORIGINAL").expect("fixture");
    fs::write(&patch_path, pmsr_patch_bytes(&[(1, b"X"), (4, b"YZ")])).expect("fixture");

    let handler = PmsrPatchHandler::new(&MOD);
    let report = handler
        .validate(
            &PatchValidateRequest {
                input: source_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("validate");
    assert_eq!(
        report.label,
        "validated MOD patch source with 2 record(s); checksum validation skipped"
    );
}

#[test]
fn validate_strict_rejects_non_paper_mario_source() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("update.mod");

    fs::write(&source_path, b"ORIGINAL").expect("fixture");
    fs::write(&patch_path, pmsr_patch_bytes(&[])).expect("fixture");

    let handler = PmsrPatchHandler::new(&MOD);
    let error = handler
        .validate(
            &PatchValidateRequest {
                input: source_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Strict),
        )
        .expect_err("strict validation should fail");
    assert!(error.to_string().contains("Source ROM checksum mismatch"));
}

#[test]
fn parse_file_rejects_patch_shorter_than_header() {
    let temp = TestDir::new();
    let patch_path = temp.child("tiny.mod");
    fs::write(&patch_path, b"PMS").expect("fixture");

    let error = super::parse_pmsr_file(&patch_path).expect_err("short patch");
    assert!(
        error
            .to_string()
            .contains("MOD patch is too small to contain a valid header")
    );
}

#[test]
fn parse_file_rejects_invalid_magic() {
    let temp = TestDir::new();
    let patch_path = temp.child("bad.mod");
    let mut bytes = pmsr_patch_bytes(&[]);
    bytes[..4].copy_from_slice(b"NOPE");
    fs::write(&patch_path, bytes).expect("fixture");

    let error = super::parse_pmsr_file(&patch_path).expect_err("bad magic");
    assert!(error.to_string().contains("Patch header invalid"));
}

#[test]
fn parse_file_rejects_trailing_data() {
    let temp = TestDir::new();
    let patch_path = temp.child("trailing.mod");
    let mut bytes = pmsr_patch_bytes(&[(0, b"AB")]);
    bytes.push(0xFF);
    fs::write(&patch_path, bytes).expect("fixture");

    let error = super::parse_pmsr_file(&patch_path).expect_err("trailing data");
    assert!(
        error
            .to_string()
            .contains("MOD patch contained unexpected trailing data")
    );
}

#[test]
fn parse_file_reads_records_and_min_target_size() {
    let temp = TestDir::new();
    let patch_path = temp.child("records.mod");
    fs::write(&patch_path, pmsr_patch_bytes(&[(4, b"AB"), (0, b"Z")])).expect("fixture");

    let parsed = super::parse_pmsr_file(&patch_path).expect("parse");
    assert_eq!(parsed.records.len(), 2);
    assert_eq!(parsed.min_target_size, 6);
    assert_eq!(parsed.records[0].offset, 4);
    assert_eq!(parsed.records[0].data, b"AB");
    assert_eq!(parsed.records[1].offset, 0);
}

#[test]
fn parse_bytes_reads_records_and_min_target_size() {
    let parsed =
        parse_pmsr_bytes(&pmsr_patch_bytes(&[(2, b"XYZ"), (16, b"")])).expect("parse bytes");
    assert_eq!(parsed.records.len(), 2);
    assert_eq!(parsed.min_target_size, 16);
    assert_eq!(parsed.records[0].data, b"XYZ");
    assert!(parsed.records[1].data.is_empty());
}

#[test]
fn parse_bytes_rejects_patch_shorter_than_header() {
    let error = parse_pmsr_bytes(b"PMSR").expect_err("short patch");
    assert!(
        error
            .to_string()
            .contains("MOD patch is too small to contain a valid header")
    );
}

#[test]
fn parse_bytes_rejects_truncated_record_data() {
    let mut bytes = pmsr_patch_bytes(&[(0, b"ABCD")]);
    bytes.truncate(bytes.len() - 2);
    let error = parse_pmsr_bytes(&bytes).expect_err("truncated record");
    assert!(
        error
            .to_string()
            .contains("MOD patch ended unexpectedly while reading MOD record data")
    );
}

#[test]
fn parse_bytes_rejects_trailing_data() {
    let mut bytes = pmsr_patch_bytes(&[(0, b"AB")]);
    bytes.push(0x00);
    let error = parse_pmsr_bytes(&bytes).expect_err("trailing data");
    assert!(
        error
            .to_string()
            .contains("MOD patch contained unexpected trailing data")
    );
}

#[test]
fn create_bytes_emits_one_record_per_difference_run() {
    let created =
        create_pmsr_patch_bytes(b"\x01\x02\x03\x04\x05", b"\x01\xAA\xBB\x04\x05").expect("create");
    let parsed = parse_pmsr_bytes(&created.bytes).expect("parse created");
    // One data record for the run, plus the zero-length record that carries the
    // target length past the last changed byte.
    assert_eq!(created.record_count, 2);
    assert_eq!(parsed.records[0].offset, 1);
    assert_eq!(parsed.records[0].data, b"\xAA\xBB");
    assert_eq!(parsed.records[1].offset, 5);
    assert!(parsed.records[1].data.is_empty());
}

#[test]
fn create_bytes_appends_zero_length_record_for_growth() {
    // The tail bytes are all zero, so no data record covers the growth: the
    // zero-length trailing record is the only thing that carries the new length.
    let created = create_pmsr_patch_bytes(b"\x01", b"\x01\x00\x00\x00").expect("create");
    let parsed = parse_pmsr_bytes(&created.bytes).expect("parse created");
    assert_eq!(created.record_count, 1);
    assert_eq!(parsed.min_target_size, 4);
    assert_eq!(parsed.records[0].offset, 4);
    assert!(parsed.records[0].data.is_empty());
}

#[test]
fn create_bytes_treats_missing_source_bytes_as_zero() {
    let created = create_pmsr_patch_bytes(b"\x01", b"\x01\x00\x07").expect("create");
    let parsed = parse_pmsr_bytes(&created.bytes).expect("parse created");
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].offset, 2);
    assert_eq!(parsed.records[0].data, b"\x07");
}

#[test]
fn in_memory_apply_rejects_record_past_declared_output() {
    let records = vec![super::PmsrRecord {
        offset: 2,
        data: vec![0xAA, 0xBB],
    }];
    let mut output = vec![0u8; 3];
    let error = super::apply_pmsr_records_in_memory(3, &records, &mut output)
        .expect_err("record past output end");
    assert!(
        error
            .to_string()
            .contains("MOD record exceeded declared output size")
    );
}

#[test]
fn in_memory_apply_skips_zero_length_records() {
    let records = vec![
        super::PmsrRecord {
            offset: 4,
            data: Vec::new(),
        },
        super::PmsrRecord {
            offset: 1,
            data: vec![0x11],
        },
    ];
    let mut output = vec![0u8; 4];
    super::apply_pmsr_records_in_memory(4, &records, &mut output).expect("apply");
    assert_eq!(output, vec![0x00, 0x11, 0x00, 0x00]);
}

#[test]
fn in_place_apply_rejects_record_past_declared_output() {
    let temp = TestDir::new();
    let output_path = temp.child("output.bin");
    fs::write(&output_path, vec![0u8; 4]).expect("fixture");
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&output_path)
        .expect("open output");

    let patch = super::ParsedPmsrPatch {
        min_target_size: 6,
        records: vec![super::PmsrRecord {
            offset: 3,
            data: vec![0x01, 0x02, 0x03],
        }],
    };
    let error = super::apply_pmsr_patch_in_place(&patch, 4, &mut output)
        .expect_err("record past output end");
    assert!(
        error
            .to_string()
            .contains("MOD record exceeded declared output size")
    );
}

#[test]
fn overlap_check_rejects_record_past_declared_output() {
    let patch = super::ParsedPmsrPatch {
        min_target_size: 8,
        records: vec![super::PmsrRecord {
            offset: 6,
            data: vec![0x01, 0x02],
        }],
    };
    let error =
        super::pmsr_records_are_non_overlapping(&patch, 4).expect_err("record past output end");
    assert!(
        error
            .to_string()
            .contains("MOD record exceeded declared output size")
    );
}

#[test]
fn overlap_check_ignores_zero_length_records() {
    let patch = super::ParsedPmsrPatch {
        min_target_size: 8,
        records: vec![
            super::PmsrRecord {
                offset: 8,
                data: Vec::new(),
            },
            super::PmsrRecord {
                offset: 0,
                data: vec![0x01, 0x02],
            },
            super::PmsrRecord {
                offset: 2,
                data: vec![0x03],
            },
        ],
    };
    assert!(
        super::pmsr_records_are_non_overlapping(&patch, 8).expect("overlap check"),
        "adjacent runs and zero-length records do not overlap"
    );
}

#[test]
fn overlap_check_detects_overlapping_records() {
    let patch = super::ParsedPmsrPatch {
        min_target_size: 8,
        records: vec![
            super::PmsrRecord {
                offset: 0,
                data: vec![0x01, 0x02, 0x03],
            },
            super::PmsrRecord {
                offset: 2,
                data: vec![0x04],
            },
        ],
    };
    assert!(
        !super::pmsr_records_are_non_overlapping(&patch, 8).expect("overlap check"),
        "the second record starts inside the first"
    );
}

#[test]
fn record_end_reports_overflow() {
    let record = super::PmsrRecord {
        offset: u64::MAX,
        data: vec![0x00],
    };
    let error = record.end().expect_err("offset plus length overflows u64");
    assert!(error.to_string().contains("MOD record end overflowed"));
}

#[test]
fn parallel_apply_is_a_no_op_for_a_record_less_patch() {
    let temp = TestDir::new();
    let output_path = temp.child("output.bin");
    fs::write(&output_path, b"UNCHANGED").expect("fixture");

    let context = test_context_with_threads(&temp, 2);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(2)))
        .expect("pool");
    let patch = super::ParsedPmsrPatch {
        min_target_size: 0,
        records: Vec::new(),
    };
    super::apply_pmsr_patch_parallel_in_place(
        &patch,
        &output_path,
        9,
        pool.size(),
        &pool,
        &context,
    )
    .expect("parallel apply");

    assert_eq!(fs::read(&output_path).expect("output"), b"UNCHANGED");
}

#[test]
fn parallel_apply_chunk_rejects_record_past_declared_output() {
    let temp = TestDir::new();
    let output_path = temp.child("output.bin");
    fs::write(&output_path, vec![0u8; 4]).expect("fixture");

    let records = vec![super::PmsrRecord {
        offset: 3,
        data: vec![0x01, 0x02],
    }];
    let error = super::apply_pmsr_record_chunk(
        &records,
        &output_path,
        4,
        &test_context_with_threads(&temp, 1),
    )
    .expect_err("record past output end");
    assert!(
        error
            .to_string()
            .contains("MOD record exceeded declared output size")
    );
}

#[test]
fn source_validation_rejects_expected_size_with_wrong_crc32() {
    let temp = TestDir::new();
    let source_path = temp.child("rom.z64");
    // Sparse zero file of the exact Paper Mario length, so only the CRC32 pass
    // can reject it.
    File::create(&source_path)
        .expect("create")
        .set_len(super::PAPER_MARIO_USA10_FILE_SIZE)
        .expect("set len");

    let error = super::validate_paper_mario_source(&source_path).expect_err("crc32 mismatch");
    assert!(error.to_string().contains("Source ROM checksum mismatch"));
}

#[test]
fn streaming_create_rejects_shrinking_outputs() {
    let temp = TestDir::new();
    let original_path = temp.child("source.bin");
    let modified_path = temp.child("target.bin");
    fs::write(&original_path, b"\x01\x02\x03\x04").expect("fixture");
    fs::write(&modified_path, b"\x01\x02").expect("fixture");

    let error = super::create_pmsr_patch_streaming(&original_path, &modified_path)
        .expect_err("shrinking output");
    assert!(
        error
            .to_string()
            .contains("MOD create does not support shrinking outputs")
    );
}

#[test]
fn streaming_create_flushes_a_run_that_reaches_the_end_of_input() {
    let temp = TestDir::new();
    let original_path = temp.child("source.bin");
    let modified_path = temp.child("target.bin");
    fs::write(&original_path, b"\x01\x02\x03").expect("fixture");
    fs::write(&modified_path, b"\x01\xAA\xBB").expect("fixture");

    let created =
        super::create_pmsr_patch_streaming(&original_path, &modified_path).expect("create");
    let parsed = parse_pmsr_bytes(&created.bytes).expect("parse created");
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].offset, 1);
    assert_eq!(parsed.records[0].data, b"\xAA\xBB");
}

#[test]
fn streaming_create_treats_an_empty_original_as_zero_bytes() {
    let temp = TestDir::new();
    let original_path = temp.child("source.bin");
    let modified_path = temp.child("target.bin");
    fs::write(&original_path, b"").expect("fixture");
    fs::write(&modified_path, b"\x00\x05\x00").expect("fixture");

    let created =
        super::create_pmsr_patch_streaming(&original_path, &modified_path).expect("create");
    let parsed = parse_pmsr_bytes(&created.bytes).expect("parse created");
    assert_eq!(parsed.records.len(), 2);
    assert_eq!(parsed.records[0].offset, 1);
    assert_eq!(parsed.records[0].data, b"\x05");
    assert_eq!(parsed.records[1].offset, 3);
    assert!(parsed.records[1].data.is_empty());
}

#[test]
fn parallel_create_rejects_shrinking_outputs() {
    let temp = TestDir::new();
    let original_path = temp.child("source.bin");
    let modified_path = temp.child("target.bin");
    fs::write(&original_path, b"\x01\x02\x03\x04").expect("fixture");
    fs::write(&modified_path, b"\x01\x02").expect("fixture");

    let context = test_context_with_threads(&temp, 2);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(2)))
        .expect("pool");
    let error = super::create_pmsr_patch_parallel(&original_path, &modified_path, &pool, &context)
        .expect_err("shrinking output");
    assert!(
        error
            .to_string()
            .contains("MOD create does not support shrinking outputs")
    );
}

#[test]
fn chunk_scan_past_the_end_of_the_target_yields_no_records() {
    let temp = TestDir::new();
    let original_path = temp.child("source.bin");
    let modified_path = temp.child("target.bin");
    fs::write(&original_path, b"\x01\x02").expect("fixture");
    fs::write(&modified_path, b"\x01\x03").expect("fixture");

    let records = super::collect_pmsr_records_for_chunk(1, &original_path, 2, &modified_path, 2)
        .expect("chunk scan");
    assert!(records.is_empty());
}

#[test]
fn chunk_record_offsets_are_absolute() {
    let records = super::collect_pmsr_records_from_bytes(100, b"\x01\x02\x03", b"\x01\xAA\x03")
        .expect("chunk scan");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].offset, 101);
    assert_eq!(records[0].data, b"\xAA");
}

#[test]
fn encode_rejects_record_offsets_above_the_32_bit_range() {
    let records = vec![super::PmsrRecord {
        offset: u64::from(u32::MAX) + 1,
        data: vec![0x01],
    }];
    let error = super::encode_pmsr_records(&records).expect_err("offset above u32 range");
    assert!(
        error
            .to_string()
            .contains("MOD record offset exceeded 32-bit range")
    );
}

#[test]
fn create_thread_capability_scales_with_the_target_length() {
    let single = super::pmsr_create_thread_capability(CREATE_SCAN_CHUNK_BYTES as u64)
        .expect("single chunk capability");
    let double = super::pmsr_create_thread_capability(CREATE_SCAN_CHUNK_BYTES as u64 + 1)
        .expect("two chunk capability");
    assert_eq!(super::pmsr_create_chunk_count(0).expect("empty"), 1);
    assert_eq!(
        single,
        ThreadCapability::Parallel {
            max_threads: Some(1)
        }
    );
    assert_eq!(
        double,
        ThreadCapability::Parallel {
            max_threads: Some(2)
        }
    );
}
