use std::{
    fs,
    io::{Seek, SeekFrom, Write},
    path::PathBuf,
};

use rom_weaver_core::{
    OperationContext, PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
};

use super::{
    CREATE_SCAN_CHUNK_BYTES, DEFAULT_EBP_METADATA_JSON, IPS_EOF, IPS_MAGIC, IPS_PROBE_PREFIX_BYTES,
    IPS_RESERVED_EOF_OFFSET, IPS32_EOF, IPS32_MAGIC, IPS32_RESERVED_EOF_OFFSET, IpsCreateResult,
    IpsDiffRun, IpsFileParser, IpsFlavor, IpsPatchHandler, IpsProbeRecord, IpsRecordData,
    JsonValue, MAX_IPS_OFFSET, MAX_IPS_RECORD_LEN, MAX_IPS32_OFFSET, OUTPUT_CHUNK_SIZE,
    adjust_record_len_for_reserved_offset, checked_add, coalesce_ips_diff_runs,
    collect_ips_diff_runs_from_bytes, find_next_rle_split, flavor_name, ips_create_chunk_count,
    ips_create_thread_capability, max_parallel_chunks, parse_ebp_metadata, parse_ips_bytes,
    parse_ips_bytes_with_validation, probe_ips_records, read_u24 as decode_u24,
    read_u32 as decode_u32, records_overlap, repeated_prefix_len, truncate_size_required,
    validate_ips_create_flips_limits, write_ips_runs_to_output, write_literal_record, write_offset,
    write_rle_record,
};
use crate::{
    EBP, IPS, IPS32,
    test_support::{TestDir, test_context_with_threads_named},
};

#[derive(Debug)]
enum TestIpsRecord {
    Literal { offset: u32, data: Vec<u8> },
    Rle { offset: u32, len: u16, value: u8 },
}

#[test]
fn parse_accepts_records_beyond_truncate_size_with_warning() {
    let patch = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 4,
            data: b"toolong".to_vec(),
        }],
        Some(6),
    );

    let parsed = parse_ips_bytes(&patch, IpsFlavor::Ips).expect("parse");
    assert_eq!(parsed.truncate_size, Some(6));
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.max_written_end, 11);
    assert_eq!(parsed.warnings.len(), 1);
    assert!(
        parsed.warnings[0].contains("records extend past truncate size 6"),
        "warning mismatch: {}",
        parsed.warnings[0]
    );
}

#[test]
fn parse_rejects_zero_length_rle_records_in_strict_mode() {
    let patch = build_ips_patch(
        vec![
            TestIpsRecord::Rle {
                offset: 0,
                len: 0,
                value: 0xFF,
            },
            TestIpsRecord::Literal {
                offset: 1,
                data: b"A".to_vec(),
            },
        ],
        None,
    );

    let error = parse_ips_bytes(&patch, IpsFlavor::Ips).expect_err("invalid zero RLE");
    assert!(
        error
            .to_string()
            .contains("invalid zero-length IPS RLE record at offset 0")
    );
}

#[test]
fn parse_can_ignore_zero_length_rle_records_with_warning() {
    let patch = build_ips_patch(
        vec![
            TestIpsRecord::Rle {
                offset: 0,
                len: 0,
                value: 0xFF,
            },
            TestIpsRecord::Literal {
                offset: 1,
                data: b"A".to_vec(),
            },
        ],
        None,
    );

    let parsed =
        parse_ips_bytes_with_validation(&patch, IpsFlavor::Ips, PatchChecksumValidation::Ignore)
            .expect("parse");
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].offset, 1);
    assert_eq!(parsed.records[0].len, 1);
    assert_eq!(parsed.warnings.len(), 1);
    assert!(
        parsed.warnings[0].contains("ignored zero-length IPS RLE record at offset 0"),
        "warning mismatch: {}",
        parsed.warnings[0]
    );
}

#[test]
fn parse_rejects_trailing_bytes_after_eof_in_strict_mode() {
    let mut patch = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: b"A".to_vec(),
        }],
        None,
    );
    patch.extend_from_slice(&[0xDE, 0xAD]);

    let error = parse_ips_bytes(&patch, IpsFlavor::Ips).expect_err("invalid trailing bytes");
    assert!(
        error
            .to_string()
            .contains("unexpected 2 trailing byte(s) after EOF in IPS patch")
    );
}

#[test]
fn parse_can_ignore_trailing_bytes_after_eof_with_warning() {
    let mut patch = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: b"A".to_vec(),
        }],
        None,
    );
    patch.extend_from_slice(&[0xDE, 0xAD]);

    let parsed =
        parse_ips_bytes_with_validation(&patch, IpsFlavor::Ips, PatchChecksumValidation::Ignore)
            .expect("parse");
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.truncate_size, None);
    assert_eq!(parsed.warnings.len(), 1);
    assert!(
        parsed.warnings[0].contains("ignored 2 trailing byte(s) after EOF in IPS patch"),
        "warning mismatch: {}",
        parsed.warnings[0]
    );
}

#[test]
fn parse_report_includes_warning_for_zero_length_rle_record() {
    let temp = TestDir::new();
    let patch_path = temp.child("zero-rle.ips");
    fs::write(
        &patch_path,
        build_ips_patch(
            vec![TestIpsRecord::Rle {
                offset: 0,
                len: 0,
                value: 0xFF,
            }],
            None,
        ),
    )
    .expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    let report = handler
        .parse(&patch_path, &ignore_validation_context(&temp, 1))
        .expect("parse report");

    assert!(
        report
            .label
            .contains("warning=ignored zero-length IPS RLE record at offset 0"),
        "label mismatch: {}",
        report.label
    );
}

#[test]
fn apply_report_includes_warning_for_trailing_bytes_after_eof() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("trailing-data.ips");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, b"ab").expect("fixture");

    let mut patch = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 1,
            data: b"Z".to_vec(),
        }],
        None,
    );
    patch.extend_from_slice(&[0x00]);
    fs::write(&patch_path, patch).expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &ignore_validation_context(&temp, 1),
        )
        .expect("apply report");

    assert_eq!(fs::read(&output_path).expect("output"), b"aZ");
    assert!(
        report
            .label
            .contains("warning=ignored 1 trailing byte(s) after EOF in IPS patch"),
        "label mismatch: {}",
        report.label
    );
}

#[test]
fn apply_report_warns_when_patch_does_not_change_output() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("no-change.ips");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, b"abcdefgh").expect("fixture");
    fs::write(
        &patch_path,
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 2,
                data: b"c".to_vec(),
            }],
            None,
        ),
    )
    .expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply report");

    assert_eq!(fs::read(&output_path).expect("output"), b"abcdefgh");
    assert!(
        report
            .label
            .contains("warning=IPS patch did not change output"),
        "label mismatch: {}",
        report.label
    );
}

#[test]
fn apply_report_warns_when_truncate_footer_is_not_needed() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, b"abcdefgh").expect("fixture");
    fs::write(
        &patch_path,
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 2,
                data: b"Z".to_vec(),
            }],
            Some(12),
        ),
    )
    .expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply report");

    assert_eq!(fs::read(&output_path).expect("output"), b"abZdefgh");
    assert!(
        report
            .label
            .contains("warning=IPS patch truncate footer was not needed"),
        "label mismatch: {}",
        report.label
    );
}

#[test]
fn apply_round_trips_overlaps_and_truncation() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, b"abcdefgh").expect("fixture");
    fs::write(
        &patch_path,
        build_ips_patch(
            vec![
                TestIpsRecord::Literal {
                    offset: 1,
                    data: b"12".to_vec(),
                },
                TestIpsRecord::Literal {
                    offset: 2,
                    data: b"XYZ".to_vec(),
                },
                TestIpsRecord::Rle {
                    offset: 6,
                    len: 3,
                    value: b'!',
                },
            ],
            Some(9),
        ),
    )
    .expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    let capabilities = handler.capabilities();
    assert!(capabilities.threaded_output);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("report");

    let execution = report.thread_execution.as_ref().expect("thread execution");
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
    assert_eq!(fs::read(&output_path).expect("output"), b"a1XYZf!!!");
}

#[test]
fn apply_clips_records_beyond_truncate_size() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, b"abcdefgh").expect("fixture");
    fs::write(
        &patch_path,
        build_ips_patch(
            vec![
                TestIpsRecord::Literal {
                    offset: 0,
                    data: b"Z".to_vec(),
                },
                TestIpsRecord::Literal {
                    offset: 4,
                    data: b"toolong".to_vec(),
                },
            ],
            Some(6),
        ),
    )
    .expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    assert_eq!(fs::read(&output_path).expect("output"), b"Zbcdto");
    assert!(
        report
            .label
            .contains("warning=IPS patch appears scrambled or malformed"),
        "label mismatch: {}",
        report.label
    );
}

#[test]
fn apply_truncate_footer_does_not_grow_output() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, []).expect("fixture");
    fs::write(&patch_path, build_ips_patch(Vec::new(), Some(32))).expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    assert_eq!(fs::read(&output_path).expect("output"), Vec::<u8>::new());
}

#[test]
fn apply_uses_parallel_threads_for_large_output() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, []).expect("fixture");

    let total_len = (OUTPUT_CHUNK_SIZE + 321) as u32;
    fs::write(&patch_path, large_rle_patch(total_len, b'Z')).expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    let capabilities = handler.capabilities();
    assert!(capabilities.threaded_output);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("report");

    let execution = report.thread_execution.as_ref().expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 2);
    assert!(execution.used_parallelism);

    let output = fs::read(&output_path).expect("output");
    assert_eq!(output.len(), total_len as usize);
    assert!(output.iter().all(|byte| *byte == b'Z'));
}

#[test]
fn create_round_trips_and_encodes_truncation_when_shrinking() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let output_path = temp.child("output.bin");
    fs::write(&original_path, b"abcdefgh").expect("fixture");

    let modified = b"a1XYZf!";
    let modified_path = temp.child("modified.bin");
    fs::write(&modified_path, modified).expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    let report = handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_path.clone(),
                format: "IPS".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("report");

    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
    assert!(
        report
            .label
            .contains("warning=IPS create input is larger than modified output"),
        "label mismatch: {}",
        report.label
    );

    let patch =
        parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
    assert_eq!(patch.truncate_size, Some(modified.len() as u64));
    assert!(!patch.records.is_empty());

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

    assert_eq!(fs::read(&output_path).expect("output"), modified);
}

#[test]
fn create_grows_with_explicit_zero_record_not_truncate_only() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let output_path = temp.child("output.bin");
    let modified_path = temp.child("modified.bin");
    fs::write(&original_path, []).expect("fixture");
    fs::write(&modified_path, [0u8; 32]).expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path,
                output: patch_path.clone(),
                format: "IPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let patch =
        parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
    assert_eq!(patch.truncate_size, None);
    assert_eq!(patch.records.len(), 1);
    assert_eq!(patch.records[0].offset, 0);
    assert_eq!(patch.records[0].len, 32);
    match &patch.records[0].data {
        IpsRecordData::Rle { byte } => assert_eq!(*byte, 0),
        other => panic!("expected RLE record, got {other:?}"),
    }

    handler
        .apply(
            &PatchApplyRequest {
                input: original_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    assert_eq!(fs::read(&output_path).expect("output"), vec![0u8; 32]);
}

#[test]
fn create_uses_rle_records_for_repeated_runs() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let modified_path = temp.child("modified.bin");
    fs::write(&original_path, []).expect("fixture");
    fs::write(&modified_path, vec![b'Z'; 32]).expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "IPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let patch =
        parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
    assert_eq!(patch.truncate_size, None);
    assert_eq!(patch.records.len(), 1);
    assert_eq!(patch.records[0].offset, 0);
    assert_eq!(patch.records[0].len, 32);
    match &patch.records[0].data {
        IpsRecordData::Rle { byte } => assert_eq!(*byte, b'Z'),
        other => panic!("expected RLE record, got {other:?}"),
    }
}

#[test]
fn create_coalesces_short_unchanged_gaps_into_literal_record() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let modified_path = temp.child("modified.bin");
    fs::write(&original_path, b"abcdefghij").expect("fixture");
    fs::write(&modified_path, b"ZbcdYfghij").expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "IPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let patch =
        parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
    assert_eq!(patch.records.len(), 1);
    assert_eq!(patch.records[0].offset, 0);
    assert_eq!(patch.records[0].len, 5);
    match &patch.records[0].data {
        IpsRecordData::Literal(data) => assert_eq!(data, b"ZbcdY"),
        other => panic!("expected literal record, got {other:?}"),
    }
}

#[test]
fn create_keeps_long_unchanged_gaps_as_separate_records() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let modified_path = temp.child("modified.bin");
    fs::write(&original_path, b"abcdefghij").expect("fixture");
    fs::write(&modified_path, b"ZbcdefgYij").expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "IPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let patch =
        parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
    assert_eq!(patch.records.len(), 2);
    assert_eq!(patch.records[0].offset, 0);
    assert_eq!(patch.records[0].len, 1);
    assert_eq!(patch.records[1].offset, 7);
    assert_eq!(patch.records[1].len, 1);
}

#[test]
fn create_splits_rle_worthy_suffix_from_mixed_literal() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let modified_path = temp.child("modified.bin");
    let original = vec![0u8; 32];
    let mut modified = original.clone();
    modified[0] = 1;
    modified[6..26].fill(2);
    fs::write(&original_path, original).expect("fixture");
    fs::write(&modified_path, modified).expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "IPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let patch =
        parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
    assert_eq!(patch.records.len(), 2);
    assert_eq!(patch.records[0].offset, 0);
    assert_eq!(patch.records[0].len, 6);
    match &patch.records[0].data {
        IpsRecordData::Literal(data) => assert_eq!(data, &[1, 0, 0, 0, 0, 0]),
        other => panic!("expected literal record, got {other:?}"),
    }
    assert_eq!(patch.records[1].offset, 6);
    assert_eq!(patch.records[1].len, 20);
    match &patch.records[1].data {
        IpsRecordData::Rle { byte } => assert_eq!(*byte, 2),
        other => panic!("expected RLE record, got {other:?}"),
    }
}

#[test]
fn create_avoids_classic_ips_eof_marker_offset_in_streaming_path() {
    assert_create_avoids_classic_ips_eof_marker_offset(1);
}

#[test]
fn create_avoids_classic_ips_eof_marker_offset_in_parallel_path() {
    assert_create_avoids_classic_ips_eof_marker_offset(8);
}

#[test]
fn create_uses_parallel_threads_for_large_input() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.ips");
    let output_path = temp.child("output.bin");

    let len = CREATE_SCAN_CHUNK_BYTES + 128;
    let original = vec![0u8; len];
    let mut modified = original.clone();
    modified[CREATE_SCAN_CHUNK_BYTES - 8..CREATE_SCAN_CHUNK_BYTES + 24].fill(b'X');
    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    let report = handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_path.clone(),
                format: "IPS".into(),
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
                input: original_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");
    assert_eq!(fs::read(&output_path).expect("output"), modified);
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let modified_path = temp.child("modified.bin");
    let patch_single = temp.child("single.ips");
    let patch_parallel = temp.child("parallel.ips");

    let len = CREATE_SCAN_CHUNK_BYTES + 128;
    let original = vec![0u8; len];
    let mut modified = original.clone();
    modified[CREATE_SCAN_CHUNK_BYTES - 8..CREATE_SCAN_CHUNK_BYTES + 24].fill(b'X');
    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);

    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_single.clone(),
                format: "IPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single create");
    let parallel_report = handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_parallel.clone(),
                format: "IPS".into(),
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
        fs::read(&patch_single).expect("single patch"),
        fs::read(&patch_parallel).expect("parallel patch")
    );
}

#[test]
fn create_splits_large_literal_runs_at_ips_record_limit() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let modified_path = temp.child("modified.bin");
    fs::write(&original_path, []).expect("fixture");

    let modified_len = MAX_IPS_RECORD_LEN + 17;
    let modified = (0..modified_len)
        .map(|index| u8::try_from((index % 255) + 1).expect("byte"))
        .collect::<Vec<_>>();
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "IPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let patch =
        parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
    assert_eq!(patch.truncate_size, None);
    assert_eq!(patch.records.len(), 2);
    assert_eq!(patch.records[0].offset, 0);
    assert_eq!(patch.records[0].len, MAX_IPS_RECORD_LEN as u64);
    assert_eq!(patch.records[1].offset, MAX_IPS_RECORD_LEN as u64);
    assert_eq!(patch.records[1].len, 17);
    assert!(matches!(patch.records[0].data, IpsRecordData::Literal(_)));
    assert!(matches!(patch.records[1].data, IpsRecordData::Literal(_)));
}

#[test]
fn create_unchanged_files_produce_empty_patch() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips");
    let modified_path = temp.child("modified.bin");
    let bytes = b"unchanged-input".repeat(1024);
    fs::write(&original_path, &bytes).expect("fixture");
    fs::write(&modified_path, &bytes).expect("fixture");

    let handler = IpsPatchHandler::new(&IPS);
    let report = handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "IPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");
    assert!(
        report
            .label
            .contains("warning=IPS patch will not change output"),
        "label mismatch: {}",
        report.label
    );

    let patch = fs::read(&patch_path).expect("patch");
    assert_eq!(patch, b"PATCHEOF");
}

#[test]
fn create_rejects_classic_ips_targets_larger_than_flips_limit() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.ips");
    let len = (0x00FF_FFFF_u64) + 2;
    write_sparse_bytes(&original_path, len, 0, &[0]);
    write_sparse_bytes(&modified_path, len, 0, &[0x5A]);

    let handler = IpsPatchHandler::new(&IPS);
    let error = handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path,
                format: "IPS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("oversized IPS create should fail");

    assert!(
        error
            .to_string()
            .contains("exceeds the Flips-compatible 16.78 MB limit"),
        "error mismatch: {error}"
    );
}

#[test]
fn create_can_ignore_classic_ips_flips_size_limit_when_records_remain_encodable() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.ips");
    let len = (0x00FF_FFFF_u64) + 2;
    write_sparse_bytes(&original_path, len, 0, &[0]);
    write_sparse_bytes(&modified_path, len, 0, &[0x5A]);

    let handler = IpsPatchHandler::new(&IPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "IPS".into(),
            },
            &ignore_validation_context(&temp, 1),
        )
        .expect("ignored validation create");

    let parsed =
        parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].offset, 0);
    assert_eq!(parsed.records[0].len, 1);
    assert_eq!(parsed.truncate_size, None);
}

#[test]
fn parse_accepts_ips32_records_past_24bit_limit() {
    let patch = build_ips32_patch(vec![TestIpsRecord::Literal {
        offset: 0x0100_0000,
        data: b"A".to_vec(),
    }]);
    let parsed = parse_ips_bytes(&patch, IpsFlavor::Ips32).expect("parse");
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].offset, 0x0100_0000);
    assert_eq!(parsed.truncate_size, None);
}

#[test]
fn apply_round_trips_for_ips32_patch() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ips32");
    let output_path = temp.child("output.bin");
    write_sparse_bytes(&input_path, 0x0100_0002, 0x0100_0000, b"ab");
    fs::write(
        &patch_path,
        build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0001,
            data: b"Z".to_vec(),
        }]),
    )
    .expect("fixture");

    let handler = IpsPatchHandler::new_ips32(&IPS32);
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");

    let output = fs::read(&output_path).expect("output");
    assert_eq!(output.len(), 0x0100_0002);
    assert_eq!(output[0x0100_0000], b'a');
    assert_eq!(output[0x0100_0001], b'Z');
}

#[test]
fn create_round_trips_for_ips32_patch() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.ips32");
    let output_path = temp.child("output.bin");
    write_sparse_bytes(&original_path, 0x0100_0002, 0x0100_0000, b"ab");
    write_sparse_bytes(&modified_path, 0x0100_0002, 0x0100_0000, b"aZ");

    let handler = IpsPatchHandler::new_ips32(&IPS32);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_path.clone(),
                format: "IPS32".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let patch = fs::read(&patch_path).expect("patch");
    assert!(patch.starts_with(IPS32_MAGIC));
    assert!(patch.ends_with(IPS32_EOF));
    let parsed = parse_ips_bytes(&patch, IpsFlavor::Ips32).expect("parse");
    assert_eq!(parsed.truncate_size, None);
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].offset, 0x0100_0001);

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
    assert_eq!(fs::read(&output_path).expect("output")[0x0100_0000], b'a');
    assert_eq!(fs::read(&output_path).expect("output")[0x0100_0001], b'Z');
}

#[test]
fn parse_accepts_ebp_metadata_after_eof() {
    let patch = build_ebp_patch(
        vec![TestIpsRecord::Literal {
            offset: 1,
            data: b"XYZ".to_vec(),
        }],
        r#"{"patcher":"EBPatcher","Title":"Test","Author":"Me","Description":"Demo"}"#,
    );
    let parsed = parse_ips_bytes(&patch, IpsFlavor::Ebp).expect("parse");
    assert_eq!(parsed.truncate_size, None);
    assert_eq!(parsed.records.len(), 1);
    let metadata = parsed.metadata.expect("metadata");
    assert_eq!(
        metadata.get("patcher").and_then(JsonValue::as_str),
        Some("EBPatcher")
    );
    assert_eq!(
        metadata.get("Title").and_then(JsonValue::as_str),
        Some("Test")
    );
}

#[test]
fn parse_rejects_invalid_ebp_metadata_json() {
    let patch = build_ebp_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: b"A".to_vec(),
        }],
        "{invalid-json}",
    );
    let error = parse_ips_bytes(&patch, IpsFlavor::Ebp).expect_err("invalid metadata");
    assert!(error.to_string().contains("EBP metadata is not valid JSON"));
}

#[test]
fn apply_round_trips_for_ebp_patch() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ebp");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, b"abcdefgh").expect("fixture");
    fs::write(
        &patch_path,
        build_ebp_patch(
            vec![
                TestIpsRecord::Literal {
                    offset: 2,
                    data: b"XYZ".to_vec(),
                },
                TestIpsRecord::Rle {
                    offset: 7,
                    len: 2,
                    value: b'!',
                },
            ],
            r#"{"patcher":"EBPatcher","Title":"Patch"}"#,
        ),
    )
    .expect("fixture");

    let handler = IpsPatchHandler::new_ebp(&EBP);
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");

    assert_eq!(fs::read(&output_path).expect("output"), b"abXYZfg!!");
}

#[test]
fn create_round_trips_and_writes_default_ebp_metadata() {
    let temp = TestDir::new();
    let original_path = temp.child("input.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.ebp");
    let output_path = temp.child("output.bin");
    fs::write(&original_path, b"abcdefgh").expect("fixture");
    fs::write(&modified_path, b"a1XYZf!!").expect("fixture");

    let handler = IpsPatchHandler::new_ebp(&EBP);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_path.clone(),
                format: "EBP".into(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("create");

    let patch = fs::read(&patch_path).expect("patch");
    assert!(patch.ends_with(DEFAULT_EBP_METADATA_JSON.as_bytes()));
    let parsed = parse_ips_bytes(&patch, IpsFlavor::Ebp).expect("parse");
    assert_eq!(parsed.truncate_size, None);
    assert!(parsed.metadata.is_some());

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
    assert_eq!(fs::read(&output_path).expect("output"), b"a1XYZf!!");
}

fn build_ips_patch(records: Vec<TestIpsRecord>, truncate_size: Option<u32>) -> Vec<u8> {
    let mut bytes = IPS_MAGIC.to_vec();
    for record in records {
        match record {
            TestIpsRecord::Literal { offset, data } => {
                write_u24(&mut bytes, offset);
                let len = u16::try_from(data.len()).expect("literal len");
                bytes.extend_from_slice(&len.to_be_bytes());
                bytes.extend_from_slice(&data);
            }
            TestIpsRecord::Rle { offset, len, value } => {
                write_u24(&mut bytes, offset);
                bytes.extend_from_slice(&0u16.to_be_bytes());
                bytes.extend_from_slice(&len.to_be_bytes());
                bytes.push(value);
            }
        }
    }
    bytes.extend_from_slice(IPS_EOF);
    if let Some(size) = truncate_size {
        write_u24(&mut bytes, size);
    }
    bytes
}

fn build_ebp_patch(records: Vec<TestIpsRecord>, metadata_json: &str) -> Vec<u8> {
    let mut bytes = build_ips_patch(records, None);
    bytes.extend_from_slice(metadata_json.as_bytes());
    bytes
}

fn build_ips32_patch(records: Vec<TestIpsRecord>) -> Vec<u8> {
    let mut bytes = IPS32_MAGIC.to_vec();
    for record in records {
        match record {
            TestIpsRecord::Literal { offset, data } => {
                write_u32(&mut bytes, offset);
                let len = u16::try_from(data.len()).expect("literal len");
                bytes.extend_from_slice(&len.to_be_bytes());
                bytes.extend_from_slice(&data);
            }
            TestIpsRecord::Rle { offset, len, value } => {
                write_u32(&mut bytes, offset);
                bytes.extend_from_slice(&0u16.to_be_bytes());
                bytes.extend_from_slice(&len.to_be_bytes());
                bytes.push(value);
            }
        }
    }
    bytes.extend_from_slice(IPS32_EOF);
    bytes
}

fn large_rle_patch(total_len: u32, value: u8) -> Vec<u8> {
    let mut records = Vec::new();
    let mut offset = 0u32;
    while offset < total_len {
        let remaining = total_len - offset;
        let len = remaining.min(u16::MAX as u32) as u16;
        records.push(TestIpsRecord::Rle { offset, len, value });
        offset += u32::from(len);
    }
    build_ips_patch(records, Some(total_len))
}

fn write_u24(bytes: &mut Vec<u8>, value: u32) {
    assert!(value <= 0x00FF_FFFF);
    bytes.push((value >> 16) as u8);
    bytes.push((value >> 8) as u8);
    bytes.push(value as u8);
}

fn write_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_be_bytes());
}

fn assert_create_avoids_classic_ips_eof_marker_offset(threads: usize) {
    let temp = TestDir::new();
    let original_name = format!("input-{threads}.bin");
    let modified_name = format!("modified-{threads}.bin");
    let patch_name = format!("update-{threads}.ips");
    let output_name = format!("output-{threads}.bin");
    let original_path = temp.child(&original_name);
    let modified_path = temp.child(&modified_name);
    let patch_path = temp.child(&patch_name);
    let output_path = temp.child(&output_name);
    let marker_offset = IPS_RESERVED_EOF_OFFSET;
    write_sparse_bytes(&original_path, marker_offset + 1, marker_offset, &[0]);
    write_sparse_bytes(&modified_path, marker_offset + 1, marker_offset, &[0x7E]);

    let handler = IpsPatchHandler::new(&IPS);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path,
                output: patch_path.clone(),
                format: "IPS".into(),
            },
            &test_context_with_threads(&temp, threads),
        )
        .expect("create");

    let patch =
        parse_ips_bytes(&fs::read(&patch_path).expect("patch"), IpsFlavor::Ips).expect("parse");
    assert_eq!(patch.records.len(), 1);
    assert_eq!(patch.records[0].offset, marker_offset - 1);
    assert_eq!(patch.records[0].len, 2);
    match &patch.records[0].data {
        IpsRecordData::Literal(data) => assert_eq!(data, &[0, 0x7E]),
        other => panic!("expected literal record, got {other:?}"),
    }

    handler
        .apply(
            &PatchApplyRequest {
                input: original_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, threads),
        )
        .expect("apply");
    let mut output = fs::File::open(&output_path).expect("output");
    output
        .seek(SeekFrom::Start(marker_offset))
        .expect("seek output");
    let mut byte = [0u8; 1];
    std::io::Read::read_exact(&mut output, &mut byte).expect("read output byte");
    assert_eq!(byte[0], 0x7E);
}

fn write_sparse_bytes(path: &PathBuf, len: u64, offset: u64, bytes: &[u8]) {
    let mut file = fs::File::create(path).expect("create sparse file");
    file.set_len(len).expect("set len");
    file.seek(SeekFrom::Start(offset)).expect("seek");
    file.write_all(bytes).expect("write bytes");
    file.flush().expect("flush");
}

fn test_context_with_threads(temp: &TestDir, threads: usize) -> OperationContext {
    test_context_with_threads_named(temp, threads, "temp-root")
}

fn ignore_validation_context(temp: &TestDir, threads: usize) -> OperationContext {
    test_context_with_threads(temp, threads)
        .with_patch_checksum_validation(PatchChecksumValidation::Ignore)
}

fn ips_probe_record(offset: u64, len: u64) -> IpsProbeRecord {
    IpsProbeRecord {
        offset,
        len,
        first: 0,
        last: 0,
    }
}

#[test]
fn header_magic_is_reported_for_classic_ips_only() {
    assert_eq!(
        IpsPatchHandler::new(&IPS).header_magic(),
        Some(&IPS_MAGIC[..])
    );
    assert_eq!(IpsPatchHandler::new_ebp(&EBP).header_magic(), None);
    assert_eq!(IpsPatchHandler::new_ips32(&IPS32).header_magic(), None);
}

#[test]
fn probe_reports_extension_confidence_for_every_flavor() {
    let temp = TestDir::new();
    let patch = temp.child("probe.ips");
    fs::write(&patch, IPS_MAGIC).expect("fixture");

    for handler in [
        IpsPatchHandler::new(&IPS),
        IpsPatchHandler::new_ebp(&EBP),
        IpsPatchHandler::new_ips32(&IPS32),
    ] {
        assert_eq!(
            handler.probe(&patch),
            rom_weaver_core::ProbeConfidence::Extension
        );
    }
}

#[test]
fn parse_rejects_trailing_data_after_the_ips32_footer() {
    let temp = TestDir::new();
    let patch_path = temp.child("trailing.ips32");
    let mut bytes = build_ips32_patch(vec![TestIpsRecord::Literal {
        offset: 0,
        data: b"AB".to_vec(),
    }]);
    bytes.extend_from_slice(b"junk");
    fs::write(&patch_path, &bytes).expect("fixture");

    let bytes_error = parse_ips_bytes(&bytes, IpsFlavor::Ips32)
        .expect_err("bytes parser should reject trailing data");
    assert!(
        bytes_error.to_string().contains("after EEOF"),
        "unexpected error: {bytes_error}"
    );

    let file_error = IpsPatchHandler::new_ips32(&IPS32)
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("file parser should reject trailing data");
    assert!(
        file_error.to_string().contains("after EEOF"),
        "unexpected error: {file_error}"
    );
}

#[test]
fn parse_accepts_an_ebp_patch_without_a_metadata_block() {
    let temp = TestDir::new();
    let patch_path = temp.child("bare.ebp");
    fs::write(
        &patch_path,
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 1,
                data: b"Z".to_vec(),
            }],
            None,
        ),
    )
    .expect("fixture");

    let report = IpsPatchHandler::new_ebp(&EBP)
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");
    assert!(report.label.contains("1 record(s)"), "{}", report.label);
    assert!(!report.label.contains("and metadata"), "{}", report.label);
}

#[test]
fn parse_report_mentions_metadata_for_an_ebp_patch_that_carries_it() {
    let temp = TestDir::new();
    let patch_path = temp.child("meta.ebp");
    fs::write(
        &patch_path,
        build_ebp_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"Z".to_vec(),
            }],
            DEFAULT_EBP_METADATA_JSON,
        ),
    )
    .expect("fixture");

    let report = IpsPatchHandler::new_ebp(&EBP)
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");
    assert!(report.label.contains("and metadata"), "{}", report.label);
}

#[test]
fn ebp_metadata_must_be_a_utf8_json_object_of_strings() {
    let not_utf8 = parse_ebp_metadata(&[0xff, 0xfe]).expect_err("invalid UTF-8 should fail");
    assert!(
        not_utf8.to_string().contains("not valid UTF-8 JSON"),
        "unexpected error: {not_utf8}"
    );

    let not_object = parse_ebp_metadata(b"[1,2]").expect_err("a JSON array should fail");
    assert!(
        not_object.to_string().contains("must be a JSON object"),
        "unexpected error: {not_object}"
    );

    let not_string =
        parse_ebp_metadata(br#"{"Title":3}"#).expect_err("a non-string value should fail");
    assert!(
        not_string.to_string().contains("`Title` must be a string"),
        "unexpected error: {not_string}"
    );

    let metadata = parse_ebp_metadata(DEFAULT_EBP_METADATA_JSON.as_bytes()).expect("default");
    assert_eq!(
        metadata.get("patcher"),
        Some(&JsonValue::String("EBPatcher".into()))
    );
}

#[test]
fn flips_limits_reject_an_exact_limit_output_that_needs_a_truncate_footer() {
    let limit = MAX_IPS_OFFSET + 1;
    let error = validate_ips_create_flips_limits(
        limit + 1,
        limit,
        IpsFlavor::Ips,
        PatchChecksumValidation::Strict,
    )
    .expect_err("a truncate footer at the limit is not encodable");
    assert!(
        error
            .to_string()
            .contains("cannot encode a truncate footer"),
        "unexpected error: {error}"
    );

    validate_ips_create_flips_limits(
        limit + 1,
        limit,
        IpsFlavor::Ips,
        PatchChecksumValidation::Ignore,
    )
    .expect("ignored validation skips the Flips limits");
    validate_ips_create_flips_limits(
        limit + 1,
        limit,
        IpsFlavor::Ips32,
        PatchChecksumValidation::Strict,
    )
    .expect("IPS32 has no Flips limit");
    validate_ips_create_flips_limits(
        limit,
        limit,
        IpsFlavor::Ips,
        PatchChecksumValidation::Strict,
    )
    .expect("an equal-sized output needs no truncate footer");
}

#[test]
fn coalescing_merges_short_gaps_and_splits_long_ones() {
    let temp = TestDir::new();
    let modified = temp.child("coalesce.bin");
    fs::write(&modified, b"ABCDEFGHIJ").expect("fixture");

    let merged = coalesce_ips_diff_runs(
        vec![
            IpsDiffRun {
                offset: 0,
                bytes: b"AB".to_vec(),
            },
            IpsDiffRun {
                offset: 4,
                bytes: b"EF".to_vec(),
            },
        ],
        &modified,
        IpsFlavor::Ips,
    )
    .expect("short gap merges");
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].offset, 0);
    assert_eq!(merged[0].bytes, b"ABCDEF");

    let split = coalesce_ips_diff_runs(
        vec![
            IpsDiffRun {
                offset: 0,
                bytes: b"AB".to_vec(),
            },
            IpsDiffRun {
                offset: 9,
                bytes: b"J".to_vec(),
            },
        ],
        &modified,
        IpsFlavor::Ips,
    )
    .expect("long gap splits");
    assert_eq!(split.len(), 2);
    assert_eq!(split[1].offset, 9);
}

#[test]
fn coalescing_rejects_overlapping_diff_runs() {
    let temp = TestDir::new();
    let modified = temp.child("overlap.bin");
    fs::write(&modified, b"ABCDEFGH").expect("fixture");

    let error = coalesce_ips_diff_runs(
        vec![
            IpsDiffRun {
                offset: 0,
                bytes: b"ABC".to_vec(),
            },
            IpsDiffRun {
                offset: 2,
                bytes: b"C".to_vec(),
            },
        ],
        &modified,
        IpsFlavor::Ips,
    )
    .expect_err("overlapping runs should fail");
    assert!(
        error.to_string().contains("overlapping diff runs"),
        "unexpected error: {error}"
    );
}

#[test]
fn diff_run_scan_reports_runs_and_treats_bytes_past_the_source_as_changed() {
    let runs = collect_ips_diff_runs_from_bytes(10, b"ABCD", b"AXCD", 14).expect("scan");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].offset, 11);
    assert_eq!(runs[0].bytes, b"X");

    // `original_len` stops before the last two bytes, so they count as changed
    // even though the padded source bytes match.
    let grown = collect_ips_diff_runs_from_bytes(0, b"AB\0\0", b"AB\0\0", 2).expect("scan");
    assert_eq!(grown.len(), 1);
    assert_eq!(grown[0].offset, 2);
    assert_eq!(grown[0].bytes, b"\0\0");
}

#[test]
fn record_length_adjustment_avoids_landing_on_the_eof_marker_offset() {
    let reserved = IPS_RESERVED_EOF_OFFSET;

    assert_eq!(
        adjust_record_len_for_reserved_offset(reserved, 0, 0, false, IpsFlavor::Ips)
            .expect("zero length is untouched"),
        0
    );

    let at_marker = adjust_record_len_for_reserved_offset(reserved, 4, 4, false, IpsFlavor::Ips)
        .expect_err("a record starting on the marker cannot be encoded");
    assert!(
        at_marker.to_string().contains("IPS record offset matched"),
        "unexpected error: {at_marker}"
    );

    assert_eq!(
        adjust_record_len_for_reserved_offset(reserved - 4, 4, 10, true, IpsFlavor::Ips)
            .expect("shortens so the next record misses the marker"),
        3
    );
    assert_eq!(
        adjust_record_len_for_reserved_offset(reserved - 1, 1, 5, true, IpsFlavor::Ips)
            .expect("grows past the marker when it cannot shrink"),
        2
    );

    let stuck = adjust_record_len_for_reserved_offset(
        IPS32_RESERVED_EOF_OFFSET - 1,
        1,
        1,
        true,
        IpsFlavor::Ips32,
    )
    .expect_err("a one-byte record with nothing after it cannot move");
    assert!(
        stuck.to_string().contains("IPS32 record split"),
        "unexpected error: {stuck}"
    );
}

#[test]
fn flavor_names_match_their_formats() {
    assert_eq!(flavor_name(IpsFlavor::Ips), "IPS");
    assert_eq!(flavor_name(IpsFlavor::Ips32), "IPS32");
    assert_eq!(flavor_name(IpsFlavor::Ebp), "EBP");
}

#[test]
fn rle_split_search_only_splits_runs_that_pay_for_a_record() {
    assert_eq!(repeated_prefix_len(b""), 0);
    assert_eq!(repeated_prefix_len(b"aaab"), 3);

    assert_eq!(find_next_rle_split(b"abcdefgh"), None);
    // A short interior run costs more as its own record than it saves.
    assert_eq!(find_next_rle_split(b"ab\x05\x05\x05\x05\x05cd"), None);
    assert_eq!(
        find_next_rle_split(b"\x07\x07\x07\x07\x07\x07\x07\x07\x07abc"),
        Some((0, 9))
    );
    assert_eq!(
        find_next_rle_split(b"ab\x09\x09\x09\x09\x09\x09\x09\x09\x09\x09\x09\x09\x09\x09cd"),
        Some((2, 14))
    );
}

#[test]
fn run_writer_emits_the_footer_and_trailer_for_every_flavor() {
    let run = || IpsDiffRun {
        offset: 0,
        bytes: b"AB".to_vec(),
    };

    let mut ebp = Vec::new();
    let created: IpsCreateResult =
        write_ips_runs_to_output(vec![run()], 2, 2, &mut ebp, IpsFlavor::Ebp).expect("ebp");
    assert_eq!(created.record_count, 1);
    assert!(ebp.starts_with(IPS_MAGIC));
    assert!(ebp.ends_with(DEFAULT_EBP_METADATA_JSON.as_bytes()));

    let mut ips32 = Vec::new();
    write_ips_runs_to_output(vec![run()], 2, 2, &mut ips32, IpsFlavor::Ips32).expect("ips32");
    assert!(ips32.starts_with(IPS32_MAGIC));
    assert!(ips32.ends_with(IPS32_EOF));

    let mut shrinking = Vec::new();
    write_ips_runs_to_output(vec![run()], 8, 4, &mut shrinking, IpsFlavor::Ips).expect("ips");
    assert_eq!(&shrinking[shrinking.len() - 3..], &[0x00, 0x00, 0x04]);

    let mut growing = Vec::new();
    write_ips_runs_to_output(vec![run()], 4, 8, &mut growing, IpsFlavor::Ips).expect("ips");
    assert!(growing.ends_with(IPS_EOF));
}

#[test]
fn truncate_footer_is_only_required_when_the_output_shrinks() {
    assert!(truncate_size_required(8, 4));
    assert!(!truncate_size_required(4, 8));
    assert!(!truncate_size_required(4, 4));
}

#[test]
fn chunk_planning_counts_output_and_scan_chunks() {
    assert_eq!(max_parallel_chunks(0).expect("empty output"), 1);
    assert_eq!(
        max_parallel_chunks(OUTPUT_CHUNK_SIZE).expect("one chunk"),
        1
    );
    assert_eq!(
        max_parallel_chunks(OUTPUT_CHUNK_SIZE + 1).expect("two chunks"),
        2
    );

    assert_eq!(ips_create_chunk_count(0).expect("empty input"), 1);
    assert_eq!(
        ips_create_chunk_count(CREATE_SCAN_CHUNK_BYTES as u64 + 1).expect("two chunks"),
        2
    );
    assert!(matches!(
        ips_create_thread_capability(CREATE_SCAN_CHUNK_BYTES as u64 + 1).expect("capability"),
        rom_weaver_core::ThreadCapability::Parallel {
            max_threads: Some(2)
        }
    ));
}

#[test]
fn record_offsets_are_range_checked_per_flavor() {
    let mut output = Vec::new();
    let over_24_bit = super::write_u24(&mut output, MAX_IPS_OFFSET + 1, "probe")
        .expect_err("a 25-bit offset should fail");
    assert!(
        over_24_bit.to_string().contains("IPS 24-bit limit"),
        "unexpected error: {over_24_bit}"
    );

    let over_32_bit = super::write_u32(&mut output, MAX_IPS32_OFFSET + 1, "probe")
        .expect_err("a 33-bit offset should fail");
    assert!(
        over_32_bit.to_string().contains("IPS32 32-bit limit"),
        "unexpected error: {over_32_bit}"
    );

    for (flavor, offset) in [
        (IpsFlavor::Ips, IPS_RESERVED_EOF_OFFSET),
        (IpsFlavor::Ebp, IPS_RESERVED_EOF_OFFSET),
        (IpsFlavor::Ips32, IPS32_RESERVED_EOF_OFFSET),
    ] {
        let error = write_offset(&mut output, offset, flavor)
            .expect_err("the reserved offset is not encodable");
        assert!(
            error.to_string().contains("matched its EOF marker"),
            "unexpected error: {error}"
        );
    }

    super::write_u24(&mut output, MAX_IPS_OFFSET, "probe").expect("the 24-bit maximum encodes");
    assert_eq!(
        decode_u24(&output[output.len() - 3..]),
        MAX_IPS_OFFSET as u32
    );
    super::write_u32(&mut output, MAX_IPS32_OFFSET, "probe").expect("the 32-bit maximum encodes");
    assert_eq!(
        decode_u32(&output[output.len() - 4..]),
        MAX_IPS32_OFFSET as u32
    );
}

#[test]
fn record_writers_skip_empty_payloads_and_reject_over_long_ones() {
    let mut output = Vec::new();
    let mut created = IpsCreateResult::default();

    write_literal_record(&mut output, 0, &[], &mut created, IpsFlavor::Ips).expect("empty literal");
    write_rle_record(&mut output, 0, 0, 0x5A, &mut created, IpsFlavor::Ips).expect("empty rle");
    assert!(output.is_empty());
    assert_eq!(created.record_count, 0);

    let over_long = vec![0u8; MAX_IPS_RECORD_LEN + 1];
    let literal_error =
        write_literal_record(&mut output, 0, &over_long, &mut created, IpsFlavor::Ips)
            .expect_err("an over-long literal should fail");
    assert!(
        literal_error
            .to_string()
            .contains("maximum encodable length"),
        "unexpected error: {literal_error}"
    );

    let rle_error = write_rle_record(
        &mut output,
        0,
        MAX_IPS_RECORD_LEN + 1,
        0x5A,
        &mut created,
        IpsFlavor::Ips,
    )
    .expect_err("an over-long RLE run should fail");
    assert!(
        rle_error.to_string().contains("maximum encodable length"),
        "unexpected error: {rle_error}"
    );
}

#[test]
fn checked_add_reports_the_label_that_overflowed() {
    let error = checked_add(u64::MAX, 1, "probe offset").expect_err("overflow should fail");
    assert!(
        error.to_string().contains("probe offset overflowed"),
        "unexpected error: {error}"
    );
    assert_eq!(checked_add(2, 3, "probe offset").expect("no overflow"), 5);
}

#[test]
fn file_parser_rejects_reads_past_the_end_of_the_patch() {
    let mut parser = IpsFileParser::new(std::io::Cursor::new(vec![0u8; 8]), 4);
    let error = parser
        .read_exact(5)
        .expect_err("reading past the file length should fail");
    assert!(
        error.to_string().contains("ended unexpectedly"),
        "unexpected error: {error}"
    );
    assert_eq!(parser.remaining().expect("remaining"), 4);
}

#[test]
fn record_overlap_detection_ignores_empty_records() {
    assert!(!records_overlap(&[
        ips_probe_record(0, 4),
        ips_probe_record(4, 4)
    ]));
    assert!(records_overlap(&[
        ips_probe_record(0, 5),
        ips_probe_record(4, 4)
    ]));
    assert!(!records_overlap(&[
        ips_probe_record(0, 4),
        ips_probe_record(2, 0)
    ]));
}

#[test]
fn probing_a_file_that_is_not_ips_reports_no_records() {
    let temp = TestDir::new();
    let too_short = temp.child("short.ips");
    let wrong_magic = temp.child("other.bin");
    fs::write(&too_short, b"PA").expect("short fixture");
    fs::write(&wrong_magic, b"NOTAPATCHFILE").expect("wrong-magic fixture");

    assert!(
        probe_ips_records(&too_short)
            .expect("short probe")
            .is_none()
    );
    assert!(
        probe_ips_records(&wrong_magic)
            .expect("wrong-magic probe")
            .is_none()
    );
}

#[test]
fn probing_reports_record_geometry_prefix_writes_and_truncate_size() {
    let temp = TestDir::new();
    let patch = temp.child("probe-geometry.ips");
    fs::write(
        &patch,
        build_ips_patch(
            vec![
                TestIpsRecord::Rle {
                    offset: 0,
                    len: 3,
                    value: 0x11,
                },
                TestIpsRecord::Literal {
                    offset: 1,
                    data: b"AB".to_vec(),
                },
                TestIpsRecord::Literal {
                    offset: 64,
                    data: b"Z".to_vec(),
                },
            ],
            Some(128),
        ),
    )
    .expect("fixture");

    let probed = probe_ips_records(&patch)
        .expect("probe")
        .expect("IPS patch");
    assert_eq!(probed.records.len(), 3);
    assert_eq!(probed.truncate_size, Some(128));
    assert_eq!(probed.records[0].first, 0x11);
    assert_eq!(probed.records[0].last, 0x11);
    assert_eq!(probed.records[1].first, b'A');
    assert_eq!(probed.records[1].last, b'B');
    // The later literal overwrites the RLE run at offsets 1 and 2, and no
    // record reaches offset 3.
    assert_eq!(
        probed.prefix_writes,
        [Some(0x11), Some(b'A'), Some(b'B'), None]
    );
    assert_eq!(IPS_PROBE_PREFIX_BYTES, 4);
}

#[test]
fn probing_selects_the_ebp_flavor_from_the_file_extension() {
    let temp = TestDir::new();
    let as_ebp = temp.child("flavored.ebp");
    let as_ips = temp.child("flavored.ips");
    let bytes = build_ebp_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: b"A".to_vec(),
        }],
        "{not json",
    );
    fs::write(&as_ebp, &bytes).expect("ebp fixture");
    fs::write(&as_ips, &bytes).expect("ips fixture");

    let error = probe_ips_records(&as_ebp).expect_err("EBP metadata is parsed for a .ebp file");
    assert!(
        error.to_string().contains("not valid JSON"),
        "unexpected error: {error}"
    );

    // The same bytes under a .ips name are classic IPS, whose probe ignores the
    // trailing block instead of decoding it as metadata.
    let probed = probe_ips_records(&as_ips)
        .expect("ips probe")
        .expect("IPS patch");
    assert_eq!(probed.records.len(), 1);
}

#[test]
fn probing_reads_ips32_offsets_past_the_24_bit_limit() {
    let temp = TestDir::new();
    let patch = temp.child("wide.ips32");
    fs::write(
        &patch,
        build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0000,
            data: b"QR".to_vec(),
        }]),
    )
    .expect("fixture");

    let probed = probe_ips_records(&patch)
        .expect("probe")
        .expect("IPS32 patch");
    assert_eq!(probed.records.len(), 1);
    assert_eq!(probed.records[0].offset, 0x0100_0000);
    assert_eq!(probed.prefix_writes, [None; IPS_PROBE_PREFIX_BYTES]);
}
