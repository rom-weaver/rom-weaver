use std::fs;

use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

use super::{PatPatchHandler, has_pat_record_signature, parse_pat_record};
use crate::{
    PAT,
    test_support::{TestDir, test_context_with_threads},
};

#[test]
fn parse_accepts_fireflower_and_fc_styles() {
    assert!(parse_pat_record("00000010 FF 00").is_some());
    assert!(parse_pat_record("00000010: FF 00").is_some());
    assert!(parse_pat_record("00000010 0g 00").is_none());
}

#[test]
fn apply_supports_forward_and_reverse_byte_toggles() {
    let temp = TestDir::new();
    let source = temp.child("source.bin");
    let patch = temp.child("toggle.pat");
    let forward = temp.child("forward.bin");
    let reverse = temp.child("reverse.bin");

    fs::write(&source, b"abc").expect("fixture");
    fs::write(&patch, b"00000000 61 41\n00000001 62 42\n").expect("fixture");

    let handler = PatPatchHandler::new(&PAT);
    handler
        .apply(
            &PatchApplyRequest {
                input: source.clone(),
                patches: vec![patch.clone()],
                output: forward.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("forward apply");

    assert_eq!(fs::read(&forward).expect("forward"), b"ABc");

    handler
        .apply(
            &PatchApplyRequest {
                input: forward,
                patches: vec![patch],
                output: reverse.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("reverse apply");

    assert_eq!(fs::read(reverse).expect("reverse"), b"abc");
}

#[test]
fn apply_skips_unexpected_bytes_without_failing() {
    let temp = TestDir::new();
    let source = temp.child("source.bin");
    let patch = temp.child("skip.pat");
    let output = temp.child("output.bin");

    fs::write(&source, b"abc").expect("fixture");
    fs::write(&patch, b"00000001 00 ff\n").expect("fixture");

    let handler = PatPatchHandler::new(&PAT);
    handler
        .apply(
            &PatchApplyRequest {
                input: source.clone(),
                patches: vec![patch],
                output: output.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    assert_eq!(fs::read(output).expect("output"), b"abc");
}

#[test]
fn apply_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let source = temp.child("source.bin");
    let patch = temp.child("update.pat");
    let output_single = temp.child("output-single.bin");
    let output_parallel = temp.child("output-parallel.bin");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 8192;
    let mut source_bytes = vec![0u8; len];
    for (index, byte) in source_bytes.iter_mut().enumerate() {
        *byte = ((index * 17 + (index >> 4)) & 0xff) as u8;
    }
    fs::write(&source, &source_bytes).expect("fixture");

    let mut patch_lines = String::new();
    for offset in (0..len).step_by(4096) {
        let source_byte = source_bytes[offset];
        let modified_byte = source_byte ^ 0x5a;
        patch_lines.push_str(&format!(
            "{offset:08X} {source_byte:02X} {modified_byte:02X}\n"
        ));
    }
    // Add duplicate-offset records to verify offset-local order remains deterministic.
    let first_source = source_bytes[0];
    let first_modified = first_source ^ 0x5a;
    patch_lines.push_str(&format!(
        "00000000 {first_modified:02X} {first_source:02X}\n"
    ));
    patch_lines.push_str(&format!(
        "00000000 {first_source:02X} {first_modified:02X}\n"
    ));
    fs::write(&patch, patch_lines).expect("patch");

    let handler = PatPatchHandler::new(&PAT);
    let capabilities = handler.capabilities();
    assert!(capabilities.threaded_output);

    let single_report = handler
        .apply(
            &PatchApplyRequest {
                input: source.clone(),
                patches: vec![patch.clone()],
                output: output_single.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single apply");
    let parallel_report = handler
        .apply(
            &PatchApplyRequest {
                input: source,
                patches: vec![patch],
                output: output_parallel.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("parallel apply");

    let single_execution = single_report.thread_execution.expect("single execution");
    let parallel_execution = parallel_report
        .thread_execution
        .expect("parallel execution");
    assert!(capabilities.threaded_output);
    assert!(!single_execution.used_parallelism);
    assert!(parallel_execution.used_parallelism);

    assert_eq!(
        fs::read(output_single).expect("single"),
        fs::read(output_parallel).expect("parallel")
    );
}

#[test]
fn create_rejects_mismatched_lengths() {
    let temp = TestDir::new();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.pat");

    fs::write(&original, b"abc").expect("fixture");
    fs::write(&modified, b"abcd").expect("fixture");

    let handler = PatPatchHandler::new(&PAT);
    let error = handler
        .create(
            &PatchCreateRequest {
                original,
                modified,
                output: patch,
                format: "pat".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("mismatched lengths should fail");
    assert!(error.to_string().contains("requires equal input lengths"));
}

#[test]
fn create_and_apply_round_trip() {
    let temp = TestDir::new();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.pat");
    let output = temp.child("output.bin");

    fs::write(&original, b"hello old world").expect("fixture");
    fs::write(&modified, b"HELlo old worlD").expect("fixture");

    let handler = PatPatchHandler::new(&PAT);
    handler
        .create(
            &PatchCreateRequest {
                original: original.clone(),
                modified: modified.clone(),
                output: patch.clone(),
                format: "pat".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let patch_text = fs::read_to_string(&patch).expect("patch");
    assert!(patch_text.contains("00000000 68 48"));
    assert!(has_pat_record_signature(&patch));

    handler
        .apply(
            &PatchApplyRequest {
                input: original,
                patches: vec![patch],
                output: output.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    assert_eq!(
        fs::read(output).expect("output"),
        fs::read(modified).expect("modified")
    );
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let original = temp.child("old-large.bin");
    let modified = temp.child("new-large.bin");
    let patch_single = temp.child("single.pat");
    let patch_parallel = temp.child("parallel.pat");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 32 * 1024;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 31 + (index >> 6)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(3001) {
        target[index] ^= 0x7f;
    }

    fs::write(&original, &source).expect("source");
    fs::write(&modified, &target).expect("target");

    let handler = PatPatchHandler::new(&PAT);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: original.clone(),
                modified: modified.clone(),
                output: patch_single.clone(),
                format: "pat".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single create");
    let parallel_report = handler
        .create(
            &PatchCreateRequest {
                original,
                modified,
                output: patch_parallel.clone(),
                format: "pat".into(),
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
        fs::read(patch_single).expect("single patch"),
        fs::read(patch_parallel).expect("parallel patch")
    );
}
