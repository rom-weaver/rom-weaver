use std::fs;

use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

use super::{
    DLDI_MAGIC, DLDI_VERSION, DO_ALLOCATED_SPACE, DO_BSS_END, DO_BSS_START, DO_CODE, DO_DATA_END,
    DO_DRIVER_SIZE, DO_FIX_SECTIONS, DO_FRIENDLY_NAME, DO_GLUE_END, DO_GLUE_START, DO_GOT_END,
    DO_GOT_START, DO_MAGIC_STRING, DO_READ_SECTORS, DO_SHUTDOWN, DO_STARTUP, DO_TEXT_START,
    DO_VERSION, DO_WRITE_SECTORS, DldiPatchHandler, FIX_ALL, FIX_BSS, FIX_GLUE, FIX_GOT,
    THREAD_WORK_CHUNK_BYTES,
};
use crate::{
    DLDI,
    test_support::{TestDir, test_context_with_threads_in_root as test_context_with_threads},
};

#[test]
fn parse_rejects_invalid_magic() {
    let temp = TestDir::new();
    let patch_path = temp.child("broken.dldi");
    fs::write(&patch_path, vec![0xAA; 1 << 8]).expect("fixture");

    let handler = DldiPatchHandler::new(&DLDI);
    let error = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect_err("parse should fail");

    assert!(error.to_string().contains("invalid DLDI magic"));
}

#[test]
fn apply_patches_slot_and_relocates_driver() {
    let temp = TestDir::new();
    let input_path = temp.child("input.nds");
    let patch_path = temp.child("driver.dldi");
    let output_path = temp.child("output.nds");

    let slot_offset = 0x200;
    let mem_offset = 0x0200_0000i32;
    let input = build_test_app_with_slot(slot_offset, 12, mem_offset, "Default driver");
    let patch = build_test_dldi_driver(
        8,
        0xBF80_0000u32 as i32,
        "Test Driver",
        FIX_ALL | FIX_GLUE | FIX_GOT | FIX_BSS,
    );

    fs::write(&input_path, &input).expect("fixture");
    fs::write(&patch_path, &patch).expect("fixture");

    let handler = DldiPatchHandler::new(&DLDI);
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");

    let output = fs::read(output_path).expect("output");
    let slot = &output[slot_offset..slot_offset + (1 << 8)];

    assert_eq!(
        &slot[DO_MAGIC_STRING..DO_MAGIC_STRING + DLDI_MAGIC.len()],
        DLDI_MAGIC
    );
    assert_eq!(slot[DO_VERSION], DLDI_VERSION);
    assert_eq!(slot[DO_DRIVER_SIZE], 8);
    assert_eq!(slot[DO_ALLOCATED_SPACE], 12);

    let startup = i32::from_le_bytes(slot[DO_STARTUP..DO_STARTUP + 4].try_into().expect("len"));
    assert_eq!(startup, mem_offset + i32::try_from(DO_CODE).expect("fits"));

    let bss_start = usize::try_from(
        i32::from_le_bytes(
            slot[DO_BSS_START..DO_BSS_START + 4]
                .try_into()
                .expect("len"),
        ) - mem_offset,
    )
    .expect("bss start");
    let bss_end = usize::try_from(
        i32::from_le_bytes(slot[DO_BSS_END..DO_BSS_END + 4].try_into().expect("len")) - mem_offset,
    )
    .expect("bss end");
    assert!(slot[bss_start..bss_end].iter().all(|byte| *byte == 0));
}

#[test]
fn apply_warns_and_extends_when_patch_exceeds_allocated_space() {
    let temp = TestDir::new();
    let input_path = temp.child("input.nds");
    let patch_path = temp.child("driver.dldi");
    let output_path = temp.child("output.nds");

    let slot_offset = 0x500;
    let mem_offset = 0x0220_0000i32;
    let input = build_test_app_with_slot(slot_offset, 8, mem_offset, "Default driver");
    let patch = build_test_dldi_driver(
        12,
        0xBF82_0000u32 as i32,
        "Oversized Driver",
        FIX_ALL | FIX_GLUE | FIX_GOT | FIX_BSS,
    );

    fs::write(&input_path, &input).expect("fixture");
    fs::write(&patch_path, &patch).expect("fixture");

    let handler = DldiPatchHandler::new(&DLDI);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("apply");

    assert!(report.label.contains(
        "warning=not enough space for DLDI patch (available 256 byte(s), need 4096 byte(s))"
    ));
    assert!(
        report
            .label
            .contains("warning=input file ended before the DLDI patch slot; extending output from 1664 to 5376 byte(s)")
    );

    let output = fs::read(output_path).expect("output");
    assert_eq!(output.len(), slot_offset + (1 << 12));
    assert_eq!(output[slot_offset + DO_ALLOCATED_SPACE], 8);
    assert_eq!(output[slot_offset + DO_DRIVER_SIZE], 12);

    let slot = &output[slot_offset..slot_offset + (1 << 12)];
    let startup = i32::from_le_bytes(slot[DO_STARTUP..DO_STARTUP + 4].try_into().expect("len"));
    assert_eq!(startup, mem_offset + i32::try_from(DO_CODE).expect("fits"));
}

#[test]
fn apply_ignores_misaligned_dldi_slot() {
    let temp = TestDir::new();
    let input_path = temp.child("misaligned.nds");
    let patch_path = temp.child("driver.dldi");
    let output_path = temp.child("output.nds");

    let aligned = build_test_app_with_slot(0x300, 12, 0x0200_0000, "Default driver");
    let mut misaligned = Vec::with_capacity(aligned.len() + 1);
    misaligned.push(0);
    misaligned.extend_from_slice(&aligned);
    let patch = build_test_dldi_driver(
        8,
        0xBF80_0000u32 as i32,
        "Test Driver",
        FIX_ALL | FIX_GLUE | FIX_GOT | FIX_BSS,
    );

    fs::write(&input_path, &misaligned).expect("fixture");
    fs::write(&patch_path, &patch).expect("fixture");

    let handler = DldiPatchHandler::new(&DLDI);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("misaligned slot should report unsupported");
    assert!(
        report
            .label
            .contains("input does not contain a patchable DLDI section")
    );
    assert_eq!(report.status, rom_weaver_core::OperationStatus::Unsupported);
}

#[test]
fn apply_accepts_truncated_patch_payload() {
    let temp = TestDir::new();
    let input_path = temp.child("input.nds");
    let patch_path = temp.child("driver-truncated.dldi");
    let output_path = temp.child("output.nds");

    let slot_offset = 0x300;
    let mem_offset = 0x0200_0000i32;
    let input = build_test_app_with_slot(slot_offset, 12, mem_offset, "Default driver");
    let patch_full = build_test_dldi_driver(
        8,
        0xBF80_0000u32 as i32,
        "Truncated Driver",
        FIX_ALL | FIX_GLUE | FIX_GOT | FIX_BSS,
    );
    let patch_truncated = &patch_full[..DO_CODE];

    fs::write(&input_path, &input).expect("fixture");
    fs::write(&patch_path, patch_truncated).expect("fixture");

    let handler = DldiPatchHandler::new(&DLDI);
    handler
        .apply(
            &PatchApplyRequest {
                input: input_path.clone(),
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("apply");

    let output = fs::read(output_path).expect("output");
    let original_slot = &input[slot_offset..slot_offset + (1 << 8)];
    let output_slot = &output[slot_offset..slot_offset + (1 << 8)];
    assert_eq!(output_slot[DO_DRIVER_SIZE], 8);
    assert_eq!(output_slot[DO_ALLOCATED_SPACE], 12);
    let bss_start = usize::try_from(
        i32::from_le_bytes(
            output_slot[DO_BSS_START..DO_BSS_START + 4]
                .try_into()
                .expect("len"),
        ) - mem_offset,
    )
    .expect("bss start");
    let bss_end = usize::try_from(
        i32::from_le_bytes(
            output_slot[DO_BSS_END..DO_BSS_END + 4]
                .try_into()
                .expect("len"),
        ) - mem_offset,
    )
    .expect("bss end");
    assert_eq!(
        &output_slot[DO_CODE..bss_start],
        &original_slot[DO_CODE..bss_start],
        "missing patch payload should preserve existing bytes before BSS"
    );
    assert!(
        output_slot[bss_start..bss_end]
            .iter()
            .all(|value| *value == 0),
        "BSS should still be zeroed by fix flags even with truncated payload"
    );
    assert_eq!(
        &output_slot[bss_end..(1 << 8)],
        &original_slot[bss_end..(1 << 8)],
        "missing patch payload should preserve existing bytes after BSS"
    );
}

#[test]
fn create_extracts_driver_and_round_trips() {
    let temp = TestDir::new();
    let original_path = temp.child("original.nds");
    let driver_path = temp.child("driver.dldi");
    let modified_path = temp.child("modified.nds");
    let created_patch_path = temp.child("created.dldi");
    let replay_path = temp.child("replay.nds");

    let original = build_test_app_with_slot(0x300, 12, 0x0200_0000, "Default driver");
    let driver = build_test_dldi_driver(
        8,
        0xBF80_0000u32 as i32,
        "Roundtrip Driver",
        FIX_ALL | FIX_GLUE | FIX_GOT | FIX_BSS,
    );
    fs::write(&original_path, &original).expect("fixture");
    fs::write(&driver_path, &driver).expect("fixture");

    let handler = DldiPatchHandler::new(&DLDI);
    handler
        .apply(
            &PatchApplyRequest {
                input: original_path.clone(),
                patches: vec![driver_path],
                output: modified_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");

    handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: created_patch_path.clone(),
                format: "dldi".into(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("create");

    handler
        .apply(
            &PatchApplyRequest {
                input: original_path,
                patches: vec![created_patch_path],
                output: replay_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("replay apply");

    assert_eq!(
        fs::read(replay_path).expect("replay"),
        fs::read(modified_path).expect("modified")
    );
}

#[test]
fn apply_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let input_path = temp.child("input-large.nds");
    let patch_path = temp.child("driver.dldi");
    let output_single = temp.child("output-single.nds");
    let output_parallel = temp.child("output-parallel.nds");

    let slot_offset = 0x300;
    let mem_offset = 0x0200_0000i32;
    let mut input = build_test_app_with_slot(slot_offset, 12, mem_offset, "Default driver");
    input.resize(THREAD_WORK_CHUNK_BYTES + 128 * 1024, 0xCD);
    let patch = build_test_dldi_driver(
        10,
        0xBF81_0000u32 as i32,
        "Threaded Driver",
        FIX_ALL | FIX_GLUE | FIX_GOT | FIX_BSS,
    );

    fs::write(&input_path, &input).expect("fixture");
    fs::write(&patch_path, &patch).expect("fixture");

    let handler = DldiPatchHandler::new(&DLDI);
    let capabilities = handler.capabilities();
    assert!(capabilities.threaded_diff);
    assert!(capabilities.threaded_output);
    let single_report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_single.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("single apply");
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
    assert_eq!(
        fs::read(output_single).expect("single"),
        fs::read(output_parallel).expect("parallel")
    );
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let original_path = temp.child("original-large.nds");
    let driver_path = temp.child("driver.dldi");
    let modified_path = temp.child("modified-large.nds");
    let patch_single = temp.child("single.dldi");
    let patch_parallel = temp.child("parallel.dldi");

    let slot_offset = 0x300;
    let mem_offset = 0x0200_0000i32;
    let mut original = build_test_app_with_slot(slot_offset, 12, mem_offset, "Default driver");
    original.resize(THREAD_WORK_CHUNK_BYTES + 256 * 1024, 0xCD);
    let driver = build_test_dldi_driver(
        10,
        0xBF81_0000u32 as i32,
        "Threaded Create Driver",
        FIX_ALL | FIX_GLUE | FIX_GOT | FIX_BSS,
    );

    fs::write(&original_path, &original).expect("fixture");
    fs::write(&driver_path, &driver).expect("fixture");

    let handler = DldiPatchHandler::new(&DLDI);
    handler
        .apply(
            &PatchApplyRequest {
                input: original_path.clone(),
                patches: vec![driver_path],
                output: modified_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: original_path.clone(),
                modified: modified_path.clone(),
                output: patch_single.clone(),
                format: "dldi".into(),
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
                format: "dldi".into(),
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

fn build_test_app_with_slot(
    slot_offset: usize,
    allocated_log2: u8,
    mem_offset: i32,
    friendly_name: &str,
) -> Vec<u8> {
    let slot_size = 1usize << allocated_log2;
    let mut file = vec![0xCDu8; slot_offset + slot_size + 0x80];
    let mut slot = build_test_dldi_driver(
        allocated_log2,
        mem_offset,
        friendly_name,
        FIX_ALL | FIX_GLUE | FIX_GOT | FIX_BSS,
    );

    // Placeholder drivers usually advertise their reserved capacity.
    slot[DO_ALLOCATED_SPACE] = allocated_log2;
    file[slot_offset..slot_offset + slot_size].copy_from_slice(&slot);
    file
}

fn build_test_dldi_driver(
    driver_log2: u8,
    base_address: i32,
    friendly_name: &str,
    fix_flags: u8,
) -> Vec<u8> {
    let size = 1usize << driver_log2;
    let mut bytes = vec![0u8; size];

    bytes[DO_MAGIC_STRING..DO_MAGIC_STRING + DLDI_MAGIC.len()].copy_from_slice(&DLDI_MAGIC);
    bytes[DO_VERSION] = DLDI_VERSION;
    bytes[DO_DRIVER_SIZE] = driver_log2;
    bytes[DO_FIX_SECTIONS] = fix_flags;
    bytes[DO_ALLOCATED_SPACE] = driver_log2;

    let name_bytes = friendly_name.as_bytes();
    let max_name_len = DO_TEXT_START - DO_FRIENDLY_NAME;
    let copy_len = name_bytes.len().min(max_name_len.saturating_sub(1));
    bytes[DO_FRIENDLY_NAME..DO_FRIENDLY_NAME + copy_len].copy_from_slice(&name_bytes[..copy_len]);

    let size_i32 = i32::try_from(size).expect("size fits");
    write_i32(&mut bytes, DO_TEXT_START, base_address);
    write_i32(&mut bytes, DO_DATA_END, base_address + size_i32);
    write_i32(&mut bytes, DO_GLUE_START, base_address + 0xA0);
    write_i32(&mut bytes, DO_GLUE_END, base_address + 0xA8);
    write_i32(&mut bytes, DO_GOT_START, base_address + 0xA8);
    write_i32(&mut bytes, DO_GOT_END, base_address + 0xB0);
    write_i32(&mut bytes, DO_BSS_START, base_address + 0xB0);
    write_i32(&mut bytes, DO_BSS_END, base_address + 0xC0);
    write_i32(
        &mut bytes,
        DO_STARTUP,
        base_address + i32::try_from(DO_CODE).expect("fits"),
    );
    write_i32(
        &mut bytes,
        DO_READ_SECTORS,
        base_address + i32::try_from(DO_CODE + 8).expect("fits"),
    );
    write_i32(
        &mut bytes,
        DO_WRITE_SECTORS,
        base_address + i32::try_from(DO_CODE + 12).expect("fits"),
    );
    write_i32(
        &mut bytes,
        DO_SHUTDOWN,
        base_address + i32::try_from(DO_CODE + 16).expect("fits"),
    );

    write_i32(&mut bytes, DO_CODE + 4, base_address + 0xD0);
    write_i32(&mut bytes, DO_CODE + 12, base_address + 0xD8);
    write_i32(&mut bytes, 0xA0, base_address + 0x80);
    write_i32(&mut bytes, 0xA8, base_address + 0x84);

    for byte in &mut bytes[0xB0..0xC0] {
        *byte = 0x7F;
    }

    bytes
}

fn write_i32(bytes: &mut [u8], offset: usize, value: i32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}
