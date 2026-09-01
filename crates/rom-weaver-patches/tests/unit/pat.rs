use std::fs;

use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler, PatchValidateRequest};

use super::{
    PatPatchHandler, build_pat_parse_label, collect_pat_chunk_records_for_chunk,
    create_pat_patch_parallel, create_pat_patch_streaming, has_pat_record_signature,
    parse_pat_file, parse_pat_record,
};
use crate::shared::threading::parallel_chunked_capability;
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
    // apply streams by default: single-thread budget serial, parallel budget parallel
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

/// Two toggles plus a comment line the parser has to ignore.
const COMMENTED_PATCH: &str = "# a comment the parser ignores\n\
00000000 61 41\n\
\n\
00000002 63 43\n";

#[test]
fn parse_reports_the_record_count_and_any_ignored_lines() {
    let temp = TestDir::new();
    let clean = temp.child("clean.pat");
    let commented = temp.child("commented.pat");
    fs::write(&clean, "00000000 61 41\n").expect("fixture");
    fs::write(&commented, COMMENTED_PATCH).expect("fixture");

    let handler = PatPatchHandler::new(&PAT);
    let context = test_context_with_threads(&temp, 1);

    let clean_report = handler.parse(&clean, &context).expect("parse");
    assert_eq!(clean_report.label, "parsed PAT patch with 1 record(s)");

    let commented_report = handler.parse(&commented, &context).expect("parse");
    assert_eq!(
        commented_report.label,
        "parsed PAT patch with 2 record(s); ignored 2 non-record line(s)"
    );
}

#[test]
fn parse_labels_are_built_from_the_parsed_counts() {
    let temp = TestDir::new();
    let path = temp.child("label.pat");
    fs::write(&path, COMMENTED_PATCH).expect("fixture");
    let parsed = parse_pat_file(&path).expect("parse");

    assert_eq!(
        build_pat_parse_label("PAT", &parsed),
        "parsed PAT patch with 2 record(s); ignored 2 non-record line(s)"
    );
}

#[test]
fn parse_rejects_a_line_longer_than_the_supported_maximum() {
    let temp = TestDir::new();
    let path = temp.child("long-line.pat");
    let mut line = "00000000 61 41".to_string();
    line.push_str(&" ".repeat(super::PAT_LINE_MAX_BYTES));
    line.push('\n');
    fs::write(&path, line).expect("fixture");

    let error = parse_pat_file(&path).expect_err("an over-long line should fail");
    assert!(
        error.to_string().contains("PAT line exceeded maximum"),
        "unexpected error: {error}"
    );
}

#[test]
fn record_parsing_rejects_malformed_field_shapes() {
    // Three whitespace-separated fields, the last two exactly two hex digits.
    assert!(parse_pat_record("00000010 FF 00 EXTRA").is_none());
    assert!(parse_pat_record("00000010 FFF 00").is_none());
    assert!(parse_pat_record("00000010 FF 000").is_none());
    assert!(parse_pat_record("00000010 FF").is_none());
    assert!(parse_pat_record("0000").is_none());
    // A leading byte-order mark is stripped rather than failing the offset.
    assert!(parse_pat_record("\u{feff}00000010 FF 00").is_some());
}

#[test]
fn validate_reports_forward_reverse_and_skipped_records() {
    let temp = TestDir::new();
    let source = temp.child("validate-source.bin");
    let patch = temp.child("validate.pat");
    fs::write(&source, b"abc").expect("fixture");
    // Offset 0 matches the source byte (forward), offset 1 matches the modified
    // byte (reverse), offset 2 matches neither (skipped).
    fs::write(&patch, "00000000 61 41\n00000001 42 62\n00000002 78 79\n").expect("fixture");

    let report = PatPatchHandler::new(&PAT)
        .validate(
            &PatchValidateRequest {
                input: source,
                patches: vec![patch],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("validate");

    assert_eq!(
        report.label,
        "validated PAT patch source with 3 record(s): 1 forward / 1 reverse; 1 record(s) would be skipped due to unexpected input byte"
    );
}

#[test]
fn validate_rejects_a_record_offset_past_the_input() {
    let temp = TestDir::new();
    let source = temp.child("short.bin");
    let patch = temp.child("far.pat");
    fs::write(&source, b"ab").expect("fixture");
    fs::write(&patch, "00000010 61 41\n").expect("fixture");

    let error = PatPatchHandler::new(&PAT)
        .validate(
            &PatchValidateRequest {
                input: source,
                patches: vec![patch],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("an out-of-range offset should fail");
    assert!(
        error
            .to_string()
            .contains("PAT record offset 0x00000010 exceeded input length 2"),
        "unexpected error: {error}"
    );
}

#[test]
fn apply_uses_the_in_memory_path_when_the_input_fits_the_cap() {
    let temp = TestDir::new();
    let source = temp.child("in-memory-source.bin");
    let patch = temp.child("in-memory.pat");
    let output = temp.child("in-memory-output.bin");
    fs::write(&source, b"abc").expect("fixture");
    fs::write(&patch, "# header comment\n00000000 61 41\n00000002 63 43\n").expect("fixture");

    let report = PatPatchHandler::new(&PAT)
        .apply(
            &PatchApplyRequest {
                input: source,
                patches: vec![patch],
                output: output.clone(),
            },
            &test_context_with_threads(&temp, 4).with_patch_apply_in_memory_limit(1 << 20),
        )
        .expect("apply");

    // The in-memory path always reports serial execution, whatever was planned.
    assert!(
        !report
            .thread_execution
            .expect("thread execution")
            .used_parallelism
    );
    assert_eq!(
        report.label,
        "applied PAT patch with 2 record(s): 2 forward / 0 reverse; ignored 1 non-record line(s)"
    );
    assert_eq!(fs::read(&output).expect("output"), b"AbC");
}

#[test]
fn streaming_create_rejects_inputs_of_different_lengths() {
    let temp = TestDir::new();
    let original = temp.child("streaming-original.bin");
    let modified = temp.child("streaming-modified.bin");
    fs::write(&original, b"abcd").expect("fixture");
    fs::write(&modified, b"abc").expect("fixture");

    let error =
        create_pat_patch_streaming(&original, &modified).expect_err("unequal lengths should fail");
    assert!(
        error
            .to_string()
            .contains("PAT create requires equal input lengths (original: 4, modified: 3)"),
        "unexpected error: {error}"
    );
}

#[test]
fn parallel_create_rejects_unequal_lengths_and_short_circuits_empty_inputs() {
    let temp = TestDir::new();
    let original = temp.child("parallel-original.bin");
    let modified = temp.child("parallel-modified.bin");
    let empty = temp.child("parallel-empty.bin");
    fs::write(&original, b"abcd").expect("fixture");
    fs::write(&modified, b"abc").expect("fixture");
    fs::write(&empty, b"").expect("fixture");
    let context = test_context_with_threads(&temp, 4);
    let (_, pool) = context
        .build_pool(parallel_chunked_capability(4, 4 * 1024 * 1024))
        .expect("pool");

    let error = create_pat_patch_parallel(&original, &modified, &pool)
        .expect_err("unequal lengths should fail");
    assert!(
        error
            .to_string()
            .contains("PAT create requires equal input"),
        "unexpected error: {error}"
    );

    let empty_patch = create_pat_patch_parallel(&empty, &empty, &pool).expect("empty inputs");
    assert!(empty_patch.records.is_empty());
}

#[test]
fn a_create_scan_chunk_past_the_input_yields_no_records() {
    let temp = TestDir::new();
    let original = temp.child("chunk-original.bin");
    let modified = temp.child("chunk-modified.bin");
    fs::write(&original, b"abcd").expect("fixture");
    fs::write(&modified, b"abXd").expect("fixture");

    let beyond = collect_pat_chunk_records_for_chunk(1, &original, &modified, 4)
        .expect("a chunk past the input");
    assert!(beyond.is_empty());

    let first =
        collect_pat_chunk_records_for_chunk(0, &original, &modified, 4).expect("the first chunk");
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].offset, 2);
}

#[test]
fn a_file_without_pat_records_has_no_pat_signature() {
    let temp = TestDir::new();
    let empty = temp.child("empty.bin");
    let comments = temp.child("comments.bin");
    let records = temp.child("records.bin");
    fs::write(&empty, b"").expect("fixture");
    fs::write(&comments, "# nothing but a comment\n").expect("fixture");
    fs::write(&records, "00000000 61 41\n").expect("fixture");

    assert!(!has_pat_record_signature(&empty));
    assert!(!has_pat_record_signature(&comments));
    assert!(!has_pat_record_signature(&temp.child("missing.bin")));
    assert!(has_pat_record_signature(&records));
}
