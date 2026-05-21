use std::{
    fs,
    io::{Seek, SeekFrom, Write},
    path::PathBuf,
};

use rom_weaver_core::{OperationContext, PatchApplyRequest, PatchCreateRequest, PatchHandler};

use super::{
    CREATE_SCAN_CHUNK_BYTES, DEFAULT_EBP_METADATA_JSON, IPS_EOF, IPS_MAGIC, IPS32_EOF, IPS32_MAGIC,
    IpsFlavor, IpsPatchHandler, IpsRecordData, JsonValue, MAX_IPS_RECORD_LEN, OUTPUT_CHUNK_SIZE,
    parse_ips_bytes,
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
fn parse_rejects_records_beyond_declared_output_size() {
    let patch = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 4,
            data: b"toolong".to_vec(),
        }],
        Some(6),
    );

    let error = parse_ips_bytes(&patch, IpsFlavor::Ips).expect_err("invalid patch");
    assert!(
        error
            .to_string()
            .contains("IPS record exceeded declared output size")
    );
}

#[test]
fn parse_accepts_zero_length_rle_records_with_warning() {
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

    let parsed = parse_ips_bytes(&patch, IpsFlavor::Ips).expect("parse");
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
fn parse_accepts_trailing_bytes_after_eof_with_warning() {
    let mut patch = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: b"A".to_vec(),
        }],
        None,
    );
    patch.extend_from_slice(&[0xDE, 0xAD]);

    let parsed = parse_ips_bytes(&patch, IpsFlavor::Ips).expect("parse");
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
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
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
            &test_context_with_threads(&temp, 1),
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

    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
    assert_eq!(fs::read(&output_path).expect("output"), b"a1XYZf!!!");
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

    let execution = report.thread_execution.expect("thread execution");
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
fn create_can_grow_with_zero_tail_using_only_truncate_size() {
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
    assert_eq!(patch.truncate_size, Some(32));
    assert!(patch.records.is_empty());

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

    let patch = fs::read(&patch_path).expect("patch");
    assert_eq!(patch, b"PATCHEOF");
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
