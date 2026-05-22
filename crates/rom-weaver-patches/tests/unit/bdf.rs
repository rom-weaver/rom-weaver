use std::{fs, path::PathBuf};

use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

use super::BdfPatchHandler;
use crate::{
    BDF_BSDIFF40,
    test_support::{TestDir, test_context_with_threads},
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
    let temp = TestDir::new();
    let (source_path, target_path, patch_path, output_path) = bdf_fixture_paths(&temp);

    let source = b"The quick brown fox jumps over the lazy dog.";
    let target = b"The quick brown cat jumps over two lazy dogs!";
    fs::write(&source_path, source).expect("fixture");
    fs::write(&target_path, target).expect("fixture");

    let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "BDF/BSDIFF40".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");

    let execution = create_report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);

    let patch_bytes = fs::read(&patch_path).expect("patch");
    assert_eq!(&patch_bytes[..8], b"BSDIFF40");

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
fn create_is_deterministic_across_thread_budgets() {
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

    let single_patch = fs::read(&patch_single).expect("single-thread patch");
    let parallel_patch = fs::read(&patch_parallel).expect("parallel-thread patch");
    assert_eq!(single_patch, parallel_patch);
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

fn build_large_fixture_bytes() -> Vec<u8> {
    let mut bytes = vec![0u8; 512 * 1024];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    bytes
}
