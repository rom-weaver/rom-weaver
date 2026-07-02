use std::fs;

use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

use super::{
    CREATE_THREAD_SCAN_CHUNK_BYTES, FILE_ID_BEGIN_MARKER, FILE_ID_END_MARKER,
    PPF_VALIDATION_BLOCK_SIZE, PPF2_BLOCKCHECK_OFFSET, PpfPatchHandler, PpfVersion,
    collect_ppf_chunk_diff_runs, collect_ppf_chunk_diff_runs_from_bytes, parse_ppf_bytes,
    parse_ppf_file,
};
use crate::{
    PPF, read_original_modified_chunk,
    test_support::{TestDir, test_context_with_threads},
};

/// Regression: when the modified file grows past the original, every new byte -- including a
/// 0x00 -- is new content and must be recorded. The main-thread-read path buffers the original
/// zero-filled past its length, so it must compare positions past `original_len` as always
/// changed (mirroring the worker-read path) instead of equating a new 0x00 byte with the
/// zero padding. Otherwise the two read modes produce different PPF patches and a trailing
/// 0x00 could be dropped from the output entirely.
#[test]
fn ppf_create_scan_agrees_on_zero_bytes_past_original_eof() {
    let temp = TestDir::new();
    let original = temp.child("orig.bin");
    let modified = temp.child("mod.bin");
    let original_bytes = [1u8, 2, 3, 4];
    // Three new bytes past the original EOF, two of which are 0x00 (including the final byte).
    let modified_bytes = [1u8, 2, 3, 4, 0, 9, 0];
    fs::write(&original, original_bytes).expect("write original");
    fs::write(&modified, modified_bytes).expect("write modified");
    let original_len = original_bytes.len() as u64;
    let modified_len = modified_bytes.len() as u64;

    let worker_read =
        collect_ppf_chunk_diff_runs(&original, original_len, &modified, 0, modified_len)
            .expect("worker-read scan");

    let (original_chunk, modified_chunk) =
        read_original_modified_chunk(&original, original_len, &modified, 0, modified_len)
            .expect("buffer chunk");
    let main_thread_read =
        collect_ppf_chunk_diff_runs_from_bytes(0, &original_chunk, &modified_chunk, original_len)
            .expect("main-thread-read scan");

    assert_eq!(
        worker_read, main_thread_read,
        "worker-read and main-thread-read PPF scans must produce identical diff runs"
    );
    // The three new bytes at offsets 4..7 form one contiguous run, zeros included.
    assert_eq!(worker_read.len(), 1, "expected a single trailing diff run");
    assert_eq!(worker_read[0].offset, 4);
    assert_eq!(worker_read[0].len, 3);
}

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
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);

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
fn apply_ignores_ppf3_undo_data_in_normal_apply_mode() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("output.bin");

    fs::write(&input_path, b"abXYZfghij").expect("fixture");
    fs::write(
        &patch_path,
        build_ppf3_patch(
            "PPF3 undo test",
            0,
            false,
            true,
            None,
            vec![
                V3Record {
                    offset: 2,
                    data: b"XYZ".to_vec(),
                    undo: b"cde".to_vec(),
                },
                V3Record {
                    offset: 7,
                    data: b"12".to_vec(),
                    undo: b"hi".to_vec(),
                },
            ],
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
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");
    assert_eq!(fs::read(output_path).expect("output"), b"abXYZfg12j");
}

/// Builds an original ROM whose game-image blockcheck region is overwritten by a single
/// PPF3 record that lives *inside* that region, returning (original, already_patched,
/// block, record).
fn ppf3_blockcheck_overlap_fixture() -> (Vec<u8>, Vec<u8>, Vec<u8>, V3Record) {
    let block_offset = 0x80A0usize;
    let mut original = vec![0u8; block_offset + PPF_VALIDATION_BLOCK_SIZE + 64];
    for (index, byte) in original.iter_mut().enumerate() {
        *byte = (index % 241) as u8;
    }
    let block = original[block_offset..block_offset + PPF_VALIDATION_BLOCK_SIZE].to_vec();

    let record_offset = block_offset + 16;
    let data = b"PATCHED!".to_vec();
    let undo = original[record_offset..record_offset + data.len()].to_vec();

    let mut already_patched = original.clone();
    already_patched[record_offset..record_offset + data.len()].copy_from_slice(&data);

    let record = V3Record {
        offset: record_offset as u64,
        data,
        undo,
    };
    (original, already_patched, block, record)
}

#[test]
fn apply_rejects_re_patch_when_not_undo_aware() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("output.bin");

    let (_original, already_patched, block, record) = ppf3_blockcheck_overlap_fixture();
    fs::write(&input_path, &already_patched).expect("fixture");
    fs::write(
        &patch_path,
        build_ppf3_patch("PPF3 overlap", 1, true, true, Some(&block), vec![record]),
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
        .expect_err("re-apply over patched input should fail blockcheck");
    assert!(
        error
            .to_string()
            .contains("binblock/patchvalidation failed")
    );
}

#[test]
fn apply_undo_aware_re_patches_already_patched_input() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("output.bin");

    let (_original, already_patched, block, record) = ppf3_blockcheck_overlap_fixture();
    fs::write(&input_path, &already_patched).expect("fixture");
    fs::write(
        &patch_path,
        build_ppf3_patch("PPF3 overlap", 1, true, true, Some(&block), vec![record]),
    )
    .expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1).with_ppf_undo_aware(true),
        )
        .expect("undo-aware re-apply should succeed");

    // Output is the fully patched ROM (idempotent for byte writes).
    assert_eq!(fs::read(output_path).expect("output"), already_patched);
    assert!(report.label.contains("undo-aware re-apply"));
}

#[test]
fn apply_undo_aware_is_noop_for_clean_input() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("output.bin");

    let (original, already_patched, block, record) = ppf3_blockcheck_overlap_fixture();
    fs::write(&input_path, &original).expect("fixture");
    fs::write(
        &patch_path,
        build_ppf3_patch("PPF3 overlap", 1, true, true, Some(&block), vec![record]),
    )
    .expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1).with_ppf_undo_aware(true),
        )
        .expect("undo-aware apply on clean input should succeed");

    // Clean input patches normally and nothing is reconstructed.
    assert_eq!(fs::read(output_path).expect("output"), already_patched);
    assert!(!report.label.contains("undo-aware re-apply"));
}

#[test]
fn apply_undo_aware_notes_already_patched_without_blockcheck() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("output.bin");

    // Already-patched input (offset 2 holds "XYZ", the patch data; undo is "cde").
    fs::write(&input_path, b"abXYZfghij").expect("fixture");
    fs::write(
        &patch_path,
        build_ppf3_patch(
            "PPF3 no blockcheck",
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
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1).with_ppf_undo_aware(true),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), b"abXYZfghij");
    assert!(report.label.contains("input already patched"));
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
fn parse_file_accepts_ppf3_with_multipatch_file_id_diz_trailer() {
    let temp = TestDir::new();
    let patch_path = temp.child("update.ppf");
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
    append_multipatch_file_id_diz_trailer(&mut patch, "hello from file id");
    fs::write(&patch_path, patch).expect("fixture");

    let parsed = parse_ppf_file(&patch_path).expect("parse should succeed");
    assert_eq!(parsed.version, PpfVersion::V3);
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].offset, 1);
    assert_eq!(parsed.records[0].data.as_slice(), b"AB");
}

#[test]
fn parse_file_accepts_ppf3_with_padded_file_id_diz_trailer() {
    let temp = TestDir::new();
    let patch_path = temp.child("update.ppf");
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
    fs::write(&patch_path, patch).expect("fixture");

    let parsed = parse_ppf_file(&patch_path).expect("parse should succeed");
    assert_eq!(parsed.version, PpfVersion::V3);
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].offset, 1);
    assert_eq!(parsed.records[0].data.as_slice(), b"AB");
}

#[test]
fn parse_file_accepts_ppf2_with_file_id_diz_trailer() {
    let temp = TestDir::new();
    let patch_path = temp.child("update.ppf");
    let block = vec![0u8; PPF_VALIDATION_BLOCK_SIZE];
    let mut patch = build_ppf2_patch(
        "PPF2 with file id",
        128,
        &block,
        vec![V1V2Record {
            offset: 4,
            data: b"ZZ".to_vec(),
        }],
    );
    append_ppf2_file_id_diz_trailer(&mut patch, "hello from file id");
    fs::write(&patch_path, patch).expect("fixture");

    let parsed = parse_ppf_file(&patch_path).expect("parse should succeed");
    assert_eq!(parsed.version, PpfVersion::V2);
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].offset, 4);
    assert_eq!(parsed.records[0].data.as_slice(), b"ZZ");
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

/// Parity regression: a changed run that straddles a parallel-scan chunk boundary must
/// produce byte-identical patch output whether the scan ran serially (one chunk) or in
/// parallel (multiple chunks). The merge must fully fuse the run across the boundary and
/// re-split into maximal 255-byte records, so record boundaries never depend on thread count.
#[test]
fn create_parallel_matches_serial_across_chunk_boundary() {
    let temp = TestDir::new();
    let original_path = temp.child("original.bin");
    let modified_path = temp.child("modified.bin");
    let serial_patch = temp.child("serial.ppf");
    let parallel_patch = temp.child("parallel.ppf");

    // Size the inputs just past one scan chunk so the parallel path uses two chunks.
    let boundary = CREATE_THREAD_SCAN_CHUNK_BYTES;
    let total = boundary + 1024;
    let original = vec![0u8; total];
    let mut modified = original.clone();
    // A 600-byte changed run straddling the chunk boundary: longer than a single 255-byte
    // record so misaligned re-chunking would diverge from the serial output.
    for byte in modified[boundary - 300..boundary + 300].iter_mut() {
        *byte = 0xCD;
    }
    fs::write(&original_path, &original).expect("write original");
    fs::write(&modified_path, &modified).expect("write modified");

    let handler = PpfPatchHandler::new(&PPF);
    handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: serial_patch.clone(),
                format: "PPF".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("serial create");

    let parallel_report = handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: parallel_patch.clone(),
                format: "PPF".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("parallel create");
    let parallel_execution = parallel_report
        .thread_execution
        .expect("parallel create reports thread execution");
    assert!(
        parallel_execution.used_parallelism,
        "test must exercise the parallel scan path"
    );

    let serial_bytes = fs::read(&serial_patch).expect("serial patch");
    let parallel_bytes = fs::read(&parallel_patch).expect("parallel patch");
    assert_eq!(
        serial_bytes, parallel_bytes,
        "parallel PPF create must be byte-identical to serial across a chunk boundary"
    );
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

fn append_multipatch_file_id_diz_trailer(bytes: &mut Vec<u8>, diz: &str) {
    bytes.extend_from_slice(FILE_ID_BEGIN_MARKER);
    bytes.extend_from_slice(diz.as_bytes());
    bytes.extend_from_slice(FILE_ID_END_MARKER);

    let diz_len = u16::try_from(diz.len()).expect("diz length must fit u16");
    bytes.extend_from_slice(&diz_len.to_le_bytes());
}

fn append_ppf2_file_id_diz_trailer(bytes: &mut Vec<u8>, diz: &str) {
    bytes.extend_from_slice(FILE_ID_BEGIN_MARKER);
    bytes.extend_from_slice(diz.as_bytes());
    bytes.extend_from_slice(FILE_ID_END_MARKER);

    let diz_len = u32::try_from(diz.len()).expect("diz length must fit u32");
    bytes.extend_from_slice(&diz_len.to_le_bytes());
}
