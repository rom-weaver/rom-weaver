use std::fs;

use rom_weaver_core::{
    PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
};

use super::{
    APS_N64_CART_ID_OFFSET, APS_N64_CRC_OFFSET, APS_N64_MODE, ApsN64PatchHandler,
    create_aps_patch_bytes, parse_aps_bytes,
};
use crate::{
    APS,
    test_support::{TestDir, test_context_with_threads},
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
    let patch_path = temp.child("inspect.aps");
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

    assert!(report.label.contains("n64 source cart id ABC"));
    assert!(report.label.contains("n64 source crc 0102030405060708"));
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
    assert!(
        report
            .thread_execution
            .expect("thread execution")
            .used_parallelism
    );

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
    assert!(
        report
            .thread_execution
            .expect("thread execution")
            .used_parallelism
    );

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
    let original_path = std::path::Path::new("original.z64");
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

    let created =
        create_aps_patch_bytes(original_path, &original, &modified).expect("create fixture");
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
