use std::{
    fs::{self, OpenOptions},
    path::Path,
};

use rom_weaver_core::{
    PatchApplyRequest, PatchCreateRequest, PatchHandler, PatchValidateRequest, ProbeConfidence,
    ThreadCapability,
};

use super::{
    CREATE_THREAD_SCAN_CHUNK_BYTES, FILE_ID_BEGIN_MARKER, FILE_ID_END_MARKER, FileIdTrailerKind,
    PPF_HEADER_MIN_SIZE, PPF_VALIDATION_BLOCK_SIZE, PPF2_BLOCKCHECK_OFFSET, PpfPatchHandler,
    PpfRecord, PpfVersion, collect_ppf_chunk_diff_runs, collect_ppf_chunk_diff_runs_from_bytes,
    parse_ppf_bytes, parse_ppf_file, undo_ppf,
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
                input: input_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");

    assert!(handler.capabilities().threaded_output);
    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    // The test context sets the in-memory limit to 0, which PPF now honours, so
    // this is the streaming path: one thread per non-overlapping record.
    assert_eq!(execution.effective_threads, 2);

    assert_eq!(fs::read(&output_path).expect("output"), b"abXYZfg!!!!");

    let in_memory_output = temp.child("output-in-memory.bin");
    let in_memory = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: in_memory_output.clone(),
            },
            &test_context_with_threads(&temp, 8).with_patch_apply_in_memory_limit(u64::MAX),
        )
        .expect("apply in memory");

    let in_memory_execution = in_memory.thread_execution.expect("thread execution");
    assert_eq!(in_memory_execution.effective_threads, 1);
    assert!(!in_memory_execution.used_parallelism);
    assert_eq!(fs::read(in_memory_output).expect("output"), b"abXYZfg!!!!");
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
fn apply_rejects_re_patch_when_blockcheck_does_not_match() {
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
fn undo_ppf_restores_the_original_rom() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");
    let applied_path = temp.child("applied.bin");
    let restored_path = temp.child("restored.bin");

    let (original, _already_patched, block, record) = ppf3_blockcheck_overlap_fixture();
    fs::write(&input_path, &original).expect("fixture");
    fs::write(
        &patch_path,
        build_ppf3_patch("PPF3 undo", 1, true, true, Some(&block), vec![record]),
    )
    .expect("fixture");

    PpfPatchHandler::new(&PPF)
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path.clone()],
                output: applied_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");
    undo_ppf(&applied_path, &patch_path, &restored_path).expect("undo");

    assert_eq!(fs::read(restored_path).expect("restored output"), original);
}

#[test]
fn undo_rejects_a_patch_without_complete_undo_data() {
    let temp = TestDir::new();
    let input_path = temp.child("patched.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("restored.bin");
    fs::write(&input_path, b"patched").expect("input");
    fs::write(
        &patch_path,
        build_ppf1_patch(
            "PPF1 has no undo data",
            vec![V1V2Record {
                offset: 0,
                data: b"original".to_vec(),
            }],
        ),
    )
    .expect("patch");

    let error =
        undo_ppf(&input_path, &patch_path, &output_path).expect_err("PPF1 cannot be undone");

    assert!(
        error
            .to_string()
            .contains("does not contain complete undo data")
    );
    assert!(
        !output_path.exists(),
        "rejected undo must not create output"
    );
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

/// Writes `bytes` to a fresh patch file and returns the `parse_ppf_file` error string,
/// failing the test if parsing unexpectedly succeeds. Exercises the production (path-based)
/// parser rather than the in-memory `#[cfg(test)]` helper.
fn parse_file_err(bytes: &[u8]) -> String {
    let temp = TestDir::new();
    let patch_path = temp.child("malformed.ppf");
    fs::write(&patch_path, bytes).expect("write malformed patch");
    parse_ppf_file(&patch_path)
        .expect_err("parse should reject malformed patch")
        .to_string()
}

/// A 1024-byte validation block whose bytes vary so a mismatch is unambiguous.
fn sample_block() -> Vec<u8> {
    (0..PPF_VALIDATION_BLOCK_SIZE)
        .map(|index| (index % 251) as u8)
        .collect()
}

/// Builds an input whose PPF2 blockcheck region (`PPF2_BLOCKCHECK_OFFSET..+1024`) is captured
/// as the expected validation block, returning `(input_bytes, block)`.
fn ppf2_blockcheck_input() -> (Vec<u8>, Vec<u8>) {
    let mut input = vec![0u8; (PPF2_BLOCKCHECK_OFFSET as usize) + PPF_VALIDATION_BLOCK_SIZE + 16];
    for (index, byte) in input.iter_mut().enumerate() {
        *byte = (index % 247) as u8;
    }
    let block = input[PPF2_BLOCKCHECK_OFFSET as usize
        ..PPF2_BLOCKCHECK_OFFSET as usize + PPF_VALIDATION_BLOCK_SIZE]
        .to_vec();
    (input, block)
}

#[test]
fn parse_method_reports_ppf1_record_count() {
    let temp = TestDir::new();
    let patch_path = temp.child("p.ppf");
    fs::write(
        &patch_path,
        build_ppf1_patch(
            "PPF1 parse",
            vec![
                V1V2Record {
                    offset: 0,
                    data: b"AB".to_vec(),
                },
                V1V2Record {
                    offset: 8,
                    data: b"C".to_vec(),
                },
            ],
        ),
    )
    .expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");
    assert!(report.label.contains("PPF1"), "label: {}", report.label);
    assert!(
        report.label.contains("2 record(s)"),
        "label: {}",
        report.label
    );
    assert!(!report.label.contains("blockcheck"));
    assert!(!report.label.contains("undo data"));
}

#[test]
fn parse_method_notes_ppf2_blockcheck_metadata() {
    let temp = TestDir::new();
    let patch_path = temp.child("p.ppf");
    fs::write(
        &patch_path,
        build_ppf2_patch(
            "PPF2 parse",
            256,
            &sample_block(),
            vec![V1V2Record {
                offset: 4,
                data: b"ZZ".to_vec(),
            }],
        ),
    )
    .expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");
    assert!(report.label.contains("PPF2"), "label: {}", report.label);
    assert!(
        report
            .label
            .contains("includes blockcheck validation bytes"),
        "label: {}",
        report.label
    );
    assert!(!report.label.contains("undo data"));
}

#[test]
fn parse_method_notes_ppf3_undo_and_blockcheck_metadata() {
    let temp = TestDir::new();
    let patch_path = temp.child("p.ppf");
    fs::write(
        &patch_path,
        build_ppf3_patch(
            "PPF3 parse",
            1,
            true,
            true,
            Some(&sample_block()),
            vec![V3Record {
                offset: 2,
                data: b"abc".to_vec(),
                undo: b"xyz".to_vec(),
            }],
        ),
    )
    .expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");
    assert!(report.label.contains("PPF3"), "label: {}", report.label);
    assert!(
        report
            .label
            .contains("includes blockcheck validation bytes"),
        "label: {}",
        report.label
    );
    assert!(
        report.label.contains("includes undo data"),
        "label: {}",
        report.label
    );
}

#[test]
fn validate_succeeds_for_ppf2_with_matching_blockcheck() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");

    let (input, block) = ppf2_blockcheck_input();
    fs::write(&input_path, &input).expect("fixture");
    fs::write(
        &patch_path,
        build_ppf2_patch(
            "PPF2 validate",
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
    let report = handler
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("validate should pass with matching blockcheck");
    assert!(
        report.label.contains("validated"),
        "label: {}",
        report.label
    );
    assert!(report.label.contains("PPF2"), "label: {}", report.label);
    assert!(
        report.label.contains("1 record(s)"),
        "label: {}",
        report.label
    );
}

#[test]
fn validate_rejects_ppf2_when_input_size_mismatches() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");

    let (input, block) = ppf2_blockcheck_input();
    fs::write(&input_path, &input).expect("fixture");
    fs::write(
        &patch_path,
        build_ppf2_patch(
            "PPF2 validate bad size",
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
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("validate should reject size mismatch");
    assert!(error.to_string().contains("PPF2 input size invalid"));
}

#[test]
fn validate_rejects_when_blockcheck_region_runs_past_input_eof() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.ppf");

    // expected_input_len matches the tiny input so the size guard passes, but the input ends
    // long before the fixed blockcheck offset -- so the validation-block read hits EOF.
    let input = vec![0u8; 10];
    fs::write(&input_path, &input).expect("fixture");
    fs::write(
        &patch_path,
        build_ppf2_patch(
            "PPF2 short input",
            input.len() as u32,
            &sample_block(),
            vec![V1V2Record {
                offset: 0,
                data: vec![0xAA],
            }],
        ),
    )
    .expect("fixture");

    let handler = PpfPatchHandler::new(&PPF);
    let error = handler
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("blockcheck read past EOF should fail");
    assert!(
        error
            .to_string()
            .contains("validation block read exceeded input length"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_patch_smaller_than_header() {
    let error = parse_file_err(&[0u8; 10]);
    assert!(
        error.contains("too small to contain a valid header"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_invalid_magic() {
    let error = parse_file_err(&[0u8; PPF_HEADER_MIN_SIZE]);
    assert!(error.contains("Patch header invalid"), "error: {error}");
}

#[test]
fn parse_file_rejects_invalid_version_digits() {
    let mut bytes = b"PPF99".to_vec();
    bytes.push(0);
    bytes.resize(PPF_HEADER_MIN_SIZE, 0);
    let error = parse_file_err(&bytes);
    assert!(
        error.contains("version digits are invalid"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_invalid_encoding_method() {
    let mut bytes = b"PPF10".to_vec();
    bytes.push(9);
    bytes.resize(PPF_HEADER_MIN_SIZE, 0);
    let error = parse_file_err(&bytes);
    assert!(
        error.contains("encoding method is invalid"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_ppf2_missing_validation_header() {
    let bytes = build_header(PpfHeaderVersion::V2, "tiny", 1);
    let error = parse_file_err(&bytes);
    assert!(
        error.contains("PPF2 patch is too small to contain a validation header"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_ppf3_header_too_small() {
    // 56-byte V3 header is below the 60-byte PPF3 base header.
    let bytes = build_header(PpfHeaderVersion::V3, "tiny", 2);
    let error = parse_file_err(&bytes);
    assert!(
        error.contains("PPF3 patch is too small to contain a valid header"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_ppf3_blockcheck_without_validation_block() {
    let mut bytes = build_header(PpfHeaderVersion::V3, "no block", 2);
    bytes.push(0); // imagetype
    bytes.push(1); // blockcheck enabled
    bytes.push(0); // undo disabled
    bytes.push(0);
    let error = parse_file_err(&bytes);
    assert!(
        error.contains("enabled blockcheck but omitted the validation block"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_ppf1_truncated_record_header() {
    let mut bytes = build_ppf1_patch("trunc header", Vec::new());
    bytes.extend_from_slice(&[1, 2, 3]); // < 5 trailing bytes: not a full record header
    let error = parse_file_err(&bytes);
    assert!(
        error.contains("PPF record header exceeded patch bounds"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_ppf1_record_data_out_of_bounds() {
    let mut bytes = build_header(PpfHeaderVersion::V1, "oob data", 0);
    bytes.extend_from_slice(&7u32.to_le_bytes()); // offset
    bytes.push(10); // declared length
    bytes.extend_from_slice(&[1, 2]); // only 2 of 10 bytes present
    let error = parse_file_err(&bytes);
    assert!(
        error.contains("PPF record data exceeded patch bounds"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_ppf3_truncated_record_header() {
    let mut bytes = build_ppf3_patch("trunc v3 header", 0, false, false, None, Vec::new());
    bytes.extend_from_slice(&[1, 2, 3, 4]); // < 9 trailing bytes: not a full PPF3 record header
    let error = parse_file_err(&bytes);
    assert!(
        error.contains("PPF3 record header exceeded patch bounds"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_ppf3_record_data_out_of_bounds() {
    let mut bytes = build_ppf3_patch(
        "v3 oob data",
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
    bytes.pop(); // drop one declared data byte
    let error = parse_file_err(&bytes);
    assert!(
        error.contains("PPF3 record data exceeded patch bounds"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_ppf3_undo_data_out_of_bounds() {
    let mut bytes = build_ppf3_patch(
        "v3 oob undo",
        0,
        false,
        true,
        None,
        vec![V3Record {
            offset: 0,
            data: vec![1, 2, 3],
            undo: vec![4, 5, 6],
        }],
    );
    bytes.pop(); // drop one declared undo byte
    let error = parse_file_err(&bytes);
    assert!(
        error.contains("PPF3 undo data exceeded patch bounds"),
        "error: {error}"
    );
}

#[test]
fn parse_file_rejects_ppf3_offset_beyond_i64_max() {
    let bytes = build_ppf3_patch(
        "v3 huge offset",
        0,
        false,
        false,
        None,
        vec![V3Record {
            offset: 0x8000_0000_0000_0000,
            data: Vec::new(),
            undo: Vec::new(),
        }],
    );
    let error = parse_file_err(&bytes);
    assert!(
        error.contains("PPF3 record offset exceeded supported range"),
        "error: {error}"
    );
}

#[test]
fn probe_reports_extension_confidence() {
    let handler = PpfPatchHandler::new(&PPF);
    assert_eq!(
        handler.probe(Path::new("update.ppf")),
        ProbeConfidence::Extension
    );
}

#[test]
fn version_detection_rejects_truncated_headers() {
    assert!(
        super::detect_version(b"PP")
            .expect_err("magic truncated")
            .to_string()
            .contains("PPF_HEADER_TRUNCATED")
    );
    assert!(
        super::detect_version(b"PPF3")
            .expect_err("digits truncated")
            .to_string()
            .contains("PPF_VERSION_DIGITS_TRUNCATED")
    );
    assert!(
        super::detect_version(b"PPF30")
            .expect_err("method truncated")
            .to_string()
            .contains("PPF patch encoding method is truncated")
    );
}

#[test]
fn parse_bytes_rejects_a_patch_smaller_than_the_header() {
    let error = parse_ppf_bytes(&[0u8; 8]).expect_err("short patch");
    assert!(
        error
            .to_string()
            .contains("PPF patch is too small to contain a valid header")
    );
}

#[test]
fn parse_bytes_reads_ppf1_records() {
    let bytes = build_ppf1_patch(
        "ppf1 bytes",
        vec![
            V1V2Record {
                offset: 4,
                data: b"XY".to_vec(),
            },
            V1V2Record {
                offset: 16,
                data: b"Z".to_vec(),
            },
        ],
    );

    let parsed = parse_ppf_bytes(&bytes).expect("parse");
    assert_eq!(parsed.version, PpfVersion::V1);
    assert!(parsed.expected_input_len.is_none());
    assert!(parsed.blockcheck.is_none());
    assert!(!parsed.has_undo_data());
    assert_eq!(parsed.records.len(), 2);
    assert_eq!(parsed.records[0].offset, 4);
    assert_eq!(parsed.records[0].data, b"XY");
    assert_eq!(parsed.records[1].offset, 16);
}

#[test]
fn parse_bytes_reads_ppf2_blockcheck_and_expected_input_length() {
    let block = sample_block();
    let bytes = build_ppf2_patch(
        "ppf2 bytes",
        2048,
        &block,
        vec![V1V2Record {
            offset: 1,
            data: b"Q".to_vec(),
        }],
    );

    let parsed = parse_ppf_bytes(&bytes).expect("parse");
    assert_eq!(parsed.version, PpfVersion::V2);
    assert_eq!(parsed.expected_input_len, Some(2048));
    let blockcheck = parsed.blockcheck.expect("blockcheck");
    assert_eq!(blockcheck.input_offset, PPF2_BLOCKCHECK_OFFSET);
    assert_eq!(blockcheck.expected, block);
    assert_eq!(parsed.records.len(), 1);
}

#[test]
fn parse_bytes_rejects_ppf2_missing_the_validation_header() {
    let mut bytes = build_header(PpfHeaderVersion::V2, "short ppf2", 1);
    bytes.extend_from_slice(&16u32.to_le_bytes());
    let error = parse_ppf_bytes(&bytes).expect_err("missing validation header");
    assert!(
        error
            .to_string()
            .contains("PPF2 patch is too small to contain a validation header")
    );
}

#[test]
fn parse_bytes_rejects_ppf2_whose_file_id_swallows_the_payload() {
    let block = sample_block();
    let mut bytes = build_ppf2_patch("ppf2 file_id", 16, &block, Vec::new());
    bytes.extend_from_slice(b".DIZ");
    bytes.extend_from_slice(&0u32.to_le_bytes());

    let error = parse_ppf_bytes(&bytes).expect_err("file_id swallows payload");
    assert!(
        error
            .to_string()
            .contains("PPF2 payload ended before record data started")
    );
}

#[test]
fn parse_bytes_reads_ppf3_records_with_undo_data() {
    let block = sample_block();
    let bytes = build_ppf3_patch(
        "ppf3 bytes",
        0,
        true,
        true,
        Some(&block),
        vec![V3Record {
            offset: 8,
            data: b"NN".to_vec(),
            undo: b"OO".to_vec(),
        }],
    );

    let parsed = parse_ppf_bytes(&bytes).expect("parse");
    assert_eq!(parsed.version, PpfVersion::V3);
    assert!(parsed.has_undo_data());
    assert_eq!(parsed.records[0].offset, 8);
    assert_eq!(parsed.records[0].data, b"NN");
    assert_eq!(
        parsed.records[0].undo_data.as_deref(),
        Some(b"OO".as_slice())
    );
    assert_eq!(
        parsed.blockcheck.expect("blockcheck").input_offset,
        super::PPF3_BIN_BLOCKCHECK_OFFSET
    );
}

#[test]
fn parse_bytes_uses_the_gi_blockcheck_offset_for_non_bin_image_types() {
    let block = sample_block();
    let bytes = build_ppf3_patch("ppf3 gi", 1, true, false, Some(&block), Vec::new());

    let parsed = parse_ppf_bytes(&bytes).expect("parse");
    assert_eq!(
        parsed.blockcheck.expect("blockcheck").input_offset,
        super::PPF3_GI_BLOCKCHECK_OFFSET
    );
    assert!(parsed.records.is_empty());
}

#[test]
fn parse_bytes_rejects_ppf3_headers_that_stop_before_the_flags() {
    let bytes = build_header(PpfHeaderVersion::V3, "short ppf3", 2);
    let error = parse_ppf_bytes(&bytes).expect_err("short v3 header");
    assert!(
        error
            .to_string()
            .contains("PPF3 patch is too small to contain a valid header")
    );
}

#[test]
fn parse_bytes_rejects_ppf3_blockcheck_without_the_validation_block() {
    let mut bytes = build_header(PpfHeaderVersion::V3, "no block", 2);
    bytes.extend_from_slice(&[0, 1, 0, 0]);
    let error = parse_ppf_bytes(&bytes).expect_err("missing validation block");
    assert!(
        error
            .to_string()
            .contains("PPF3 patch enabled blockcheck but omitted the validation block")
    );
}

#[test]
fn parse_bytes_rejects_ppf3_whose_file_id_swallows_the_payload() {
    let block = sample_block();
    let mut bytes = build_ppf3_patch("ppf3 file_id", 0, true, false, Some(&block), Vec::new());
    bytes.extend_from_slice(b".DIZ");
    bytes.extend_from_slice(&0u16.to_le_bytes());

    let error = parse_ppf_bytes(&bytes).expect_err("file_id swallows payload");
    assert!(
        error
            .to_string()
            .contains("PPF3 payload ended before record data started")
    );
}

#[test]
fn parse_bytes_rejects_a_ppf1_record_header_that_runs_past_the_patch() {
    let mut bytes = build_ppf1_patch("ppf1 trunc", Vec::new());
    bytes.extend_from_slice(&[0u8; 3]);
    let error = parse_ppf_bytes(&bytes).expect_err("truncated record header");
    assert!(
        error
            .to_string()
            .contains("PPF record header exceeded patch bounds")
    );
}

#[test]
fn parse_bytes_rejects_ppf1_record_data_that_runs_past_the_patch() {
    let mut bytes = build_ppf1_patch("ppf1 oob", Vec::new());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.push(8);
    bytes.extend_from_slice(b"AB");
    let error = parse_ppf_bytes(&bytes).expect_err("record data out of bounds");
    assert!(
        error
            .to_string()
            .contains("PPF record data exceeded patch bounds")
    );
}

#[test]
fn parse_bytes_rejects_a_ppf3_record_header_that_runs_past_the_patch() {
    let mut bytes = build_ppf3_patch("ppf3 trunc", 0, false, false, None, Vec::new());
    bytes.extend_from_slice(&[0u8; 5]);
    let error = parse_ppf_bytes(&bytes).expect_err("truncated record header");
    assert!(
        error
            .to_string()
            .contains("PPF3 record header exceeded patch bounds")
    );
}

#[test]
fn parse_bytes_rejects_a_ppf3_record_offset_past_i64_max() {
    let mut bytes = build_ppf3_patch("ppf3 offset", 0, false, false, None, Vec::new());
    bytes.extend_from_slice(&u64::MAX.to_le_bytes());
    bytes.push(0);
    let error = parse_ppf_bytes(&bytes).expect_err("offset past i64::MAX");
    assert!(
        error
            .to_string()
            .contains("PPF3 record offset exceeded supported range")
    );
}

#[test]
fn parse_bytes_rejects_ppf3_record_data_that_runs_past_the_patch() {
    let mut bytes = build_ppf3_patch("ppf3 data oob", 0, false, false, None, Vec::new());
    bytes.extend_from_slice(&0u64.to_le_bytes());
    bytes.push(8);
    bytes.extend_from_slice(b"AB");
    let error = parse_ppf_bytes(&bytes).expect_err("record data out of bounds");
    assert!(
        error
            .to_string()
            .contains("PPF3 record data exceeded patch bounds")
    );
}

#[test]
fn parse_bytes_rejects_ppf3_undo_data_that_runs_past_the_patch() {
    let mut bytes = build_ppf3_patch("ppf3 undo oob", 0, false, true, None, Vec::new());
    bytes.extend_from_slice(&0u64.to_le_bytes());
    bytes.push(2);
    bytes.extend_from_slice(b"AB");
    bytes.push(b'C');
    let error = parse_ppf_bytes(&bytes).expect_err("undo data out of bounds");
    assert!(
        error
            .to_string()
            .contains("PPF3 undo data exceeded patch bounds")
    );
}

#[test]
fn file_id_marker_scan_ignores_patches_without_markers() {
    assert_eq!(
        super::detect_file_id_len_from_markers(b"no markers at all", 0, FileIdTrailerKind::V3)
            .expect("scan"),
        None
    );
}

#[test]
fn file_id_marker_scan_ignores_markers_before_the_payload() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(FILE_ID_BEGIN_MARKER);
    bytes.extend_from_slice(b"note");
    bytes.extend_from_slice(FILE_ID_END_MARKER);
    bytes.extend_from_slice(&4u16.to_le_bytes());

    assert_eq!(
        super::detect_file_id_len_from_markers(&bytes, 8, FileIdTrailerKind::V3).expect("scan"),
        None
    );
}

#[test]
fn file_id_marker_scan_ignores_a_begin_marker_without_an_end_marker() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(FILE_ID_BEGIN_MARKER);
    bytes.extend_from_slice(b"note");

    assert_eq!(
        super::detect_file_id_len_from_markers(&bytes, 0, FileIdTrailerKind::V3).expect("scan"),
        None
    );
}

#[test]
fn file_id_marker_scan_accepts_a_two_byte_trailer_length() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(FILE_ID_BEGIN_MARKER);
    bytes.extend_from_slice(b"note");
    bytes.extend_from_slice(FILE_ID_END_MARKER);
    bytes.extend_from_slice(&4u16.to_le_bytes());

    assert_eq!(
        super::detect_file_id_len_from_markers(&bytes, 0, FileIdTrailerKind::V3).expect("scan"),
        Some(bytes.len())
    );
}

#[test]
fn file_id_marker_scan_accepts_a_four_byte_trailer_length_for_ppf2() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(FILE_ID_BEGIN_MARKER);
    bytes.extend_from_slice(b"note");
    bytes.extend_from_slice(FILE_ID_END_MARKER);
    bytes.extend_from_slice(&4u32.to_le_bytes());

    assert_eq!(
        super::detect_file_id_len_from_markers(&bytes, 0, FileIdTrailerKind::V2).expect("scan"),
        Some(bytes.len())
    );
}

#[test]
fn file_id_marker_scan_rejects_a_trailer_length_that_disagrees_with_the_payload() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(FILE_ID_BEGIN_MARKER);
    bytes.extend_from_slice(b"note");
    bytes.extend_from_slice(FILE_ID_END_MARKER);
    bytes.extend_from_slice(&99u16.to_le_bytes());

    assert_eq!(
        super::detect_file_id_len_from_markers(&bytes, 0, FileIdTrailerKind::V3).expect("scan"),
        None
    );
}

#[test]
fn file_id_marker_scan_rejects_a_trailer_of_an_unexpected_width() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(FILE_ID_BEGIN_MARKER);
    bytes.extend_from_slice(b"note");
    bytes.extend_from_slice(FILE_ID_END_MARKER);
    bytes.extend_from_slice(&[4, 0, 0]);

    assert_eq!(
        super::detect_file_id_len_from_markers(&bytes, 0, FileIdTrailerKind::V3).expect("scan"),
        None
    );
}

#[test]
fn file_id_length_falls_back_to_the_ppf2_footer_magic() {
    let mut bytes = vec![0u8; 64];
    bytes.extend_from_slice(b".DIZ");
    bytes.extend_from_slice(&6u32.to_le_bytes());

    assert_eq!(
        super::detect_file_id_len_v2(&bytes, 0).expect("scan"),
        6 + super::PPF2_FILE_ID_OVERHEAD
    );
}

#[test]
fn file_id_length_falls_back_to_the_unpadded_ppf3_footer_magic() {
    let mut bytes = vec![0u8; 64];
    bytes.extend_from_slice(b".DIZ");
    bytes.extend_from_slice(&6u16.to_le_bytes());

    assert_eq!(
        super::detect_file_id_len_v3(&bytes, 0).expect("scan"),
        6 + super::PPF3_FILE_ID_OVERHEAD
    );
}

#[test]
fn file_id_length_falls_back_to_the_padded_ppf3_footer_magic() {
    let mut bytes = vec![0u8; 64];
    bytes.extend_from_slice(b".DIZ");
    bytes.extend_from_slice(&6u32.to_le_bytes());

    assert_eq!(
        super::detect_file_id_len_v3(&bytes, 0).expect("scan"),
        6 + super::PPF3_FILE_ID_PADDED_OVERHEAD
    );
}

#[test]
fn footer_magic_scan_reports_no_file_id_for_short_or_unmarked_patches() {
    assert_eq!(
        super::detect_file_id_len_from_footer_magic(b"ab", 4, 38, "PPF2").expect("short"),
        0
    );
    assert_eq!(
        super::detect_file_id_len_from_footer_magic(&[0u8; 32], 4, 38, "PPF2").expect("no magic"),
        0
    );
}

#[test]
fn footer_magic_scan_rejects_an_unsupported_length_field_width() {
    let mut bytes = vec![0u8; 32];
    bytes.extend_from_slice(b".DIZ");
    bytes.extend_from_slice(&[0u8; 3]);

    let error = super::detect_file_id_len_from_footer_magic(&bytes, 3, 10, "PPF3")
        .expect_err("unsupported width");
    assert!(
        error
            .to_string()
            .contains("unsupported file_id length field width")
    );
}

#[test]
fn footer_magic_scan_rejects_a_file_id_larger_than_the_patch() {
    let mut bytes = vec![0u8; 16];
    bytes.extend_from_slice(b".DIZ");
    bytes.extend_from_slice(&9000u32.to_le_bytes());

    let error = super::detect_file_id_len_from_footer_magic(&bytes, 4, 38, "PPF2")
        .expect_err("file_id larger than patch");
    assert!(
        error
            .to_string()
            .contains("PPF2 file_id length exceeded patch size")
    );
}

#[test]
fn footer_magic_path_scan_reports_no_file_id_for_files_shorter_than_the_footer() {
    let temp = TestDir::new();
    let patch_path = temp.child("tiny.ppf");
    fs::write(&patch_path, b"ab").expect("fixture");

    assert_eq!(
        super::detect_file_id_len_from_footer_magic_path(&patch_path, 2, 4, 38, "PPF2")
            .expect("short"),
        0
    );
}

#[test]
fn footer_magic_path_scan_rejects_an_unsupported_length_field_width() {
    let temp = TestDir::new();
    let patch_path = temp.child("width.ppf");
    let mut bytes = vec![0u8; 32];
    bytes.extend_from_slice(b".DIZ");
    bytes.extend_from_slice(&[0u8; 3]);
    fs::write(&patch_path, &bytes).expect("fixture");

    let error = super::detect_file_id_len_from_footer_magic_path(
        &patch_path,
        bytes.len() as u64,
        3,
        10,
        "PPF3",
    )
    .expect_err("unsupported width");
    assert!(
        error
            .to_string()
            .contains("unsupported file_id length field width")
    );
}

#[test]
fn parse_file_rejects_a_file_id_length_larger_than_the_patch() {
    let mut bytes = build_ppf3_patch("huge file_id", 0, false, false, None, Vec::new());
    bytes.extend_from_slice(b".DIZ");
    bytes.extend_from_slice(&60_000u16.to_le_bytes());

    let error = parse_file_err(&bytes);
    assert!(
        error.contains("PPF3 file_id length exceeded patch size"),
        "{error}"
    );
}

#[test]
fn parse_file_rejects_ppf2_whose_file_id_swallows_the_payload() {
    let block = sample_block();
    let mut bytes = build_ppf2_patch("ppf2 file_id", 16, &block, Vec::new());
    bytes.extend_from_slice(b".DIZ");
    bytes.extend_from_slice(&0u32.to_le_bytes());

    let error = parse_file_err(&bytes);
    assert!(
        error.contains("PPF2 payload ended before record data started"),
        "{error}"
    );
}

#[test]
fn parse_file_rejects_ppf3_whose_file_id_swallows_the_payload() {
    let block = sample_block();
    let mut bytes = build_ppf3_patch("ppf3 file_id", 0, true, false, Some(&block), Vec::new());
    bytes.extend_from_slice(b".DIZ");
    bytes.extend_from_slice(&0u16.to_le_bytes());

    let error = parse_file_err(&bytes);
    assert!(
        error.contains("PPF3 payload ended before record data started"),
        "{error}"
    );
}

#[test]
fn subslice_searches_treat_an_empty_needle_as_a_match_at_each_end() {
    assert_eq!(super::find_subslice(b"abc", b""), Some(0));
    assert_eq!(super::rfind_subslice(b"abc", b""), Some(3));
    assert_eq!(super::find_subslice(b"abcabc", b"bc"), Some(1));
    assert_eq!(super::rfind_subslice(b"abcabc", b"bc"), Some(4));
    assert_eq!(super::find_subslice(b"abc", b"zz"), None);
}

#[test]
fn little_endian_reads_reject_offsets_past_the_buffer() {
    assert_eq!(super::read_u16_le(&[0x34, 0x12], 0).expect("u16"), 0x1234);
    assert_eq!(
        super::read_u64_le(&[1, 0, 0, 0, 0, 0, 0, 0], 0).expect("u64"),
        1
    );
    assert!(
        super::read_u16_le(&[0u8; 1], 0)
            .expect_err("u16 past end")
            .to_string()
            .contains("u16 read exceeded patch bounds")
    );
    assert!(
        super::read_u64_le(&[0u8; 4], 0)
            .expect_err("u64 past end")
            .to_string()
            .contains("u64 read exceeded patch bounds")
    );
}

#[test]
fn ppf3_record_writer_skips_empty_payloads_and_rejects_oversized_ones() {
    let mut output = Vec::new();
    super::write_ppf3_record(&mut output, 0, &[]).expect("empty record");
    assert!(output.is_empty());

    let error =
        super::write_ppf3_record(&mut output, 0, &vec![0u8; 256]).expect_err("oversized record");
    assert!(
        error
            .to_string()
            .contains("PPF3 record length exceeded 255 bytes")
    );

    super::write_ppf3_record(&mut output, 7, b"AB").expect("record");
    assert_eq!(output, [7, 0, 0, 0, 0, 0, 0, 0, 2, b'A', b'B']);
}

#[test]
fn in_memory_apply_rejects_a_record_past_the_output_end() {
    let records = vec![PpfRecord {
        offset: 2,
        data: vec![1, 2, 3],
        undo_data: None,
    }];
    let mut output = vec![0u8; 4];

    let error = super::apply_records_in_memory(&records, &mut output).expect_err("past output end");
    assert!(
        error
            .to_string()
            .contains("PPF record exceeded output size")
    );
}

#[test]
fn streaming_and_parallel_apply_paths_produce_the_same_writes() {
    let temp = TestDir::new();
    let output_path = temp.child("streamed.bin");
    fs::write(&output_path, b"........").expect("fixture");

    let records = vec![
        PpfRecord {
            offset: 1,
            data: b"AB".to_vec(),
            undo_data: None,
        },
        PpfRecord {
            offset: 5,
            data: b"YZ".to_vec(),
            undo_data: None,
        },
    ];

    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&output_path)
        .expect("open output");
    super::apply_records(&mut output, &records).expect("streaming apply");
    drop(output);
    assert_eq!(fs::read(&output_path).expect("output"), b".AB..YZ.");

    let context = test_context_with_threads(&temp, 2);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(2)))
        .expect("pool");
    let prepared =
        super::prepare_ppf_writes_parallel(&records, &pool, &context).expect("parallel prepare");
    assert_eq!(prepared.len(), 2);
    assert_eq!(prepared[0].offset, 1);
    assert_eq!(prepared[0].data, b"AB");
    assert_eq!(prepared[1].offset, 5);
    assert_eq!(prepared[1].data, b"YZ");
}

#[test]
fn undo_rejects_undo_data_that_runs_past_the_rom() {
    let temp = TestDir::new();
    let patch_path = temp.child("undo.ppf");
    let input_path = temp.child("input.bin");
    let output_path = temp.child("output.bin");

    let bytes = build_ppf3_patch(
        "undo out of bounds",
        0,
        false,
        true,
        None,
        vec![V3Record {
            offset: 100,
            data: b"NN".to_vec(),
            undo: b"OO".to_vec(),
        }],
    );
    fs::write(&patch_path, bytes).expect("patch fixture");
    fs::write(&input_path, b"ABCD").expect("input fixture");

    let error = undo_ppf(&input_path, &patch_path, &output_path).expect_err("undo past rom end");
    assert!(
        error
            .to_string()
            .contains("PPF undo data exceeds ROM bounds")
    );
}

#[test]
fn parallel_create_rejects_shrinking_outputs() {
    let temp = TestDir::new();
    let original_path = temp.child("orig.bin");
    let modified_path = temp.child("mod.bin");
    fs::write(&original_path, b"ABCDEFGH").expect("fixture");
    fs::write(&modified_path, b"ABCD").expect("fixture");

    let context = test_context_with_threads(&temp, 2);
    let (_, pool) = context
        .build_pool(ThreadCapability::parallel(Some(2)))
        .expect("pool");
    let mut output = Vec::new();
    let error =
        super::create_ppf3_patch_parallel(&original_path, 8, &modified_path, 4, &pool, &mut output)
            .expect_err("shrinking output");
    assert!(
        error
            .to_string()
            .contains("PPF create does not support shrinking outputs")
    );
}

#[test]
fn chunk_diff_scan_seeks_into_the_middle_of_both_inputs() {
    let temp = TestDir::new();
    let original_path = temp.child("orig.bin");
    let modified_path = temp.child("mod.bin");
    fs::write(&original_path, b"ABCDEFGH").expect("fixture");
    fs::write(&modified_path, b"ABCXEFGH").expect("fixture");

    let runs =
        collect_ppf_chunk_diff_runs(&original_path, 8, &modified_path, 2, 8).expect("chunk scan");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].offset, 3);
    assert_eq!(runs[0].len, 1);
}
