use std::fs;

use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

use super::{GdiffPatchHandler, write_gdiff_header};
use crate::{
    GDIFF,
    test_support::{TestDir, test_context_with_threads},
};

enum TestGdiffCommand {
    Data(Vec<u8>),
    Copy { offset: u64, len: u64 },
}

fn build_test_gdiff_patch(commands: Vec<TestGdiffCommand>) -> Vec<u8> {
    let mut bytes = Vec::new();
    write_gdiff_header(&mut bytes).expect("header");
    for command in commands {
        match command {
            TestGdiffCommand::Data(data) => {
                if data.len() <= 246 {
                    bytes.push(u8::try_from(data.len()).expect("len"));
                } else {
                    bytes.push(247);
                    bytes.extend_from_slice(
                        &u16::try_from(data.len())
                            .expect("len fits u16")
                            .to_be_bytes(),
                    );
                }
                bytes.extend_from_slice(&data);
            }
            TestGdiffCommand::Copy { offset, len } => {
                if offset <= u64::from(u16::MAX) && len <= u64::from(u8::MAX) {
                    bytes.push(249);
                    bytes.extend_from_slice(&(offset as u16).to_be_bytes());
                    bytes.push(len as u8);
                } else if offset <= u64::from(i32::MAX as u32) && len <= u64::from(i32::MAX as u32)
                {
                    bytes.push(254);
                    bytes.extend_from_slice(&(offset as u32).to_be_bytes());
                    bytes.extend_from_slice(&(len as u32).to_be_bytes());
                } else {
                    bytes.push(255);
                    bytes.extend_from_slice(&(offset as i64).to_be_bytes());
                    bytes.extend_from_slice(&(len as i32).to_be_bytes());
                }
            }
        }
    }
    bytes.push(0);
    bytes
}

#[test]
fn parse_rejects_invalid_magic() {
    let temp = TestDir::new();
    let patch_path = temp.child("bad.gdiff");
    fs::write(&patch_path, b"BAD!\x04\x00").expect("fixture");

    let handler = GdiffPatchHandler::new(&GDIFF);
    let error = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("invalid magic");
    assert!(error.to_string().contains("header magic is invalid"));
}

#[test]
fn apply_supports_copy_and_data_commands() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("update.gdiff");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"abcdefgh").expect("fixture");
    let patch = build_test_gdiff_patch(vec![
        TestGdiffCommand::Copy { offset: 0, len: 2 },
        TestGdiffCommand::Data(b"XY".to_vec()),
        TestGdiffCommand::Copy { offset: 4, len: 4 },
    ]);
    fs::write(&patch_path, patch).expect("fixture");

    let handler = GdiffPatchHandler::new(&GDIFF);
    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), b"abXYefgh");
}

#[test]
fn apply_rejects_negative_copy_position() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("negative.gdiff");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"abcdefgh").expect("fixture");
    let mut patch = Vec::new();
    write_gdiff_header(&mut patch).expect("header");
    patch.push(255);
    patch.extend_from_slice(&(-1_i64).to_be_bytes());
    patch.extend_from_slice(&(1_i32).to_be_bytes());
    patch.push(0);
    fs::write(&patch_path, patch).expect("fixture");

    let handler = GdiffPatchHandler::new(&GDIFF);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("negative position");
    assert!(
        error
            .to_string()
            .contains("copy position must be non-negative")
    );
}

#[test]
fn create_and_apply_round_trip() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.gdiff");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"this is the old bytes").expect("fixture");
    let mut target = b"this is a different target with more bytes".to_vec();
    target.extend_from_slice(&[0x01, 0x02, 0x03, 0x04]);
    fs::write(&target_path, &target).expect("fixture");

    let handler = GdiffPatchHandler::new(&GDIFF);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "gdiff".into(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("create");

    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    assert_eq!(
        fs::read(output_path).expect("output"),
        fs::read(target_path).expect("target")
    );
}

#[test]
fn apply_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("update.gdiff");
    let output_single = temp.child("output-single.bin");
    let output_parallel = temp.child("output-parallel.bin");

    let source = b"0123456789abcdefghijklmnopqrstuvwxyz".to_vec();
    fs::write(&source_path, &source).expect("fixture");
    let patch = build_test_gdiff_patch(vec![
        TestGdiffCommand::Copy { offset: 0, len: 10 },
        TestGdiffCommand::Data(b"++".to_vec()),
        TestGdiffCommand::Copy { offset: 10, len: 8 },
        TestGdiffCommand::Data(b"--".to_vec()),
        TestGdiffCommand::Copy { offset: 2, len: 14 },
        TestGdiffCommand::Data(vec![0xFA, 0xCE, 0xB0, 0x0C]),
    ]);
    fs::write(&patch_path, patch).expect("patch");

    let handler = GdiffPatchHandler::new(&GDIFF);
    let single_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_single.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single apply");
    let parallel_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_parallel.clone(),
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
    assert!(
        parallel_report
            .thread_execution
            .expect("parallel execution")
            .used_parallelism
    );
    assert_eq!(
        fs::read(output_single).expect("single output"),
        fs::read(output_parallel).expect("parallel output")
    );
}

#[test]
fn apply_runtime_threads_match_capabilities_for_multi_command_patch() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("update.gdiff");
    let output_path = temp.child("output.bin");

    let len = super::CREATE_COMMAND_CHUNK_BYTES * 4 + 257;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 17 + (index >> 2)) & 0xff) as u8;
    }
    fs::write(&source_path, &source).expect("source");

    let patch = build_test_gdiff_patch(vec![
        TestGdiffCommand::Copy {
            offset: 0,
            len: super::CREATE_COMMAND_CHUNK_BYTES as u64,
        },
        TestGdiffCommand::Data(vec![0xAA; 64]),
        TestGdiffCommand::Copy {
            offset: super::CREATE_COMMAND_CHUNK_BYTES as u64,
            len: super::CREATE_COMMAND_CHUNK_BYTES as u64,
        },
        TestGdiffCommand::Data(vec![0x55; 64]),
        TestGdiffCommand::Copy {
            offset: (super::CREATE_COMMAND_CHUNK_BYTES * 2) as u64,
            len: super::CREATE_COMMAND_CHUNK_BYTES as u64,
        },
    ]);
    fs::write(&patch_path, patch).expect("patch");

    let handler = GdiffPatchHandler::new(&GDIFF);
    let capabilities = handler.capabilities();
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");
    let execution = report.thread_execution.expect("thread execution");

    assert!(capabilities.threaded_output);
    assert_eq!(execution.requested_threads, 8);
    assert!(execution.used_parallelism);
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let source_path = temp.child("source-large.bin");
    let target_path = temp.child("target-large.bin");
    let single_patch = temp.child("single.gdiff");
    let parallel_patch = temp.child("parallel.gdiff");

    let len = super::CREATE_COMMAND_CHUNK_BYTES * 8 + 123;
    fs::write(&source_path, vec![0u8; len]).expect("source");

    let mut target = vec![0u8; len];
    for (index, byte) in target.iter_mut().enumerate() {
        *byte = ((index * 11 + (index >> 3)) & 0xff) as u8;
    }
    fs::write(&target_path, &target).expect("target");

    let handler = GdiffPatchHandler::new(&GDIFF);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: single_patch.clone(),
                format: "gdiff".into(),
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
                format: "gdiff".into(),
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
