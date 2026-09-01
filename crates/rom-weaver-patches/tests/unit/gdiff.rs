use std::fs;

use rom_weaver_core::{
    PatchApplyRequest, PatchCreateRequest, PatchHandler, PatchValidateRequest, ProbeConfidence,
};

use super::{
    GDIFF_INLINE_DATA_MAX, GdiffPatchHandler, create_gdiff_patch_parallel,
    encode_data_command_bytes, ensure_copy_range, read_gdiff_command, write_gdiff_header,
};
use crate::shared::threading::parallel_chunked_capability;
use crate::{
    GDIFF,
    test_support::{RoundTripCase, TestDir, assert_round_trip, test_context_with_threads},
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
    let mut target = b"this is a different target with more bytes".to_vec();
    target.extend_from_slice(&[0x01, 0x02, 0x03, 0x04]);

    let handler = GdiffPatchHandler::new(&GDIFF);
    assert_round_trip(
        &handler,
        &RoundTripCase {
            patch_extension: "gdiff",
            create_threads: 4,
            apply_threads: 1,
            ..RoundTripCase::new(b"this is the old bytes", &target, "gdiff")
        },
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

/// A patch that copies `source[0..4]`, then appends two literal bytes, encoded
/// with the opcode pair the caller names. Every copy opcode addresses the same
/// range, so one source fixture drives them all.
fn patch_with_copy_opcode(opcode: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    write_gdiff_header(&mut bytes).expect("header");
    bytes.push(opcode);
    match opcode {
        249 => {
            bytes.extend_from_slice(&0u16.to_be_bytes());
            bytes.push(4);
        }
        250 => {
            bytes.extend_from_slice(&0u16.to_be_bytes());
            bytes.extend_from_slice(&4u16.to_be_bytes());
        }
        251 => {
            bytes.extend_from_slice(&0u16.to_be_bytes());
            bytes.extend_from_slice(&4i32.to_be_bytes());
        }
        252 => {
            bytes.extend_from_slice(&0i32.to_be_bytes());
            bytes.push(4);
        }
        253 => {
            bytes.extend_from_slice(&0i32.to_be_bytes());
            bytes.extend_from_slice(&4u16.to_be_bytes());
        }
        254 => {
            bytes.extend_from_slice(&0i32.to_be_bytes());
            bytes.extend_from_slice(&4i32.to_be_bytes());
        }
        255 => {
            bytes.extend_from_slice(&0i64.to_be_bytes());
            bytes.extend_from_slice(&4i32.to_be_bytes());
        }
        other => panic!("opcode {other} is not a copy opcode"),
    }
    // A 248-encoded data command exercises the 32-bit literal length arm.
    bytes.push(248);
    bytes.extend_from_slice(&2i32.to_be_bytes());
    bytes.extend_from_slice(b"XY");
    bytes.push(0);
    bytes
}

#[test]
fn probe_reports_extension_confidence() {
    let temp = TestDir::new();
    let patch = temp.child("probe.gdiff");
    fs::write(&patch, [0xD1, 0xFF, 0xD1, 0xFF, 4]).expect("fixture");

    assert_eq!(
        GdiffPatchHandler::new(&GDIFF).probe(&patch),
        ProbeConfidence::Extension
    );
}

#[test]
fn every_copy_opcode_addresses_the_same_source_range() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    fs::write(&source_path, b"abcdefgh").expect("fixture");
    let handler = GdiffPatchHandler::new(&GDIFF);

    for opcode in [249u8, 250, 251, 252, 253, 254, 255] {
        let patch_path = temp.child(&format!("opcode-{opcode}.gdiff"));
        let output_path = temp.child(&format!("output-{opcode}.bin"));
        fs::write(&patch_path, patch_with_copy_opcode(opcode)).expect("fixture");

        let report = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect("parse");
        assert_eq!(
            report.label, "parsed GDIFF patch with 2 command(s): 1 copy / 1 data; output 6 byte(s)",
            "opcode {opcode}"
        );

        handler
            .apply(
                &PatchApplyRequest {
                    input: source_path.clone(),
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("apply");
        assert_eq!(
            fs::read(&output_path).expect("output"),
            b"abcdXY",
            "opcode {opcode}"
        );
    }
}

#[test]
fn validate_checks_every_copy_range_without_writing_output() {
    let temp = TestDir::new();
    let source_path = temp.child("validate-source.bin");
    let patch_path = temp.child("validate.gdiff");
    fs::write(&source_path, b"abcdefgh").expect("fixture");
    fs::write(&patch_path, patch_with_copy_opcode(249)).expect("fixture");

    let report = GdiffPatchHandler::new(&GDIFF)
        .validate(
            &PatchValidateRequest {
                input: source_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("validate");
    assert_eq!(
        report.label,
        "validated GDIFF patch source with 2 command(s): 1 copy / 1 data; output would be 6 byte(s)"
    );
}

#[test]
fn validate_rejects_a_copy_that_runs_past_the_source() {
    let temp = TestDir::new();
    let source_path = temp.child("short-source.bin");
    let patch_path = temp.child("far-copy.gdiff");
    fs::write(&source_path, b"ab").expect("fixture");
    fs::write(&patch_path, patch_with_copy_opcode(249)).expect("fixture");

    let error = GdiffPatchHandler::new(&GDIFF)
        .validate(
            &PatchValidateRequest {
                input: source_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("a copy past the source should fail");
    assert!(
        error
            .to_string()
            .contains("copy command exceeded available source length (4 > 2)"),
        "unexpected error: {error}"
    );
}

#[test]
fn copy_ranges_are_checked_for_overflow_and_for_the_source_end() {
    ensure_copy_range(8, 4, 4).expect("a range that ends exactly at the source end");
    ensure_copy_range(8, 0, 0).expect("an empty range");

    let overflow =
        ensure_copy_range(8, u64::MAX, 1).expect_err("a range whose end leaves u64 should fail");
    assert!(
        overflow.to_string().contains("copy range overflowed"),
        "unexpected error: {overflow}"
    );

    let past_end = ensure_copy_range(8, 6, 4).expect_err("a range past the source end should fail");
    assert!(
        past_end
            .to_string()
            .contains("copy command exceeded available source length (10 > 8)"),
        "unexpected error: {past_end}"
    );
}

#[test]
fn a_negative_length_or_position_is_rejected_by_the_decoder() {
    let temp = TestDir::new();
    let source_path = temp.child("negative-source.bin");
    fs::write(&source_path, b"abcdefgh").expect("fixture");
    let handler = GdiffPatchHandler::new(&GDIFF);

    // Opcode 248 is a 32-bit literal length; opcode 253 a 32-bit copy position.
    for (opcode, tail, needle) in [
        (248u8, (-1_i32).to_be_bytes().to_vec(), "data length"),
        (
            253u8,
            {
                let mut tail = (-1_i32).to_be_bytes().to_vec();
                tail.extend_from_slice(&4u16.to_be_bytes());
                tail
            },
            "copy position",
        ),
    ] {
        let patch_path = temp.child(&format!("negative-{opcode}.gdiff"));
        let mut patch = Vec::new();
        write_gdiff_header(&mut patch).expect("header");
        patch.push(opcode);
        patch.extend_from_slice(&tail);
        patch.push(0);
        fs::write(&patch_path, patch).expect("fixture");

        let error = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect_err("a negative field should fail");
        assert!(
            error
                .to_string()
                .contains(&format!("GDIFF {needle} must be non-negative")),
            "opcode {opcode}: unexpected error: {error}"
        );
    }
}

#[test]
fn a_patch_that_ends_mid_command_names_the_field_it_was_reading() {
    let temp = TestDir::new();
    let patch_path = temp.child("truncated.gdiff");
    let mut patch = Vec::new();
    write_gdiff_header(&mut patch).expect("header");
    // A 247 data command promising two length bytes that the file does not hold.
    patch.push(247);
    patch.push(0x00);
    fs::write(&patch_path, patch).expect("fixture");

    let error = GdiffPatchHandler::new(&GDIFF)
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("a truncated command should fail");
    assert!(
        error
            .to_string()
            .contains("GDIFF patch ended unexpectedly while reading data length"),
        "unexpected error: {error}"
    );
}

#[test]
fn a_wrong_version_byte_is_rejected() {
    let temp = TestDir::new();
    let patch_path = temp.child("version.gdiff");
    fs::write(&patch_path, [0xD1, 0xFF, 0xD1, 0xFF, 9, 0]).expect("fixture");

    let error = GdiffPatchHandler::new(&GDIFF)
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("an unsupported version should fail");
    assert!(
        error
            .to_string()
            .contains("GDIFF patch version 9 is not supported"),
        "unexpected error: {error}"
    );
}

#[test]
fn the_command_decoder_refuses_an_opcode_it_is_never_handed() {
    // `parse_gdiff_patch` breaks on opcode 0 before decoding, so this arm is a
    // contract check on the decoder itself rather than a reachable patch shape.
    // `GdiffCommand` is not `Debug`, so the success arm cannot use `expect_err`.
    let Err(error) = read_gdiff_command(&mut std::io::Cursor::new(Vec::new()), 0) else {
        panic!("opcode 0 is not a command");
    };
    assert!(
        error
            .to_string()
            .contains("GDIFF opcode 0 is not supported"),
        "unexpected error: {error}"
    );
}

#[test]
fn data_commands_switch_to_the_16_bit_length_form_past_the_inline_maximum() {
    let inline = encode_data_command_bytes(&vec![0xAB; GDIFF_INLINE_DATA_MAX]).expect("inline");
    assert_eq!(inline[0], GDIFF_INLINE_DATA_MAX as u8);
    assert_eq!(inline.len(), GDIFF_INLINE_DATA_MAX + 1);

    let extended =
        encode_data_command_bytes(&vec![0xCD; GDIFF_INLINE_DATA_MAX + 1]).expect("extended");
    assert_eq!(extended[0], 247);
    assert_eq!(
        u16::from_be_bytes([extended[1], extended[2]]),
        (GDIFF_INLINE_DATA_MAX + 1) as u16
    );
    assert_eq!(extended.len(), GDIFF_INLINE_DATA_MAX + 4);
}

#[test]
fn parallel_create_writes_a_bare_terminator_for_an_empty_input() {
    let temp = TestDir::new();
    let modified = temp.child("empty.bin");
    fs::write(&modified, b"").expect("fixture");
    let context = test_context_with_threads(&temp, 4);
    let (_, pool) = context
        .build_pool(parallel_chunked_capability(0, 4 * 1024 * 1024))
        .expect("pool");

    let mut output = Vec::new();
    let (command_count, output_bytes) =
        create_gdiff_patch_parallel(&modified, &pool, &mut output).expect("create");

    assert_eq!((command_count, output_bytes), (0, 0));
    assert_eq!(output, vec![0xD1, 0xFF, 0xD1, 0xFF, 4, 0]);
}
