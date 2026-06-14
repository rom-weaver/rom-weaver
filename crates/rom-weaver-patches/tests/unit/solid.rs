use std::{
    fs,
    sync::{Mutex, OnceLock},
};

use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

use super::*;
use crate::{
    SOLID,
    test_support::{
        RoundTripCase, TestDir, assert_round_trip,
        test_context_with_threads_in_root as test_context_with_threads,
    },
};

static SOLID_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct EnvRestore {
    entries: Vec<(&'static str, Option<Option<String>>)>,
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        for (name, previous) in &self.entries {
            restore_solid_test_env_override(name, previous.clone());
        }
    }
}

fn set_env_vars(vars: &[(&'static str, Option<&str>)]) -> EnvRestore {
    let mut entries = Vec::with_capacity(vars.len());
    for (name, value) in vars {
        let previous = set_solid_test_env_override(name, *value);
        entries.push((*name, previous));
    }
    EnvRestore { entries }
}

fn with_solid_env_vars(vars: &[(&'static str, Option<&str>)], run: impl FnOnce()) {
    let lock = SOLID_ENV_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().expect("solid env lock");
    let _restore = set_env_vars(vars);
    run();
}

#[test]
fn parse_rejects_invalid_magic() {
    let temp = TestDir::new();
    let patch = temp.child("broken.solid");
    fs::write(&patch, b"XX\x04\x00bad").expect("fixture");

    let handler = SolidPatchHandler::new(&SOLID);
    let error = handler
        .parse(&patch, &test_context_with_threads(&temp, 1))
        .expect_err("parse should fail");
    assert!(error.to_string().contains("SOLID patch"));
}

#[test]
fn create_and_apply_round_trip_for_truncate_case() {
    let handler = SolidPatchHandler::new(&SOLID);
    assert_round_trip(
        &handler,
        &RoundTripCase {
            patch_extension: "solid",
            create_threads: 2,
            apply_threads: 1,
            in_root: true,
            ..RoundTripCase::new(b"ABCDEFGHIJ", b"ABCDzzG", "solid")
        },
    );
}

#[test]
fn create_and_apply_round_trip_for_expand_case() {
    let handler = SolidPatchHandler::new(&SOLID);
    assert_round_trip(
        &handler,
        &RoundTripCase {
            patch_extension: "solid",
            create_threads: 2,
            apply_threads: 1,
            in_root: true,
            patch_assert: Some(|patch_bytes| {
                assert_eq!(&patch_bytes[..SOLID_MAGIC.len()], SOLID_MAGIC);
                let addr_param = patch_bytes[SOLID_MAGIC.len() + 1];
                assert_eq!((addr_param & MOD_ACTION_MASK) >> 4, MOD_ACTION_EXPAND);
            }),
            ..RoundTripCase::new(b"ABCDEF", b"ABXCDEFZ", "solid")
        },
    );
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let original = temp.child("old-large.bin");
    let modified = temp.child("new-large.bin");
    let single_patch = temp.child("single/update.solid");
    let parallel_patch = temp.child("parallel/update.solid");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 48 * 1024;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 5 + (index >> 1)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(4099) {
        target[index] ^= 0x66;
    }

    fs::write(&original, &source).expect("source");
    fs::write(&modified, &target).expect("target");

    let handler = SolidPatchHandler::new(&SOLID);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: original.clone(),
                modified: modified.clone(),
                output: single_patch.clone(),
                format: "solid".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single create");
    let parallel_report = handler
        .create(
            &PatchCreateRequest {
                original,
                modified,
                output: parallel_patch.clone(),
                format: "solid".into(),
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

#[test]
fn create_is_deterministic_when_diff_crosses_chunk_boundary_and_expands_suffix() {
    let temp = TestDir::new();
    let original = temp.child("old-boundary.bin");
    let modified = temp.child("new-boundary.bin");
    let single_patch = temp.child("single/boundary.solid");
    let parallel_patch = temp.child("parallel/boundary.solid");
    let output = temp.child("output-boundary.bin");

    let original_len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 8;
    let mut source = vec![0u8; original_len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 3) & 0xff) as u8;
    }
    let mut target = source.clone();
    target.resize(original_len + 32, 0);
    let run_start = super::CREATE_THREAD_SCAN_CHUNK_BYTES - 4;
    for (index, byte) in target.iter_mut().enumerate().skip(run_start) {
        *byte = ((index * 13 + 5) & 0xff) as u8;
    }

    fs::write(&original, &source).expect("source");
    fs::write(&modified, &target).expect("target");

    let handler = SolidPatchHandler::new(&SOLID);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: original.clone(),
                modified: modified.clone(),
                output: single_patch.clone(),
                format: "solid".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single create");
    let parallel_report = handler
        .create(
            &PatchCreateRequest {
                original: original.clone(),
                modified: modified.clone(),
                output: parallel_patch.clone(),
                format: "solid".into(),
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
        fs::read(&single_patch).expect("single patch"),
        fs::read(&parallel_patch).expect("parallel patch")
    );

    let patch_bytes = fs::read(&parallel_patch).expect("patch bytes");
    let parsed = parse_solid_patch_bytes(&patch_bytes).expect("parse");
    match parsed.resize {
        ResizeAction::Expand { size, .. } => assert_eq!(size, 32),
        _ => panic!("expected expand resize action"),
    }
    assert_eq!(parsed.expansion_data.len(), 32);

    handler
        .apply(
            &PatchApplyRequest {
                input: original,
                patches: vec![parallel_patch],
                output: output.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("apply");
    assert_eq!(fs::read(output).expect("output"), target);
}

#[test]
fn create_can_emit_patch_info_flag_with_seven_strings() {
    with_solid_env_vars(
        &[
            (SOLID_PATCH_INFO7_ENV, Some("1")),
            (SOLID_PATCH_SYSTEM_ENV, Some("NDS")),
            (SOLID_PATCH_GAME_ENV, Some("Example Game")),
            (SOLID_PATCH_HACK_ENV, Some("Example Hack")),
            (SOLID_PATCH_VERSION_ENV, Some("v1.0")),
            (SOLID_PATCH_AUTHOR_ENV, Some("rom-weaver")),
            (SOLID_PATCH_CONTACT_ENV, Some("example@example.com")),
            (SOLID_PATCH_COMMENT_ENV, Some("generated in tests")),
        ],
        || {
            let temp = TestDir::new();
            let original = temp.child("old.bin");
            let modified = temp.child("new.bin");
            let patch = temp.child("update.solid");
            fs::write(&original, b"abcdefgh").expect("fixture");
            fs::write(&modified, b"abcXefgh").expect("fixture");

            let handler = SolidPatchHandler::new(&SOLID);
            handler
                .create(
                    &PatchCreateRequest {
                        original,
                        modified,
                        output: patch.clone(),
                        format: "solid".into(),
                    },
                    &test_context_with_threads(&temp, 1),
                )
                .expect("create");

            let patch_bytes = fs::read(&patch).expect("patch bytes");
            let addr_param = patch_bytes[SOLID_MAGIC.len() + 1];
            assert_ne!(addr_param & PATCH_INFO_FLAG, 0);

            let mut cursor = SOLID_MAGIC.len() + 2;
            let width = if addr_param & BIG_FILE_FLAG != 0 {
                8
            } else {
                4
            };
            let _primitive_count =
                read_u64_le(&patch_bytes, &mut cursor, width, "SOLID primitive count")
                    .expect("primitive count");
            let _source_md5 = read_md5(&patch_bytes, &mut cursor).expect("md5");
            let _creation_date =
                read_exact(&patch_bytes, &mut cursor, SOLID_DATE_LEN).expect("date");

            let mut description_strings = Vec::new();
            for _ in 0..SOLID_MAX_DESCRIPTION_COUNT {
                description_strings.push(
                    read_null_terminated_string(&patch_bytes, &mut cursor)
                        .expect("description string"),
                );
            }

            assert_eq!(description_strings[0], "NDS");
            assert_eq!(description_strings[1], "Example Game");
            assert_eq!(description_strings[2], "Example Hack");
            assert_eq!(description_strings[3], "v1.0");
            assert_eq!(description_strings[4], "rom-weaver");
            assert_eq!(description_strings[5], "example@example.com");
            assert_eq!(description_strings[6], "generated in tests");
        },
    );
}

#[test]
fn apply_rejects_md5_mismatch() {
    let temp = TestDir::new();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.solid");
    let wrong_input = temp.child("wrong.bin");
    let output = temp.child("output.bin");

    fs::write(&original, b"ABCDEFGH").expect("fixture");
    fs::write(&modified, b"ABCXEFGH").expect("fixture");
    fs::write(&wrong_input, b"XXXXXXXX").expect("fixture");

    let handler = SolidPatchHandler::new(&SOLID);
    handler
        .create(
            &PatchCreateRequest {
                original,
                modified,
                output: patch.clone(),
                format: "solid".into(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("create");

    let error = handler
        .apply(
            &PatchApplyRequest {
                input: wrong_input,
                patches: vec![patch],
                output,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("apply should fail");
    assert!(error.to_string().contains("MD5 mismatch"));
}

#[test]
fn apply_runtime_threads_match_capabilities_for_multi_primitive_patch() {
    let temp = TestDir::new();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.solid");
    let output = temp.child("output.bin");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 96 * 1024;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 9 + (index >> 3)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(2053) {
        target[index] ^= 0x3c;
    }

    fs::write(&original, &source).expect("source");
    fs::write(&modified, &target).expect("target");

    let handler = SolidPatchHandler::new(&SOLID);
    let capabilities = handler.capabilities();
    assert!(capabilities.threaded_output);

    handler
        .create(
            &PatchCreateRequest {
                original: original.clone(),
                modified: modified.clone(),
                output: patch.clone(),
                format: "solid".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");

    let apply_report = handler
        .apply(
            &PatchApplyRequest {
                input: original,
                patches: vec![patch],
                output: output.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");

    let execution = apply_report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 8);
    assert!(execution.used_parallelism);
    assert_eq!(fs::read(output).expect("output"), target);
}
