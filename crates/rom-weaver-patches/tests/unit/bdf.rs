use std::{
    fs,
    io::{Cursor, Write},
    path::PathBuf,
};

use bzip2::{Compression, write::BzEncoder};
use qbsdiff::{Bsdiff, Bspatch, ParallelScheme};
use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

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
