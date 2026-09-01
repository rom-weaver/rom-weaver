use std::{
    fs,
    io::{Cursor, Write},
    path::PathBuf,
};

use bzip2::{Compression, write::BzEncoder};
use qbsdiff::{Bsdiff, Bspatch, ParallelScheme};
use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler, PatchValidateRequest};

use super::BdfPatchHandler;
use crate::{
    BDF_BSDIFF40,
    test_support::{RoundTripCase, TestDir, assert_round_trip, test_context_with_threads},
};

fn bdf_fixture_paths(temp: &TestDir) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    (
        temp.child("source.bin"),
        temp.child("target.bin"),
        temp.child("update.bdf"),
        temp.child("output.bin"),
    )
}

#[test]
fn parse_rejects_invalid_patch_header() {
    let temp = TestDir::new();
    let patch_path = temp.child("broken.bdf");
    fs::write(&patch_path, b"not-a-valid-patch").expect("fixture");

    let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
    let error = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("parse should fail");
    assert!(error.to_string().contains("not a valid patch"));
}

#[test]
fn create_and_apply_round_trip() {
    let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
    let create_report = assert_round_trip(
        &handler,
        &RoundTripCase {
            patch_extension: "bdf",
            patch_assert: Some(|patch| assert_eq!(&patch[..8], b"BSDIFF40")),
            ..RoundTripCase::new(
                b"The quick brown fox jumps over the lazy dog.",
                b"The quick brown cat jumps over two lazy dogs!",
                "BDF/BSDIFF40",
            )
        },
    );

    let execution = create_report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
}

#[test]
fn apply_rejects_multiple_patch_files() {
    let temp = TestDir::new();
    let (source_path, target_path, patch_path, output_path) = bdf_fixture_paths(&temp);

    fs::write(&source_path, b"abc").expect("fixture");
    fs::write(&target_path, b"abZ").expect("fixture");

    let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path,
                output: patch_path.clone(),
                format: "BDF/BSDIFF40".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let error = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path.clone(), patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("apply should fail");

    assert!(error.to_string().contains("expects exactly one patch file"));
}

#[test]
fn create_outputs_apply_across_thread_budgets() {
    let temp = TestDir::new();
    let source_path = temp.child("source-large.bin");
    let target_path = temp.child("target-large.bin");
    let patch_single = temp.child("single-thread.bdf");
    let patch_parallel = temp.child("parallel-thread.bdf");

    let source = build_large_fixture_bytes();
    let mut target = source.clone();
    for index in (0..target.len()).step_by(4096) {
        target[index] = target[index].wrapping_add(17);
    }
    fs::write(&source_path, &source).expect("fixture");
    fs::write(&target_path, &target).expect("fixture");

    let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_single.clone(),
                format: "bdf".into(),
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
                format: "bdf".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("parallel create");

    let single_execution = single_report
        .thread_execution
        .expect("single-thread execution");
    assert_eq!(single_execution.effective_threads, 1);
    assert!(!single_execution.used_parallelism);
    let parallel_execution = parallel_report
        .thread_execution
        .expect("parallel-thread execution");
    assert_eq!(parallel_execution.requested_threads, 8);
    assert_eq!(parallel_execution.effective_threads, 8);
    assert!(parallel_execution.used_parallelism);

    for patch_path in [patch_single, patch_parallel] {
        let patch = fs::read(patch_path).expect("patch");
        assert_eq!(&patch[..8], b"BSDIFF40");
        assert_eq!(
            apply_with_qbsdiff(source.as_slice(), patch.as_slice()),
            target
        );
    }
}

#[test]
fn apply_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let source_path = temp.child("source-apply.bin");
    let target_path = temp.child("target-apply.bin");
    let patch_path = temp.child("update-apply.bdf");
    let single_output = temp.child("single-output.bin");
    let parallel_output = temp.child("parallel-output.bin");

    let source = build_large_fixture_bytes();
    let mut target = source.clone();
    for index in (0..target.len()).step_by(3071) {
        target[index] = target[index].wrapping_add(33);
    }
    fs::write(&source_path, &source).expect("source fixture");
    fs::write(&target_path, &target).expect("target fixture");

    let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path,
                output: patch_path.clone(),
                format: "bdf".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");

    let single_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path.clone(),
                patches: vec![patch_path.clone()],
                output: single_output.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single apply");
    let parallel_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: parallel_output.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("parallel apply");

    assert!(
        !single_report
            .thread_execution
            .expect("single execution")
            .used_parallelism
    );
    let parallel_execution = parallel_report
        .thread_execution
        .expect("parallel execution");
    assert_eq!(parallel_execution.requested_threads, 8);
    assert!(parallel_execution.used_parallelism);
    assert_eq!(fs::read(single_output).expect("single output"), target);
    assert_eq!(fs::read(parallel_output).expect("parallel output"), target);
}

#[test]
fn apply_accepts_qbsdiff_created_patch() {
    let temp = TestDir::new();
    let source_path = temp.child("source-qbsdiff.bin");
    let target_path = temp.child("target-qbsdiff.bin");
    let patch_path = temp.child("external-qbsdiff.bdf");
    let output_path = temp.child("output-qbsdiff.bin");

    let source = b"AAAAABBBBBCCCCCDDDDDEEEEE";
    let target = b"AAAAAxxxxxBBBBBCCCCCDDDDDEEEEE";
    fs::write(&source_path, source).expect("source fixture");
    fs::write(&target_path, target).expect("target fixture");
    fs::write(
        &patch_path,
        create_qbsdiff_patch(source, target, ParallelScheme::Never),
    )
    .expect("patch fixture");

    BdfPatchHandler::new(&BDF_BSDIFF40)
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
fn create_output_applies_with_qbsdiff_bspatch() {
    let temp = TestDir::new();
    let source_path = temp.child("source-bspatch.bin");
    let target_path = temp.child("target-bspatch.bin");
    let patch_path = temp.child("created-qbsdiff.bdf");

    let source = b"0123456789abcdef0123456789abcdef";
    let target = b"0123456789XYZabcdef0123456789abcdef!";
    fs::write(&source_path, source).expect("source fixture");
    fs::write(&target_path, target).expect("target fixture");

    BdfPatchHandler::new(&BDF_BSDIFF40)
        .create(
            &PatchCreateRequest {
                original: source_path,
                modified: target_path,
                output: patch_path.clone(),
                format: "bdf".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let patch = fs::read(patch_path).expect("patch");
    assert_eq!(&patch[..8], b"BSDIFF40");
    assert_eq!(apply_with_qbsdiff(source, patch.as_slice()), target);
}

#[test]
fn apply_uses_zero_for_source_ranges_outside_input_bounds() {
    let temp = TestDir::new();
    let source_path = temp.child("source-short.bin");
    let patch_path = temp.child("outside-source.bdf");
    let output_path = temp.child("outside-output.bin");

    fs::write(&source_path, [10u8]).expect("source fixture");
    fs::write(
        &patch_path,
        build_bsdiff_patch(&[(1, 0, -2), (3, 0, 0)], &[1, 7, 8, 9], &[], 4),
    )
    .expect("patch fixture");

    BdfPatchHandler::new(&BDF_BSDIFF40)
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), [11, 7, 18, 9]);
}

#[test]
fn apply_rejects_control_output_length_mismatch() {
    let temp = TestDir::new();
    let source_path = temp.child("source-mismatch.bin");
    let patch_path = temp.child("mismatch.bdf");
    let output_path = temp.child("mismatch-output.bin");

    fs::write(&source_path, [1u8, 2, 3]).expect("source fixture");
    fs::write(&patch_path, build_bsdiff_patch(&[(1, 0, 0)], &[0], &[], 2)).expect("patch fixture");

    let error = BdfPatchHandler::new(&BDF_BSDIFF40)
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("apply should fail");

    assert!(
        error
            .to_string()
            .contains("control output length did not match header target length")
    );
}

fn build_large_fixture_bytes() -> Vec<u8> {
    let mut bytes = vec![0u8; 512 * 1024];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    bytes
}

fn create_qbsdiff_patch(source: &[u8], target: &[u8], parallel_scheme: ParallelScheme) -> Vec<u8> {
    let mut patch = Vec::new();
    Bsdiff::new(source, target)
        .parallel_scheme(parallel_scheme)
        .compression_level(9)
        .compare(Cursor::new(&mut patch))
        .expect("qbsdiff create");
    patch
}

fn apply_with_qbsdiff(source: &[u8], patch: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    Bspatch::new(patch)
        .expect("qbsdiff parse")
        .apply(source, Cursor::new(&mut output))
        .expect("qbsdiff apply");
    output
}

fn build_bsdiff_patch(
    controls: &[(i64, i64, i64)],
    delta: &[u8],
    extra: &[u8],
    target_len: i64,
) -> Vec<u8> {
    let mut control_bytes = Vec::with_capacity(controls.len() * 24);
    for (add_len, copy_len, seek) in controls {
        control_bytes.extend_from_slice(&super::encode_bsdiff_i64(*add_len));
        control_bytes.extend_from_slice(&super::encode_bsdiff_i64(*copy_len));
        control_bytes.extend_from_slice(&super::encode_bsdiff_i64(*seek));
    }

    let control_block = bzip2_encode(control_bytes.as_slice());
    let delta_block = bzip2_encode(delta);
    let extra_block = bzip2_encode(extra);

    let mut patch = Vec::new();
    patch.extend_from_slice(b"BSDIFF40");
    patch.extend_from_slice(&super::encode_bsdiff_i64(control_block.len() as i64));
    patch.extend_from_slice(&super::encode_bsdiff_i64(delta_block.len() as i64));
    patch.extend_from_slice(&super::encode_bsdiff_i64(target_len));
    patch.extend_from_slice(control_block.as_slice());
    patch.extend_from_slice(delta_block.as_slice());
    patch.extend_from_slice(extra_block.as_slice());
    patch
}

fn bzip2_encode(payload: &[u8]) -> Vec<u8> {
    let mut encoder = BzEncoder::new(Vec::new(), Compression::new(9));
    encoder.write_all(payload).expect("bzip2 write");
    encoder.finish().expect("bzip2 finish")
}

/// Assembles a BSDIFF40 file from already-encoded section blocks, so a test can
/// hand the parser a section the normal builder would never emit (a zero-length
/// block, a non-bzip2 control stream).
fn build_raw_bsdiff_patch(
    control_block: &[u8],
    delta_block: &[u8],
    extra_block: &[u8],
    target_len: i64,
) -> Vec<u8> {
    let mut patch = Vec::new();
    patch.extend_from_slice(b"BSDIFF40");
    patch.extend_from_slice(&super::encode_bsdiff_i64(control_block.len() as i64));
    patch.extend_from_slice(&super::encode_bsdiff_i64(delta_block.len() as i64));
    patch.extend_from_slice(&super::encode_bsdiff_i64(target_len));
    patch.extend_from_slice(control_block);
    patch.extend_from_slice(delta_block);
    patch.extend_from_slice(extra_block);
    patch
}

fn apply_bdf(
    temp: &TestDir,
    name: &str,
    source: &[u8],
    patch: &[u8],
    threads: usize,
) -> rom_weaver_core::Result<Vec<u8>> {
    let source_path = temp.child(&format!("{name}-source.bin"));
    let patch_path = temp.child(&format!("{name}.bdf"));
    let output_path = temp.child(&format!("{name}-output.bin"));
    fs::write(&source_path, source).expect("source fixture");
    fs::write(&patch_path, patch).expect("patch fixture");

    BdfPatchHandler::new(&BDF_BSDIFF40).apply(
        &PatchApplyRequest {
            input: source_path,
            patches: vec![patch_path],
            output: output_path.clone(),
        },
        &test_context_with_threads(temp, threads),
    )?;
    Ok(fs::read(output_path).expect("output"))
}

#[test]
fn parse_reports_the_declared_target_size() {
    let temp = TestDir::new();
    let patch_path = temp.child("sized.bdf");
    fs::write(
        &patch_path,
        build_bsdiff_patch(&[(2, 0, 0)], &[1, 2], &[], 2),
    )
    .expect("patch fixture");

    let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");
    assert!(
        report
            .label
            .contains("parsed BDF/BSDIFF40 patch targeting 2 byte(s)"),
        "unexpected label: {}",
        report.label
    );
}

#[test]
fn validate_reports_the_planned_output_size() {
    let temp = TestDir::new();
    let source_path = temp.child("validate-source.bin");
    let patch_path = temp.child("validate.bdf");
    fs::write(&source_path, [1u8, 2]).expect("source fixture");
    fs::write(
        &patch_path,
        build_bsdiff_patch(&[(2, 1, 0)], &[1, 2], b"X", 3),
    )
    .expect("patch fixture");

    let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
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
    assert!(
        report
            .label
            .contains("validated BDF/BSDIFF40 patch source; output would be 3 byte(s)"),
        "unexpected label: {}",
        report.label
    );
}

#[test]
fn parse_rejects_a_full_length_header_with_the_wrong_magic() {
    let temp = TestDir::new();
    let patch_path = temp.child("wrong-magic.bdf");
    // Long enough to clear the header-size check, so the magic comparison runs.
    let mut bytes = vec![0u8; 64];
    bytes[..8].copy_from_slice(b"BSDIFF39");
    fs::write(&patch_path, bytes).expect("patch fixture");

    let error = BdfPatchHandler::new(&BDF_BSDIFF40)
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("a wrong magic must be rejected");
    assert!(error.to_string().contains("not a valid patch"));
}

#[test]
fn parse_rejects_sections_that_run_past_the_end_of_the_patch() {
    let temp = TestDir::new();
    let patch_path = temp.child("overlong.bdf");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"BSDIFF40");
    bytes.extend_from_slice(&super::encode_bsdiff_i64(1_000));
    bytes.extend_from_slice(&super::encode_bsdiff_i64(1_000));
    bytes.extend_from_slice(&super::encode_bsdiff_i64(16));
    bytes.resize(64, 0);
    fs::write(&patch_path, bytes).expect("patch fixture");

    let error = BdfPatchHandler::new(&BDF_BSDIFF40)
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("sections past the end must be rejected");
    assert!(error.to_string().contains("patch corrupted"));
}

#[test]
fn apply_rejects_a_control_block_that_is_not_bzip2() {
    let temp = TestDir::new();
    let patch = build_raw_bsdiff_patch(b"not-a-bzip2-stream", &bzip2_encode(&[]), &[], 0);
    let error = apply_bdf(&temp, "bad-control", &[1u8], &patch, 1)
        .expect_err("a corrupt control block must be rejected");
    assert!(
        error
            .to_string()
            .contains("BSDIFF40 control block decode failed")
    );
}

#[test]
fn apply_rejects_a_control_block_that_ends_mid_record() {
    let temp = TestDir::new();
    // Ten bytes is not a whole 24-byte control record.
    let patch = build_raw_bsdiff_patch(&bzip2_encode(&[0u8; 10]), &bzip2_encode(&[]), &[], 0);
    let error = apply_bdf(&temp, "partial-control", &[1u8], &patch, 1)
        .expect_err("a partial control record must be rejected");
    assert!(
        error
            .to_string()
            .contains("control block ended with a partial record")
    );
}

#[test]
fn apply_rejects_negative_add_and_copy_lengths() {
    let temp = TestDir::new();

    let negative_add = apply_bdf(
        &temp,
        "negative-add",
        &[1u8],
        &build_bsdiff_patch(&[(-1, 0, 0)], &[], &[], 1),
        1,
    )
    .expect_err("a negative add length must be rejected");
    assert!(negative_add.to_string().contains("negative add length"));

    let negative_copy = apply_bdf(
        &temp,
        "negative-copy",
        &[1u8],
        &build_bsdiff_patch(&[(0, -1, 0)], &[], &[], 1),
        1,
    )
    .expect_err("a negative copy length must be rejected");
    assert!(negative_copy.to_string().contains("negative copy length"));
}

#[test]
fn apply_reads_copy_segments_from_the_extra_payload() {
    let temp = TestDir::new();
    let output = apply_bdf(
        &temp,
        "extra-copy",
        &[10u8, 20],
        &build_bsdiff_patch(&[(2, 3, 0)], &[1, 2], b"XYZ", 5),
        1,
    )
    .expect("apply");
    assert_eq!(output, [11, 22, b'X', b'Y', b'Z']);
}

#[test]
fn apply_rejects_a_zero_length_delta_section() {
    let temp = TestDir::new();
    // BSDIFF40 always carries three bzip2 streams, so a section the header
    // declares as zero bytes long has no stream to decode.
    let patch = build_raw_bsdiff_patch(
        &bzip2_encode(
            &[
                super::encode_bsdiff_i64(0),
                super::encode_bsdiff_i64(3),
                super::encode_bsdiff_i64(0),
            ]
            .concat(),
        ),
        &[],
        &bzip2_encode(b"XYZ"),
        3,
    );

    let error = apply_bdf(&temp, "empty-delta", &[1u8], &patch, 1)
        .expect_err("a zero-length delta section must be rejected");
    assert!(
        error
            .to_string()
            .contains("BSDIFF40 bzip2 payload decode failed")
    );
}

#[test]
fn apply_skips_source_addition_for_an_empty_source_and_for_offsets_past_its_end() {
    let temp = TestDir::new();

    let empty_source = apply_bdf(
        &temp,
        "empty-source",
        &[],
        &build_bsdiff_patch(&[(2, 0, 0)], &[9, 9], &[], 2),
        1,
    )
    .expect("apply against an empty source");
    assert_eq!(empty_source, [9, 9]);

    // The leading seek pushes the source cursor past the one-byte source, so the
    // second record has no overlap to add.
    let past_end = apply_bdf(
        &temp,
        "past-end",
        &[7u8],
        &build_bsdiff_patch(&[(0, 0, 5), (2, 0, 0)], &[3, 4], &[], 2),
        1,
    )
    .expect("apply past the source end");
    assert_eq!(past_end, [3, 4]);
}

#[test]
fn apply_prepares_writes_in_parallel_for_a_large_target() {
    let temp = TestDir::new();
    let add_len = 200_000usize;
    let copy_len = 150_000usize;

    let source: Vec<u8> = (0..add_len).map(|index| (index % 251) as u8).collect();
    let delta: Vec<u8> = (0..add_len).map(|index| (index % 7) as u8).collect();
    let extra: Vec<u8> = (0..copy_len).map(|index| (index % 13) as u8).collect();

    let patch = build_bsdiff_patch(
        &[(add_len as i64, copy_len as i64, 0)],
        &delta,
        &extra,
        (add_len + copy_len) as i64,
    );

    let source_path = temp.child("large-source.bin");
    let patch_path = temp.child("large.bdf");
    let output_path = temp.child("large-output.bin");
    fs::write(&source_path, &source).expect("source fixture");
    fs::write(&patch_path, &patch).expect("patch fixture");

    let report = BdfPatchHandler::new(&BDF_BSDIFF40)
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");

    let execution = report.thread_execution.expect("thread execution");
    assert!(
        execution.used_parallelism,
        "a target over the parallel threshold must use the worker pool"
    );

    let mut expected: Vec<u8> = source
        .iter()
        .zip(delta.iter())
        .map(|(source_byte, delta_byte)| source_byte.wrapping_add(*delta_byte))
        .collect();
    expected.extend_from_slice(&extra);
    assert_eq!(fs::read(output_path).expect("output"), expected);
}

#[test]
fn apply_in_parallel_skips_source_addition_when_a_record_starts_past_the_source() {
    let temp = TestDir::new();
    let add_len = 300_000usize;

    let source = vec![0x11u8; 16];
    let delta: Vec<u8> = (0..add_len).map(|index| (index % 251) as u8).collect();
    // The leading seek moves the source cursor past the 16-byte source, so the
    // pooled worker has no overlapping source bytes to add.
    let patch = build_bsdiff_patch(
        &[(0, 0, 4_096), (add_len as i64, 0, 0)],
        &delta,
        &[],
        add_len as i64,
    );

    let source_path = temp.child("no-overlap-source.bin");
    let patch_path = temp.child("no-overlap.bdf");
    let output_path = temp.child("no-overlap-output.bin");
    fs::write(&source_path, &source).expect("source fixture");
    fs::write(&patch_path, &patch).expect("patch fixture");

    let report = BdfPatchHandler::new(&BDF_BSDIFF40)
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");

    assert!(
        report
            .thread_execution
            .expect("thread execution")
            .used_parallelism
    );
    assert_eq!(fs::read(output_path).expect("output"), delta);
}
