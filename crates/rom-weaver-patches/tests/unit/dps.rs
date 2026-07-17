use std::{
    fs::{self, File, OpenOptions},
    io::Write,
};

use rom_weaver_core::{
    PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
};

use super::{
    DPS_PATCH_VERSION, DPS_RECORD_EMBEDDED_DATA, DpsHeaderMetadata, DpsParseMode, DpsPatchHandler,
    DpsRecord, ParsedDpsRecord, encode_dps_patch, parse_dps_bytes,
};
use crate::{
    DPS,
    test_support::{
        RoundTripCase, TestDir, assert_round_trip, report_endpoints, test_context_with_threads,
    },
};

#[test]
fn parse_reports_normalized_size_endpoints() {
    let temp = TestDir::new();
    let patch_path = temp.child("probe.dps");
    let records = vec![DpsRecord::EmbeddedData {
        output_offset: 0,
        data: b"AB".to_vec(),
    }];
    let bytes = encode_dps_patch(
        &records,
        DpsHeaderMetadata {
            patch_name: "probe.dps",
            patch_author: "test",
            patch_version_text: "1",
            patch_flag: 0,
        },
        16,
    )
    .expect("patch");
    fs::write(&patch_path, bytes).expect("fixture");

    let handler = DpsPatchHandler::new(&DPS);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");

    let endpoints = report_endpoints(&report);
    assert_eq!(endpoints.len(), 1);
    assert_eq!(endpoints[0]["input"]["size"].as_u64(), Some(16));
    assert_eq!(endpoints[0]["output"]["size"].as_u64(), Some(2));
    assert!(endpoints[0]["input"].get("checksums").is_none());
}

#[test]
fn parse_rejects_unsupported_patch_version() {
    let records = vec![DpsRecord::EmbeddedData {
        output_offset: 0,
        data: b"A".to_vec(),
    }];
    let mut bytes = encode_dps_patch(
        &records,
        DpsHeaderMetadata {
            patch_name: "unsupported-version.dps",
            patch_author: "test",
            patch_version_text: "0",
            patch_flag: 0,
        },
        0,
    )
    .expect("patch");
    bytes[193] = DPS_PATCH_VERSION + 1;

    let error = parse_dps_bytes(&bytes, DpsParseMode::Strict).expect_err("unsupported version");
    assert!(error.to_string().contains("is not supported"));
}

#[test]
fn apply_supports_copy_and_embedded_data_records() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("update.dps");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"abcdefgh").expect("fixture");
    let records = vec![
        DpsRecord::CopyFromSource {
            output_offset: 0,
            source_offset: 0,
            length: 2,
        },
        DpsRecord::EmbeddedData {
            output_offset: 2,
            data: b"XY".to_vec(),
        },
        DpsRecord::CopyFromSource {
            output_offset: 4,
            source_offset: 4,
            length: 4,
        },
    ];
    let patch = encode_dps_patch(
        &records,
        DpsHeaderMetadata {
            patch_name: "copy-and-data.dps",
            patch_author: "test",
            patch_version_text: "1",
            patch_flag: 0,
        },
        8,
    )
    .expect("patch bytes");
    fs::write(&patch_path, patch).expect("fixture");

    let handler = DpsPatchHandler::new(&DPS);
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

    assert_eq!(fs::read(output_path).expect("output"), b"abXYefgh");
}

#[test]
fn create_and_apply_round_trip_supports_shrinking_outputs() {
    let handler = DpsPatchHandler::new(&DPS);
    assert_round_trip(
        &handler,
        &RoundTripCase {
            patch_extension: "dps",
            create_threads: 2,
            apply_threads: 1,
            ..RoundTripCase::new(b"abcdefgh", b"abXY", "dps")
        },
    );
}

#[test]
fn apply_ignores_source_size_validation_when_requested() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let mismatched_source_path = temp.child("source-mismatch.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.dps");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"abcdefgh").expect("fixture");
    fs::write(&mismatched_source_path, b"abcdefghZZ").expect("fixture");
    fs::write(&target_path, b"abXYefgh").expect("fixture");

    let handler = DpsPatchHandler::new(&DPS);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "dps".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let strict_error = handler
        .apply(
            &PatchApplyRequest {
                input: mismatched_source_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("strict mismatch");
    assert!(strict_error.to_string().contains("source size mismatch"));

    let ignored_report = handler
        .apply(
            &PatchApplyRequest {
                input: mismatched_source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("ignore mismatch");
    assert!(ignored_report.label.contains("checksum validation skipped"));
    assert_eq!(fs::read(output_path).expect("output"), b"abXYefgh");
}

#[test]
fn apply_warns_and_stops_on_malformed_records_when_ignore_requested() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("update.dps");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"abcdefgh").expect("fixture");
    let mut patch = encode_dps_patch(
        &[
            DpsRecord::CopyFromSource {
                output_offset: 0,
                source_offset: 0,
                length: 4,
            },
            DpsRecord::EmbeddedData {
                output_offset: 4,
                data: b"XY".to_vec(),
            },
        ],
        DpsHeaderMetadata {
            patch_name: "malformed-tail.dps",
            patch_author: "test",
            patch_version_text: "1",
            patch_flag: 0,
        },
        8,
    )
    .expect("patch");
    patch.push(DPS_RECORD_EMBEDDED_DATA);
    patch.extend_from_slice(&6u32.to_le_bytes());
    patch.extend_from_slice(&3u32.to_le_bytes());
    patch.extend_from_slice(b"Z");
    fs::write(&patch_path, patch).expect("fixture");

    let handler = DpsPatchHandler::new(&DPS);
    let strict_error = handler
        .apply(
            &PatchApplyRequest {
                input: source_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("strict malformed");
    assert!(strict_error.to_string().contains("ended unexpectedly"));

    let ignored_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("ignore malformed");
    assert!(
        ignored_report
            .label
            .contains("warning=ignored malformed DPS record")
    );
    assert_eq!(fs::read(output_path).expect("output"), b"abcdXY");
}

#[test]
fn create_merges_embedded_data_that_crosses_thread_chunk_boundary() {
    let temp = TestDir::new();
    let source_path = temp.child("source-boundary.bin");
    let target_path = temp.child("target-boundary.bin");
    let single_patch = temp.child("single/boundary.dps");
    let parallel_patch = temp.child("parallel/boundary.dps");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 64;
    let source = vec![0x22u8; len];
    let mut target = source.clone();
    let run_start = super::CREATE_THREAD_SCAN_CHUNK_BYTES - 11;
    let run_len = 29usize;
    for (index, byte) in target[run_start..run_start + run_len]
        .iter_mut()
        .enumerate()
    {
        *byte = 0x80u8.wrapping_add(index as u8);
    }

    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let handler = DpsPatchHandler::new(&DPS);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: single_patch.clone(),
                format: "dps".into(),
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
                format: "dps".into(),
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
        fs::read(&single_patch).expect("single patch"),
        fs::read(&parallel_patch).expect("parallel patch")
    );

    let patch_bytes = fs::read(parallel_patch).expect("patch bytes");
    let parsed = parse_dps_bytes(&patch_bytes, DpsParseMode::Strict).expect("parse");
    assert_eq!(parsed.data_record_count, 1);

    let embedded = parsed
        .records
        .iter()
        .find_map(|record| match record {
            ParsedDpsRecord::EmbeddedData {
                output_offset,
                data,
            } => Some((*output_offset, data)),
            _ => None,
        })
        .expect("embedded record");

    assert_eq!(embedded.0, run_start as u32);
    assert_eq!(embedded.1.len(), run_len);
    assert_eq!(
        embedded.1.as_slice(),
        &target[run_start..run_start + run_len]
    );
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let source_path = temp.child("source-large.bin");
    let target_path = temp.child("target-large.bin");
    let single_patch = temp.child("single/update.dps");
    let parallel_patch = temp.child("parallel/update.dps");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 96 * 1024;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 7 + (index >> 2)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(4097) {
        target[index] ^= 0x33;
    }

    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let handler = DpsPatchHandler::new(&DPS);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: single_patch.clone(),
                format: "dps".into(),
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
                format: "dps".into(),
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
fn apply_runtime_threads_match_capabilities_for_multi_record_patch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.dps");
    let output_path = temp.child("output.bin");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 96 * 1024;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 13 + (index >> 2)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(3071) {
        target[index] ^= 0x33;
    }

    fs::write(&source_path, &source).expect("source fixture");
    fs::write(&target_path, &target).expect("target fixture");

    let handler = DpsPatchHandler::new(&DPS);
    let capabilities = handler.capabilities();
    assert!(capabilities.threaded_output);

    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "dps".into(),
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

#[test]
fn checked_range_accepts_in_bounds_and_rejects_past_the_limit() {
    assert_eq!(
        super::checked_range(2, 3, 10, "ok").expect("within limit"),
        (2, 5)
    );

    let error = super::checked_range(8, 5, 10, "past limit").expect_err("exceeds limit");
    let message = error.to_string();
    assert!(message.contains("DPS_RANGE_EXCEEDED_LIMIT"), "{message}");
    assert!(message.contains("limit=10"), "{message}");
}

#[test]
fn validate_dps_record_ranges_accepts_in_bounds_records() {
    let records = vec![
        ParsedDpsRecord::CopyFromSource {
            output_offset: 0,
            source_offset: 0,
            length: 4,
        },
        ParsedDpsRecord::EmbeddedData {
            output_offset: 4,
            data: b"XY".to_vec(),
        },
    ];
    super::validate_dps_record_ranges(&records, 8, 6).expect("in bounds");
}

#[test]
fn validate_dps_record_ranges_rejects_oversized_output_range() {
    let records = vec![ParsedDpsRecord::EmbeddedData {
        output_offset: 4,
        data: b"XYZ".to_vec(),
    }];

    let error = super::validate_dps_record_ranges(&records, 8, 6).expect_err("oversized output");
    let message = error.to_string();
    assert!(message.contains("DPS_RANGE_EXCEEDED_LIMIT"), "{message}");
    assert!(message.contains("DPS output write"), "{message}");
}

#[test]
fn validate_dps_record_ranges_rejects_oversized_source_range() {
    let records = vec![ParsedDpsRecord::CopyFromSource {
        output_offset: 0,
        source_offset: 6,
        length: 4,
    }];

    let error = super::validate_dps_record_ranges(&records, 8, 16).expect_err("oversized source");
    let message = error.to_string();
    assert!(message.contains("DPS_RANGE_EXCEEDED_LIMIT"), "{message}");
    assert!(message.contains("DPS source copy"), "{message}");
}

#[test]
fn merge_dps_record_collapses_adjacent_copy_records() {
    let mut merged = Vec::new();
    super::merge_dps_record(
        &mut merged,
        DpsRecord::CopyFromSource {
            output_offset: 0,
            source_offset: 0,
            length: 4,
        },
    )
    .expect("first copy");
    super::merge_dps_record(
        &mut merged,
        DpsRecord::CopyFromSource {
            output_offset: 4,
            source_offset: 4,
            length: 3,
        },
    )
    .expect("second copy");

    assert_eq!(merged.len(), 1);
    match &merged[0] {
        DpsRecord::CopyFromSource {
            output_offset,
            source_offset,
            length,
        } => assert_eq!((*output_offset, *source_offset, *length), (0, 0, 7)),
        other => panic!("expected merged copy record, got {other:?}"),
    }
}

#[test]
fn merge_dps_record_collapses_adjacent_embedded_data() {
    let mut merged = Vec::new();
    super::merge_dps_record(
        &mut merged,
        DpsRecord::EmbeddedData {
            output_offset: 0,
            data: b"AB".to_vec(),
        },
    )
    .expect("first embedded");
    super::merge_dps_record(
        &mut merged,
        DpsRecord::EmbeddedData {
            output_offset: 2,
            data: b"CD".to_vec(),
        },
    )
    .expect("second embedded");

    assert_eq!(merged.len(), 1);
    match &merged[0] {
        DpsRecord::EmbeddedData {
            output_offset,
            data,
        } => {
            assert_eq!(*output_offset, 0);
            assert_eq!(data.as_slice(), b"ABCD");
        }
        other => panic!("expected merged embedded record, got {other:?}"),
    }
}

#[test]
fn merge_dps_record_keeps_non_adjacent_and_mixed_records_separate() {
    let mut merged = Vec::new();
    super::merge_dps_record(
        &mut merged,
        DpsRecord::CopyFromSource {
            output_offset: 0,
            source_offset: 0,
            length: 4,
        },
    )
    .expect("first copy");
    // output offsets abut but source offsets do not, so the copies cannot merge.
    super::merge_dps_record(
        &mut merged,
        DpsRecord::CopyFromSource {
            output_offset: 4,
            source_offset: 16,
            length: 2,
        },
    )
    .expect("second copy");
    // Different variant than the tail, exercising the no-merge fallthrough arm.
    super::merge_dps_record(
        &mut merged,
        DpsRecord::EmbeddedData {
            output_offset: 6,
            data: b"ZZ".to_vec(),
        },
    )
    .expect("trailing embedded");

    assert_eq!(merged.len(), 3);
}

#[test]
fn create_dps_records_streaming_emits_copy_and_embedded_records() {
    let temp = TestDir::new();
    let source_path = temp.child("stream-source.bin");
    let target_path = temp.child("stream-target.bin");
    fs::write(&source_path, b"abcdefgh").expect("source");
    fs::write(&target_path, b"abXYefgh").expect("target");

    let records =
        super::create_dps_records_streaming(&source_path, &target_path).expect("streaming records");

    assert_eq!(records.len(), 3);
    match &records[0] {
        DpsRecord::CopyFromSource {
            output_offset,
            source_offset,
            length,
        } => assert_eq!((*output_offset, *source_offset, *length), (0, 0, 2)),
        other => panic!("expected leading copy record, got {other:?}"),
    }
    match &records[1] {
        DpsRecord::EmbeddedData {
            output_offset,
            data,
        } => {
            assert_eq!(*output_offset, 2);
            assert_eq!(data.as_slice(), b"XY");
        }
        other => panic!("expected embedded record, got {other:?}"),
    }
    match &records[2] {
        DpsRecord::CopyFromSource {
            output_offset,
            source_offset,
            length,
        } => assert_eq!((*output_offset, *source_offset, *length), (4, 4, 4)),
        other => panic!("expected trailing copy record, got {other:?}"),
    }
}

#[test]
fn collect_dps_chunk_records_treats_bytes_past_source_as_embedded() {
    let temp = TestDir::new();
    let source_path = temp.child("chunk-source.bin");
    let target_path = temp.child("chunk-target.bin");
    fs::write(&source_path, b"abcd").expect("source");
    fs::write(&target_path, b"abcdEFGH").expect("target");

    let records = super::collect_dps_chunk_records(&source_path, 4, &target_path, 0, 8)
        .expect("chunk records");

    assert_eq!(records.len(), 2);
    match &records[0] {
        DpsRecord::CopyFromSource {
            output_offset,
            source_offset,
            length,
        } => assert_eq!((*output_offset, *source_offset, *length), (0, 0, 4)),
        other => panic!("expected leading copy record, got {other:?}"),
    }
    match &records[1] {
        DpsRecord::EmbeddedData {
            output_offset,
            data,
        } => {
            assert_eq!(*output_offset, 4);
            assert_eq!(data.as_slice(), b"EFGH");
        }
        other => panic!("expected trailing embedded record, got {other:?}"),
    }
}

#[test]
fn apply_dps_records_in_place_supports_shrinking_output() {
    let temp = TestDir::new();
    let source_path = temp.child("in-place-source.bin");
    let output_path = temp.child("in-place-output.bin");
    fs::write(&source_path, b"abcdefgh").expect("source");

    let records = vec![
        ParsedDpsRecord::CopyFromSource {
            output_offset: 0,
            source_offset: 0,
            length: 2,
        },
        ParsedDpsRecord::EmbeddedData {
            output_offset: 2,
            data: b"XY".to_vec(),
        },
    ];

    let mut source = File::open(&source_path).expect("open source");
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&output_path)
        .expect("open output");
    output.set_len(4).expect("size output");

    super::apply_dps_records_in_place(&records, 8, 4, &mut source, &mut output)
        .expect("apply in place");
    output.flush().expect("flush");
    drop(output);

    assert_eq!(fs::read(&output_path).expect("output"), b"abXY");
}
