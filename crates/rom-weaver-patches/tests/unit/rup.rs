use std::{
    fs::{self, File, OpenOptions},
    io::{self, Cursor, Read, Write},
};

use rom_weaver_core::{
    CancellationToken, PatchApplyDirection, PatchApplyRequest, PatchCheckScopes,
    PatchChecksumValidation, PatchCreateRequest, PatchEndpointSelection, PatchHandler,
    PatchInputN64ByteOrder, PatchValidateRequest,
};

use super::{
    COPIER_HEADER_SIZE, GAME_BOY_BANK_SIZE, LYNX_HEADER_SIZE, NES_INES_HEADER_SIZE, PCE_BANK_SIZE,
    RUP_COMMAND_END, RUP_COMMAND_OPEN_NEW_FILE, RUP_COMMAND_XOR_RECORD, RUP_HEADER_SIZE, RupFile,
    RupMetadata, RupOverflowMode, RupPatchHandler, RupPreparedRecord, RupPreparedTask, RupRecord,
    SMD_BLOCK_SIZE, SNES_BANK_SIZE, apply_rup_prepared_records, apply_xor_records_in_place,
    build_rup_prepared_tasks, build_xor_records, collect_rup_chunk_records,
    collect_rup_records_parallel, copy_exact_bytes, copy_unif_payload_chunks,
    create_rup_patch_bytes, create_rup_patch_parallel, deinterleave_smd_block,
    deinterleave_snes_payload, encode_rup_patch, format_md5_hex, is_unif_payload_chunk, md5_bytes,
    nibble_to_hex, normalize_rup_input, parallel_chunked_capability, parse_rup_bytes,
    prepare_rup_write_task, push_vlv, read_unif_chunk_header, read_xor_suffix,
    rebuild_unif_payload, snes_payload_needs_deinterleave, validate_rup_ranges, write_fixed_string,
    write_n64_big_endian_to_temp, write_smd_deinterleaved_to_temp,
};
use crate::{
    RUP,
    test_support::{
        TestDir, report_endpoints, test_context_with_threads, test_context_with_threads_named,
    },
};

#[test]
fn parse_rejects_invalid_magic() {
    let mut bytes = create_rup_patch_bytes(b"source", b"target")
        .expect("patch")
        .bytes;
    bytes[0] ^= 0x01;

    let error = parse_rup_bytes(&bytes).expect_err("invalid magic should fail");
    assert!(error.to_string().contains("Patch header invalid"));
}

#[test]
fn parse_rejects_invalid_overflow_mode() {
    let mut bytes = create_rup_patch_bytes(b"short", b"this-is-longer")
        .expect("patch")
        .bytes;

    let command_offset = bytes
        .iter()
        .position(|byte| *byte == RUP_COMMAND_OPEN_NEW_FILE)
        .expect("open command");

    let mut cursor = command_offset + 1;

    let name_len = usize::from(bytes[cursor]);
    cursor += 1 + name_len;
    cursor += 1;

    let source_size_len = usize::from(bytes[cursor]);
    cursor += 1 + source_size_len;

    let target_size_len = usize::from(bytes[cursor]);
    cursor += 1 + target_size_len;

    cursor += 32;
    bytes[cursor] = b'Z';

    let error = parse_rup_bytes(&bytes).expect_err("invalid overflow mode should fail");
    assert!(error.to_string().contains("invalid overflow mode"));
}

#[test]
fn parse_reports_md5_for_each_variant() {
    let temp = TestDir::new();
    let patch_path = temp.child("multi-variant.rup");
    let source_md5_a = md5_bytes(b"source-a");
    let target_md5_a = md5_bytes(b"target-a");
    let source_md5_b = md5_bytes(b"source-b");
    let target_md5_b = md5_bytes(b"target-b");
    let patch = encode_rup_patch(
        &RupMetadata::default(),
        &[
            RupFile {
                file_name: "variant-a.bin".to_string(),
                rom_type: 0,
                source_file_size: 8,
                target_file_size: 8,
                source_md5: source_md5_a,
                target_md5: target_md5_a,
                overflow_mode: None,
                overflow_data: Vec::new(),
                records: Vec::new(),
            },
            RupFile {
                file_name: "variant-b.bin".to_string(),
                rom_type: 0,
                source_file_size: 8,
                target_file_size: 8,
                source_md5: source_md5_b,
                target_md5: target_md5_b,
                overflow_mode: None,
                overflow_data: Vec::new(),
                records: Vec::new(),
            },
        ],
    )
    .expect("patch");
    fs::write(&patch_path, patch).expect("fixture");

    let handler = RupPatchHandler::new(&RUP);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse report");

    assert!(report.label.contains(&format!(
        "variant 1 source md5 {}; target md5 {}",
        format_md5_hex(source_md5_a),
        format_md5_hex(target_md5_a)
    )));
    assert!(report.label.contains(&format!(
        "variant 2 source md5 {}; target md5 {}",
        format_md5_hex(source_md5_b),
        format_md5_hex(target_md5_b)
    )));

    let endpoints = report_endpoints(&report);
    assert_eq!(endpoints.len(), 4);
    for (endpoint, (variant, direction, source_md5, target_md5)) in endpoints.iter().zip([
        (0, "forward", source_md5_a, target_md5_a),
        (0, "reverse", target_md5_a, source_md5_a),
        (1, "forward", source_md5_b, target_md5_b),
        (1, "reverse", target_md5_b, source_md5_b),
    ]) {
        assert_eq!(endpoint["input"]["size"].as_u64(), Some(8));
        assert_eq!(endpoint["output"]["size"].as_u64(), Some(8));
        assert_eq!(endpoint["execution"]["variant"], variant);
        assert_eq!(endpoint["execution"]["direction"], direction);
        assert_eq!(
            endpoint["input"]["checksums"]["md5"].as_str(),
            Some(format_md5_hex(source_md5).as_str())
        );
        assert_eq!(
            endpoint["output"]["checksums"]["md5"].as_str(),
            Some(format_md5_hex(target_md5).as_str())
        );
    }
}

#[test]
fn endpoint_resolution_reports_all_ambiguous_rup_variants() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("ambiguous.rup");
    let source = b"same-source".to_vec();
    let target_a = b"target-one!".to_vec();
    let target_b = b"target-two!".to_vec();
    fs::write(&input_path, &source).expect("source");
    fs::write(
        &patch_path,
        encode_rup_patch(
            &RupMetadata::default(),
            &[
                typed_rup_file(&source, &target_a, 0),
                typed_rup_file(&source, &target_b, 0),
            ],
        )
        .expect("patch"),
    )
    .expect("patch fixture");

    let selections = RupPatchHandler::new(&RUP)
        .resolve_endpoint_selections(
            &patch_path,
            &input_path,
            &test_context_with_threads(&temp, 1),
        )
        .expect("endpoint resolution");

    assert_eq!(
        selections,
        vec![
            PatchEndpointSelection {
                variant: 0,
                direction: PatchApplyDirection::Forward,
            },
            PatchEndpointSelection {
                variant: 1,
                direction: PatchApplyDirection::Forward,
            },
        ]
    );
}

#[test]
fn endpoint_resolution_propagates_cancellation() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("update.rup");
    fs::write(&input_path, b"source").expect("source");
    fs::write(&patch_path, typed_rup_patch(b"source", b"target", 0)).expect("patch");
    let context = test_context_with_threads(&temp, 1);
    context.cancel().cancel();

    let error = RupPatchHandler::new(&RUP)
        .resolve_endpoint_selections(&patch_path, &input_path, &context)
        .expect_err("endpoint hashing cancellation must propagate");

    assert!(matches!(error, rom_weaver_core::RomWeaverError::Cancelled));
}

#[test]
fn selected_endpoint_validation_propagates_cancellation() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("update.rup");
    fs::write(&input_path, b"source").expect("source");
    fs::write(&patch_path, typed_rup_patch(b"source", b"target", 0)).expect("patch");
    let context =
        test_context_with_threads(&temp, 1).with_patch_endpoint_selection(PatchEndpointSelection {
            variant: 0,
            direction: PatchApplyDirection::Forward,
        });
    context.cancel().cancel();

    let error = RupPatchHandler::new(&RUP)
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &context,
        )
        .expect_err("selected endpoint hashing cancellation must propagate");

    assert!(matches!(error, rom_weaver_core::RomWeaverError::Cancelled));
}

#[test]
fn selected_endpoint_apply_without_source_checks_cancels_before_output_creation() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let output_path = temp.child("output.bin");
    let patch_path = temp.child("update.rup");
    fs::write(&input_path, b"source").expect("source");
    fs::write(&patch_path, typed_rup_patch(b"source", b"target", 0)).expect("patch");
    let context = test_context_with_threads(&temp, 1)
        .with_patch_checksum_validation(PatchChecksumValidation::Ignore)
        .with_patch_endpoint_selection(PatchEndpointSelection {
            variant: 0,
            direction: PatchApplyDirection::Forward,
        });
    context.cancel().cancel();

    let error = RupPatchHandler::new(&RUP)
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &context,
        )
        .expect_err("selected apply must observe cancellation without source checks");

    assert!(matches!(error, rom_weaver_core::RomWeaverError::Cancelled));
    assert!(!output_path.exists(), "cancelled apply created output");
}

#[test]
fn endpoint_resolution_uses_rup_n64_snes_and_unif_normalization() {
    let temp = TestDir::new();
    let handler = RupPatchHandler::new(&RUP);

    let n64_source = vec![0x80, 0x37, 0x12, 0x40, 0xaa, 0x55];
    let mut n64_target = n64_source.clone();
    n64_target[5] ^= 0x33;

    let mut snes_interleaved = vec![0u8; 0x10000];
    for (index, byte) in snes_interleaved.iter_mut().enumerate() {
        *byte = ((index * 7) & 0xff) as u8;
    }
    snes_interleaved[0x7fd5] = 1;
    snes_interleaved[0x7fdc..0x7fde].copy_from_slice(&0x1357u16.to_le_bytes());
    snes_interleaved[0x7fde..0x7fe0].copy_from_slice(&0xeca8u16.to_le_bytes());
    let snes_source = super::deinterleave_snes_payload(&snes_interleaved);
    let mut snes_target = snes_source.clone();
    snes_target[0x100] ^= 0x44;

    let cases = [
        (
            "n64",
            byte_swap_pairs(&n64_source),
            n64_source,
            n64_target,
            4,
        ),
        ("snes", snes_interleaved, snes_source, snes_target, 3),
        (
            "unif",
            unif_fixture(b"PRG1", b"CHR1"),
            b"PRG1CHR1".to_vec(),
            b"PRG2CHR2".to_vec(),
            1,
        ),
    ];

    for (name, input, source, target, rom_type) in cases {
        let input_name = format!("{name}-input.bin");
        let patch_name = format!("{name}.rup");
        let input_path = temp.child(&input_name);
        let patch_path = temp.child(&patch_name);
        fs::write(&input_path, input).expect("input fixture");
        fs::write(&patch_path, typed_rup_patch(&source, &target, rom_type)).expect("patch fixture");

        let selections = handler
            .resolve_endpoint_selections(
                &patch_path,
                &input_path,
                &test_context_with_threads(&temp, 1),
            )
            .unwrap_or_else(|error| panic!("{name} endpoint resolution failed: {error}"));
        assert_eq!(
            selections,
            vec![PatchEndpointSelection {
                variant: 0,
                direction: PatchApplyDirection::Forward,
            }],
            "{name} normalization"
        );
    }
}

#[test]
fn endpoint_resolution_removes_partial_n64_temp_after_normalization_error() {
    let temp = TestDir::new();
    let input_path = temp.child("odd-byte-swapped.v64");
    let patch_path = temp.child("update.rup");
    let source = vec![0x80, 0x37, 0x12, 0x40, 0xaa];
    let mut target = source.clone();
    target[4] ^= 0x55;
    fs::write(&input_path, [0x37, 0x80, 0x40, 0x12, 0xaa]).expect("input fixture");
    fs::write(&patch_path, typed_rup_patch(&source, &target, 4)).expect("patch fixture");

    let context = test_context_with_threads(&temp, 1);
    let selections = RupPatchHandler::new(&RUP)
        .resolve_endpoint_selections(&patch_path, &input_path, &context)
        .expect("invalid typed normalization is a nonmatch");
    assert!(selections.is_empty());

    let namespace = context
        .temp_paths()
        .root()
        .join(context.temp_paths().namespace());
    assert!(
        namespace.is_dir(),
        "normalization must create its temp namespace"
    );
    let leftovers = fs::read_dir(namespace)
        .expect("live temp namespace")
        .map(|entry| entry.expect("temp entry").file_name())
        .collect::<Vec<_>>();
    assert!(
        leftovers.is_empty(),
        "partial RUP temp files survived normalization error: {leftovers:?}"
    );
}

struct CancelAfterFirstRead<R> {
    inner: R,
    cancel: CancellationToken,
    cancelled: bool,
}

impl<R: Read> Read for CancelAfterFirstRead<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        if read > 0 && !self.cancelled {
            self.cancel.cancel();
            self.cancelled = true;
        }
        Ok(read)
    }
}

#[test]
fn normalization_copy_cancels_mid_stream_and_removes_partial_temp() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 1);
    let mut input = CancelAfterFirstRead {
        inner: Cursor::new(vec![0x5a; super::RUP_IO_BUFFER_SIZE * 2]),
        cancel: context.cancel().clone(),
        cancelled: false,
    };

    let error = super::write_normalization_temp(&context, "rup-cancelled-copy", |output_path| {
        let mut output = File::create(output_path)?;
        super::copy_cancellable(&mut input, &mut output, &context)?;
        Ok(())
    })
    .expect_err("mid-normalization cancellation must propagate");

    assert!(matches!(error, rom_weaver_core::RomWeaverError::Cancelled));
    assert!(input.cancelled, "test reader did not cancel after a read");
    assert!(
        input.inner.position() > 0,
        "cancellation happened before normalization copied a chunk"
    );
    let namespace = context
        .temp_paths()
        .root()
        .join(context.temp_paths().namespace());
    let leftovers = fs::read_dir(namespace)
        .expect("live temp namespace")
        .map(|entry| entry.expect("temp entry").file_name())
        .collect::<Vec<_>>();
    assert!(
        leftovers.is_empty(),
        "partial RUP temp files survived cancellation: {leftovers:?}"
    );
}

#[test]
fn endpoint_resolution_normalizes_each_rom_type_once_and_removes_temps() {
    let temp = TestDir::new();
    let input_path = temp.child("headered-interleaved.sfc");
    let baseline_patch_path = temp.child("baseline.rup");
    let patch_path = temp.child("ambiguous.rup");

    let mut interleaved = vec![0u8; 0x10000];
    for (index, byte) in interleaved.iter_mut().enumerate() {
        *byte = ((index * 7) & 0xff) as u8;
    }
    interleaved[0x7fd5] = 1;
    interleaved[0x7fdc..0x7fde].copy_from_slice(&0x1357u16.to_le_bytes());
    interleaved[0x7fde..0x7fe0].copy_from_slice(&0xeca8u16.to_le_bytes());
    let source = super::deinterleave_snes_payload(&interleaved);

    let mut target_a = source.clone();
    target_a[0x100] ^= 0x44;
    let mut target_b = source.clone();
    target_b[0x200] ^= 0x55;
    let mut nonmatch_source = source.clone();
    nonmatch_source[0x300] ^= 0x66;
    let mut nonmatch_target = nonmatch_source.clone();
    nonmatch_target[0x400] ^= 0x77;

    let mut headered_input = vec![0u8; 0x200];
    headered_input.extend_from_slice(&interleaved);
    fs::write(&input_path, headered_input).expect("input fixture");
    fs::write(&baseline_patch_path, typed_rup_patch(&source, &target_a, 3))
        .expect("baseline patch fixture");
    fs::write(
        &patch_path,
        encode_rup_patch(
            &RupMetadata::default(),
            &[
                typed_rup_file(&source, &target_a, 3),
                typed_rup_file(&source, &target_b, 3),
                typed_rup_file(&nonmatch_source, &nonmatch_target, 3),
            ],
        )
        .expect("patch"),
    )
    .expect("patch fixture");

    let baseline_context = test_context_with_threads_named(&temp, 1, "baseline-temp");
    RupPatchHandler::new(&RUP)
        .resolve_endpoint_selections(&baseline_patch_path, &input_path, &baseline_context)
        .expect("one-variant baseline");
    let baseline_next = baseline_context
        .temp_paths()
        .next_path("after-rup-normalization", Some("bin"));

    let context = test_context_with_threads_named(&temp, 1, "ambiguous-temp");
    let selections = RupPatchHandler::new(&RUP)
        .resolve_endpoint_selections(&patch_path, &input_path, &context)
        .expect("endpoint resolution");
    assert_eq!(
        selections,
        vec![
            PatchEndpointSelection {
                variant: 0,
                direction: PatchApplyDirection::Forward,
            },
            PatchEndpointSelection {
                variant: 1,
                direction: PatchApplyDirection::Forward,
            },
        ]
    );

    let namespace = context
        .temp_paths()
        .root()
        .join(context.temp_paths().namespace());
    assert!(namespace.is_dir(), "normalization must exercise temp files");
    let leftovers = fs::read_dir(namespace)
        .expect("live temp namespace")
        .map(|entry| entry.expect("temp entry").file_name())
        .collect::<Vec<_>>();
    assert!(
        leftovers.is_empty(),
        "leftover RUP temp files: {leftovers:?}"
    );
    let next_path = context
        .temp_paths()
        .next_path("after-rup-normalization", Some("bin"));
    assert_eq!(
        next_path.file_name(),
        baseline_next.file_name(),
        "same-ROM-type variants must not repeat the baseline normalization"
    );
}

#[test]
fn successful_selection_reuses_normalized_input_and_removes_temps() {
    let temp = TestDir::new();
    let input_path = temp.child("headered-interleaved.sfc");
    let baseline_patch_path = temp.child("baseline.rup");
    let patch_path = temp.child("unique.rup");

    let mut interleaved = vec![0u8; 0x10000];
    for (index, byte) in interleaved.iter_mut().enumerate() {
        *byte = ((index * 7) & 0xff) as u8;
    }
    interleaved[0x7fd5] = 1;
    interleaved[0x7fdc..0x7fde].copy_from_slice(&0x1357u16.to_le_bytes());
    interleaved[0x7fde..0x7fe0].copy_from_slice(&0xeca8u16.to_le_bytes());
    let source = super::deinterleave_snes_payload(&interleaved);
    let mut target = source.clone();
    target[0x100] ^= 0x44;
    let mut nonmatch_source = source.clone();
    nonmatch_source[0x200] ^= 0x55;
    let mut nonmatch_target = nonmatch_source.clone();
    nonmatch_target[0x300] ^= 0x66;

    let mut headered_input = vec![0u8; 0x200];
    headered_input.extend_from_slice(&interleaved);
    fs::write(&input_path, headered_input).expect("input fixture");
    fs::write(&baseline_patch_path, typed_rup_patch(&source, &target, 3))
        .expect("baseline patch fixture");
    fs::write(
        &patch_path,
        encode_rup_patch(
            &RupMetadata::default(),
            &[
                typed_rup_file(&source, &target, 3),
                typed_rup_file(&nonmatch_source, &nonmatch_target, 3),
            ],
        )
        .expect("patch"),
    )
    .expect("patch fixture");

    let baseline_context = test_context_with_threads_named(&temp, 1, "baseline-temp");
    RupPatchHandler::new(&RUP)
        .resolve_endpoint_selections(&baseline_patch_path, &input_path, &baseline_context)
        .expect("one-variant baseline");
    let baseline_next = baseline_context
        .temp_paths()
        .next_path("after-rup-selection", Some("bin"));

    let context = test_context_with_threads_named(&temp, 1, "selection-temp");
    RupPatchHandler::new(&RUP)
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &context,
        )
        .expect("unique endpoint validation");

    let namespace = context
        .temp_paths()
        .root()
        .join(context.temp_paths().namespace());
    let leftovers = fs::read_dir(&namespace)
        .expect("live temp namespace")
        .map(|entry| entry.expect("temp entry").file_name())
        .collect::<Vec<_>>();
    assert!(
        leftovers.is_empty(),
        "selected RUP input left normalization temps: {leftovers:?}"
    );
    let next_path = context
        .temp_paths()
        .next_path("after-rup-selection", Some("bin"));
    assert_eq!(
        next_path.file_name(),
        baseline_next.file_name(),
        "successful selection must not repeat the baseline normalization"
    );
}

#[test]
fn apply_normalizes_nes_ines_header_and_preserves_it_on_reverse() {
    let temp = TestDir::new();
    let source_path = temp.child("source.nes");
    let patched_path = temp.child("patched.nes");
    let reverse_path = temp.child("reverse.nes");
    let patch_path = temp.child("update.rup");

    let mut header = b"NES\x1A".to_vec();
    header.resize(0x10, 0);
    let source_payload = b"ABCDEFGH".to_vec();
    let target_payload = b"ABCXEFGH".to_vec();
    let source = [header.as_slice(), source_payload.as_slice()].concat();
    let target = [header.as_slice(), target_payload.as_slice()].concat();
    fs::write(&source_path, &source).expect("source");
    fs::write(
        &patch_path,
        typed_rup_patch(&source_payload, &target_payload, 1),
    )
    .expect("patch");

    let handler = RupPatchHandler::new(&RUP);
    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path.clone()],
                output: patched_path.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("apply");
    assert_eq!(fs::read(&patched_path).expect("patched"), target);

    handler
        .apply(
            &PatchApplyRequest {
                input: patched_path,
                patches: vec![patch_path],
                output: reverse_path.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("reverse");
    assert_eq!(fs::read(reverse_path).expect("reverse"), source);
}

#[test]
fn apply_does_not_strip_nes_payload_without_ines_magic() {
    let temp = TestDir::new();
    let source_path = temp.child("source.nes");
    let output_path = temp.child("output.nes");
    let patch_path = temp.child("update.rup");

    let source = b"NES!headerless-payload".to_vec();
    let mut target = source.clone();
    target[4] ^= 0x5a;
    fs::write(&source_path, &source).expect("source");
    fs::write(&patch_path, typed_rup_patch(&source, &target, 1)).expect("patch");

    RupPatchHandler::new(&RUP)
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_normalizes_unif_prg_chr_payloads() {
    let temp = TestDir::new();
    let source_path = temp.child("source.unif");
    let output_path = temp.child("output.unif");
    let patch_path = temp.child("update.rup");

    let source_payload = b"PRG1CHR1".to_vec();
    let target_payload = b"PRG2CHR2".to_vec();
    let source = unif_fixture(b"PRG1", b"CHR1");
    let target = unif_fixture(b"PRG2", b"CHR2");
    fs::write(&source_path, &source).expect("source");
    fs::write(
        &patch_path,
        typed_rup_patch(&source_payload, &target_payload, 1),
    )
    .expect("patch");

    let handler = RupPatchHandler::new(&RUP);
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

    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_normalizes_snes_copier_header_and_preserves_nsrt_header() {
    let temp = TestDir::new();
    let source_path = temp.child("source.sfc");
    let output_path = temp.child("output.sfc");
    let patch_path = temp.child("update.rup");

    let mut header = vec![0u8; 0x200];
    header[0x1e8..0x1ec].copy_from_slice(b"NSRT");
    let mut source_payload = vec![0u8; 0x8000];
    source_payload[0x7fd5] = 0;
    source_payload[0x7fdc..0x7fde].copy_from_slice(&0x4321u16.to_le_bytes());
    source_payload[0x7fde..0x7fe0].copy_from_slice(&0xbcdeu16.to_le_bytes());
    let mut target_payload = source_payload.clone();
    target_payload[0x40] = 0x77;
    let expected = [header.as_slice(), target_payload.as_slice()].concat();
    fs::write(
        &source_path,
        [header.as_slice(), source_payload.as_slice()].concat(),
    )
    .expect("source");
    fs::write(
        &patch_path,
        typed_rup_patch(&source_payload, &target_payload, 3),
    )
    .expect("patch");

    let handler = RupPatchHandler::new(&RUP);
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

    assert_eq!(fs::read(output_path).expect("output"), expected);
}

#[test]
fn apply_normalizes_snes_interleaved_payload_to_native_output() {
    let temp = TestDir::new();
    let source_path = temp.child("source.smc");
    let output_path = temp.child("output.sfc");
    let patch_path = temp.child("update.rup");

    let mut interleaved_source = vec![0u8; 0x10000];
    for (index, byte) in interleaved_source.iter_mut().enumerate() {
        *byte = ((index * 7) & 0xff) as u8;
    }
    interleaved_source[0x7fd5] = 1;
    interleaved_source[0x7fdc..0x7fde].copy_from_slice(&0x1357u16.to_le_bytes());
    interleaved_source[0x7fde..0x7fe0].copy_from_slice(&0xeca8u16.to_le_bytes());
    let source_native = super::deinterleave_snes_payload(&interleaved_source);
    let mut target_native = source_native.clone();
    target_native[0x100] ^= 0x33;
    fs::write(&source_path, interleaved_source).expect("source");
    fs::write(
        &patch_path,
        typed_rup_patch(&source_native, &target_native, 3),
    )
    .expect("patch");

    let handler = RupPatchHandler::new(&RUP);
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

    assert_eq!(fs::read(output_path).expect("output"), target_native);
}

#[test]
fn apply_normalizes_n64_byte_swapped_input_to_native_output() {
    let temp = TestDir::new();
    let source_path = temp.child("source.v64");
    let output_path = temp.child("output.z64");
    let patch_path = temp.child("update.rup");

    let source_native = vec![0x80, 0x37, 0x12, 0x40, 0xAA, 0x55];
    let mut target_native = source_native.clone();
    target_native[5] = 0x66;
    fs::write(&source_path, byte_swap_pairs(&source_native)).expect("source");
    fs::write(
        &patch_path,
        typed_rup_patch(&source_native, &target_native, 4),
    )
    .expect("patch");

    let handler = RupPatchHandler::new(&RUP);
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

    assert_eq!(fs::read(output_path).expect("output"), target_native);
}

#[test]
fn apply_normalizes_n64_little_endian_input_to_native_output() {
    let temp = TestDir::new();
    let source_path = temp.child("source.n64");
    let output_path = temp.child("output.z64");
    let patch_path = temp.child("update.rup");

    let source_native = vec![0x80, 0x37, 0x12, 0x40, 0xAA, 0x55, 0x11, 0x22];
    let mut target_native = source_native.clone();
    target_native[6] = 0x66;
    fs::write(&source_path, reverse_n64_words(&source_native)).expect("source");
    fs::write(
        &patch_path,
        typed_rup_patch(&source_native, &target_native, 4),
    )
    .expect("patch");

    let report = RupPatchHandler::new(&RUP)
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("strict apply");

    assert_eq!(fs::read(output_path).expect("output"), target_native);
    assert_eq!(
        report
            .details
            .as_ref()
            .and_then(|details| { details.pointer("/patch/output_representation/n64_byte_order") })
            .and_then(serde_json::Value::as_str),
        Some("big-endian")
    );
}

#[test]
fn selected_n64_endpoint_uses_planned_order_after_magic_changes() {
    let temp = TestDir::new();
    let source_path = temp.child("modified-intermediate.bin");
    let output_path = temp.child("output.z64");
    let patch_path = temp.child("update.rup");

    let source_native = vec![0x80, 0x37, 0x12, 0x40, 0xAA, 0x55];
    let mut target_native = source_native.clone();
    target_native[5] = 0x66;
    let mut intermediate_native = source_native.clone();
    intermediate_native[1] ^= 0x31;
    fs::write(&source_path, byte_swap_pairs(&intermediate_native)).expect("source");
    fs::write(
        &patch_path,
        typed_rup_patch(&source_native, &target_native, 4),
    )
    .expect("patch");

    let context = test_context_with_threads(&temp, 1)
        .with_patch_check_scopes(PatchCheckScopes {
            patch_integrity: true,
            source: false,
            target: false,
        })
        .with_patch_endpoint_selection(PatchEndpointSelection {
            variant: 0,
            direction: PatchApplyDirection::Forward,
        })
        .with_patch_input_n64_byte_order(PatchInputN64ByteOrder::ByteSwapped);
    let report = RupPatchHandler::new(&RUP)
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &context,
        )
        .expect("apply");

    intermediate_native[5] = 0x66;
    assert_eq!(fs::read(output_path).expect("output"), intermediate_native);
    assert_eq!(
        report
            .details
            .as_ref()
            .and_then(|details| { details.pointer("/patch/output_representation/n64_byte_order") })
            .and_then(serde_json::Value::as_str),
        Some("big-endian")
    );
}

#[test]
fn apply_normalizes_copier_headers_that_multipatch_drops() {
    let temp = TestDir::new();
    let gb_source = temp.child("source.gb");
    let gb_output = temp.child("output.gb");
    let gb_patch = temp.child("update-gb.rup");
    let pce_source = temp.child("source.pce");
    let pce_output = temp.child("output.pce");
    let pce_patch = temp.child("update-pce.rup");

    let gb_payload = vec![0x11; 0x4000];
    let mut gb_target = gb_payload.clone();
    gb_target[3] = 0x22;
    fs::write(&gb_source, [vec![0xAB; 0x200], gb_payload.clone()].concat()).expect("gb source");
    fs::write(&gb_patch, typed_rup_patch(&gb_payload, &gb_target, 5)).expect("gb patch");

    let pce_payload = vec![0x44; 0x1000];
    let mut pce_target = pce_payload.clone();
    pce_target[4] = 0x55;
    fs::write(
        &pce_source,
        [vec![0xCD; 0x200], pce_payload.clone()].concat(),
    )
    .expect("pce source");
    fs::write(&pce_patch, typed_rup_patch(&pce_payload, &pce_target, 8)).expect("pce patch");

    let handler = RupPatchHandler::new(&RUP);
    handler
        .apply(
            &PatchApplyRequest {
                input: gb_source,
                patches: vec![gb_patch],
                output: gb_output.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("gb apply");
    handler
        .apply(
            &PatchApplyRequest {
                input: pce_source,
                patches: vec![pce_patch],
                output: pce_output.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("pce apply");

    assert_eq!(fs::read(gb_output).expect("gb output"), gb_target);
    assert_eq!(fs::read(pce_output).expect("pce output"), pce_target);
}

#[test]
fn apply_normalizes_lynx_header_and_preserves_it() {
    let temp = TestDir::new();
    let source_path = temp.child("source.lnx");
    let output_path = temp.child("output.lnx");
    let patch_path = temp.child("update.rup");

    let mut header = b"LYNX".to_vec();
    header.resize(0x40, 0x9A);
    let source_payload = b"lynxdata".to_vec();
    let target_payload = b"lynxDATA".to_vec();
    fs::write(
        &source_path,
        [header.as_slice(), source_payload.as_slice()].concat(),
    )
    .expect("source");
    fs::write(
        &patch_path,
        typed_rup_patch(&source_payload, &target_payload, 9),
    )
    .expect("patch");

    let handler = RupPatchHandler::new(&RUP);
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
        [header.as_slice(), target_payload.as_slice()].concat()
    );
}

#[test]
fn apply_normalizes_smd_interleaved_genesis_input() {
    let temp = TestDir::new();
    let source_path = temp.child("source.smd");
    let output_path = temp.child("output.bin");
    let patch_path = temp.child("update.rup");

    let mut source_payload = vec![0u8; 0x4000];
    for (index, byte) in source_payload.iter_mut().enumerate() {
        *byte = (index & 0xff) as u8;
    }
    let mut target_payload = source_payload.clone();
    target_payload[17] ^= 0x5a;
    let mut header = vec![0u8; 0x200];
    header[8] = 0xaa;
    header[9] = 0xbb;
    fs::write(
        &source_path,
        [header, smd_interleave_block(&source_payload)].concat(),
    )
    .expect("source");
    fs::write(
        &patch_path,
        typed_rup_patch(&source_payload, &target_payload, 7),
    )
    .expect("patch");

    let handler = RupPatchHandler::new(&RUP);
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

    assert_eq!(fs::read(output_path).expect("output"), target_payload);
}

#[test]
fn apply_continues_after_normalization_failure_to_later_variant() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let output_path = temp.child("output.bin");
    let patch_path = temp.child("multi.rup");

    let source = b"abc".to_vec();
    let target = b"axc".to_vec();
    let unrelated = b"unused".to_vec();
    let patch = encode_rup_patch(
        &RupMetadata::default(),
        &[
            typed_rup_file(&unrelated, &unrelated, 3),
            typed_rup_file(&source, &target, 0),
        ],
    )
    .expect("patch");
    fs::write(&source_path, &source).expect("source");
    fs::write(&patch_path, patch).expect("patch");

    RupPatchHandler::new(&RUP)
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_rejects_named_rup_entries_for_single_file_apply() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let patch_path = temp.child("named.rup");
    let output_path = temp.child("output.bin");
    fs::write(&source_path, b"source").expect("source");
    let patch = encode_rup_patch(
        &RupMetadata::default(),
        &[RupFile {
            file_name: "nested.bin".to_string(),
            rom_type: 0,
            source_file_size: 6,
            target_file_size: 6,
            source_md5: md5_bytes(b"source"),
            target_md5: md5_bytes(b"target"),
            overflow_mode: None,
            overflow_data: Vec::new(),
            records: build_xor_records(b"source", b"target").expect("records"),
        }],
    )
    .expect("patch");
    fs::write(&patch_path, patch).expect("patch file");

    let handler = RupPatchHandler::new(&RUP);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("named entries are unsupported");

    assert!(error.to_string().contains("named file entries"));
}

#[test]
fn create_and_apply_round_trip_with_append_overflow() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.rup");
    let output_path = temp.child("output.bin");
    let reverse_path = temp.child("reverse.bin");

    let source = b"abcabcabcabc";
    let target = b"abcabcZZabcabcTAIL";
    fs::write(&source_path, source).expect("source");
    fs::write(&target_path, target).expect("target");

    let handler = RupPatchHandler::new(&RUP);
    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "RUP".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");

    let execution = create_report.thread_execution.expect("thread execution");
    assert_eq!(execution.requested_threads, 8);
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);

    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path.clone()],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("apply");

    assert_eq!(fs::read(&output_path).expect("output"), target);

    handler
        .apply(
            &PatchApplyRequest {
                input: output_path,
                patches: vec![patch_path],
                output: reverse_path.clone(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("undo");

    assert_eq!(fs::read(reverse_path).expect("reverse"), source);
}

#[test]
fn create_and_apply_round_trip_with_minify_overflow() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.rup");
    let output_path = temp.child("output.bin");

    let source = b"long-source-with-tail";
    let target = b"long-source";
    fs::write(&source_path, source).expect("source");
    fs::write(&target_path, target).expect("target");

    let handler = RupPatchHandler::new(&RUP);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "RUP".into(),
            },
            &test_context_with_threads(&temp, 2),
        )
        .expect("create");

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

    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_rejects_input_that_matches_neither_source_nor_target() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("update.rup");
    let wrong_path = temp.child("wrong.bin");
    let output_path = temp.child("output.bin");

    fs::write(&source_path, b"source bytes").expect("source");
    fs::write(&target_path, b"target bytes").expect("target");
    fs::write(&wrong_path, b"not matching md5").expect("wrong");

    let handler = RupPatchHandler::new(&RUP);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path,
                modified: target_path,
                output: patch_path.clone(),
                format: "RUP".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let error = handler
        .apply(
            &PatchApplyRequest {
                input: wrong_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("expected mismatch");

    assert!(error.to_string().contains("RUP input validation failed"));
}

#[test]
fn apply_uses_source_bytes_for_each_record_even_when_records_overlap() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("overlap.rup");
    let output_path = temp.child("output.bin");

    let source = vec![0u8; 8];
    let target = vec![0u8, 1, 2, 2, 0, 0, 0, 0];
    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let mut patch = create_rup_patch_bytes(&source, &target)
        .expect("patch")
        .bytes;

    let command_offset = patch
        .iter()
        .position(|byte| *byte == RUP_COMMAND_OPEN_NEW_FILE)
        .expect("open command");
    let mut cursor = command_offset + 1;

    let name_len = usize::from(patch[cursor]);
    cursor += 1 + name_len;
    cursor += 1;

    let source_size_len = usize::from(patch[cursor]);
    cursor += 1 + source_size_len;

    let target_size_len = usize::from(patch[cursor]);
    cursor += 1 + target_size_len;

    cursor += 32;

    patch.truncate(cursor);
    patch.push(0x02);
    patch.extend_from_slice(&[0x01, 0x01, 0x01, 0x02, 0x01, 0x01]);
    patch.push(0x02);
    patch.extend_from_slice(&[0x01, 0x02, 0x01, 0x02, 0x02, 0x02]);
    patch.push(0x00);

    fs::write(&patch_path, &patch).expect("patch file");

    let handler = RupPatchHandler::new(&RUP);
    handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("apply");

    assert_eq!(fs::read(output_path).expect("output"), target);
}

#[test]
fn apply_is_deterministic_across_thread_budgets_for_overlapping_records() {
    let temp = TestDir::new();
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    let patch_path = temp.child("overlap.rup");
    let output_single = temp.child("output-single.bin");
    let output_parallel = temp.child("output-parallel.bin");

    let source = vec![0u8; 8];
    let target = vec![0u8, 1, 2, 2, 0, 0, 0, 0];
    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let mut patch = create_rup_patch_bytes(&source, &target)
        .expect("patch")
        .bytes;
    let command_offset = patch
        .iter()
        .position(|byte| *byte == RUP_COMMAND_OPEN_NEW_FILE)
        .expect("open command");
    let mut cursor = command_offset + 1;
    let name_len = usize::from(patch[cursor]);
    cursor += 1 + name_len;
    cursor += 1;
    let source_size_len = usize::from(patch[cursor]);
    cursor += 1 + source_size_len;
    let target_size_len = usize::from(patch[cursor]);
    cursor += 1 + target_size_len;
    cursor += 32;
    patch.truncate(cursor);
    patch.push(0x02);
    patch.extend_from_slice(&[0x01, 0x01, 0x01, 0x02, 0x01, 0x01]);
    patch.push(0x02);
    patch.extend_from_slice(&[0x01, 0x02, 0x01, 0x02, 0x02, 0x02]);
    patch.push(0x00);
    fs::write(&patch_path, &patch).expect("patch file");

    let handler = RupPatchHandler::new(&RUP);
    let single_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path.clone(),
                patches: vec![patch_path.clone()],
                output: output_single.clone(),
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("single apply");
    let parallel_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_parallel.clone(),
            },
            &test_context_with_threads(&temp, 8)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
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
fn apply_runtime_threads_match_capabilities_for_multi_record_patch() {
    let temp = TestDir::new();
    let source_path = temp.child("source-large.bin");
    let target_path = temp.child("target-large.bin");
    let patch_path = temp.child("update.rup");
    let output_path = temp.child("output.bin");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 128 * 1024;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 23 + (index >> 4)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(6143) {
        target[index] ^= 0x44;
    }
    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let handler = RupPatchHandler::new(&RUP);
    handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path,
                output: patch_path.clone(),
                format: "RUP".into(),
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect("create");

    let capabilities = handler.capabilities();
    let apply_report = handler
        .apply(
            &PatchApplyRequest {
                input: source_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");
    let execution = apply_report.thread_execution.expect("thread execution");
    assert!(capabilities.threaded_output);
    assert_eq!(execution.requested_threads, 8);
    assert!(execution.used_parallelism);
}

#[test]
fn create_merges_record_that_crosses_thread_chunk_boundary() {
    let temp = TestDir::new();
    let source_path = temp.child("source-boundary.bin");
    let target_path = temp.child("target-boundary.bin");
    let patch_path = temp.child("boundary.rup");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 64;
    let source = vec![0x33u8; len];
    let mut target = source.clone();
    let run_start = super::CREATE_THREAD_SCAN_CHUNK_BYTES - 9;
    let run_len = 23usize;
    target[run_start..run_start + run_len].fill(0xcc);

    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let handler = RupPatchHandler::new(&RUP);
    let create_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path,
                modified: target_path,
                output: patch_path.clone(),
                format: "RUP".into(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("create");

    assert!(
        create_report
            .thread_execution
            .expect("thread execution")
            .used_parallelism
    );

    let parsed = parse_rup_bytes(&fs::read(patch_path).expect("patch bytes")).expect("parse");
    assert_eq!(parsed.files.len(), 1);
    assert_eq!(parsed.files[0].records.len(), 1);
    assert_eq!(parsed.files[0].records[0].offset, run_start as u64);
    assert_eq!(parsed.files[0].records[0].xor.len(), run_len);
    assert!(
        parsed.files[0].records[0]
            .xor
            .iter()
            .all(|byte| *byte == 0xff)
    );
}

#[test]
fn create_is_deterministic_across_thread_budgets() {
    let temp = TestDir::new();
    let source_path = temp.child("source-large.bin");
    let target_path = temp.child("target-large.bin");
    let single_patch = temp.child("single.rup");
    let parallel_patch = temp.child("parallel.rup");

    let len = super::CREATE_THREAD_SCAN_CHUNK_BYTES + 128 * 1024;
    let mut source = vec![0u8; len];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 23 + (index >> 4)) & 0xff) as u8;
    }
    let mut target = source.clone();
    for index in (0..target.len()).step_by(6143) {
        target[index] ^= 0x44;
    }

    fs::write(&source_path, &source).expect("source");
    fs::write(&target_path, &target).expect("target");

    let handler = RupPatchHandler::new(&RUP);
    let single_report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: single_patch.clone(),
                format: "RUP".into(),
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
                format: "RUP".into(),
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

fn typed_rup_patch(source_payload: &[u8], target_payload: &[u8], rom_type: u8) -> Vec<u8> {
    encode_rup_patch(
        &RupMetadata::default(),
        &[typed_rup_file(source_payload, target_payload, rom_type)],
    )
    .expect("typed rup patch")
}

fn typed_rup_file(source_payload: &[u8], target_payload: &[u8], rom_type: u8) -> RupFile {
    assert_eq!(source_payload.len(), target_payload.len());
    RupFile {
        file_name: String::new(),
        rom_type,
        source_file_size: source_payload.len() as u64,
        target_file_size: target_payload.len() as u64,
        source_md5: md5_bytes(source_payload),
        target_md5: md5_bytes(target_payload),
        overflow_mode: None,
        overflow_data: Vec::new(),
        records: build_xor_records(source_payload, target_payload).expect("records"),
    }
}

fn unif_fixture(prg: &[u8], chr: &[u8]) -> Vec<u8> {
    let mut bytes = b"UNIF".to_vec();
    bytes.resize(0x20, 0);
    push_unif_chunk(&mut bytes, b"NAME", b"keep");
    push_unif_chunk(&mut bytes, b"PRG0", prg);
    push_unif_chunk(&mut bytes, b"CHR0", chr);
    bytes
}

fn push_unif_chunk(bytes: &mut Vec<u8>, id: &[u8; 4], data: &[u8]) {
    bytes.extend_from_slice(id);
    bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
    bytes.extend_from_slice(data);
}

fn byte_swap_pairs(bytes: &[u8]) -> Vec<u8> {
    assert_eq!(bytes.len() % 2, 0);
    let mut output = Vec::with_capacity(bytes.len());
    for pair in bytes.chunks_exact(2) {
        output.push(pair[1]);
        output.push(pair[0]);
    }
    output
}

fn reverse_n64_words(bytes: &[u8]) -> Vec<u8> {
    assert_eq!(bytes.len() % 4, 0);
    let mut output = bytes.to_vec();
    for word in output.chunks_exact_mut(4) {
        word.reverse();
    }
    output
}

fn smd_interleave_block(payload: &[u8]) -> Vec<u8> {
    assert_eq!(payload.len(), 0x4000);
    let mut output = vec![0u8; payload.len()];
    for index in 0..0x2000 {
        output[index] = payload[index * 2];
        output[0x2000 + index] = payload[(index * 2) + 1];
    }
    output
}

/// The 0x800-byte metadata header every RUP patch starts with, taken from a
/// real encode so the size check in the parser is satisfied exactly.
fn rup_header_bytes() -> Vec<u8> {
    let mut bytes = encode_rup_patch(&RupMetadata::default(), &[]).expect("header");
    bytes.truncate(RUP_HEADER_SIZE);
    bytes
}

fn rup_patch_with_commands(commands: &[u8]) -> Vec<u8> {
    let mut bytes = rup_header_bytes();
    bytes.extend_from_slice(commands);
    bytes
}

fn rup_file_of_type(rom_type: u8) -> RupFile {
    typed_rup_file(b"", b"", rom_type)
}

fn sized_fixture(temp: &TestDir, name: &str, len: usize) -> std::path::PathBuf {
    let path = temp.child(name);
    let bytes = (0..len)
        .map(|index| (index & 0xff) as u8)
        .collect::<Vec<_>>();
    fs::write(&path, bytes).expect("fixture");
    path
}

#[test]
fn parse_rejects_a_patch_smaller_than_its_header() {
    let error = parse_rup_bytes(&[0u8; 16]).expect_err("an undersized patch should fail");
    assert!(
        error
            .to_string()
            .contains("too small to contain a valid header"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_an_xor_record_before_any_file_header() {
    let bytes = rup_patch_with_commands(&[RUP_COMMAND_XOR_RECORD, 0, 0, RUP_COMMAND_END]);
    let error = parse_rup_bytes(&bytes).expect_err("a leading XOR record should fail");
    assert!(
        error
            .to_string()
            .contains("XOR record before any file header"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_an_unknown_command_byte() {
    let bytes = rup_patch_with_commands(&[0x7f, RUP_COMMAND_END]);
    let error = parse_rup_bytes(&bytes).expect_err("an unknown command should fail");
    assert!(
        error.to_string().contains("invalid command"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_patch_without_an_end_command() {
    let bytes = rup_header_bytes();
    let error = parse_rup_bytes(&bytes).expect_err("a patch with no commands should fail");
    assert!(
        error.to_string().contains("missing the end command"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_command_stream_that_ends_mid_record() {
    let bytes = rup_patch_with_commands(&[RUP_COMMAND_OPEN_NEW_FILE]);
    let error = parse_rup_bytes(&bytes).expect_err("a truncated record should fail");
    assert!(
        error
            .to_string()
            .contains("ended unexpectedly while reading data"),
        "unexpected error: {error}"
    );
}

#[test]
fn parse_rejects_a_vlv_wider_than_sixty_four_bits() {
    let bytes = rup_patch_with_commands(&[RUP_COMMAND_OPEN_NEW_FILE, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    let error = parse_rup_bytes(&bytes).expect_err("a 9-byte VLV should fail");
    assert!(
        error
            .to_string()
            .contains("VLV length exceeded 64-bit range"),
        "unexpected error: {error}"
    );
}

#[test]
fn apply_rejects_an_endpoint_selection_that_names_a_missing_variant() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("update.rup");
    fs::write(&input_path, b"source").expect("source");
    fs::write(&patch_path, typed_rup_patch(b"source", b"target", 0)).expect("patch");

    let error = RupPatchHandler::new(&RUP)
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1).with_patch_endpoint_selection(
                PatchEndpointSelection {
                    variant: 3,
                    direction: PatchApplyDirection::Forward,
                },
            ),
        )
        .expect_err("a missing variant should fail");
    assert!(
        error
            .to_string()
            .contains("RUP endpoint variant 3 is not present"),
        "unexpected error: {error}"
    );
}

#[test]
fn apply_rejects_a_selected_endpoint_whose_checksum_does_not_match() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("update.rup");
    fs::write(&input_path, b"source").expect("source");
    fs::write(&patch_path, typed_rup_patch(b"source", b"target", 0)).expect("patch");

    let error = RupPatchHandler::new(&RUP)
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1).with_patch_endpoint_selection(
                PatchEndpointSelection {
                    variant: 0,
                    direction: PatchApplyDirection::Reverse,
                },
            ),
        )
        .expect_err("the reverse endpoint does not match the source input");
    assert!(
        error
            .to_string()
            .contains("RUP selected reverse endpoint checksum mismatch"),
        "unexpected error: {error}"
    );
}

#[test]
fn validate_without_checksums_falls_back_to_the_only_file_variant() {
    let temp = TestDir::new();
    let input_path = temp.child("other.bin");
    let patch_path = temp.child("update.rup");
    fs::write(&input_path, b"zzzzzz").expect("input");
    fs::write(&patch_path, typed_rup_patch(b"source", b"target", 0)).expect("patch");

    let report = RupPatchHandler::new(&RUP)
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect("the single variant is used when checksums are ignored");
    assert!(report.label.contains("validated"), "{}", report.label);
}

#[test]
fn validate_without_checksums_rejects_a_multi_variant_patch() {
    let temp = TestDir::new();
    let input_path = temp.child("other.bin");
    let patch_path = temp.child("multi.rup");
    fs::write(&input_path, b"zzzzzz").expect("input");
    let bytes = encode_rup_patch(
        &RupMetadata::default(),
        &[
            typed_rup_file(b"source", b"target", 0),
            typed_rup_file(b"source", b"tarGet", 0),
        ],
    )
    .expect("multi-variant patch");
    fs::write(&patch_path, bytes).expect("patch");

    let error = RupPatchHandler::new(&RUP)
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1)
                .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
        )
        .expect_err("multiple variants leave the direction ambiguous");
    assert!(
        error.to_string().contains("input direction is ambiguous"),
        "unexpected error: {error}"
    );
}

#[test]
fn validate_rejects_an_input_that_matches_more_than_one_variant() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("duplicate.rup");
    fs::write(&input_path, b"source").expect("input");
    let bytes = encode_rup_patch(
        &RupMetadata::default(),
        &[
            typed_rup_file(b"source", b"target", 0),
            typed_rup_file(b"source", b"target", 0),
        ],
    )
    .expect("duplicate-variant patch");
    fs::write(&patch_path, bytes).expect("patch");

    let error = RupPatchHandler::new(&RUP)
        .validate(
            &PatchValidateRequest {
                input: input_path,
                patches: vec![patch_path],
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("two matching variants are ambiguous");
    assert!(
        error.to_string().contains("matched multiple file variants"),
        "unexpected error: {error}"
    );
}

#[test]
fn apply_rejects_a_patch_whose_target_checksum_does_not_match_the_result() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("bad-target.rup");
    let output_path = temp.child("output.bin");
    fs::write(&input_path, b"source").expect("input");

    let mut file = typed_rup_file(b"source", b"target", 0);
    file.target_md5 = md5_bytes(b"not-the-target");
    fs::write(
        &patch_path,
        encode_rup_patch(&RupMetadata::default(), &[file]).expect("patch"),
    )
    .expect("patch file");

    let error = RupPatchHandler::new(&RUP)
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("a wrong target md5 should fail");
    assert!(
        error.to_string().contains("RUP target checksum mismatch"),
        "unexpected error: {error}"
    );
}

#[test]
fn normalization_leaves_bank_aligned_and_unmarked_inputs_alone() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 1);

    let cases = [
        ("gb-aligned.bin", GAME_BOY_BANK_SIZE as usize, 5u8),
        ("pce-aligned.bin", PCE_BANK_SIZE as usize, 8),
        ("lynx-plain.bin", 0x80, 9),
        ("n64-plain.bin", 0x40, 4),
        ("unknown-type.bin", 0x40, 200),
    ];
    for (name, len, rom_type) in cases {
        let path = sized_fixture(&temp, name, len);
        let normalized =
            normalize_rup_input(&path, &rup_file_of_type(rom_type), &context).expect("normalize");
        assert_eq!(normalized.path, path, "{name} should not be rewritten");
        assert!(normalized.reconstruction.is_identity(), "{name}");
    }
}

#[test]
fn normalization_strips_copier_headers_from_game_boy_and_pce_inputs() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 1);

    for (name, bank_size, rom_type) in [
        ("gb-headered.bin", GAME_BOY_BANK_SIZE, 5u8),
        ("pce-headered.bin", PCE_BANK_SIZE, 8),
    ] {
        let len = (bank_size + COPIER_HEADER_SIZE) as usize;
        let path = sized_fixture(&temp, name, len);
        let normalized =
            normalize_rup_input(&path, &rup_file_of_type(rom_type), &context).expect("normalize");
        assert_ne!(normalized.path, path, "{name} should be rewritten");
        assert_eq!(
            fs::metadata(&normalized.path).expect("normalized").len(),
            bank_size
        );
        // The copier header is dropped, not preserved, for these rom types.
        assert!(normalized.reconstruction.is_identity(), "{name}");
    }
}

#[test]
fn normalization_strips_and_preserves_lynx_and_nes_ffe_headers() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 1);

    let lynx = temp.child("game.lnx");
    let mut lynx_bytes = b"LYNX".to_vec();
    lynx_bytes.resize(LYNX_HEADER_SIZE as usize + 0x20, 0x11);
    fs::write(&lynx, &lynx_bytes).expect("lynx fixture");
    let normalized =
        normalize_rup_input(&lynx, &rup_file_of_type(9), &context).expect("lynx normalize");
    assert_eq!(fs::metadata(&normalized.path).expect("payload").len(), 0x20);
    assert!(!normalized.reconstruction.is_identity());

    let ffe = temp.child("game.nes");
    let mut ffe_bytes = vec![0u8; COPIER_HEADER_SIZE as usize + 0x30];
    ffe_bytes[8] = 0xaa;
    ffe_bytes[9] = 0xbb;
    fs::write(&ffe, &ffe_bytes).expect("ffe fixture");
    let normalized =
        normalize_rup_input(&ffe, &rup_file_of_type(1), &context).expect("nes normalize");
    assert_eq!(fs::metadata(&normalized.path).expect("payload").len(), 0x30);
    assert!(!normalized.reconstruction.is_identity());
}

#[test]
fn normalization_reports_inputs_that_are_shorter_than_their_headers() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 1);

    let ines = temp.child("tiny.nes");
    fs::write(&ines, b"NES\x1A").expect("ines fixture");
    let ines_error = normalize_rup_input(&ines, &rup_file_of_type(1), &context)
        .expect_err("an iNES file shorter than its header should fail");
    assert!(
        ines_error.to_string().contains(&format!(
            "requires at least 0x{NES_INES_HEADER_SIZE:X} bytes"
        )),
        "unexpected error: {ines_error}"
    );

    let snes = sized_fixture(&temp, "tiny.sfc", 100);
    let snes_error = normalize_rup_input(&snes, &rup_file_of_type(3), &context)
        .expect_err("a headered SNES file shorter than 0x200 should fail");
    assert!(
        snes_error
            .to_string()
            .contains("SNES header normalization requires at least 0x200 bytes"),
        "unexpected error: {snes_error}"
    );

    let smd = temp.child("tiny.smd");
    let mut smd_bytes = vec![0u8; 0x100];
    smd_bytes[8] = 0xaa;
    smd_bytes[9] = 0xbb;
    fs::write(&smd, &smd_bytes).expect("smd fixture");
    let smd_error = normalize_rup_input(&smd, &rup_file_of_type(7), &context)
        .expect_err("an interleaved SMD file shorter than 0x200 should fail");
    assert!(
        smd_error
            .to_string()
            .contains("SMD normalization requires at least 0x200 bytes"),
        "unexpected error: {smd_error}"
    );
}

#[test]
fn normalization_keeps_native_sms_images_untouched() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 1);
    let path = temp.child("game.sms");
    let mut bytes = vec![0u8; 0x8000];
    bytes[0x7ff4..0x7ff8].copy_from_slice(b"SEGA");
    fs::write(&path, &bytes).expect("sms fixture");

    let normalized =
        normalize_rup_input(&path, &rup_file_of_type(6), &context).expect("sms normalize");
    assert_eq!(normalized.path, path);
    assert!(normalized.reconstruction.is_identity());
}

#[test]
fn n64_normalization_requires_a_length_that_matches_the_byte_order_unit() {
    let temp = TestDir::new();
    let path = sized_fixture(&temp, "odd.n64", 6);
    let context = test_context_with_threads(&temp, 1)
        .with_patch_input_n64_byte_order(PatchInputN64ByteOrder::LittleEndian);

    let error = normalize_rup_input(&path, &rup_file_of_type(4), &context)
        .expect_err("a 6-byte little-endian image is not word aligned");
    assert!(
        error
            .to_string()
            .contains("requires a byte length divisible by 4"),
        "unexpected error: {error}"
    );
}

#[test]
fn n64_big_endian_rewrite_copies_the_input_byte_for_byte() {
    let temp = TestDir::new();
    let path = sized_fixture(&temp, "native.n64", 16);
    let context = test_context_with_threads(&temp, 1);

    let rewritten =
        write_n64_big_endian_to_temp(&path, &context, PatchInputN64ByteOrder::BigEndian)
            .expect("rewrite");
    assert_eq!(
        fs::read(&rewritten).expect("rewritten"),
        fs::read(&path).expect("source")
    );
    fs::remove_file(&rewritten).expect("cleanup");
}

#[test]
fn smd_deinterleave_writes_a_short_trailing_block_verbatim() {
    let temp = TestDir::new();
    let payload_len = SMD_BLOCK_SIZE + 5;
    let path = sized_fixture(&temp, "smd-tail.bin", payload_len);
    let context = test_context_with_threads(&temp, 1);

    let output = write_smd_deinterleaved_to_temp(&path, 0, payload_len as u64, &context, "probe")
        .expect("deinterleave");
    let bytes = fs::read(&output).expect("output");
    let source = fs::read(&path).expect("source");
    assert_eq!(bytes.len(), payload_len);
    assert_eq!(
        bytes[..SMD_BLOCK_SIZE],
        deinterleave_smd_block(&source[..SMD_BLOCK_SIZE])[..]
    );
    assert_eq!(bytes[SMD_BLOCK_SIZE..], source[SMD_BLOCK_SIZE..]);
    fs::remove_file(&output).expect("cleanup");
}

#[test]
fn smd_block_deinterleave_reassembles_alternating_halves() {
    let block = (0..16u8).collect::<Vec<_>>();
    let deinterleaved = deinterleave_smd_block(&block);
    assert_eq!(
        deinterleaved,
        vec![0, 8, 1, 9, 2, 10, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15]
    );
}

#[test]
fn snes_deinterleave_leaves_images_with_fewer_than_two_banks_alone() {
    let payload = vec![7u8; SNES_BANK_SIZE as usize];
    assert_eq!(deinterleave_snes_payload(&payload), payload);

    let bank = SNES_BANK_SIZE as usize;
    let mut two_banks = vec![0u8; bank * 2];
    two_banks[..bank].fill(0xaa);
    two_banks[bank..].fill(0xbb);
    let swapped = deinterleave_snes_payload(&two_banks);
    assert_eq!(swapped[..bank], vec![0xbb; bank][..]);
    assert_eq!(swapped[bank..], vec![0xaa; bank][..]);
}

#[test]
fn snes_deinterleave_detection_reads_the_lo_and_hi_rom_headers() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 1);

    let small = sized_fixture(&temp, "small.sfc", 0x100);
    assert!(!snes_payload_needs_deinterleave(&small, &context).expect("small payload"));

    let lo = temp.child("lo.sfc");
    let mut bytes = vec![0u8; 0x8000];
    bytes[0x7fd5] = 0x21; // odd map-mode nibble marks an interleaved LoROM image
    bytes[0x7fdc..0x7fde].copy_from_slice(&0x1234u16.to_le_bytes());
    bytes[0x7fde..0x7fe0].copy_from_slice(&0xedcbu16.to_le_bytes());
    fs::write(&lo, &bytes).expect("lo fixture");
    assert!(snes_payload_needs_deinterleave(&lo, &context).expect("lo header"));

    bytes[0x7fd5] = 0x20;
    fs::write(&lo, &bytes).expect("even lo fixture");
    assert!(!snes_payload_needs_deinterleave(&lo, &context).expect("even lo header"));

    let hi = temp.child("hi.sfc");
    let mut hi_bytes = vec![0u8; 0x10000];
    hi_bytes[0xffd5] = 0x31;
    hi_bytes[0xffdc..0xffde].copy_from_slice(&0x1234u16.to_le_bytes());
    hi_bytes[0xffde..0xffe0].copy_from_slice(&0xedcbu16.to_le_bytes());
    fs::write(&hi, &hi_bytes).expect("hi fixture");
    assert!(!snes_payload_needs_deinterleave(&hi, &context).expect("hi header"));

    // A HiROM header whose checksum pair does not complement still reports no
    // deinterleave once the map-mode nibble is present.
    hi_bytes[0xffdc..0xffe0].fill(0);
    fs::write(&hi, &hi_bytes).expect("unchecksummed hi fixture");
    assert!(!snes_payload_needs_deinterleave(&hi, &context).expect("unchecksummed hi header"));
}

#[test]
fn unif_chunk_headers_stop_at_a_short_tail_and_reject_oversized_lengths() {
    let temp = TestDir::new();
    let short = temp.child("short-tail.unif");
    fs::write(&short, vec![0u8; 0x24]).expect("short fixture");
    let mut file = File::open(&short).expect("open short");
    assert!(
        read_unif_chunk_header(&mut file, 0x20, 0x24)
            .expect("short tail")
            .is_none()
    );

    let oversized = temp.child("oversized.unif");
    let mut bytes = b"UNIF".to_vec();
    bytes.resize(0x20, 0);
    push_unif_chunk(&mut bytes, b"PRG0", b"data");
    // Rewrite the chunk length so it claims more bytes than the file holds.
    let len_offset = 0x24;
    bytes[len_offset..len_offset + 4].copy_from_slice(&0xffffu32.to_le_bytes());
    fs::write(&oversized, &bytes).expect("oversized fixture");
    let mut file = File::open(&oversized).expect("open oversized");
    let file_len = bytes.len() as u64;
    let error = read_unif_chunk_header(&mut file, 0x20, file_len)
        .expect_err("an oversized chunk length should fail");
    assert!(
        error
            .to_string()
            .contains("chunk length exceeded file size"),
        "unexpected error: {error}"
    );
}

#[test]
fn unif_payload_chunk_ids_are_prg_and_chr_with_a_hex_suffix() {
    assert!(is_unif_payload_chunk(b"PRG0"));
    assert!(is_unif_payload_chunk(b"CHRA"));
    assert!(is_unif_payload_chunk(b"CHRF"));
    assert!(!is_unif_payload_chunk(b"PRGZ"));
    assert!(!is_unif_payload_chunk(b"NAME"));
}

#[test]
fn unif_normalization_and_reconstruction_require_a_full_container_header() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 1);
    let tiny = temp.child("tiny.unif");
    fs::write(&tiny, b"UNIF").expect("tiny fixture");
    let payload = temp.child("payload.bin");
    fs::write(&payload, b"").expect("payload fixture");

    let mut input = File::open(&tiny).expect("open tiny");
    let mut output = File::create(&payload).expect("create payload");
    let extract_error = copy_unif_payload_chunks(&mut input, &mut output, &context)
        .expect_err("a 4-byte UNIF file cannot be normalized");
    assert!(
        extract_error
            .to_string()
            .contains("UNIF normalization requires at least 0x20 bytes"),
        "unexpected error: {extract_error}"
    );

    let mut template = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&tiny)
        .expect("open template");
    let mut normalized = File::open(&payload).expect("open normalized");
    let rebuild_error = rebuild_unif_payload(&mut template, &mut normalized)
        .expect_err("a 4-byte UNIF template cannot be rebuilt");
    assert!(
        rebuild_error
            .to_string()
            .contains("UNIF reconstruction requires at least 0x20 bytes"),
        "unexpected error: {rebuild_error}"
    );
}

#[test]
fn unif_reconstruction_rejects_a_payload_larger_than_the_template() {
    let temp = TestDir::new();
    let template_path = temp.child("template.unif");
    let payload_path = temp.child("too-long.bin");
    fs::write(&template_path, unif_fixture(b"PPPP", b"CCCC")).expect("template");
    fs::write(&payload_path, b"PPPPCCCCEXTRA").expect("payload");

    let mut template = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&template_path)
        .expect("open template");
    let mut payload = File::open(&payload_path).expect("open payload");
    let error = rebuild_unif_payload(&mut template, &mut payload)
        .expect_err("an over-long payload should fail");
    assert!(
        error
            .to_string()
            .contains("exceeded template PRG/CHR capacity"),
        "unexpected error: {error}"
    );
}

#[test]
fn copy_exact_bytes_reports_an_input_that_ends_early() {
    let temp = TestDir::new();
    let source = temp.child("short-source.bin");
    let destination = temp.child("destination.bin");
    fs::write(&source, b"AB").expect("source");
    fs::write(&destination, b"").expect("destination");

    let mut input = File::open(&source).expect("open source");
    let mut output = OpenOptions::new()
        .write(true)
        .open(&destination)
        .expect("open destination");
    let error = copy_exact_bytes(&mut input, &mut output, 8, "probe")
        .expect_err("a short input should fail");
    assert!(
        error
            .to_string()
            .contains("probe ended unexpectedly while copying bytes"),
        "unexpected error: {error}"
    );
}

#[test]
fn range_validation_rejects_records_and_overflow_data_past_the_output() {
    let mut file = typed_rup_file(b"abcd", b"abcd", 0);
    file.records.push(RupRecord {
        offset: 3,
        xor: vec![1, 1, 1],
    });
    let error =
        validate_rup_ranges(&file, false, 4).expect_err("a record past the output should fail");
    assert!(
        error
            .to_string()
            .contains("record exceeded declared output size"),
        "unexpected error: {error}"
    );

    let mut append = typed_rup_file(b"abcd", b"abcd", 0);
    append.target_file_size = 8;
    append.overflow_mode = Some(RupOverflowMode::Append);
    append.overflow_data = vec![0xff; 6];
    let overflow_error = validate_rup_ranges(&append, false, 8)
        .expect_err("overflow data past the output should fail");
    assert!(
        overflow_error
            .to_string()
            .contains("overflow data exceeded declared output size"),
        "unexpected error: {overflow_error}"
    );
    // Applying the same patch in reverse never writes the append payload.
    validate_rup_ranges(&append, true, 4).expect("undo skips append overflow");

    let mut minify = typed_rup_file(b"abcd", b"abcd", 0);
    minify.target_file_size = 2;
    minify.overflow_mode = Some(RupOverflowMode::Minify);
    minify.overflow_data = vec![0xff; 2];
    validate_rup_ranges(&minify, true, 4).expect("undo restores the minified tail");
    validate_rup_ranges(&minify, false, 2).expect("forward skips minify overflow");
}

#[test]
fn prepared_record_tasks_report_out_of_range_indexes_and_oversized_records() {
    let temp = TestDir::new();
    let input_path = temp.child("prepared-input.bin");
    fs::write(&input_path, b"abcd").expect("input");
    let context = test_context_with_threads(&temp, 1);
    let mut file = typed_rup_file(b"abcd", b"abcd", 0);
    file.records.push(RupRecord {
        offset: 0,
        xor: vec![1, 1],
    });

    let tasks = build_rup_prepared_tasks(file.records.len());
    assert_eq!(tasks.len(), 1);

    let missing = prepare_rup_write_task(
        &RupPreparedTask { index: 9 },
        &file,
        &input_path,
        4,
        4,
        &context,
    )
    .expect_err("an out-of-range task index should fail");
    assert!(
        missing
            .to_string()
            .contains("record index was out of bounds"),
        "unexpected error: {missing}"
    );

    let oversized = prepare_rup_write_task(&tasks[0], &file, &input_path, 4, 1, &context)
        .expect_err("a record past the output should fail");
    assert!(
        oversized
            .to_string()
            .contains("record exceeded declared output size"),
        "unexpected error: {oversized}"
    );
}

#[test]
fn prepared_records_treat_bytes_past_the_input_as_zero() {
    let temp = TestDir::new();
    let input_path = temp.child("short-input.bin");
    fs::write(&input_path, b"ab").expect("input");
    let context = test_context_with_threads(&temp, 1);
    let mut file = typed_rup_file(b"ab", b"ab", 0);
    file.records.push(RupRecord {
        offset: 2,
        xor: vec![0x41, 0x42],
    });

    let prepared = prepare_rup_write_task(
        &RupPreparedTask { index: 0 },
        &file,
        &input_path,
        2,
        4,
        &context,
    )
    .expect("prepare");
    assert_eq!(prepared.index, 0);
    assert_eq!(prepared.bytes, b"AB");
}

#[test]
fn applying_prepared_records_reports_an_out_of_range_index() {
    let temp = TestDir::new();
    let output_path = temp.child("prepared-output.bin");
    fs::write(&output_path, b"abcd").expect("output");
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&output_path)
        .expect("open output");
    let file = typed_rup_file(b"abcd", b"abcd", 0);

    let error = apply_rup_prepared_records(
        &file,
        &[RupPreparedRecord {
            index: 4,
            bytes: vec![0],
        }],
        &mut output,
        &test_context_with_threads(&temp, 1),
    )
    .expect_err("an out-of-range prepared index should fail");
    assert!(
        error.to_string().contains("record index was out of bounds"),
        "unexpected error: {error}"
    );
}

#[test]
fn in_place_xor_rejects_oversized_records_and_zero_fills_past_the_input() {
    let temp = TestDir::new();
    let input_path = temp.child("in-place-input.bin");
    let output_path = temp.child("in-place-output.bin");
    fs::write(&input_path, b"ab").expect("input");
    fs::write(&output_path, b"ab\0\0").expect("output");
    let mut file = typed_rup_file(b"ab", b"ab", 0);
    file.records.push(RupRecord {
        offset: 2,
        xor: vec![0x41, 0x42],
    });

    let mut input = File::open(&input_path).expect("open input");
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&output_path)
        .expect("open output");
    let error = apply_xor_records_in_place(&file, 3, 2, &mut input, &mut output)
        .expect_err("a record past the output should fail");
    assert!(
        error
            .to_string()
            .contains("record exceeded declared output size"),
        "unexpected error: {error}"
    );

    apply_xor_records_in_place(&file, 4, 2, &mut input, &mut output).expect("in-place apply");
    output.flush().expect("flush");
    drop(output);
    assert_eq!(fs::read(&output_path).expect("output"), b"abAB");
}

#[test]
fn encoding_rejects_a_size_changing_file_without_an_overflow_mode() {
    let mut file = typed_rup_file(b"abcd", b"abcd", 0);
    file.target_file_size = 8;

    let error = encode_rup_patch(&RupMetadata::default(), &[file])
        .expect_err("a size change needs an overflow mode");
    assert!(
        error
            .to_string()
            .contains("overflow mode was missing for a size-changing patch"),
        "unexpected error: {error}"
    );
}

#[test]
fn in_memory_create_encodes_a_minify_overflow_for_a_shrinking_target() {
    let created = create_rup_patch_bytes(b"long-source-bytes", b"short").expect("patch");
    let parsed = parse_rup_bytes(&created.bytes).expect("parse");

    assert_eq!(parsed.files.len(), 1);
    assert_eq!(parsed.files[0].overflow_mode, Some(RupOverflowMode::Minify));
    assert_eq!(
        parsed.files[0].overflow_data,
        b"source-bytes"
            .iter()
            .map(|byte| byte ^ 0xff)
            .collect::<Vec<_>>()
    );
}

#[test]
fn parallel_create_encodes_both_overflow_directions() {
    let temp = TestDir::new();
    let smaller = temp.child("smaller.bin");
    let larger = temp.child("larger.bin");
    fs::write(&smaller, b"abcd").expect("smaller");
    fs::write(&larger, b"abcdEFGH").expect("larger");
    let context = test_context_with_threads(&temp, 4);
    let (_, pool) = context
        .build_pool(parallel_chunked_capability(8, 4 * 1024 * 1024))
        .expect("pool");

    let grown = create_rup_patch_parallel(&smaller, &larger, &pool).expect("append patch");
    let parsed = parse_rup_bytes(&grown.bytes).expect("parse append");
    assert_eq!(parsed.files[0].overflow_mode, Some(RupOverflowMode::Append));
    assert_eq!(
        parsed.files[0].overflow_data,
        b"EFGH".iter().map(|byte| byte ^ 0xff).collect::<Vec<_>>()
    );

    let shrunk = create_rup_patch_parallel(&larger, &smaller, &pool).expect("minify patch");
    let parsed = parse_rup_bytes(&shrunk.bytes).expect("parse minify");
    assert_eq!(parsed.files[0].overflow_mode, Some(RupOverflowMode::Minify));
    assert_eq!(
        parsed.files[0].overflow_data,
        b"EFGH".iter().map(|byte| byte ^ 0xff).collect::<Vec<_>>()
    );
}

#[test]
fn parallel_record_collection_is_empty_when_the_files_share_no_bytes() {
    let temp = TestDir::new();
    let empty = temp.child("empty.bin");
    let target = temp.child("target.bin");
    fs::write(&empty, b"").expect("empty");
    fs::write(&target, b"abcd").expect("target");
    let context = test_context_with_threads(&temp, 2);
    let (_, pool) = context
        .build_pool(parallel_chunked_capability(0, 4 * 1024 * 1024))
        .expect("pool");

    let records =
        collect_rup_records_parallel(&empty, 0, &target, 4, 0, &pool).expect("no shared bytes");
    assert!(records.is_empty());
}

#[test]
fn chunk_record_collection_pads_a_source_that_ends_inside_the_range() {
    let temp = TestDir::new();
    let source = temp.child("chunk-source.bin");
    let target = temp.child("chunk-target.bin");
    fs::write(&source, b"ab").expect("source");
    fs::write(&target, b"abcd").expect("target");

    let records = collect_rup_chunk_records(&source, 2, &target, 4, 0, 4).expect("chunk records");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].offset, 2);
    assert_eq!(records[0].xor, b"cd");
}

#[test]
fn xor_suffix_reads_the_complement_of_every_trailing_byte() {
    let temp = TestDir::new();
    let path = temp.child("suffix.bin");
    fs::write(&path, b"ABC").expect("fixture");

    assert_eq!(
        read_xor_suffix(&path, 1).expect("suffix"),
        vec![b'B' ^ 0xff, b'C' ^ 0xff]
    );
    assert!(read_xor_suffix(&path, 3).expect("empty suffix").is_empty());
}

#[test]
fn vlv_encoding_uses_one_length_byte_and_little_endian_digits() {
    let mut bytes = Vec::new();
    push_vlv(&mut bytes, 0).expect("zero");
    assert_eq!(bytes, vec![0]);

    bytes.clear();
    push_vlv(&mut bytes, 0x1234).expect("two bytes");
    assert_eq!(bytes, vec![2, 0x34, 0x12]);

    bytes.clear();
    push_vlv(&mut bytes, u64::MAX).expect("eight bytes");
    assert_eq!(bytes[0], 8);
    assert_eq!(&bytes[1..], &[0xff; 8]);
}

#[test]
fn fixed_strings_are_truncated_and_nul_padded_to_their_field_width() {
    let mut bytes = Vec::new();
    write_fixed_string(&mut bytes, "abc", 5);
    assert_eq!(bytes, b"abc\0\0");

    bytes.clear();
    write_fixed_string(&mut bytes, "abcdef", 3);
    assert_eq!(bytes, b"abc");
}

#[test]
fn md5_hex_formatting_maps_out_of_range_nibbles_to_zero() {
    let mut value = [0u8; 16];
    value[0] = 0x0f;
    value[15] = 0xa5;
    let hex = format_md5_hex(value);

    assert!(hex.starts_with("0f"));
    assert!(hex.ends_with("a5"));
    assert_eq!(nibble_to_hex(16), '0');
}
