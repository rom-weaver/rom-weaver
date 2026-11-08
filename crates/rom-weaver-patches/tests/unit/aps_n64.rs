use std::fs;

use rom_weaver_core::{
    PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
    PatchValidateRequest, ProbeConfidence,
};

use super::{
    APS_N64_CART_ID_OFFSET, APS_N64_CRC_OFFSET, APS_N64_MODE, ApsN64PatchHandler,
    create_aps_patch_bytes, parse_aps_bytes,
};
use crate::{
    APS,
    test_support::{TestDir, report_endpoints, test_context_with_threads},
};

#[derive(Clone)]
enum TestRecord {
    Simple { offset: u32, data: Vec<u8> },
    Rle { offset: u32, byte: u8, length: u8 },
}

#[derive(Clone)]
struct TestN64Header {
    original_format: u8,
    cart_id: [u8; 3],
    crc: [u8; 8],
    pad: [u8; 5],
}

#[test]
fn parse_rejects_invalid_header() {
    let mut bytes = vec![0u8; 61];
    bytes[..5].copy_from_slice(b"BAD10");
    let error = parse_aps_bytes(&bytes).expect_err("invalid header");
    assert!(error.to_string().contains("Patch header invalid"));
}

#[test]
fn parse_reports_concrete_n64_validation_values() {
    let temp = TestDir::new();
    let patch_path = temp.child("probe.aps");
    let patch = build_aps_patch(
        APS_N64_MODE,
        Some(TestN64Header {
            original_format: 1,
            cart_id: *b"ABC",
            crc: [1, 2, 3, 4, 5, 6, 7, 8],
            pad: [0; 5],
        }),
        0x100,
        vec![],
    );
    fs::write(&patch_path, patch).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse report");

    // The cart ID is the two bytes "AB"; the third header byte "C" is the country.
    assert!(report.label.contains(
        "n64 source cart id 4142; n64 source country 43; n64 source crc 0102030405060708"
    ));
}

#[test]
fn parse_reports_non_text_cart_id_and_country_bytes_without_lossy_rendering() {
    let temp = TestDir::new();
    let patch_path = temp.child("binary-ids.aps");
    let patch = build_aps_patch(
        APS_N64_MODE,
        Some(TestN64Header {
            original_format: 1,
            cart_id: [0xFF, 0x00, 0x80],
            crc: [0; 8],
            pad: [0; 5],
        }),
        0x100,
        vec![],
    );
    fs::write(&patch_path, patch).expect("fixture");

    let report = ApsN64PatchHandler::new(&APS)
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse report");
    assert!(
        report
            .label
            .contains("n64 source cart id ff00; n64 source country 80;"),
        "unexpected label: {}",
        report.label
    );
    assert!(!report.label.contains('\u{FFFD}'));
}

#[test]
fn parse_reports_normalized_output_size_endpoint() {
    let temp = TestDir::new();
    let patch_path = temp.child("probe.aps");
    let patch = build_aps_patch(
        APS_N64_MODE,
        Some(TestN64Header {
            original_format: 1,
            cart_id: *b"ABC",
            crc: [1, 2, 3, 4, 5, 6, 7, 8],
            pad: [0; 5],
        }),
        0x100,
        vec![],
    );
    fs::write(&patch_path, patch).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse report");

    let endpoints = report_endpoints(&report);
    assert_eq!(endpoints.len(), 1);
    // The cart-id/CRC header bytes are not a whole-file checksum.
    assert!(endpoints[0]["input"].as_object().expect("input").is_empty());
    assert_eq!(endpoints[0]["output"]["size"].as_u64(), Some(0x100));
}

#[test]
fn apply_supports_simple_and_rle_records() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.aps");
    let output_path = temp.child("output.bin");

    fs::write(&input_path, b"abcdefghij").expect("fixture");
    let patch = build_aps_patch(
        0,
        None,
        10,
        vec![
            TestRecord::Simple {
                offset: 1,
                data: b"XY".to_vec(),
            },
            TestRecord::Rle {
                offset: 4,
                byte: b'Z',
                length: 3,
            },
        ],
    );
    fs::write(&patch_path, patch).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");
    let execution = report.thread_execution.expect("thread execution");
    // The test context forces streaming apply; this multi-record patch parallelizes
    assert!(execution.used_parallelism);
    assert!(execution.effective_threads > 1);

    assert_eq!(fs::read(output_path).expect("output"), b"aXYdZZZhij");
}

#[test]
fn apply_strict_rejects_mismatched_n64_source() {
    let temp = TestDir::new();
    let input_path = temp.child("input.z64");
    let patch_path = temp.child("update.aps");
    let output_path = temp.child("output.bin");

    let mut input = vec![0u8; 0x100];
    input[0..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
    input[APS_N64_CART_ID_OFFSET as usize..APS_N64_CART_ID_OFFSET as usize + 3]
        .copy_from_slice(b"BAD");
    input[APS_N64_CRC_OFFSET as usize..APS_N64_CRC_OFFSET as usize + 8]
        .copy_from_slice(&[0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]);
    fs::write(&input_path, input).expect("fixture");

    let patch = build_aps_patch(
        APS_N64_MODE,
        Some(TestN64Header {
            original_format: 1,
            cart_id: *b"ABC",
            crc: [1, 2, 3, 4, 5, 6, 7, 8],
            pad: [0; 5],
        }),
        0x100,
        vec![],
    );
    fs::write(&patch_path, patch).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Strict),
        )
        .expect_err("strict validation should fail");
    assert!(error.to_string().contains("Source ROM checksum mismatch"));
}

#[test]
fn create_and_apply_round_trip_for_n64_source() {
    let temp = TestDir::new();
    let original_path = temp.child("original.z64");
    let modified_path = temp.child("modified.z64");
    let patch_path = temp.child("update.aps");
    let output_path = temp.child("output.z64");

    let mut original = vec![0u8; 0x200];
    for (index, byte) in original.iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    original[0..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
    original[APS_N64_CART_ID_OFFSET as usize..APS_N64_CART_ID_OFFSET as usize + 3]
        .copy_from_slice(b"XYZ");
    original[APS_N64_CRC_OFFSET as usize..APS_N64_CRC_OFFSET as usize + 8]
        .copy_from_slice(&[0xA0, 0xB1, 0xC2, 0xD3, 0xE4, 0xF5, 0x16, 0x27]);
    let mut modified = original.clone();
    modified[0x20..0x28].fill(0xAA);
    modified[0x60] = 0x11;
    modified[0x61] = 0x22;
    modified[0x62] = 0x33;

    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path,
                output: patch_path.clone(),
                format: "APS".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");
    assert_eq!(
        create_report
            .thread_execution
            .expect("thread execution")
            .requested_threads,
        8
    );

    let parsed = parse_aps_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
    assert_eq!(parsed.header_type, APS_N64_MODE);
    assert!(parsed.n64_header.is_some());
    assert!(!parsed.records.is_empty());

    let report = handler
        .apply(
            &PatchApplyRequest {
                input: original_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2)
                .with_patch_checksum_validation(PatchChecksumValidation::Strict),
        )
        .expect("apply");
    let execution = report.thread_execution.expect("thread execution");
    // The test context forces streaming apply; this multi-record patch parallelizes
    assert!(execution.used_parallelism);
    assert!(execution.effective_threads > 1);

    assert_eq!(fs::read(output_path).expect("output"), modified);
}

#[test]
fn apply_with_overlapping_records_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("overlap.aps");
    let output_single = temp.child("output-single.bin");
    let output_parallel = temp.child("output-parallel.bin");

    fs::write(&input_path, b"0123456789").expect("fixture");
    let patch = build_aps_patch(
        0,
        None,
        10,
        vec![
            TestRecord::Simple {
                offset: 2,
                data: b"ABCD".to_vec(),
            },
            TestRecord::Simple {
                offset: 4,
                data: b"xy".to_vec(),
            },
            TestRecord::Rle {
                offset: 7,
                byte: b'Q',
                length: 2,
            },
        ],
    );
    fs::write(&patch_path, patch).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let single_report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_single.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single-thread apply");
    let parallel_report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_parallel.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("parallel apply");

    // single-thread budget stays serial; the parallel budget now streams in parallel
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
    assert_eq!(fs::read(&output_single).expect("single"), b"01ABxy6QQ9");
    assert_eq!(fs::read(&output_parallel).expect("parallel"), b"01ABxy6QQ9");
    assert_eq!(
        fs::read(output_single).expect("single"),
        fs::read(output_parallel).expect("parallel")
    );
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let original_path = temp.child("original.z64");
    let modified_path = temp.child("modified.z64");
    let patch_single = temp.child("single.aps");
    let patch_parallel = temp.child("parallel.aps");

    let size = (super::APS_CREATE_CHUNK_BYTES * 2) + 4096;
    let mut original = vec![0u8; size];
    for (index, byte) in original.iter_mut().enumerate() {
        *byte = ((index * 11 + (index >> 3)) & 0xFF) as u8;
    }
    original[0..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
    original[APS_N64_CART_ID_OFFSET as usize..APS_N64_CART_ID_OFFSET as usize + 3]
        .copy_from_slice(b"XYZ");
    original[APS_N64_CRC_OFFSET as usize..APS_N64_CRC_OFFSET as usize + 8]
        .copy_from_slice(&[0xA0, 0xB1, 0xC2, 0xD3, 0xE4, 0xF5, 0x16, 0x27]);
    let mut modified = original.clone();
    modified[0x2000..0x2100].fill(0x44);
    modified[super::APS_CREATE_CHUNK_BYTES - 8..super::APS_CREATE_CHUNK_BYTES + 8].fill(0xAA);
    modified[(super::APS_CREATE_CHUNK_BYTES * 2) + 64] ^= 0x5A;

    fs::write(&original_path, &original).expect("fixture");
    fs::write(&modified_path, &modified).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_single.clone(),
                format: "APS".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single create");
    let parallel_report = handler
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_parallel.clone(),
                format: "APS".into(),
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

#[test]
fn create_matches_rompatcher_js_n64_fixture() {
    // Fixture generated from:
    // https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.aps_n64.js
    // using BinFile.js + APS.buildFromRoms(...).export(...).
    let mut original = vec![0u8; 0x200];
    for (index, byte) in original.iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    original[0..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
    original[APS_N64_CART_ID_OFFSET as usize..APS_N64_CART_ID_OFFSET as usize + 3]
        .copy_from_slice(b"XYZ");
    original[APS_N64_CRC_OFFSET as usize..APS_N64_CRC_OFFSET as usize + 8]
        .copy_from_slice(&[0xA0, 0xB1, 0xC2, 0xD3, 0xE4, 0xF5, 0x16, 0x27]);

    let mut modified = original.clone();
    modified[0x20..0x28].fill(0xAA);
    modified[0x60] = 0x11;
    modified[0x61] = 0x22;
    modified[0x62] = 0x33;

    let created = create_aps_patch_bytes(&original, &modified).expect("create fixture");
    let expected = hex_to_bytes(
        "415053313001006e6f206465736372697074696f6e0000000000000000000000000000000000000000000000000000000000000000000000000158595aa0b1c2d3e4f516270000000000000200002000000000aa086000000003112233",
    );

    assert_eq!(created.bytes, expected);
    assert_eq!(created.record_count, 2);
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0, "hex fixture must have even length");
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for index in (0..hex.len()).step_by(2) {
        let byte = u8::from_str_radix(&hex[index..index + 2], 16).expect("valid hex fixture");
        bytes.push(byte);
    }
    bytes
}

fn build_aps_patch(
    header_type: u8,
    n64_header: Option<TestN64Header>,
    output_size: u32,
    records: Vec<TestRecord>,
) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"APS10");
    bytes.push(header_type);
    bytes.push(0);
    let mut description = [0u8; 50];
    let label = b"test patcher";
    description[..label.len()].copy_from_slice(label);
    bytes.extend_from_slice(&description);

    if let Some(n64_header) = n64_header {
        bytes.push(n64_header.original_format);
        bytes.extend_from_slice(&n64_header.cart_id);
        bytes.extend_from_slice(&n64_header.crc);
        bytes.extend_from_slice(&n64_header.pad);
    }

    bytes.extend_from_slice(&output_size.to_le_bytes());
    for record in records {
        match record {
            TestRecord::Simple { offset, data } => {
                bytes.extend_from_slice(&offset.to_le_bytes());
                bytes.push(data.len() as u8);
                bytes.extend_from_slice(&data);
            }
            TestRecord::Rle {
                offset,
                byte,
                length,
            } => {
                bytes.extend_from_slice(&offset.to_le_bytes());
                bytes.push(0);
                bytes.push(byte);
                bytes.push(length);
            }
        }
    }
    bytes
}

fn simple_and_rle_patch() -> Vec<u8> {
    build_aps_patch(
        0,
        None,
        10,
        vec![
            TestRecord::Simple {
                offset: 1,
                data: b"XY".to_vec(),
            },
            TestRecord::Rle {
                offset: 4,
                byte: b'Z',
                length: 3,
            },
        ],
    )
}

#[test]
fn probe_reports_extension_confidence() {
    let handler = ApsN64PatchHandler::new(&APS);
    assert!(matches!(
        handler.probe(std::path::Path::new("update.aps")),
        ProbeConfidence::Extension
    ));
}

#[test]
fn parse_omits_the_n64_label_for_a_plain_patch() {
    let temp = TestDir::new();
    let patch_path = temp.child("plain.aps");
    fs::write(&patch_path, simple_and_rle_patch()).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse report");
    assert!(!report.label.contains("n64 source cart id"));
}

#[test]
fn apply_in_memory_matches_the_streaming_output() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.aps");
    let streamed_path = temp.child("streamed.bin");
    let in_memory_path = temp.child("in-memory.bin");

    fs::write(&input_path, b"abcdefghij").expect("fixture");
    fs::write(&patch_path, simple_and_rle_patch()).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path.clone(),
                patches: vec![patch_path.clone()],
                output: streamed_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("streaming apply");

    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: in_memory_path.clone(),
            },
            &test_context_with_threads(&temp, 4).with_patch_apply_in_memory_limit(1 << 24),
        )
        .expect("in-memory apply");

    // The in-memory path writes the whole output at once, so it always reports
    // serial execution however many threads the budget offered.
    let execution = report.thread_execution.expect("thread execution");
    assert!(!execution.used_parallelism);
    assert_eq!(execution.effective_threads, 1);

    assert_eq!(fs::read(streamed_path).expect("streamed"), b"aXYdZZZhij");
    assert_eq!(fs::read(in_memory_path).expect("in-memory"), b"aXYdZZZhij");
}

#[test]
fn apply_in_memory_grows_a_short_input_to_the_declared_output_size() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.aps");
    let output_path = temp.child("output.bin");

    fs::write(&input_path, b"abcd").expect("fixture");
    let patch = build_aps_patch(
        0,
        None,
        8,
        vec![TestRecord::Rle {
            byte: b'!',
            offset: 6,
            length: 2,
        }],
    );
    fs::write(&patch_path, patch).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1).with_patch_apply_in_memory_limit(1 << 24),
        )
        .expect("in-memory apply");
    assert_eq!(fs::read(output_path).expect("output"), b"abcd\0\0!!");
}

#[test]
fn apply_in_memory_rejects_a_record_past_the_output_size() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let simple_patch = temp.child("simple.aps");
    let rle_patch = temp.child("rle.aps");
    let output_path = temp.child("output.bin");

    fs::write(&input_path, b"abcdefghij").expect("fixture");
    fs::write(
        &simple_patch,
        build_aps_patch(
            0,
            None,
            10,
            vec![TestRecord::Simple {
                offset: 9,
                data: b"XY".to_vec(),
            }],
        ),
    )
    .expect("fixture");
    fs::write(
        &rle_patch,
        build_aps_patch(
            0,
            None,
            10,
            vec![TestRecord::Rle {
                offset: 9,
                byte: b'Z',
                length: 4,
            }],
        ),
    )
    .expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let context = || test_context_with_threads(&temp, 1).with_patch_apply_in_memory_limit(1 << 24);

    let simple = handler
        .apply(
            &PatchApplyRequest {
                input: input_path.clone(),
                patches: vec![simple_patch],
                output: output_path.clone(),
            },
            &context(),
        )
        .expect_err("a simple record past the output size must be rejected");
    assert!(
        simple
            .to_string()
            .contains("APS record exceeded output size")
    );

    let rle = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![rle_patch],
                output: output_path,
            },
            &context(),
        )
        .expect_err("an RLE record past the output size must be rejected");
    assert!(
        rle.to_string()
            .contains("APS RLE record exceeded output size")
    );
}

#[test]
fn validate_accepts_a_matching_source() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    let patch_path = temp.child("update.aps");

    fs::write(&input_path, b"abcdefghij").expect("fixture");
    fs::write(&patch_path, simple_and_rle_patch()).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let report = handler
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("validate");
    assert_eq!(report.stage, "validate");
    assert!(report.label.contains("validated APS patch source"));
}

#[test]
fn validate_rejects_a_mismatched_n64_source() {
    let temp = TestDir::new();
    let input_path = temp.child("input.z64");
    let patch_path = temp.child("update.aps");

    let mut input = vec![0u8; 0x100];
    input[APS_N64_CART_ID_OFFSET as usize..APS_N64_CART_ID_OFFSET as usize + 3]
        .copy_from_slice(b"ZZZ");
    fs::write(&input_path, &input).expect("fixture");

    let patch = build_aps_patch(
        APS_N64_MODE,
        Some(TestN64Header {
            original_format: 1,
            cart_id: *b"ABC",
            crc: [1, 2, 3, 4, 5, 6, 7, 8],
            pad: [0; 5],
        }),
        0x100,
        vec![],
    );
    fs::write(&patch_path, patch).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let error = handler
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("a mismatched cart id must be rejected");
    assert!(error.to_string().contains("Source ROM checksum mismatch"));
}

#[test]
fn validate_n64_source_rejects_an_input_too_short_for_the_header_fields() {
    let temp = TestDir::new();
    let input_path = temp.child("tiny.z64");
    let patch_path = temp.child("update.aps");

    fs::write(&input_path, b"short").expect("fixture");
    let patch = build_aps_patch(
        APS_N64_MODE,
        Some(TestN64Header {
            original_format: 1,
            cart_id: *b"ABC",
            crc: [1, 2, 3, 4, 5, 6, 7, 8],
            pad: [0; 5],
        }),
        0x10,
        vec![],
    );
    fs::write(&patch_path, patch).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let error = handler
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("an input shorter than the N64 header fields must be rejected");
    assert!(error.to_string().contains("Source ROM checksum mismatch"));
}

#[test]
fn apply_rejects_a_source_cut_inside_the_header_even_when_the_missing_bytes_read_as_zero() {
    // A z64 ROM cut at 0x3E bytes loses the country byte. Missing bytes read as zero, so a
    // patch made from a ROM whose country byte is 0 would match it field by field: only the
    // length check tells that the source is a truncated dump.
    let truncated = z64_rom()[..0x3E].to_vec();
    let patch = n64_patch_for_format(1, [b'N', b'Z', 0]);

    let temp = TestDir::new();
    let error = apply_aps(&temp, &truncated, &patch, PatchChecksumValidation::Strict)
        .expect_err("a source shorter than the N64 header must be rejected");
    assert!(
        error
            .to_string()
            .contains("too short to hold an N64 header"),
        "{error}"
    );

    let applied = apply_aps(&temp, &truncated, &patch, PatchChecksumValidation::Ignore)
        .expect("ignoring checksums skips the header length check");
    assert_eq!(applied.len(), 0x100);
    assert_eq!(applied[0x80..0x82], *b"XY");
}

#[test]
fn parse_aps_bytes_rejects_truncated_headers_and_records() {
    let short = parse_aps_bytes(&[0u8; 8]).expect_err("a short header must be rejected");
    assert!(
        short
            .to_string()
            .contains("too small to contain a valid header")
    );

    // An N64-mode header that stops before its 17 extra bytes.
    let mut truncated_n64 = vec![0u8; 61];
    truncated_n64[..5].copy_from_slice(b"APS10");
    truncated_n64[5] = APS_N64_MODE;
    let error =
        parse_aps_bytes(&truncated_n64).expect_err("a truncated N64 header must be rejected");
    assert!(error.to_string().contains("APS N64 header was truncated"));

    let mut short_record = build_aps_patch(
        0,
        None,
        10,
        vec![TestRecord::Simple {
            offset: 0,
            data: b"XY".to_vec(),
        }],
    );
    // Drop the record payload, leaving only part of its 5-byte header.
    short_record.truncate(short_record.len() - 4);
    let error =
        parse_aps_bytes(&short_record).expect_err("a truncated record header must be rejected");
    assert!(
        error
            .to_string()
            .contains("APS record header exceeded patch bounds")
    );

    let mut short_rle = build_aps_patch(
        0,
        None,
        10,
        vec![TestRecord::Rle {
            offset: 0,
            byte: b'Z',
            length: 2,
        }],
    );
    short_rle.truncate(short_rle.len() - 1);
    let error = parse_aps_bytes(&short_rle).expect_err("a truncated RLE record must be rejected");
    assert!(
        error
            .to_string()
            .contains("APS RLE record exceeded patch bounds")
    );

    let mut short_data = build_aps_patch(
        0,
        None,
        10,
        vec![TestRecord::Simple {
            offset: 0,
            data: b"XYZW".to_vec(),
        }],
    );
    short_data.truncate(short_data.len() - 2);
    let error = parse_aps_bytes(&short_data).expect_err("a truncated payload must be rejected");
    assert!(
        error
            .to_string()
            .contains("APS record data exceeded patch bounds")
    );
}

#[test]
fn parse_aps_file_rejects_truncated_headers_and_records() {
    let temp = TestDir::new();
    let handler = ApsN64PatchHandler::new(&APS);
    let context = test_context_with_threads(&temp, 1);

    let short = temp.child("short.aps");
    fs::write(&short, [0u8; 8]).expect("fixture");
    let error = handler
        .parse(&short, &context)
        .expect_err("a short header must be rejected");
    assert!(
        error
            .to_string()
            .contains("too small to contain a valid header")
    );

    let bad_magic = temp.child("bad-magic.aps");
    let mut bytes = vec![0u8; 61];
    bytes[..5].copy_from_slice(b"BAD10");
    fs::write(&bad_magic, bytes).expect("fixture");
    let error = handler
        .parse(&bad_magic, &context)
        .expect_err("a bad magic must be rejected");
    assert!(error.to_string().contains("Patch header invalid"));

    let short_record = temp.child("short-record.aps");
    let mut record_bytes = build_aps_patch(
        0,
        None,
        10,
        vec![TestRecord::Simple {
            offset: 0,
            data: b"XY".to_vec(),
        }],
    );
    record_bytes.truncate(record_bytes.len() - 4);
    fs::write(&short_record, record_bytes).expect("fixture");
    let error = handler
        .parse(&short_record, &context)
        .expect_err("a truncated record header must be rejected");
    assert!(
        error
            .to_string()
            .contains("APS record header exceeded patch bounds")
    );

    let short_rle = temp.child("short-rle.aps");
    let mut rle_bytes = build_aps_patch(
        0,
        None,
        10,
        vec![TestRecord::Rle {
            offset: 0,
            byte: b'Z',
            length: 2,
        }],
    );
    rle_bytes.truncate(rle_bytes.len() - 1);
    fs::write(&short_rle, rle_bytes).expect("fixture");
    let error = handler
        .parse(&short_rle, &context)
        .expect_err("a truncated RLE record must be rejected");
    assert!(
        error
            .to_string()
            .contains("APS RLE record exceeded patch bounds")
    );
}

#[test]
fn parse_reports_lowercase_hex_for_high_crc_nibbles() {
    let temp = TestDir::new();
    let patch_path = temp.child("hex.aps");
    let patch = build_aps_patch(
        APS_N64_MODE,
        Some(TestN64Header {
            original_format: 1,
            cart_id: *b"ABC",
            crc: [0xAB, 0xCD, 0xEF, 0x0F, 0xF0, 0x99, 0xA0, 0x0A],
            pad: [0; 5],
        }),
        0x100,
        vec![],
    );
    fs::write(&patch_path, patch).expect("fixture");

    let handler = ApsN64PatchHandler::new(&APS);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse report");
    assert!(report.label.contains("abcdef0ff099a00a"));
}

#[test]
fn apply_rejects_a_corrupt_output_size_that_would_write_gigabytes() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("corrupt.aps");
    let output_path = temp.child("output.bin");
    fs::write(&source_path, vec![0u8; 512]).expect("fixture");
    fs::write(
        &patch_path,
        build_aps_patch(
            0,
            None,
            0xF000_0000,
            vec![TestRecord::Simple {
                offset: 1,
                data: b"X".to_vec(),
            }],
        ),
    )
    .expect("fixture");

    let result = ApsN64PatchHandler::new(&APS).apply(
        &rom_weaver_core::PatchApplyRequest {
            input: source_path,
            patches: vec![patch_path],
            output: output_path.clone(),
        },
        &test_context_with_threads(&temp, 2),
    );
    crate::test_support::assert_implausible_output_rejected(result, &output_path);
}

const Z64_MAGIC: [u8; 4] = [0x80, 0x37, 0x12, 0x40];
const LITTLE_ENDIAN_MAGIC: [u8; 4] = [0x40, 0x12, 0x37, 0x80];
const ROM_CRC: [u8; 8] = [0xA0, 0xB1, 0xC2, 0xD3, 0xE4, 0xF5, 0x16, 0x27];

/// A 0x100-byte z64 ROM with cart ID "NZ" at 0x3C, country "E" at 0x3E and `ROM_CRC` at 0x10.
fn z64_rom() -> Vec<u8> {
    let mut rom: Vec<u8> = (0..0x100).map(|index| (index % 251) as u8).collect();
    rom[..4].copy_from_slice(&Z64_MAGIC);
    rom[0x10..0x18].copy_from_slice(&ROM_CRC);
    rom[0x3C..0x3F].copy_from_slice(b"NZE");
    rom
}

/// The same ROM as a Doctor V64 dump, where every 16-bit word is byte-swapped.
fn v64_rom() -> Vec<u8> {
    let mut rom = z64_rom();
    for pair in rom.chunks_exact_mut(2) {
        pair.swap(0, 1);
    }
    rom
}

fn little_endian_rom() -> Vec<u8> {
    let mut rom = z64_rom();
    for word in rom.chunks_exact_mut(4) {
        word.reverse();
    }
    assert_eq!(rom[..4], LITTLE_ENDIAN_MAGIC);
    rom
}

/// A type 1 patch holding the z64-order fields of `z64_rom` and one record at 0x80.
fn n64_patch_for_format(original_format: u8, cart_and_country: [u8; 3]) -> Vec<u8> {
    build_aps_patch(
        APS_N64_MODE,
        Some(TestN64Header {
            original_format,
            cart_id: cart_and_country,
            crc: ROM_CRC,
            pad: [0; 5],
        }),
        0x100,
        vec![TestRecord::Simple {
            offset: 0x80,
            data: b"XY".to_vec(),
        }],
    )
}

fn apply_aps(
    temp: &TestDir,
    rom: &[u8],
    patch: &[u8],
    validation: PatchChecksumValidation,
) -> rom_weaver_core::Result<Vec<u8>> {
    let input_path = temp.child("input.rom");
    let patch_path = temp.child("update.aps");
    let output_path = temp.child("output.rom");
    fs::write(&input_path, rom).expect("fixture");
    fs::write(&patch_path, patch).expect("fixture");
    ApsN64PatchHandler::new(&APS).apply(
        &PatchApplyRequest {
            input: input_path,
            patches: vec![patch_path],
            output: output_path.clone(),
        },
        &test_context_with_threads(temp, 2).with_patch_checksum_validation(validation),
    )?;
    Ok(fs::read(output_path).expect("output"))
}

fn expected_with_record(rom: &[u8]) -> Vec<u8> {
    let mut expected = rom.to_vec();
    expected[0x80..0x82].copy_from_slice(b"XY");
    expected
}

#[test]
fn apply_enforces_the_original_format_byte_against_the_input_byte_order() {
    // n64aps: "Image is in the wrong format", fatal even with -f.
    for validation in [
        PatchChecksumValidation::Strict,
        PatchChecksumValidation::Ignore,
    ] {
        let temp = TestDir::new();
        let v64_patch = n64_patch_for_format(0, *b"NZE");
        let z64_patch = n64_patch_for_format(1, *b"NZE");

        let error = apply_aps(&temp, &z64_rom(), &v64_patch, validation)
            .expect_err("a v64 patch must not apply to a z64 ROM");
        assert!(
            error
                .to_string()
                .contains("made from a byte-swapped (v64) ROM"),
            "{error}"
        );
        assert!(
            error
                .to_string()
                .contains("rerun with --n64-byte-order byte-swapped ["),
            "{error}"
        );
        let error = apply_aps(&temp, &v64_rom(), &z64_patch, validation)
            .expect_err("a z64 patch must not apply to a v64 ROM");
        assert!(
            error.to_string().contains("made from a non-v64 ROM"),
            "{error}"
        );
        assert!(
            error
                .to_string()
                .contains("rerun with --n64-byte-order big-endian ["),
            "{error}"
        );
        let unknown_patch = n64_patch_for_format(2, *b"NZE");
        let error = apply_aps(&temp, &z64_rom(), &unknown_patch, validation)
            .expect_err("an unknown original format matches no ROM");
        assert!(
            error
                .to_string()
                .contains("unknown original format that no source can match ["),
            "{error}"
        );

        assert_eq!(
            apply_aps(&temp, &z64_rom(), &z64_patch, validation).expect("z64 on z64"),
            expected_with_record(&z64_rom())
        );
        assert_eq!(
            apply_aps(&temp, &v64_rom(), &v64_patch, validation).expect("v64 on v64"),
            expected_with_record(&v64_rom())
        );
    }
}

#[test]
fn validate_enforces_the_original_format_byte() {
    let temp = TestDir::new();
    let input_path = temp.child("input.z64");
    let patch_path = temp.child("update.aps");
    fs::write(&input_path, z64_rom()).expect("fixture");
    fs::write(&patch_path, n64_patch_for_format(0, *b"NZE")).expect("fixture");
    let error = ApsN64PatchHandler::new(&APS)
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect_err("a v64 patch must not validate against a z64 ROM");
    assert!(error.to_string().contains("byte-swapped (v64)"), "{error}");
}

#[test]
fn apply_names_the_header_field_that_does_not_match() {
    let temp = TestDir::new();
    let wrong_cart = n64_patch_for_format(1, *b"NXE");
    let wrong_country = n64_patch_for_format(1, *b"NZJ");
    let mut wrong_crc = n64_patch_for_format(1, *b"NZE");
    wrong_crc[61 + 4] ^= 0xFF;

    for (patch, field) in [
        (
            &wrong_cart,
            "cart ID is 4e58 in the patch but 4e5a in the source",
        ),
        (
            &wrong_country,
            "country is 4a in the patch but 45 in the source",
        ),
        (
            &wrong_crc,
            "CRC is a0b1c2d31bf51627 in the patch but a0b1c2d3e4f51627 in the source",
        ),
    ] {
        for rom in [z64_rom(), v64_rom()] {
            let mut patch = patch.clone();
            patch[57] = u8::from(rom[..4] == Z64_MAGIC);
            let error = apply_aps(&temp, &rom, &patch, PatchChecksumValidation::Strict)
                .expect_err("a mismatched header field must be rejected");
            let message = error.to_string();
            assert!(
                message.contains("Source ROM checksum mismatch"),
                "{message}"
            );
            assert!(message.contains(field), "{message}");

            // Ignoring checksum validation still overrides cart ID, country and CRC.
            assert_eq!(
                apply_aps(&temp, &rom, &patch, PatchChecksumValidation::Ignore)
                    .expect("ignore overrides field mismatches"),
                expected_with_record(&rom)
            );
        }
    }
}

#[test]
fn apply_reads_v64_country_from_raw_offset_0x3f() {
    // Byte-swapping the word at 0x3C moves country "E" from 0x3E to 0x3F.
    let temp = TestDir::new();
    let mut rom = v64_rom();
    assert_eq!(rom[0x3E..0x40], *b"?E");
    rom[0x3F] = b'J';
    let error = apply_aps(
        &temp,
        &rom,
        &n64_patch_for_format(0, *b"NZE"),
        PatchChecksumValidation::Strict,
    )
    .expect_err("country differs");
    assert!(
        error
            .to_string()
            .contains("country is 45 in the patch but 4a in the source"),
        "{error}"
    );
}

fn create_aps(temp: &TestDir, original_name: &str, original: &[u8], threads: usize) -> Vec<u8> {
    let original_path = temp.child(original_name);
    let modified_path = temp.child("modified.bin");
    let patch_path = temp.child("created.aps");
    let mut modified = original.to_vec();
    modified[0x80..0x82].copy_from_slice(b"XY");
    fs::write(&original_path, original).expect("fixture");
    fs::write(&modified_path, modified).expect("fixture");
    ApsN64PatchHandler::new(&APS)
        .create(
            &PatchCreateRequest {
                original: original_path,
                modified: modified_path,
                output: patch_path.clone(),
                format: "APS".into(),
            },
            &test_context_with_threads(temp, threads),
        )
        .expect("create");
    fs::read(patch_path).expect("patch")
}

#[test]
fn create_derives_the_header_from_the_original_content_not_its_name() {
    // n64caps: format byte 0 for a v64 original, 1 for z64, with z64-order cart ID, country and CRC.
    for threads in [1, 4] {
        for (name, rom, expected_format) in [
            ("original.v64", z64_rom(), 1u8),
            ("original.z64", v64_rom(), 0),
            ("original.v64", v64_rom(), 0),
            ("original.z64", z64_rom(), 1),
        ] {
            let temp = TestDir::new();
            let patch = create_aps(&temp, name, &rom, threads);
            assert_eq!(&patch[..5], b"APS10");
            assert_eq!(patch[5], 1, "{name}: type 1 N64 patch");
            assert_eq!(patch[57], expected_format, "{name}: original-format byte");
            assert_eq!(&patch[58..60], b"NZ", "{name}: cart ID");
            assert_eq!(patch[60], b'E', "{name}: country");
            assert_eq!(&patch[61..69], &ROM_CRC, "{name}: CRC");
            assert_eq!(&patch[69..74], &[0; 5]);

            let applied = apply_aps(&temp, &rom, &patch, PatchChecksumValidation::Strict)
                .expect("a created patch applies to its own original");
            assert_eq!(applied, expected_with_record(&rom));
        }
    }
}

#[test]
fn create_keeps_type_0_for_originals_without_a_z64_or_v64_header() {
    for (name, rom) in [
        ("original.n64", little_endian_rom()),
        ("original.z64", vec![0x55; 0x100]),
    ] {
        let temp = TestDir::new();
        let patch = create_aps(&temp, name, &rom, 1);
        assert_eq!(patch[5], 0, "{name}: type 0 simple patch");
    }
}

#[test]
fn parse_rejects_unknown_patch_types_and_encoding_methods() {
    let temp = TestDir::new();
    let handler = ApsN64PatchHandler::new(&APS);
    let context = test_context_with_threads(&temp, 1);

    let mut unknown_type = simple_and_rle_patch();
    unknown_type[5] = 2;
    let mut unknown_encoding = simple_and_rle_patch();
    unknown_encoding[6] = 1;

    for (bytes, expected) in [
        (unknown_type, "APS patch type 2 is not supported"),
        (unknown_encoding, "APS encoding method 1 is not supported"),
    ] {
        let patch_path = temp.child("unknown.aps");
        fs::write(&patch_path, &bytes).expect("fixture");
        let error = handler
            .parse(&patch_path, &context)
            .expect_err("parse must reject");
        assert!(error.to_string().contains(expected), "{error}");

        let input_path = temp.child("input.bin");
        fs::write(&input_path, b"abcdefghij").expect("fixture");
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: temp.child("output.bin"),
                },
                &context,
            )
            .expect_err("apply must reject");
        assert!(error.to_string().contains(expected), "{error}");
        let error = handler
            .validate(
                &PatchValidateRequest {
                    input: input_path,
                    patches: vec![patch_path],
                },
                &context,
            )
            .expect_err("validate must reject");
        assert!(error.to_string().contains(expected), "{error}");
    }
}
