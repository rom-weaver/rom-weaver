use std::fs;

use rom_weaver_core::{
    PatchApplyRequest, PatchChecksumValidation, PatchCreateFormatOptions, PatchCreateRequest,
    PatchHandler, PatchValidateRequest, SolidPatchMetadata,
};

use super::*;
use crate::{
    SOLID,
    test_support::{
        RoundTripCase, TestDir, assert_round_trip, report_endpoints,
        test_context_with_threads_in_root as test_context_with_threads,
    },
};

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
fn parse_reports_normalized_source_md5_endpoint() {
    let temp = TestDir::new();
    let original = temp.child("original.bin");
    let modified = temp.child("modified.bin");
    let patch = temp.child("patch.solid");
    fs::write(&original, b"ABCDEF").expect("source");
    fs::write(&modified, b"ABCDzz").expect("target");

    let handler = SolidPatchHandler::new(&SOLID);
    handler
        .create(
            &PatchCreateRequest {
                original: original.clone(),
                modified,
                output: patch.clone(),
                format: "solid".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let report = handler
        .parse(&patch, &test_context_with_threads(&temp, 1))
        .expect("parse");
    let parsed = parse_solid_patch_file(&patch).expect("parsed");

    let endpoints = report_endpoints(&report);
    assert_eq!(endpoints.len(), 1);
    assert_eq!(
        endpoints[0]["input"]["checksums"]["md5"].as_str(),
        Some(format_md5_hex(parsed.source_md5).as_str())
    );
    assert!(endpoints[0]["input"].get("size").is_none());
    assert!(
        endpoints[0]["output"]
            .as_object()
            .expect("output")
            .is_empty()
    );
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
    let temp = TestDir::new();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.solid");
    fs::write(&original, b"abcdefgh").expect("fixture");
    fs::write(&modified, b"abcXefgh").expect("fixture");

    let options = PatchCreateFormatOptions::Solid(SolidPatchMetadata {
        system: Some("NDS".into()),
        game: Some("Example Game".into()),
        hack: Some("Example Hack".into()),
        version: Some("v1.0".into()),
        author: Some("rom-weaver".into()),
        contact: Some("example@example.com".into()),
        comment: Some("generated in tests".into()),
        extended: true,
    });
    let handler = SolidPatchHandler::new(&SOLID);
    handler
        .create_with_options(
            &PatchCreateRequest {
                original,
                modified,
                output: patch.clone(),
                format: "solid".into(),
            },
            Some(&options),
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
    let _primitive_count = read_u64_le(&patch_bytes, &mut cursor, width, "SOLID primitive count")
        .expect("primitive count");
    let _source_md5 = read_md5(&patch_bytes, &mut cursor).expect("md5");
    let _creation_date = read_exact(&patch_bytes, &mut cursor, SOLID_DATE_LEN).expect("date");

    let mut description_strings = Vec::new();
    for _ in 0..SOLID_MAX_DESCRIPTION_COUNT {
        description_strings.push(
            read_null_terminated_string(&patch_bytes, &mut cursor).expect("description string"),
        );
    }

    assert_eq!(description_strings[0], "NDS");
    assert_eq!(description_strings[1], "Example Game");
    assert_eq!(description_strings[2], "Example Hack");
    assert_eq!(description_strings[3], "v1.0");
    assert_eq!(description_strings[4], "rom-weaver");
    assert_eq!(description_strings[5], "example@example.com");
    assert_eq!(description_strings[6], "generated in tests");
}

#[test]
fn create_can_override_basic_metadata_without_extended_header() {
    let temp = TestDir::new();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.solid");
    fs::write(&original, b"abcdefgh").expect("fixture");
    fs::write(&modified, b"abcXefgh").expect("fixture");

    let options = PatchCreateFormatOptions::Solid(SolidPatchMetadata {
        system: Some("NDS".into()),
        game: Some("Example Game".into()),
        hack: Some("Example Hack".into()),
        ..SolidPatchMetadata::default()
    });
    SolidPatchHandler::new(&SOLID)
        .create_with_options(
            &PatchCreateRequest {
                original,
                modified,
                output: patch.clone(),
                format: "solid".into(),
            },
            Some(&options),
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let bytes = fs::read(patch).expect("patch bytes");
    assert_eq!(bytes[SOLID_MAGIC.len() + 1] & PATCH_INFO_FLAG, 0);
    assert!(
        bytes
            .windows(b"NDS\0Example Game\0Example Hack\0".len())
            .any(|window| window == b"NDS\0Example Game\0Example Hack\0")
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

/// Assemble a hand-crafted SOLID patch with the default version, a 4-byte
/// `primitiveCount` (no big-file flag), three empty description strings (no
/// patch-info flag), and a zeroed source MD5. `body` carries everything after
/// the description block: resize fields (per the `mod_action` encoded in
/// `addr_param`), primitive records, then any expansion payload.
fn assemble_solid(addr_param: u8, primitive_count: u32, body: &[u8]) -> Vec<u8> {
    assemble_solid_versioned(SOLID_FORMAT_VERSION, addr_param, primitive_count, body)
}

fn assemble_solid_versioned(
    version: u8,
    addr_param: u8,
    primitive_count: u32,
    body: &[u8],
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(SOLID_MAGIC);
    out.push(version);
    out.push(addr_param);
    out.extend_from_slice(&primitive_count.to_le_bytes());
    out.extend_from_slice(&[0u8; SOLID_MD5_LEN]);
    out.extend_from_slice(&[0u8, 0, 0]); // date -> decodes to None
    out.push(0); // description 1 (empty)
    out.push(0); // description 2 (empty)
    out.push(0); // description 3 (empty)
    out.extend_from_slice(body);
    out
}

/// Run both SOLID decoders over the same bytes: the streaming file parser
/// (`parse_solid_patch_file`, written to disk) and the in-memory byte parser
/// (`parse_solid_patch_bytes`). Both share the on-disk format so each error and
/// decode arm should agree.
fn parse_solid_both(
    temp: &TestDir,
    name: &str,
    bytes: &[u8],
) -> (Result<ParsedSolidPatch>, Result<ParsedSolidPatch>) {
    let path = temp.child(name);
    fs::write(&path, bytes).expect("write crafted patch");
    (
        parse_solid_patch_file(&path),
        parse_solid_patch_bytes(bytes),
    )
}

fn assert_both_err_contains(
    results: (Result<ParsedSolidPatch>, Result<ParsedSolidPatch>),
    needle: &str,
) {
    let (file_result, bytes_result) = results;
    let file_err = file_result.expect_err("file parser should reject");
    let bytes_err = bytes_result.expect_err("bytes parser should reject");
    assert!(
        file_err.to_string().contains(needle),
        "file parser error did not contain {needle:?}: {file_err}"
    );
    assert!(
        bytes_err.to_string().contains(needle),
        "bytes parser error did not contain {needle:?}: {bytes_err}"
    );
}

/// One base-addressed literal ("AB" at delta 0), one relative literal ("C" one
/// byte further on), and one 0xFF-addressed RLE run (two bytes of 0x5A). Drives
/// every primitive-address arm plus both payload variants.
fn mixed_primitive_patch() -> Vec<u8> {
    let body = [
        0x00, 0x02, 0x00, 0x00, b'A', b'B', // base-addr literal "AB", base delta 0 (2-byte)
        0x01, 0x01, b'C', // relative (+1) literal "C"
        0xFF, 0x00, 0x02, 0x5A, // 0xFF addr, RLE length 2 value 0x5A
    ];
    // addr_param 0x01: baseAddrSize encoded 1 -> 2-byte base addresses, modFileAction none.
    assemble_solid(0x01, 3, &body)
}

#[test]
fn parse_rejects_header_below_minimum_length() {
    let temp = TestDir::new();
    assert_both_err_contains(
        parse_solid_both(&temp, "tiny.solid", b"SP\x04\x01"),
        "too small to contain a valid header",
    );
}

#[test]
fn parse_rejects_unsupported_version() {
    let temp = TestDir::new();
    let bytes = assemble_solid_versioned(SOLID_FORMAT_VERSION + 1, 0x01, 0, &[]);
    assert_both_err_contains(
        parse_solid_both(&temp, "version.solid", &bytes),
        "unsupported version",
    );
}

#[test]
fn parse_rejects_unsupported_mod_file_action() {
    let temp = TestDir::new();
    // modFileAction bits = 3 (> MOD_ACTION_TRUNCATE).
    let bytes = assemble_solid(0x30, 0, &[]);
    assert_both_err_contains(
        parse_solid_both(&temp, "mod-action.solid", &bytes),
        "unsupported modFileAction",
    );
}

#[test]
fn parse_rejects_extension_flag() {
    let temp = TestDir::new();
    let bytes = assemble_solid(EXTENSION_FLAG, 0, &[]);
    assert_both_err_contains(
        parse_solid_both(&temp, "extension.solid", &bytes),
        "extensionFlag",
    );
}

#[test]
fn parse_rejects_base_addr_when_base_size_disabled() {
    let temp = TestDir::new();
    // addr_param 0x00 disables baseAddrSize, but the lone primitive uses addr_byte 0
    // (base addressing) which requires it.
    let body = [0x00, 0x02];
    let bytes = assemble_solid(0x00, 1, &body);
    assert_both_err_contains(
        parse_solid_both(&temp, "base-disabled.solid", &bytes),
        "baseAddrSize is disabled",
    );
}

#[test]
fn parse_rejects_truncated_literal_payload() {
    let temp = TestDir::new();
    // One relative literal claiming 4 payload bytes but only 2 are present.
    let body = [0x01, 0x04, 0xAA, 0xBB];
    let bytes = assemble_solid(0x00, 1, &body);
    assert_both_err_contains(
        parse_solid_both(&temp, "truncated.solid", &bytes),
        "ended unexpectedly",
    );
}

#[test]
fn parse_rejects_unexpected_trailing_data() {
    let temp = TestDir::new();
    // Zero primitives, no resize: the extra 0x99 byte is unexpected trailing data.
    let bytes = assemble_solid(0x00, 0, &[0x99]);
    assert_both_err_contains(
        parse_solid_both(&temp, "trailing.solid", &bytes),
        "unexpected trailing data",
    );
}

#[test]
fn parse_decodes_all_primitive_address_and_payload_arms() {
    let temp = TestDir::new();
    let bytes = mixed_primitive_patch();
    let (file_result, bytes_result) = parse_solid_both(&temp, "mixed.solid", &bytes);
    file_result.expect("file parser should accept mixed patch");
    let parsed = bytes_result.expect("bytes parser should accept mixed patch");

    assert!(matches!(parsed.resize, ResizeAction::None));
    assert_eq!(parsed.primitives.len(), 3);

    assert_eq!(parsed.primitives[0].addr_byte, 0);
    assert_eq!(parsed.primitives[0].base_delta, Some(0));
    assert!(matches!(
        parsed.primitives[0].payload,
        PrimitivePayload::Literal(ref data) if data.as_slice() == b"AB"
    ));

    assert_eq!(parsed.primitives[1].addr_byte, 1);
    assert_eq!(parsed.primitives[1].base_delta, None);
    assert!(matches!(
        parsed.primitives[1].payload,
        PrimitivePayload::Literal(ref data) if data.as_slice() == b"C"
    ));

    assert_eq!(parsed.primitives[2].addr_byte, 0xFF);
    assert!(matches!(
        parsed.primitives[2].payload,
        PrimitivePayload::Rle {
            len: 2,
            value: 0x5A
        }
    ));
}

#[test]
fn apply_writes_relative_and_rle_primitives() {
    let temp = TestDir::new();
    let source = temp.child("src.bin");
    let patch = temp.child("mixed.solid");
    let output = temp.child("out.bin");
    fs::write(&source, [0u8; 8]).expect("source");
    fs::write(&patch, mixed_primitive_patch()).expect("patch");

    let handler = SolidPatchHandler::new(&SOLID);
    handler
        .apply(
            &PatchApplyRequest {
                input: source,
                patches: vec![patch],
                output: output.clone(),
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("apply");

    assert_eq!(
        fs::read(&output).expect("output"),
        vec![0x41, 0x42, 0x00, 0x43, 0x5A, 0x5A, 0x00, 0x00]
    );
}

#[test]
fn apply_rejects_truncate_size_beyond_output_length() {
    let temp = TestDir::new();
    let source = temp.child("src.bin");
    let patch = temp.child("truncate.solid");
    let output = temp.child("out.bin");
    fs::write(&source, b"ABCD").expect("source");
    // modFileAction truncate (2 << 4), zero primitives, truncate size 100 > 4-byte source.
    let bytes = assemble_solid(0x20, 0, &100u32.to_le_bytes());
    fs::write(&patch, bytes).expect("patch");

    let handler = SolidPatchHandler::new(&SOLID);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: source,
                patches: vec![patch],
                output,
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect_err("apply should reject oversized truncate");
    assert!(
        error
            .to_string()
            .contains("truncate size exceeds output length"),
        "unexpected error: {error}"
    );
}

#[test]
fn apply_rejects_expand_address_beyond_output_length() {
    let temp = TestDir::new();
    let source = temp.child("src.bin");
    let patch = temp.child("expand.solid");
    let output = temp.child("out.bin");
    fs::write(&source, b"ABCD").expect("source");
    // modFileAction expand (1 << 4): resizeFileAddr 100 > 4-byte source, size 2 + 2 bytes data.
    let mut body = Vec::new();
    body.extend_from_slice(&100u32.to_le_bytes()); // resizeFileAddr
    body.extend_from_slice(&2u32.to_le_bytes()); // resizeFileDataSize
    body.extend_from_slice(&[0xDE, 0xAD]); // expansion payload
    let bytes = assemble_solid(0x10, 0, &body);
    fs::write(&patch, bytes).expect("patch");

    let handler = SolidPatchHandler::new(&SOLID);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: source,
                patches: vec![patch],
                output,
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect_err("apply should reject out-of-range resizeFileAddr");
    assert!(
        error
            .to_string()
            .contains("resizeFileAddr exceeds output length"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_reports_label_for_expand_patch() {
    let temp = TestDir::new();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("expand.solid");
    fs::write(&original, b"ABCDEF").expect("source");
    fs::write(&modified, b"ABCDEFGH").expect("target"); // pure append -> expand by 2

    let handler = SolidPatchHandler::new(&SOLID);
    handler
        .create(
            &PatchCreateRequest {
                original: original.clone(),
                modified,
                output: patch.clone(),
                format: "solid".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let report = handler
        .parse(&patch, &test_context_with_threads(&temp, 1))
        .expect("parse");
    assert!(
        report.label.contains("expand at 6 for 2 byte(s)"),
        "{}",
        report.label
    );
    assert!(report.label.contains("created "), "{}", report.label);
    assert!(report.label.contains("source md5"), "{}", report.label);
}

#[test]
fn parse_reports_label_for_truncate_patch() {
    let temp = TestDir::new();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("truncate.solid");
    fs::write(&original, b"ABCDEFGH").expect("source");
    fs::write(&modified, b"ABCD").expect("target"); // shared prefix -> truncate to 4

    let handler = SolidPatchHandler::new(&SOLID);
    handler
        .create(
            &PatchCreateRequest {
                original: original.clone(),
                modified,
                output: patch.clone(),
                format: "solid".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let report = handler
        .parse(&patch, &test_context_with_threads(&temp, 1))
        .expect("parse");
    assert!(
        report.label.contains("truncate output to 4 byte(s)"),
        "{}",
        report.label
    );
}

#[test]
fn validate_succeeds_for_created_patch() {
    let temp = TestDir::new();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.solid");
    fs::write(&original, b"ABCDEFGH").expect("source");
    fs::write(&modified, b"ABCXEFGH").expect("target");

    let handler = SolidPatchHandler::new(&SOLID);
    handler
        .create(
            &PatchCreateRequest {
                original: original.clone(),
                modified,
                output: patch.clone(),
                format: "solid".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let report = handler
        .validate(
            &PatchValidateRequest {
                input: original,
                patches: vec![patch],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("validate");
    assert!(report.label.contains("validated"), "{}", report.label);
}

#[test]
fn validate_rejects_md5_mismatch() {
    let temp = TestDir::new();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.solid");
    let wrong_input = temp.child("wrong.bin");
    fs::write(&original, b"ABCDEFGH").expect("source");
    fs::write(&modified, b"ABCXEFGH").expect("target");
    fs::write(&wrong_input, b"ZZZZZZZZ").expect("wrong");

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

    let error = handler
        .validate(
            &PatchValidateRequest {
                input: wrong_input,
                patches: vec![patch],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("validate should reject mismatched source");
    assert!(error.to_string().contains("MD5 mismatch"), "{error}");
}

/// Header bytes up to (but not including) the description block: magic,
/// version, `addr_param`, a 4-byte `primitiveCount`, a zeroed source MD5, and a
/// date that decodes to `None`. Tests that need a malformed description block
/// append their own bytes.
fn solid_header_prefix(addr_param: u8, primitive_count: u32) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(SOLID_MAGIC);
    out.push(SOLID_FORMAT_VERSION);
    out.push(addr_param);
    out.extend_from_slice(&primitive_count.to_le_bytes());
    out.extend_from_slice(&[0u8; SOLID_MD5_LEN]);
    out.extend_from_slice(&[0u8, 0, 0]);
    out
}

fn empty_parsed_patch(resize: ResizeAction, expansion_data: Vec<u8>) -> ParsedSolidPatch {
    ParsedSolidPatch {
        version: SOLID_FORMAT_VERSION,
        source_md5: [0u8; SOLID_MD5_LEN],
        creation_date: None,
        resize,
        primitives: Vec::new(),
        expansion_data,
    }
}

#[test]
fn probe_reports_extension_confidence() {
    let temp = TestDir::new();
    let patch = temp.child("probe.solid");
    fs::write(&patch, b"SP").expect("fixture");

    assert_eq!(
        SolidPatchHandler::new(&SOLID).probe(&patch),
        ProbeConfidence::Extension
    );
}

#[test]
fn parse_rejects_invalid_magic_in_a_full_length_header() {
    let temp = TestDir::new();
    let mut bytes = assemble_solid(0x01, 0, &[]);
    bytes[0] = b'X';

    assert_both_err_contains(
        parse_solid_both(&temp, "bad-magic.solid", &bytes),
        "invalid magic header",
    );
}

#[test]
fn parse_reads_seven_description_strings_when_patch_info_flag_is_set() {
    let temp = TestDir::new();
    let mut bytes = solid_header_prefix(PATCH_INFO_FLAG | 0x01, 1);
    for index in 0..SOLID_MAX_DESCRIPTION_COUNT {
        bytes.extend_from_slice(format!("d{index}").as_bytes());
        bytes.push(0);
    }
    bytes.extend_from_slice(&[0x00, 0x01, 0x00, 0x00, b'Z']);

    let (file_result, bytes_result) = parse_solid_both(&temp, "patch-info.solid", &bytes);
    let from_file = file_result.expect("file parser should accept seven descriptions");
    let from_bytes = bytes_result.expect("bytes parser should accept seven descriptions");
    assert_eq!(from_file.primitives.len(), 1);
    assert_eq!(from_bytes.primitives.len(), 1);
    assert_eq!(from_bytes.primitives[0].base_delta, Some(0));
}

#[test]
fn parse_rejects_a_patch_that_ends_before_its_description_block() {
    let temp = TestDir::new();
    let bytes = solid_header_prefix(0x01, 0);

    assert_both_err_contains(
        parse_solid_both(&temp, "no-descriptions.solid", &bytes),
        "ended unexpectedly while reading description strings",
    );
}

#[test]
fn parse_rejects_a_description_string_without_a_terminator() {
    let temp = TestDir::new();
    let mut bytes = solid_header_prefix(0x01, 0);
    bytes.extend_from_slice(b"a\0b\0ccc");
    let path = temp.child("unterminated.solid");
    fs::write(&path, &bytes).expect("fixture");

    let bytes_error =
        parse_solid_patch_bytes(&bytes).expect_err("bytes parser should reject the run-on string");
    assert!(
        bytes_error
            .to_string()
            .contains("missing a terminating NUL byte"),
        "unexpected error: {bytes_error}"
    );
    // The streaming parser has no lookahead, so it runs off the end of the file
    // instead of recognising the missing terminator.
    let file_error =
        parse_solid_patch_file(&path).expect_err("file parser should reject the run-on string");
    assert!(
        file_error.to_string().contains("ended unexpectedly"),
        "unexpected error: {file_error}"
    );
}

#[test]
fn parse_rejects_a_description_string_longer_than_the_maximum() {
    let temp = TestDir::new();
    let mut bytes = solid_header_prefix(0x01, 0);
    bytes.extend_from_slice(b"a\0b\0");
    bytes.extend(std::iter::repeat_n(b'x', SOLID_MAX_DESCRIPTION_LEN + 1));
    bytes.push(0);

    assert_both_err_contains(
        parse_solid_both(&temp, "long-description.solid", &bytes),
        "SOLID_DESCRIPTION_STRING_EXCEEDED_MAX_LEN",
    );
}

#[test]
fn parse_rejects_a_description_string_that_is_not_utf8() {
    let temp = TestDir::new();
    let mut bytes = solid_header_prefix(0x01, 0);
    bytes.extend_from_slice(b"a\0b\0\xff\0");

    assert_both_err_contains(
        parse_solid_both(&temp, "non-utf8-description.solid", &bytes),
        "not valid UTF-8",
    );
}

#[test]
fn apply_grows_the_output_when_a_primitive_writes_past_the_source() {
    let temp = TestDir::new();
    let source = temp.child("short.bin");
    let patch = temp.child("grow.solid");
    let output = temp.child("grown.bin");
    fs::write(&source, b"AB").expect("source");
    fs::write(
        &patch,
        assemble_solid(0x01, 1, &[0x00, 0x04, 0x00, 0x00, b'W', b'X', b'Y', b'Z']),
    )
    .expect("patch");

    SolidPatchHandler::new(&SOLID)
        .apply(
            &PatchApplyRequest {
                input: source,
                patches: vec![patch],
                output: output.clone(),
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("apply");

    assert_eq!(fs::read(&output).expect("output"), b"WXYZ");
}

#[test]
fn apply_resize_rejects_expansion_data_that_does_not_match_the_declared_size() {
    let temp = TestDir::new();
    let output = temp.child("expand-mismatch.bin");
    fs::write(&output, b"0123").expect("fixture");
    let parsed = empty_parsed_patch(
        ResizeAction::Expand {
            address: 0,
            size: 4,
        },
        vec![1, 2],
    );

    let error = apply_resize_action_to_file(&parsed, &output, &test_context_with_threads(&temp, 1))
        .expect_err("payload length mismatch should fail");
    assert!(
        error
            .to_string()
            .contains("does not match resizeFileDataSize"),
        "unexpected error: {error}"
    );
}

#[test]
fn apply_resize_leaves_the_output_alone_for_a_zero_length_expansion() {
    let temp = TestDir::new();
    let output = temp.child("expand-empty.bin");
    fs::write(&output, b"0123").expect("fixture");
    let parsed = empty_parsed_patch(
        ResizeAction::Expand {
            address: 2,
            size: 0,
        },
        Vec::new(),
    );

    apply_resize_action_to_file(&parsed, &output, &test_context_with_threads(&temp, 1))
        .expect("zero-length expansion succeeds");
    assert_eq!(fs::read(&output).expect("output"), b"0123");
}

#[test]
fn apply_resize_splices_expansion_data_at_the_resize_address() {
    let temp = TestDir::new();
    let output = temp.child("expand-splice.bin");
    fs::write(&output, b"0123").expect("fixture");
    let parsed = empty_parsed_patch(
        ResizeAction::Expand {
            address: 2,
            size: 3,
        },
        b"XYZ".to_vec(),
    );

    apply_resize_action_to_file(&parsed, &output, &test_context_with_threads(&temp, 1))
        .expect("expansion succeeds");
    assert_eq!(fs::read(&output).expect("output"), b"01XYZ23");
}

#[test]
fn write_plans_reject_base_addressing_without_a_base_address() {
    let mut parsed = empty_parsed_patch(ResizeAction::None, Vec::new());
    parsed.primitives.push(ParsedPrimitive {
        addr_byte: 0,
        base_delta: None,
        payload: PrimitivePayload::Literal(b"A".to_vec()),
    });

    // `PrimitiveWritePlan` is not `Debug`, so the success arm cannot use `expect_err`.
    let Err(error) = build_primitive_write_plans(&parsed, 4) else {
        panic!("base addressing without a delta should fail");
    };
    assert!(
        error
            .to_string()
            .contains("base addressing without base address bytes"),
        "unexpected error: {error}"
    );
}

#[test]
fn created_primitives_reject_non_monotonic_chunk_addresses() {
    let error = build_created_primitives_from_chunks(vec![(4, vec![1, 2, 3]), (2, vec![9])])
        .expect_err("a backwards chunk should fail");
    assert!(
        error
            .to_string()
            .contains("non-monotonic primitive addresses"),
        "unexpected error: {error}"
    );
}

#[test]
fn created_primitives_split_chunks_longer_than_one_size_byte() {
    let primitives = build_created_primitives_from_chunks(vec![(10, vec![7u8; 300])])
        .expect("long chunk splits");

    assert_eq!(primitives.len(), 2);
    assert_eq!(primitives[0].base_delta, 10);
    assert_eq!(primitives[0].data.len(), usize::from(u8::MAX));
    assert_eq!(primitives[1].base_delta, 0);
    assert_eq!(primitives[1].data.len(), 300 - usize::from(u8::MAX));
}

#[test]
fn files_equal_detects_length_and_content_differences() {
    let temp = TestDir::new();
    let left = temp.child("left.bin");
    let shorter = temp.child("shorter.bin");
    let different = temp.child("different.bin");
    fs::write(&left, b"abcd").expect("left");
    fs::write(&shorter, b"abc").expect("shorter");
    fs::write(&different, b"abce").expect("different");

    assert!(files_equal(&left, &left).expect("identical files"));
    assert!(!files_equal(&left, &shorter).expect("different lengths"));
    assert!(!files_equal(&left, &different).expect("different bytes"));
}

#[test]
fn read_solid_suffix_returns_nothing_when_the_range_is_empty() {
    let temp = TestDir::new();
    let path = temp.child("suffix.bin");
    fs::write(&path, b"abcdef").expect("fixture");

    assert!(
        read_solid_suffix(&path, 4, 4)
            .expect("empty range")
            .is_empty()
    );
    assert_eq!(read_solid_suffix(&path, 4, 6).expect("tail"), b"ef");
}

#[test]
fn description_strings_reject_nul_bytes_and_over_long_values() {
    let mut output = Vec::new();
    let nul_error =
        write_description_string(&mut output, "a\0b").expect_err("embedded NUL should fail");
    assert!(
        nul_error.to_string().contains("embedded NUL bytes"),
        "unexpected error: {nul_error}"
    );

    let long = "x".repeat(SOLID_MAX_DESCRIPTION_LEN + 1);
    let long_error =
        write_description_string(&mut output, &long).expect_err("over-long value should fail");
    assert!(
        long_error
            .to_string()
            .contains("SOLID_DESCRIPTION_STRING_EXCEEDED_MAX_LEN"),
        "unexpected error: {long_error}"
    );
    assert!(output.is_empty());
}

#[test]
fn read_u8_reports_the_cursor_and_length_at_end_of_input() {
    let mut cursor = 2usize;
    let error =
        read_u8(&[1, 2], &mut cursor, "probe").expect_err("reading past the end should fail");
    assert!(
        error.to_string().contains("SOLID_READ_U8_UNEXPECTED_EOF"),
        "unexpected error: {error}"
    );
    assert!(error.to_string().contains("cursor=2"), "{error}");
}

#[test]
fn integer_readers_and_writers_reject_unsupported_widths() {
    let bytes = [0u8; 8];
    for width in [0usize, 9] {
        let mut cursor = 0usize;
        let read_error = read_u64_le(&bytes, &mut cursor, width, "probe")
            .expect_err("unsupported read width should fail");
        assert!(
            read_error
                .to_string()
                .contains("SOLID_INTEGER_WIDTH_UNSUPPORTED"),
            "unexpected error: {read_error}"
        );

        let mut output = Vec::new();
        let write_error = write_u64_le(&mut output, 1, width, "probe")
            .expect_err("unsupported write width should fail");
        assert!(
            write_error
                .to_string()
                .contains("SOLID_INTEGER_WIDTH_UNSUPPORTED"),
            "unexpected error: {write_error}"
        );
        assert!(output.is_empty());

        let mut parser = SolidFileParser::new(std::io::Cursor::new(bytes.to_vec()), 8);
        let parser_error = parser
            .read_u64_le(width, "probe")
            .expect_err("unsupported streaming width should fail");
        assert!(
            parser_error
                .to_string()
                .contains("SOLID_INTEGER_WIDTH_UNSUPPORTED"),
            "unexpected error: {parser_error}"
        );
    }
}

#[test]
fn file_parser_rejects_a_read_past_the_declared_file_length() {
    let mut parser = SolidFileParser::new(std::io::Cursor::new(vec![0u8; 8]), 4);
    let error = parser
        .read_exact(5, "probe")
        .expect_err("reading past the declared length should fail");

    assert!(
        error
            .to_string()
            .contains("ended unexpectedly while reading binary data"),
        "unexpected error: {error}"
    );
}

#[test]
fn md5_hex_formats_every_nibble_and_maps_out_of_range_values_to_zero() {
    let mut value = [0u8; SOLID_MD5_LEN];
    value[0] = 0x0a;
    value[SOLID_MD5_LEN - 1] = 0xf9;

    let hex = format_md5_hex(value);
    assert!(hex.starts_with("0a"));
    assert!(hex.ends_with("f9"));
    assert_eq!(hex.len(), SOLID_MD5_LEN * 2);
    assert_eq!(hex_nibble(16), '0');
}

#[test]
fn checked_helpers_report_overflow_with_their_operands() {
    let usize_error = checked_add_usize(usize::MAX, 1, "probe").expect_err("usize overflow");
    assert!(
        usize_error.to_string().contains("SOLID_USIZE_ADD_OVERFLOW"),
        "unexpected error: {usize_error}"
    );

    let u64_error = checked_add_u64(u64::MAX, 1, "probe").expect_err("u64 overflow");
    assert!(
        u64_error.to_string().contains("SOLID_U64_ADD_OVERFLOW"),
        "unexpected error: {u64_error}"
    );
    assert!(u64_error.to_string().contains("rhs=1"), "{u64_error}");
}

#[test]
fn patch_dates_round_trip_and_reject_unusable_encodings() {
    let date = PatchDate {
        year: 2024,
        month: 7,
        day: 19,
    };
    let decoded = decode_patch_date(&encode_patch_date(date)).expect("round trip");
    assert_eq!((decoded.year, decoded.month, decoded.day), (2024, 7, 19));

    assert!(decode_patch_date(&[0, 0]).is_none());
    // Day 0 never encodes a real date, so the decoder reports no date at all.
    assert!(decode_patch_date(&[0, 0, 0]).is_none());
}

#[test]
fn created_addr_param_encodes_flags_and_mod_action() {
    let full = build_created_addr_param(MOD_ACTION_EXPAND, true, true);
    assert_eq!(full & BASE_ADDR_SIZE_MASK, CREATED_BASE_ADDR_FIELD);
    assert_eq!((full & MOD_ACTION_MASK) >> 4, MOD_ACTION_EXPAND);
    assert_ne!(full & BIG_FILE_FLAG, 0);
    assert_ne!(full & PATCH_INFO_FLAG, 0);

    let plain = build_created_addr_param(MOD_ACTION_NONE, false, false);
    assert_eq!(plain & MOD_ACTION_MASK, 0);
    assert_eq!(plain & BIG_FILE_FLAG, 0);
    assert_eq!(plain & PATCH_INFO_FLAG, 0);
}

#[test]
fn sequential_chunk_scan_emits_suffixes_only_when_asked() {
    let temp = TestDir::new();
    let original = temp.child("seq-original.bin");
    let modified = temp.child("seq-modified.bin");
    let context = test_context_with_threads(&temp, 1);
    fs::write(&original, b"").expect("empty original");
    fs::write(&modified, b"ABC").expect("modified");

    let with_suffix =
        collect_created_chunks_sequential_from_paths(&original, 0, &modified, 3, true, &context)
            .expect("suffix only");
    assert_eq!(with_suffix, vec![(0u64, b"ABC".to_vec())]);

    let without_suffix =
        collect_created_chunks_sequential_from_paths(&original, 0, &modified, 3, false, &context)
            .expect("no suffix");
    assert!(without_suffix.is_empty());

    fs::write(&original, b"AB").expect("original");
    let growth =
        collect_created_chunks_sequential_from_paths(&original, 2, &modified, 3, true, &context)
            .expect("growth suffix");
    assert_eq!(growth, vec![(2u64, b"C".to_vec())]);
}

#[test]
fn parallel_chunk_scan_merges_a_suffix_that_continues_the_last_run() {
    let temp = TestDir::new();
    let original = temp.child("par-original.bin");
    let modified = temp.child("par-modified.bin");
    let context = test_context_with_threads(&temp, 4);
    let (_, pool) = context
        .build_pool(parallel_chunked_capability(
            3,
            CREATE_THREAD_SCAN_CHUNK_BYTES as u64,
        ))
        .expect("pool");

    fs::write(&original, b"").expect("empty original");
    fs::write(&modified, b"ABC").expect("modified");
    let empty_source = collect_created_chunks_parallel_from_paths(
        &original, 0, &modified, 3, true, &pool, &context,
    )
    .expect("suffix only");
    assert_eq!(empty_source, vec![(0u64, b"ABC".to_vec())]);

    fs::write(&original, b"AB").expect("original");
    fs::write(&modified, b"AXC").expect("adjacent diff");
    let merged = collect_created_chunks_parallel_from_paths(
        &original, 2, &modified, 3, true, &pool, &context,
    )
    .expect("merged suffix");
    assert_eq!(merged, vec![(1u64, b"XC".to_vec())]);

    fs::write(&modified, b"XBC").expect("detached diff");
    let detached = collect_created_chunks_parallel_from_paths(
        &original, 2, &modified, 3, true, &pool, &context,
    )
    .expect("detached suffix");
    assert_eq!(detached, vec![(0u64, b"X".to_vec()), (2u64, b"C".to_vec())]);
}

#[test]
fn parallel_chunk_range_scan_is_empty_past_the_shared_length() {
    let temp = TestDir::new();
    let original = temp.child("range-original.bin");
    let modified = temp.child("range-modified.bin");
    fs::write(&original, b"AB").expect("original");
    fs::write(&modified, b"XY").expect("modified");

    let beyond = collect_created_chunk_ranges_from_file_chunk(&original, 2, &modified, 2, 1)
        .expect("chunk past the shared length");
    assert!(beyond.is_empty());

    let first = collect_created_chunk_ranges_from_file_chunk(&original, 2, &modified, 2, 0)
        .expect("first chunk");
    assert_eq!(first, vec![(0u64, b"XY".to_vec())]);
}
