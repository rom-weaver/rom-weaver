use std::fs;

use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

use super::{
    CREATE_THREAD_SCAN_CHUNK_BYTES, FILE_ID_BEGIN_MARKER, FILE_ID_END_MARKER,
    PPF_VALIDATION_BLOCK_SIZE, PPF2_BLOCKCHECK_OFFSET, PpfPatchHandler, PpfVersion,
    parse_ppf_bytes,
};
use crate::{
    PPF,
    test_support::{TestDir, test_context_with_threads},
};

#[derive(Clone)]
struct V1V2Record {
    offset: u32,
    data: Vec<u8>,
}

#[derive(Clone)]
struct V3Record {
    offset: u64,
    data: Vec<u8>,
    undo: Vec<u8>,
}

#[test]
fn parse_and_apply_round_trip_for_ppf1() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("output.bin");

    fs::write(&input_path, b"abcdefgh").expect("fixture");
    fs::write(
        &patch_path,
        build_ppf1_patch(
            "PPF1 test",
            vec![
                V1V2Record {
                    offset: 2,
                    data: b"XYZ".to_vec(),
                },
                V1V2Record {
                    offset: 7,
                    data: b"!!!!".to_vec(),
                },
            ],
        ),
    )
    .expect("fixture");

    let patch_bytes = fs::read(&patch_path).expect("patch");
    let parsed = parse_ppf_bytes(&patch_bytes).expect("parse");
    assert_eq!(parsed.records.len(), 2);

    let handler = PpfPatchHandler::new(&PPF);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");

    assert!(handler.capabilities().threaded_output);
    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 2);
    assert!(execution.used_parallelism);

    assert_eq!(fs::read(output_path).expect("output"), b"abXYZfg!!!!");
}

#[test]
fn apply_round_trip_for_ppf2_with_validation() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("output.bin");

    let mut input = vec![0u8; (PPF2_BLOCKCHECK_OFFSET as usize) + PPF_VALIDATION_BLOCK_SIZE + 32];
    for (index, byte) in input.iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    fs::write(&input_path, &input).expect("fixture");

    let block = input[PPF2_BLOCKCHECK_OFFSET as usize
        ..PPF2_BLOCKCHECK_OFFSET as usize + PPF_VALIDATION_BLOCK_SIZE]
        .to_vec();

    fs::write(
        &patch_path,
        build_ppf2_patch(
            "PPF2 test",
            input.len() as u32,
            &block,
            vec![V1V2Record {
                offset: 4,
                data: b"ZZ".to_vec(),
            }],
        ),
    )
    .expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("apply");

    let mut expected = input;
    expected[4] = b'Z';
    expected[5] = b'Z';
    assert_eq!(fs::read(output_path).expect("output"), expected);
}

#[test]
fn apply_rejects_ppf2_when_input_size_mismatches() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("output.bin");

    let mut input = vec![0u8; (PPF2_BLOCKCHECK_OFFSET as usize) + PPF_VALIDATION_BLOCK_SIZE + 1];
    for (index, byte) in input.iter_mut().enumerate() {
        *byte = (index % 199) as u8;
    }
    fs::write(&input_path, &input).expect("fixture");
    let block = input[PPF2_BLOCKCHECK_OFFSET as usize
        ..PPF2_BLOCKCHECK_OFFSET as usize + PPF_VALIDATION_BLOCK_SIZE]
        .to_vec();

    fs::write(
        &patch_path,
        build_ppf2_patch(
            "PPF2 bad size",
            (input.len() as u32).saturating_add(1),
            &block,
            vec![V1V2Record {
                offset: 0,
                data: vec![0xFF],
            }],
        ),
    )
    .expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("apply should fail");

    assert!(error.to_string().contains("PPF2 input size invalid"));
}

#[test]
fn apply_round_trip_for_ppf3_with_undo_and_blockcheck() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("output.bin");

    let block_offset = 0x80A0usize;
    let mut input = vec![0u8; block_offset + PPF_VALIDATION_BLOCK_SIZE + 64];
    for (index, byte) in input.iter_mut().enumerate() {
        *byte = (index % 241) as u8;
    }
    fs::write(&input_path, &input).expect("fixture");

    let block = input[block_offset..block_offset + PPF_VALIDATION_BLOCK_SIZE].to_vec();

    fs::write(
        &patch_path,
        build_ppf3_patch(
            "PPF3 test",
            1,
            true,
            true,
            Some(&block),
            vec![V3Record {
                offset: 3,
                data: b"PATCH".to_vec(),
                undo: b"-----".to_vec(),
            }],
        ),
    )
    .expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 3),
        )
        .expect("apply");

    let mut expected = input;
    expected[3..8].copy_from_slice(b"PATCH");
    assert_eq!(fs::read(output_path).expect("output"), expected);
}

#[test]
fn apply_uses_undo_data_when_reapplying_ppf3_undo_patch() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");
    let once_path = temp.child("once.bin");
    let twice_path = temp.child("twice.bin");

    let original = b"abcdefghij".to_vec();
    fs::write(&input_path, &original).expect("fixture");
    fs::write(
        &patch_path,
        build_ppf3_patch(
            "PPF3 undo test",
            0,
            false,
            true,
            None,
            vec![V3Record {
                offset: 2,
                data: b"XYZ".to_vec(),
                undo: b"cde".to_vec(),
            }],
        ),
    )
    .expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path.clone(),
                patches: vec![patch_path.clone()],
                output: once_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("first apply");
    assert_eq!(fs::read(&once_path).expect("first output"), b"abXYZfghij");

    handler
        .apply(
            &PatchApplyRequest {
                input: once_path,
                patches: vec![patch_path],
                output: twice_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("second apply");
    assert_eq!(fs::read(twice_path).expect("second output"), original);
}

#[test]
fn parse_rejects_truncated_ppf3_record() {
    let mut patch = build_ppf3_patch(
        "bad",
        0,
        false,
        false,
        None,
        vec![V3Record {
            offset: 0,
            data: vec![1, 2, 3],
            undo: Vec::new(),
        }],
    );
    patch.pop();

    let error = parse_ppf_bytes(&patch).expect_err("truncated record should fail");
    assert!(
        error
            .to_string()
            .contains("PPF3 record data exceeded patch bounds")
    );
}

#[test]
fn parse_accepts_ppf3_with_rompatcher_style_file_id_diz_trailer() {
    let mut patch = build_ppf3_patch(
        "with file id",
        0,
        false,
        false,
        None,
        vec![V3Record {
            offset: 1,
            data: b"AB".to_vec(),
            undo: Vec::new(),
        }],
    );
    append_rompatcher_file_id_diz_trailer(&mut patch, "hello from file id");

    let parsed = parse_ppf_bytes(&patch).expect("parse should succeed");
    assert_eq!(parsed.version, PpfVersion::V3);
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].offset, 1);
    assert_eq!(parsed.records[0].data.as_slice(), b"AB");
}

#[test]
fn parse_rejects_inconsistent_version_tuple() {
    let mut patch = build_ppf1_patch("bad version", Vec::new());
    patch[5] = 2;

    let error = parse_ppf_bytes(&patch).expect_err("inconsistent tuple should fail");
    assert!(error.to_string().contains("version tuple is inconsistent"));
}

#[test]
fn create_and_apply_round_trip_for_ppf3() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("output.bin");

    let original = b"hello old world".to_vec();
    let mut modified = b"hello new world".to_vec();
    modified.extend_from_slice(&[0, 0, 0]);
    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_path.clone(),
                format: "PPF".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");
    let execution = create_report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);

    let patch_bytes = fs::read(&patch_path).expect("patch");
    let parsed = parse_ppf_bytes(&patch_bytes).expect("parse");
    assert_eq!(parsed.version, PpfVersion::V3);
    assert!(!parsed.records.is_empty());

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

    assert_eq!(fs::read(output_path).expect("output"), modified);
}

#[test]
fn create_uses_parallel_threads_for_large_input() {
    let temp = TestDir::new();
    let original_path = temp.child("original-large.bin");
    let modified_path = temp.child("modified-large.bin");
    let patch_path = temp.child("update-large.ppf");

    let mut original = vec![0u8; (CREATE_THREAD_SCAN_CHUNK_BYTES * 2) + 4096];
    for (index, byte) in original.iter_mut().enumerate() {
        *byte = (index as u8).wrapping_mul(7);
    }
    let mut modified = original.clone();
    for byte in &mut modified[..1024] {
        *byte = byte.wrapping_add(1);
    }
    let boundary = CREATE_THREAD_SCAN_CHUNK_BYTES;
    for byte in &mut modified[(boundary - 128)..(boundary + 128)] {
        *byte = byte.wrapping_add(3);
    }

    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path,
                format: "PPF".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");
    let execution = create_report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert!(execution.effective_threads >= 2);
    assert!(execution.used_parallelism);
}

#[test]
fn create_enables_blockcheck_when_source_is_large_enough() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.ppf");

    let min_len = (PPF2_BLOCKCHECK_OFFSET as usize) + PPF_VALIDATION_BLOCK_SIZE + 8;
    let mut original = vec![0u8; min_len];
    for (index, byte) in original.iter_mut().enumerate() {
        *byte = (index % 239) as u8;
    }
    let mut modified = original.clone();
    modified[4] = modified[4].wrapping_add(1);

    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "PPF".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let patch_bytes = fs::read(&patch_path).expect("patch");
    let parsed = parse_ppf_bytes(&patch_bytes).expect("parse");
    assert_eq!(parsed.version, PpfVersion::V3);
    assert!(parsed.blockcheck.is_some());
}

#[test]
fn create_splits_runs_larger_than_u8_max() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.ppf");

    let original = vec![0u8; 1024];
    let modified = vec![0xAB; 1024];
    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "PPF".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let patch_bytes = fs::read(&patch_path).expect("patch");
    let parsed = parse_ppf_bytes(&patch_bytes).expect("parse");
    assert_eq!(parsed.version, PpfVersion::V3);
    assert_eq!(parsed.records.len(), 5);
    assert_eq!(parsed.records[0].offset, 0);
    assert_eq!(parsed.records[0].data.len(), 255);
    assert_eq!(parsed.records[4].offset, 1020);
    assert_eq!(parsed.records[4].data.len(), 4);
}

#[test]
fn create_rejects_shrinking_outputs() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("update.ppf");
    fs::write(&original_path, b"abcdef").expect("fixture");
    fs::write(&modified_path, b"abc").expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    let error = handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path,
                format: "PPF".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("create should fail");

    assert!(
        error
            .to_string()
            .contains("does not support shrinking outputs")
    );
}

fn build_ppf1_patch(description: &str, records: Vec<V1V2Record>) -> Vec<u8> {
    let mut bytes = build_header(PpfHeaderVersion::V1, description, 0);
    push_v1_v2_records(&mut bytes, records);
    bytes
}

fn build_ppf2_patch(
    description: &str,
    expected_len: u32,
    block: &[u8],
    records: Vec<V1V2Record>,
) -> Vec<u8> {
    assert_eq!(block.len(), PPF_VALIDATION_BLOCK_SIZE);
    let mut bytes = build_header(PpfHeaderVersion::V2, description, 1);
    bytes.extend_from_slice(&expected_len.to_le_bytes());
    bytes.extend_from_slice(block);
    push_v1_v2_records(&mut bytes, records);
    bytes
}

fn build_ppf3_patch(
    description: &str,
    imagetype: u8,
    blockcheck: bool,
    undo: bool,
    block: Option<&[u8]>,
    records: Vec<V3Record>,
) -> Vec<u8> {
    let mut bytes = build_header(PpfHeaderVersion::V3, description, 2);
    bytes.push(imagetype);
    bytes.push(u8::from(blockcheck));
    bytes.push(u8::from(undo));
    bytes.push(0);

    if blockcheck {
        let block = block.expect("blockcheck bytes");
        assert_eq!(block.len(), PPF_VALIDATION_BLOCK_SIZE);
        bytes.extend_from_slice(block);
    }

    for record in records {
        bytes.extend_from_slice(&record.offset.to_le_bytes());
        bytes.push(record.data.len() as u8);
        bytes.extend_from_slice(&record.data);
        if undo {
            assert_eq!(record.undo.len(), record.data.len());
            bytes.extend_from_slice(&record.undo);
        }
    }

    bytes
}

fn push_v1_v2_records(bytes: &mut Vec<u8>, records: Vec<V1V2Record>) {
    for record in records {
        bytes.extend_from_slice(&record.offset.to_le_bytes());
        bytes.push(record.data.len() as u8);
        bytes.extend_from_slice(&record.data);
    }
}

#[derive(Clone, Copy)]
enum PpfHeaderVersion {
    V1,
    V2,
    V3,
}

fn build_header(version: PpfHeaderVersion, description: &str, method: u8) -> Vec<u8> {
    let version_digit = match version {
        PpfHeaderVersion::V1 => b'1',
        PpfHeaderVersion::V2 => b'2',
        PpfHeaderVersion::V3 => b'3',
    };

    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"PPF");
    bytes.push(version_digit);
    bytes.push(b'0');
    bytes.push(method);
    let mut desc = [0u8; 50];
    let src = description.as_bytes();
    let copy_len = src.len().min(desc.len());
    desc[..copy_len].copy_from_slice(&src[..copy_len]);
    bytes.extend_from_slice(&desc);
    bytes
}

fn append_rompatcher_file_id_diz_trailer(bytes: &mut Vec<u8>, diz: &str) {
    bytes.extend_from_slice(FILE_ID_BEGIN_MARKER);
    bytes.extend_from_slice(diz.as_bytes());
    bytes.extend_from_slice(FILE_ID_END_MARKER);

    let diz_len = u16::try_from(diz.len()).expect("diz length must fit u16");
    bytes.extend_from_slice(&diz_len.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
}
