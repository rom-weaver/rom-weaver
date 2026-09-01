use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use rom_weaver_core::{
    DEFAULT_BLOCK_CACHE_MAX_BLOCKS, DEFAULT_BLOCK_CACHE_SIZE_BYTES, PatchApplyRequest,
    PatchCreateRequest, PatchHandler, ProbeConfidence, RomWeaverError, SharedBlockCacheReader,
    UnsupportedOp,
};

use super::{
    HdiffCompression, HdiffPatchHandler, apply_hdiff13, apply_hdiffsf20,
    build_uncompressed_hdiff13_patch, write_var_u64,
};
use crate::{
    HDIFFPATCH,
    test_support::{TestDir, test_context_with_threads},
};

#[test]
fn create_is_reported_as_unsupported() {
    let temp = TestDir::new();
    let patch_path = temp.child("update.hdiff");
    let source_path = temp.child("source.bin");
    let target_path = temp.child("target.bin");
    fs::write(&source_path, b"source").expect("source");
    fs::write(&target_path, b"target").expect("target");

    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
    let report = handler
        .create(
            &PatchCreateRequest {
                original: source_path.clone(),
                modified: target_path.clone(),
                output: patch_path.clone(),
                format: "hdiffpatch".into(),
            },
            &test_context_with_threads(&temp, 4),
        )
        .expect("create report");

    assert_eq!(report.status, rom_weaver_core::OperationStatus::Unsupported);
    assert!(
        report.label.contains("patch creation is disabled"),
        "unexpected label: {}",
        report.label
    );
}

#[test]
fn parse_reports_hdiff13_details() {
    let temp = TestDir::new();
    let patch_path = temp.child("probe.hdiff");

    let patch = build_uncompressed_hdiff13_patch(b"old", b"newer bytes").expect("patch");
    fs::write(&patch_path, patch).expect("fixture");

    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");

    assert!(report.label.contains("HDIFF13"));
    assert!(report.label.contains("cover_count=0"));
}

#[test]
fn apply_rejects_source_size_mismatch() {
    let temp = TestDir::new();
    let patch = build_uncompressed_hdiff13_patch(b"old-size", b"patched").expect("patch");

    let patch_path = temp.child("mismatch.hdiff");
    let input_path = temp.child("input.bin");
    let output_path = temp.child("output.bin");

    fs::write(&patch_path, patch).expect("patch");
    fs::write(&input_path, b"tiny").expect("input");

    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("mismatch");

    assert!(error.to_string().contains("source size mismatch"));
}

#[test]
fn apply_hdiff13_zero_cover_round_trip() {
    let old = b"hello old world";
    let new = b"completely new bytes";
    let patch = build_uncompressed_hdiff13_patch(old, new).expect("patch");
    let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse");

    let super::ParsedPatchVariant::SingleFile13(header) = parsed.variant else {
        panic!("expected hdiff13");
    };

    let output = apply_hdiff13(old, &parsed.bytes, &header).expect("apply");
    assert_eq!(output, new);
}

fn build_zstd_hdiff13_patch(old: &[u8], new: &[u8]) -> Vec<u8> {
    let compressed = rom_weaver_core::codecs::encode_zstd(new, 3).expect("zstd encode");
    assert!(
        compressed.len() < new.len(),
        "fixture should be compressible"
    );

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF13&zstd");
    patch.push(0);

    write_var_u64(&mut patch, u64::try_from(new.len()).expect("new size"));
    write_var_u64(&mut patch, u64::try_from(old.len()).expect("old size"));
    write_var_u64(&mut patch, 0); // cover_count
    write_var_u64(&mut patch, 0); // cover_buf_size
    write_var_u64(&mut patch, 0); // compress_cover_buf_size
    write_var_u64(&mut patch, 0); // rle_ctrl_buf_size
    write_var_u64(&mut patch, 0); // compress_rle_ctrl_buf_size
    write_var_u64(&mut patch, 0); // rle_code_buf_size
    write_var_u64(&mut patch, 0); // compress_rle_code_buf_size
    write_var_u64(&mut patch, u64::try_from(new.len()).expect("new diff size"));
    write_var_u64(
        &mut patch,
        u64::try_from(compressed.len()).expect("compressed size"),
    );
    patch.extend_from_slice(&compressed);

    patch
}

fn build_identity_hdiff13_patch_with_cover_and_rle(source: &[u8]) -> Vec<u8> {
    let source_len = u64::try_from(source.len()).expect("source size");
    let mut cover = Vec::new();
    cover.push(0); // old sign=0, old_delta=0
    write_var_u64(&mut cover, 0); // copy_length
    write_var_u64(&mut cover, source_len); // cover_length

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF13&nocomp");
    patch.push(0);
    write_var_u64(&mut patch, source_len); // new_data_size
    write_var_u64(&mut patch, source_len); // old_data_size
    write_var_u64(&mut patch, 1); // cover_count
    write_var_u64(&mut patch, u64::try_from(cover.len()).expect("cover size"));
    write_var_u64(&mut patch, 0); // compress_cover_buf_size
    write_var_u64(&mut patch, 1); // rle_ctrl_buf_size
    write_var_u64(&mut patch, 0); // compress_rle_ctrl_buf_size
    write_var_u64(&mut patch, 1); // rle_code_buf_size
    write_var_u64(&mut patch, 0); // compress_rle_code_buf_size
    write_var_u64(&mut patch, 0); // new_data_diff_size
    write_var_u64(&mut patch, 0); // compress_new_data_diff_size
    patch.extend_from_slice(&cover);
    patch.push(0xC0); // rle_type=copy, length=1
    patch.push(0x00); // add 0, leaves byte unchanged
    patch
}

fn append_sf20_zero_delta_cover(out: &mut Vec<u8>, cover_len: usize) {
    out.push(0); // old sign=0, old_delta=0
    write_var_u64(out, 0); // new_gap
    write_var_u64(out, u64::try_from(cover_len).expect("cover len"));
}

fn build_hdiffsf20_nocomp_identity_two_steps(source: &[u8]) -> Vec<u8> {
    assert!(source.len() >= 2, "fixture requires at least two bytes");
    let split = source.len() / 2;
    let tail = source.len() - split;
    assert!(split > 0 && tail > 0, "fixture split invalid");

    let mut payload = Vec::new();

    let mut cover1 = Vec::new();
    append_sf20_zero_delta_cover(&mut cover1, split);
    let mut rle1 = Vec::new();
    write_var_u64(&mut rle1, u64::try_from(split).expect("split"));
    write_var_u64(
        &mut payload,
        u64::try_from(cover1.len()).expect("cover1 len"),
    );
    write_var_u64(&mut payload, u64::try_from(rle1.len()).expect("rle1 len"));
    payload.extend_from_slice(&cover1);
    payload.extend_from_slice(&rle1);

    let mut cover2 = Vec::new();
    append_sf20_zero_delta_cover(&mut cover2, tail);
    let mut rle2 = Vec::new();
    write_var_u64(&mut rle2, u64::try_from(tail).expect("tail"));
    write_var_u64(
        &mut payload,
        u64::try_from(cover2.len()).expect("cover2 len"),
    );
    write_var_u64(&mut payload, u64::try_from(rle2.len()).expect("rle2 len"));
    payload.extend_from_slice(&cover2);
    payload.extend_from_slice(&rle2);

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFFSF20&nocomp");
    patch.push(0);
    write_var_u64(&mut patch, u64::try_from(source.len()).expect("new size"));
    write_var_u64(&mut patch, u64::try_from(source.len()).expect("old size"));
    write_var_u64(&mut patch, 2); // cover_count
    write_var_u64(&mut patch, 256); // step_mem_size
    write_var_u64(
        &mut patch,
        u64::try_from(payload.len()).expect("payload size"),
    );
    write_var_u64(&mut patch, 0); // compressed_size
    patch.extend_from_slice(&payload);
    patch
}

fn build_hdiffsf20_nocomp_identity_single_step_two_covers(source: &[u8]) -> Vec<u8> {
    assert!(source.len() >= 2, "fixture requires at least two bytes");
    let split = source.len() / 2;
    let tail = source.len() - split;
    assert!(split > 0 && tail > 0, "fixture split invalid");

    let mut cover = Vec::new();
    append_sf20_zero_delta_cover(&mut cover, split);
    append_sf20_zero_delta_cover(&mut cover, tail);

    let mut rle = Vec::new();
    write_var_u64(&mut rle, u64::try_from(split).expect("split"));
    write_var_u64(&mut rle, 0); // len_value for the second cover transition
    write_var_u64(&mut rle, u64::try_from(tail).expect("tail"));

    let mut payload = Vec::new();
    write_var_u64(&mut payload, u64::try_from(cover.len()).expect("cover len"));
    write_var_u64(&mut payload, u64::try_from(rle.len()).expect("rle len"));
    payload.extend_from_slice(&cover);
    payload.extend_from_slice(&rle);

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFFSF20&nocomp");
    patch.push(0);
    write_var_u64(&mut patch, u64::try_from(source.len()).expect("new size"));
    write_var_u64(&mut patch, u64::try_from(source.len()).expect("old size"));
    write_var_u64(&mut patch, 2); // cover_count
    write_var_u64(&mut patch, 256); // step_mem_size
    write_var_u64(
        &mut patch,
        u64::try_from(payload.len()).expect("payload size"),
    );
    write_var_u64(&mut patch, 0); // compressed_size
    patch.extend_from_slice(&payload);
    patch
}

#[test]
fn apply_hdiff13_zstd_zero_cover_round_trip() {
    let old = b"01234567890123456789";
    let new = b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let patch = build_zstd_hdiff13_patch(old, new);
    let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse");

    let super::ParsedPatchVariant::SingleFile13(header) = parsed.variant else {
        panic!("expected hdiff13");
    };
    assert_eq!(header.compression.as_str(), "zstd");

    let output = apply_hdiff13(old, &parsed.bytes, &header).expect("apply");
    assert_eq!(output, new);
}

#[test]
fn apply_reports_parallel_execution_for_multi_chunk_hdiff13() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("patch.hdiff");
    let output_path = temp.child("output.bin");

    let source = vec![0x5au8; 1024];
    let patch = build_identity_hdiff13_patch_with_cover_and_rle(&source);
    fs::write(&input_path, &source).expect("source");
    fs::write(&patch_path, patch).expect("patch");

    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");

    let execution = report.thread_execution.expect("thread execution");
    assert!(execution.used_parallelism);
    assert!(execution.effective_threads > 1);
    assert_eq!(fs::read(output_path).expect("output"), source);
}

#[test]
fn apply_reports_single_thread_execution_when_only_one_chunk_is_present() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("patch.hdiff");
    let output_path = temp.child("output.bin");

    let source = b"input bytes".to_vec();
    let output = b"replacement bytes".to_vec();
    let patch = build_uncompressed_hdiff13_patch(&source, &output).expect("patch");
    fs::write(&input_path, &source).expect("source");
    fs::write(&patch_path, patch).expect("patch");

    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");

    let execution = report.thread_execution.expect("thread execution");
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
    assert_eq!(fs::read(output_path).expect("output"), output);
}

#[test]
fn apply_hdiffsf20_reports_parallel_execution_for_multi_step_patch() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("patch.hpatchz");
    let output_path = temp.child("output.bin");
    let source = vec![0x5au8; 1024];
    fs::write(&input_path, &source).expect("source");
    fs::write(
        &patch_path,
        build_hdiffsf20_nocomp_identity_two_steps(&source),
    )
    .expect("patch");

    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");

    let execution = report.thread_execution.expect("thread execution");
    assert!(execution.used_parallelism);
    assert!(execution.effective_threads > 1);
    assert_eq!(fs::read(output_path).expect("output"), source);
}

#[test]
fn apply_hdiffsf20_reports_parallel_fallback_for_single_step_patch() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("patch.hpatchz");
    let output_path = temp.child("output.bin");
    let source = vec![0x33u8; 1024];
    fs::write(&input_path, &source).expect("source");
    fs::write(
        &patch_path,
        build_hdiffsf20_nocomp_identity_single_step_two_covers(&source),
    )
    .expect("patch");

    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
    let report = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path.clone(),
            },
            &test_context_with_threads(&temp, 8),
        )
        .expect("apply");

    let execution = report.thread_execution.expect("thread execution");
    assert!(!execution.used_parallelism);
    assert!(execution.thread_fallback);
    assert!(
        execution
            .thread_fallback_reason
            .as_deref()
            .unwrap_or_default()
            .contains("no independent step-level parallel work")
    );
    assert_eq!(execution.effective_threads, 1);
    assert_eq!(fs::read(output_path).expect("output"), source);
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("hdiffpatch")
        .join(name)
}

#[test]
fn apply_upstream_hdiff13_codec_fixtures() {
    let source = fs::read(fixture_path("source.bin")).expect("source fixture");
    let expected = fs::read(fixture_path("target.bin")).expect("target fixture");
    let fixtures = [
        ("upstream-hdiff13-zstd.hdiff", "zstd"),
        ("upstream-hdiff13-zlib.hdiff", "zlib"),
        ("upstream-hdiff13-bz2.hdiff", "bz2"),
        ("upstream-hdiff13-lzma.hdiff", "lzma"),
        ("upstream-hdiff13-lzma2.hdiff", "lzma2"),
    ];

    for (fixture, compression) in fixtures {
        let patch = fs::read(fixture_path(fixture)).expect("patch fixture");
        let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse fixture");
        let super::ParsedPatchVariant::SingleFile13(header) = parsed.variant else {
            panic!("expected HDIFF13 variant for {fixture}");
        };

        assert_eq!(header.compression.as_str(), compression);
        let output = apply_hdiff13(&source, &parsed.bytes, &header)
            .unwrap_or_else(|error| panic!("failed to apply {fixture}: {error}"));
        assert_eq!(output, expected, "unexpected output for {fixture}");
    }
}

#[test]
fn apply_upstream_hdiffsf20_zstd_fixture() {
    let source = fs::read(fixture_path("source.bin")).expect("source fixture");
    let expected = fs::read(fixture_path("target.bin")).expect("target fixture");
    let patch = fs::read(fixture_path("upstream-hdiffsf20-zstd.hpatchz")).expect("fixture");
    let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse fixture");

    let super::ParsedPatchVariant::SingleStream20(header) = parsed.variant else {
        panic!("expected HDIFFSF20 variant");
    };
    assert_eq!(header.compression.as_str(), "zstd");

    let output = apply_hdiffsf20(&source, &parsed.bytes, &header).expect("apply");
    assert_eq!(output, expected);
}

#[test]
fn capabilities_mark_threaded_output_with_create_disabled() {
    let capabilities = HdiffPatchHandler::new(&HDIFFPATCH).capabilities();
    assert!(capabilities.parse);
    assert!(capabilities.apply);
    assert!(!capabilities.create);
    assert!(!capabilities.threaded_scan);
    assert!(!capabilities.threaded_diff);
    assert!(capabilities.threaded_output);
}

fn bzip2_encode(payload: &[u8]) -> Vec<u8> {
    use std::io::Write;

    use bzip2::{Compression, write::BzEncoder};

    let mut encoder = BzEncoder::new(Vec::new(), Compression::new(9));
    encoder.write_all(payload).expect("bzip2 write");
    encoder.finish().expect("bzip2 finish")
}

fn build_bz2_hdiff13_patch(old: &[u8], new: &[u8]) -> Vec<u8> {
    let compressed = bzip2_encode(new);

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF13&bz2");
    patch.push(0);

    write_var_u64(&mut patch, u64::try_from(new.len()).expect("new size"));
    write_var_u64(&mut patch, u64::try_from(old.len()).expect("old size"));
    write_var_u64(&mut patch, 0); // cover_count
    write_var_u64(&mut patch, 0); // cover_buf_size
    write_var_u64(&mut patch, 0); // compress_cover_buf_size
    write_var_u64(&mut patch, 0); // rle_ctrl_buf_size
    write_var_u64(&mut patch, 0); // compress_rle_ctrl_buf_size
    write_var_u64(&mut patch, 0); // rle_code_buf_size
    write_var_u64(&mut patch, 0); // compress_rle_code_buf_size
    write_var_u64(&mut patch, u64::try_from(new.len()).expect("new diff size"));
    write_var_u64(
        &mut patch,
        u64::try_from(compressed.len()).expect("compressed size"),
    );
    patch.extend_from_slice(&compressed);
    patch
}

#[test]
fn apply_hdiff13_bz2_zero_cover_round_trip() {
    let old = b"01234567890123456789";
    let new = b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    let patch = build_bz2_hdiff13_patch(old, new);
    let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse");

    let super::ParsedPatchVariant::SingleFile13(header) = parsed.variant else {
        panic!("expected hdiff13");
    };
    assert_eq!(header.compression.as_str(), "bz2");

    let output = apply_hdiff13(old, &parsed.bytes, &header).expect("apply");
    assert_eq!(output, new);
}

fn build_hdiff13_single_cover_with_rle(
    old_len: usize,
    new_len: usize,
    cover_length: u64,
    rle_ctrl: &[u8],
    rle_code: &[u8],
) -> Vec<u8> {
    let mut cover = Vec::new();
    cover.push(0); // old sign=0, old_delta=0
    write_var_u64(&mut cover, 0); // copy_length
    write_var_u64(&mut cover, cover_length); // cover_length

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF13&nocomp");
    patch.push(0);
    write_var_u64(&mut patch, u64::try_from(new_len).expect("new size"));
    write_var_u64(&mut patch, u64::try_from(old_len).expect("old size"));
    write_var_u64(&mut patch, 1); // cover_count
    write_var_u64(&mut patch, u64::try_from(cover.len()).expect("cover size"));
    write_var_u64(&mut patch, 0); // compress_cover_buf_size
    write_var_u64(
        &mut patch,
        u64::try_from(rle_ctrl.len()).expect("rle ctrl size"),
    );
    write_var_u64(&mut patch, 0); // compress_rle_ctrl_buf_size
    write_var_u64(
        &mut patch,
        u64::try_from(rle_code.len()).expect("rle code size"),
    );
    write_var_u64(&mut patch, 0); // compress_rle_code_buf_size
    write_var_u64(&mut patch, 0); // new_data_diff_size
    write_var_u64(&mut patch, 0); // compress_new_data_diff_size
    patch.extend_from_slice(&cover);
    patch.extend_from_slice(rle_ctrl);
    patch.extend_from_slice(rle_code);
    patch
}

#[test]
fn apply_hdiff13_rle_explicit_set_value_adds_constant_to_cover() {
    // rle ctrl byte 0x83 => rle_type=2 (set from rle_code), length=4; rle_code
    // delta of 1 is added to every covered byte.
    let old = b"ABCD";
    let patch = build_hdiff13_single_cover_with_rle(
        old.len(),
        old.len(),
        u64::try_from(old.len()).expect("cover length"),
        &[0x83],
        &[1],
    );
    let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse");

    let super::ParsedPatchVariant::SingleFile13(header) = parsed.variant else {
        panic!("expected hdiff13");
    };

    let output = apply_hdiff13(old, &parsed.bytes, &header).expect("apply");
    assert_eq!(output, b"BCDE");
}

#[test]
fn apply_hdiff13_rle_implicit_set_value_wraps_cover_bytes() {
    // rle ctrl byte 0x43 => rle_type=1 (implicit set_value = 0u8.wrapping_sub(1)
    // = 255), length=4; adding 255 wrapping subtracts one from every byte. No
    // rle_code is consumed for the implicit-value path.
    let old = b"BCDE";
    let patch = build_hdiff13_single_cover_with_rle(
        old.len(),
        old.len(),
        u64::try_from(old.len()).expect("cover length"),
        &[0x43],
        &[],
    );
    let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse");

    let super::ParsedPatchVariant::SingleFile13(header) = parsed.variant else {
        panic!("expected hdiff13");
    };

    let output = apply_hdiff13(old, &parsed.bytes, &header).expect("apply");
    assert_eq!(output, b"ABCD");
}

fn build_hdiffsf20_single_cover_value_rle(source: &[u8], deltas: &[u8]) -> Vec<u8> {
    assert_eq!(
        source.len(),
        deltas.len(),
        "value-phase fixture needs one delta per source byte"
    );
    let cover_len = source.len();

    let mut cover = Vec::new();
    append_sf20_zero_delta_cover(&mut cover, cover_len);

    let mut rle = Vec::new();
    write_var_u64(&mut rle, 0); // len_zero: no verbatim bytes
    write_var_u64(&mut rle, u64::try_from(cover_len).expect("len_value")); // len_value
    rle.extend_from_slice(deltas);

    let mut payload = Vec::new();
    write_var_u64(&mut payload, u64::try_from(cover.len()).expect("cover len"));
    write_var_u64(&mut payload, u64::try_from(rle.len()).expect("rle len"));
    payload.extend_from_slice(&cover);
    payload.extend_from_slice(&rle);

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFFSF20&nocomp");
    patch.push(0);
    write_var_u64(&mut patch, u64::try_from(source.len()).expect("new size"));
    write_var_u64(&mut patch, u64::try_from(source.len()).expect("old size"));
    write_var_u64(&mut patch, 1); // cover_count
    write_var_u64(&mut patch, 256); // step_mem_size
    write_var_u64(
        &mut patch,
        u64::try_from(payload.len()).expect("payload size"),
    );
    write_var_u64(&mut patch, 0); // compressed_size
    patch.extend_from_slice(&payload);
    patch
}

#[test]
fn apply_hdiffsf20_value_phase_rle_from_temp_file() {
    let temp = TestDir::new();
    let input_path = temp.child("source.bin");
    let patch_path = temp.child("patch.hpatchz");
    let output_path = temp.child("output.bin");

    let source = vec![0x10u8, 0x20, 0x30, 0x40];
    let deltas = [1u8, 2, 3, 4];
    let expected = vec![0x11u8, 0x22, 0x33, 0x44];

    fs::write(&input_path, &source).expect("source");
    fs::write(
        &patch_path,
        build_hdiffsf20_single_cover_value_rle(&source, &deltas),
    )
    .expect("patch");

    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
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

    assert!(report.label.contains("applied"), "label: {}", report.label);
    assert_eq!(fs::read(output_path).expect("output"), expected);
}

#[test]
fn probe_reports_extension_confidence() {
    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
    assert_eq!(
        handler.probe(Path::new("update.hdiff")),
        ProbeConfidence::Extension
    );
}

#[test]
fn compression_names_map_to_canonical_labels() {
    for (text, expected, label) in [
        ("", HdiffCompression::NoComp, "nocomp"),
        ("nocomp", HdiffCompression::NoComp, "nocomp"),
        ("zstd", HdiffCompression::Zstd, "zstd"),
        (" zlib ", HdiffCompression::Zlib, "zlib"),
        ("bz2", HdiffCompression::Bz2, "bz2"),
        ("pbz2", HdiffCompression::Bz2, "bz2"),
        ("lzma", HdiffCompression::Lzma, "lzma"),
        ("LZMA2", HdiffCompression::Lzma2, "lzma2"),
    ] {
        let parsed = HdiffCompression::parse(text).expect("compression");
        assert_eq!(parsed, expected, "{text}");
        assert_eq!(parsed.as_str(), label, "{text}");
    }
}

#[test]
fn compression_parser_rejects_unknown_names() {
    let error = HdiffCompression::parse("brotli").expect_err("unknown compression");
    let message = error.to_string();
    assert!(
        message.contains("HDIFF_COMPRESSION_UNRECOGNIZED"),
        "{message}"
    );
    assert!(message.contains("compression=brotli"), "{message}");
}

#[test]
fn slice_reads_report_the_end_of_the_buffer() {
    let mut index = 0usize;
    let error = super::read_u8_slice(&[], &mut index, "probe").expect_err("end of buffer");
    let message = error.to_string();
    assert!(message.contains("HDIFF_READ_UNEXPECTED_EOF"), "{message}");
    assert!(message.contains("label=probe"), "{message}");
}

#[test]
fn slice_varints_decode_multi_byte_values() {
    let mut encoded = Vec::new();
    write_var_u64(&mut encoded, 300);
    assert!(encoded.len() > 1, "fixture must need a continuation byte");

    let mut index = 0usize;
    assert_eq!(
        super::read_var_u64(&encoded, &mut index, "probe").expect("varint"),
        300
    );
    assert_eq!(index, encoded.len());
}

#[test]
fn tagged_slice_varints_reject_tag_widths_over_six_bits() {
    let mut index = 0usize;
    let error =
        super::read_var_u64_tagged_slice(&[0], &mut index, 7, 0, "probe").expect_err("tag bits");
    assert!(
        error
            .to_string()
            .contains("HDiffPatch varint tag_bits must be <= 6")
    );
}

#[test]
fn add_usize_u64_reports_an_addition_overflow() {
    assert_eq!(super::add_usize_u64(4, 6, "probe").expect("sum"), 10);
    let error = super::add_usize_u64(usize::MAX, 1, "probe").expect_err("overflow");
    assert!(error.to_string().contains("HDIFF_USIZE_ADD_OVERFLOW"));
}

#[test]
fn null_terminated_header_reads_report_bad_shapes() {
    assert_eq!(
        super::read_null_terminated_string(b"HDIFF13&nocomp\0rest", 1024).expect("header"),
        ("HDIFF13&nocomp".to_string(), 15)
    );
    assert!(
        super::read_null_terminated_string(b"no terminator", 1024)
            .expect_err("missing terminator")
            .to_string()
            .contains("HDiffPatch header was missing null terminator")
    );
    assert!(
        super::read_null_terminated_string(&[0xFF, 0xFE, 0x00], 1024)
            .expect_err("non utf8")
            .to_string()
            .contains("HDiffPatch header contained non-UTF8 bytes")
    );
}

#[test]
fn bool_bytes_read_any_non_zero_value_as_true() {
    let mut index = 0usize;
    assert!(!super::read_bool_byte(&[0, 2], &mut index, "probe").expect("false"));
    assert!(super::read_bool_byte(&[0, 2], &mut index, "probe").expect("true"));
    assert_eq!(index, 2);
}

#[test]
fn rle_varints_decode_multi_byte_lengths() {
    let mut index = 0usize;
    assert_eq!(
        super::read_rle_varint(&[0x82, 0x2C], &mut index, "probe").expect("varint"),
        300
    );
    assert_eq!(index, 2);
}

#[test]
fn append_from_new_diff_reports_a_source_that_ends_early() {
    let mut output = Vec::new();
    let mut index = 0usize;
    let error = super::append_from_new_diff(&mut output, b"ab", &mut index, 4, "probe")
        .expect_err("source ends early");
    let message = error.to_string();
    assert!(
        message.contains("HDIFF_NEW_DIFF_UNEXPECTED_EOF"),
        "{message}"
    );
    assert!(message.contains("source_len=2"), "{message}");
}

#[test]
fn file_parser_reports_the_end_of_the_patch() {
    let mut parser = super::HdiffFileParser::new(b"".as_slice(), 0);
    let error = parser.read_u8("probe").expect_err("end of patch");
    assert!(error.to_string().contains("HDIFF_READ_UNEXPECTED_EOF"));
}

#[test]
fn file_parser_rejects_tag_widths_over_six_bits() {
    let mut parser = super::HdiffFileParser::new([0u8; 4].as_slice(), 4);
    let error = parser
        .read_var_u64_tagged(7, 0, "probe")
        .expect_err("tag bits");
    assert!(
        error
            .to_string()
            .contains("HDiffPatch varint tag_bits must be <= 6")
    );
}

#[test]
fn file_parser_decodes_multi_byte_varints_and_bools() {
    let mut encoded = Vec::new();
    write_var_u64(&mut encoded, 300);
    encoded.push(1);
    let len = encoded.len() as u64;

    let mut parser = super::HdiffFileParser::new(encoded.as_slice(), len);
    assert_eq!(parser.read_var_u64("probe").expect("varint"), 300);
    assert!(parser.read_bool("flag").expect("bool"));
}

#[test]
fn file_parser_rejects_headers_longer_than_the_scan_limit() {
    let mut parser = super::HdiffFileParser::new(b"ABCD".as_slice(), 4);
    let error = parser
        .read_null_terminated_string(4)
        .expect_err("no terminator within the limit");
    assert!(
        error
            .to_string()
            .contains("HDiffPatch header was missing null terminator")
    );
}

#[test]
fn file_parser_rejects_non_utf8_headers() {
    let mut parser = super::HdiffFileParser::new([0xFFu8, 0x00].as_slice(), 2);
    let error = parser
        .read_null_terminated_string(1024)
        .expect_err("non utf8 header");
    assert!(
        error
            .to_string()
            .contains("HDiffPatch header contained non-UTF8 bytes")
    );
}

#[test]
fn in_memory_old_data_reports_ranges_past_its_end() {
    let old = super::HdiffOldData::Bytes(b"abcd".to_vec());
    assert_eq!(old.len(), 4);
    assert_eq!(old.read_range(1, 2).expect("range"), b"bc");
    assert!(
        old.read_range(3, 4)
            .expect_err("past end")
            .to_string()
            .contains("HDiffPatch source range exceeded bounds")
    );
    assert!(
        old.read_range(usize::MAX, 2)
            .expect_err("overflow")
            .to_string()
            .contains("HDiffPatch source range overflowed")
    );
}

#[test]
fn cached_old_data_reports_ranges_past_its_end() {
    let temp = TestDir::new();
    let old_path = temp.child("old.bin");
    fs::write(&old_path, b"abcd").expect("fixture");

    let old = super::HdiffOldData::from_path(&old_path).expect("old data");
    assert_eq!(old.len(), 4);
    assert_eq!(old.read_range(1, 2).expect("range"), b"bc");
    assert!(
        old.read_range(3, 4)
            .expect_err("past end")
            .to_string()
            .contains("HDiffPatch source range exceeded bounds")
    );
    assert!(
        old.read_range(usize::MAX, 2)
            .expect_err("overflow")
            .to_string()
            .contains("HDiffPatch source range overflowed")
    );
}

fn build_hdiff19_patch(
    is_input_dir: u8,
    is_output_dir: u8,
    input_sum_size: u64,
    output_sum_size: u64,
) -> Vec<u8> {
    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF19&nocomp");
    patch.push(0);
    patch.push(is_input_dir);
    patch.push(is_output_dir);
    write_var_u64(&mut patch, 2); // input_dir_count
    write_var_u64(&mut patch, input_sum_size);
    write_var_u64(&mut patch, 3); // output_dir_count
    write_var_u64(&mut patch, output_sum_size);
    patch
}

fn build_hdiffsf20_header(
    new_data_size: u64,
    old_data_size: u64,
    cover_count: u64,
    payload: &[u8],
) -> Vec<u8> {
    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFFSF20&nocomp");
    patch.push(0);
    write_var_u64(&mut patch, new_data_size);
    write_var_u64(&mut patch, old_data_size);
    write_var_u64(&mut patch, cover_count);
    write_var_u64(&mut patch, 256); // step_mem_size
    write_var_u64(&mut patch, payload.len() as u64);
    write_var_u64(&mut patch, 0); // compressed_size
    patch.extend_from_slice(payload);
    patch
}

/// An HDIFF13 patch whose four `nocomp` chunks are written verbatim, so a test
/// can pair deliberately inconsistent header sizes with real chunk bytes.
struct Hdiff13Parts<'a> {
    new_data_size: u64,
    old_data_size: u64,
    cover_count: u64,
    cover: &'a [u8],
    rle_ctrl: &'a [u8],
    rle_code: &'a [u8],
    new_diff: &'a [u8],
}

fn build_hdiff13_parts(parts: &Hdiff13Parts<'_>) -> Vec<u8> {
    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF13&nocomp");
    patch.push(0);
    write_var_u64(&mut patch, parts.new_data_size);
    write_var_u64(&mut patch, parts.old_data_size);
    write_var_u64(&mut patch, parts.cover_count);
    write_var_u64(&mut patch, parts.cover.len() as u64);
    write_var_u64(&mut patch, 0);
    write_var_u64(&mut patch, parts.rle_ctrl.len() as u64);
    write_var_u64(&mut patch, 0);
    write_var_u64(&mut patch, parts.rle_code.len() as u64);
    write_var_u64(&mut patch, 0);
    write_var_u64(&mut patch, parts.new_diff.len() as u64);
    write_var_u64(&mut patch, 0);
    patch.extend_from_slice(parts.cover);
    patch.extend_from_slice(parts.rle_ctrl);
    patch.extend_from_slice(parts.rle_code);
    patch.extend_from_slice(parts.new_diff);
    patch
}

fn parsed_hdiff13(patch: Vec<u8>) -> (Vec<u8>, super::ParsedHdiff13) {
    let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse");
    let super::ParsedPatchVariant::SingleFile13(header) = parsed.variant else {
        panic!("expected an HDIFF13 patch");
    };
    (parsed.bytes, header)
}

/// A single stored (uncompressed) DEFLATE block. The crate exposes no deflate
/// encoder, and a stored block is the smallest stream a test can write by hand.
fn stored_deflate_block(payload: &[u8]) -> Vec<u8> {
    let len = u16::try_from(payload.len()).expect("stored block length");
    let mut block = vec![0x01];
    block.extend_from_slice(&len.to_le_bytes());
    block.extend_from_slice(&(!len).to_le_bytes());
    block.extend_from_slice(payload);
    block
}

fn zlib_stream(payload: &[u8]) -> Vec<u8> {
    let mut stream = vec![0x78, 0x01];
    stream.extend_from_slice(&stored_deflate_block(payload));
    let mut low = 1u32;
    let mut high = 0u32;
    for byte in payload {
        low = (low + u32::from(*byte)) % 65521;
        high = (high + low) % 65521;
    }
    stream.extend_from_slice(&((high << 16) | low).to_be_bytes());
    stream
}

#[test]
fn parse_rejects_headers_without_a_compression_field() {
    let temp = TestDir::new();
    let patch_path = temp.child("incomplete.hdiff");
    let mut bytes = b"HDIFF13".to_vec();
    bytes.push(0);
    fs::write(&patch_path, &bytes).expect("fixture");

    assert!(
        super::parse_hdiff_patch_view(&bytes)
            .expect_err("incomplete header")
            .to_string()
            .contains("HDiffPatch header is incomplete")
    );
    assert!(
        super::parse_hdiff_patch_file(&patch_path)
            .expect_err("incomplete header")
            .to_string()
            .contains("HDiffPatch header is incomplete")
    );
}

#[test]
fn parse_rejects_an_unsupported_magic() {
    let temp = TestDir::new();
    let patch_path = temp.child("magic.hdiff");
    let mut bytes = b"HDIFF99&nocomp".to_vec();
    bytes.push(0);
    fs::write(&patch_path, &bytes).expect("fixture");

    for error in [
        super::parse_hdiff_patch_view(&bytes).expect_err("unsupported magic"),
        super::parse_hdiff_patch_file(&patch_path).expect_err("unsupported magic"),
    ] {
        let message = error.to_string();
        assert!(message.contains("HDIFF_MAGIC_UNSUPPORTED"), "{message}");
        assert!(message.contains("magic=HDIFF99"), "{message}");
    }
}

#[test]
fn parse_reads_hdiff19_directory_headers() {
    let bytes = build_hdiff19_patch(1, 1, 128, 256);
    let super::ParsedPatchVariant::Directory19(header) =
        super::parse_hdiff_patch_view(&bytes).expect("parse")
    else {
        panic!("expected an HDIFF19 patch");
    };
    assert_eq!(header.old_data_size, 128);
    assert_eq!(header.new_data_size, 256);
    assert_eq!(header.compression.as_str(), "nocomp");
}

#[test]
fn parse_rejects_hdiff19_patches_that_are_not_directory_to_directory() {
    let temp = TestDir::new();
    let patch_path = temp.child("flat.hdiff");
    let bytes = build_hdiff19_patch(1, 0, 128, 256);
    fs::write(&patch_path, &bytes).expect("fixture");

    for error in [
        super::parse_hdiff_patch_view(&bytes).expect_err("non-directory"),
        super::parse_hdiff_patch_file(&patch_path).expect_err("non-directory"),
    ] {
        assert!(
            error
                .to_string()
                .contains("HDIFF19 patch flagged non-directory I/O unexpectedly")
        );
    }
}

#[test]
fn parse_reports_hdiff19_directory_details() {
    let temp = TestDir::new();
    let patch_path = temp.child("dir.hdiff");
    fs::write(&patch_path, build_hdiff19_patch(1, 1, 128, 256)).expect("fixture");

    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");
    assert!(report.label.contains("HDIFF19"), "{}", report.label);
    assert!(
        report.label.contains("directory patch; apply unsupported"),
        "{}",
        report.label
    );
}

#[test]
fn parse_reports_hdiffsf20_details() {
    let temp = TestDir::new();
    let patch_path = temp.child("sf20.hdiff");
    let source = b"single stream fixture";
    fs::write(
        &patch_path,
        build_hdiffsf20_nocomp_identity_two_steps(source),
    )
    .expect("fixture");

    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
    let report = handler
        .parse(&patch_path, &test_context_with_threads(&temp, 1))
        .expect("parse");
    assert!(report.label.contains("HDIFFSF20"), "{}", report.label);
    assert!(report.label.contains("cover_count=2"), "{}", report.label);
}

#[test]
fn apply_rejects_directory_patches() {
    let temp = TestDir::new();
    let patch_path = temp.child("dir.hdiff");
    let input_path = temp.child("input.bin");
    let output_path = temp.child("output.bin");
    fs::write(&patch_path, build_hdiff19_patch(1, 1, 4, 4)).expect("patch");
    fs::write(&input_path, b"abcd").expect("input");

    let handler = HdiffPatchHandler::new(&HDIFFPATCH);
    let error = handler
        .apply(
            &PatchApplyRequest {
                input: input_path,
                patches: vec![patch_path],
                output: output_path,
            },
            &test_context_with_threads(&temp, 1),
        )
        .expect_err("directory patch");
    assert!(
        matches!(
            error,
            RomWeaverError::Unsupported(UnsupportedOp::HdiffDirectoryPatch)
        ),
        "{error}"
    );
}

#[test]
fn parse_file_reports_a_patch_that_ends_inside_the_header() {
    let temp = TestDir::new();
    let patch_path = temp.child("truncated.hdiff");
    let mut bytes = b"HDIFF13&nocomp".to_vec();
    bytes.push(0);
    write_var_u64(&mut bytes, 16);
    fs::write(&patch_path, bytes).expect("fixture");

    let error = super::parse_hdiff_patch_file(&patch_path).expect_err("truncated header");
    assert!(error.to_string().contains("HDIFF_READ_UNEXPECTED_EOF"));
}

#[test]
fn hdiff13_apply_rejects_a_source_whose_size_differs_from_the_header() {
    let (bytes, header) = parsed_hdiff13(build_hdiff13_parts(&Hdiff13Parts {
        new_data_size: 4,
        old_data_size: 8,
        cover_count: 0,
        cover: &[],
        rle_ctrl: &[],
        rle_code: &[],
        new_diff: b"ABCD",
    }));

    let error = apply_hdiff13(b"ab", &bytes, &header).expect_err("source size mismatch");
    let message = error.to_string();
    assert!(message.contains("HDIFF_SOURCE_SIZE_MISMATCH"), "{message}");
    assert!(message.contains("expected=8"), "{message}");
    assert!(message.contains("actual=2"), "{message}");
}

#[test]
fn hdiff13_apply_rejects_an_output_size_that_cannot_be_allocated() {
    let (bytes, header) = parsed_hdiff13(build_hdiff13_parts(&Hdiff13Parts {
        new_data_size: u64::MAX,
        old_data_size: 2,
        cover_count: 0,
        cover: &[],
        rle_ctrl: &[],
        rle_code: &[],
        new_diff: &[],
    }));

    let error = apply_hdiff13(b"ab", &bytes, &header).expect_err("unallocatable output");
    assert!(
        error.to_string().contains("exceeds allocatable memory"),
        "{error}"
    );
}

#[test]
fn hdiff13_apply_rejects_a_cover_that_moves_before_the_start_of_the_source() {
    let mut cover = vec![0x81u8];
    write_var_u64(&mut cover, 0);
    write_var_u64(&mut cover, 1);
    let (bytes, header) = parsed_hdiff13(build_hdiff13_parts(&Hdiff13Parts {
        new_data_size: 1,
        old_data_size: 4,
        cover_count: 1,
        cover: &cover,
        rle_ctrl: &[],
        rle_code: &[],
        new_diff: &[],
    }));

    let error = apply_hdiff13(b"abcd", &bytes, &header).expect_err("old position underflow");
    assert!(
        error
            .to_string()
            .contains("HDiffPatch cover old position underflowed")
    );
}

#[test]
fn hdiff13_apply_rejects_a_cover_that_reads_past_the_source() {
    let mut cover = vec![0x00u8];
    write_var_u64(&mut cover, 0);
    write_var_u64(&mut cover, 8);
    let (bytes, header) = parsed_hdiff13(build_hdiff13_parts(&Hdiff13Parts {
        new_data_size: 8,
        old_data_size: 4,
        cover_count: 1,
        cover: &cover,
        rle_ctrl: &[],
        rle_code: &[],
        new_diff: &[],
    }));

    let error = apply_hdiff13(b"abcd", &bytes, &header).expect_err("cover past source end");
    let message = error.to_string();
    assert!(
        message.contains("HDIFF_COVER_EXCEEDED_OLD_BOUNDS"),
        "{message}"
    );
    assert!(message.contains("old_len=4"), "{message}");
}

#[test]
fn hdiff13_apply_fills_the_gap_before_a_cover_from_the_new_data_diff() {
    let mut cover = vec![0x00u8];
    write_var_u64(&mut cover, 2); // copy_length: two new bytes precede the cover
    write_var_u64(&mut cover, 2); // cover_length
    let (bytes, header) = parsed_hdiff13(build_hdiff13_parts(&Hdiff13Parts {
        new_data_size: 4,
        old_data_size: 2,
        cover_count: 1,
        cover: &cover,
        rle_ctrl: &[],
        rle_code: &[],
        new_diff: b"XY",
    }));

    assert_eq!(
        apply_hdiff13(b"ab", &bytes, &header).expect("apply"),
        b"XYab"
    );
}

#[test]
fn hdiff13_apply_rejects_an_output_shorter_than_the_covers_produce() {
    let mut cover = vec![0x00u8];
    write_var_u64(&mut cover, 0);
    write_var_u64(&mut cover, 4);
    let (bytes, header) = parsed_hdiff13(build_hdiff13_parts(&Hdiff13Parts {
        new_data_size: 2,
        old_data_size: 4,
        cover_count: 1,
        cover: &cover,
        rle_ctrl: &[],
        rle_code: &[],
        new_diff: &[],
    }));

    let error = apply_hdiff13(b"abcd", &bytes, &header).expect_err("output size mismatch");
    let message = error.to_string();
    assert!(message.contains("HDIFF_OUTPUT_SIZE_MISMATCH"), "{message}");
    assert!(message.contains("expected=2"), "{message}");
}

#[test]
fn hdiff13_chunks_read_in_parallel_match_the_serial_read() {
    let source = b"parallel chunk fixture bytes";
    let (bytes, header) = parsed_hdiff13(build_identity_hdiff13_patch_with_cover_and_rle(source));
    let old_data = super::HdiffOldData::Bytes(source.to_vec());

    let serial = super::apply_hdiff13_with_chunk_parallelism(&old_data, &bytes, &header, false)
        .expect("serial chunk read");
    let parallel = super::apply_hdiff13_with_chunk_parallelism(&old_data, &bytes, &header, true)
        .expect("parallel chunk read");

    assert_eq!(serial, source);
    assert_eq!(parallel, serial);
}

#[test]
fn chunk_reads_report_ranges_past_the_patch_and_compressed_nocomp_chunks() {
    assert_eq!(
        super::read_hdiff_chunk(b"abcd", 1, 2, 0, HdiffCompression::NoComp, "cover")
            .expect("chunk"),
        b"bc"
    );
    assert!(
        super::read_hdiff_chunk(b"abcd", 0, 8, 0, HdiffCompression::NoComp, "cover")
            .expect_err("past patch end")
            .to_string()
            .contains("HDIFF_CHUNK_EXCEEDED_PATCH_LENGTH")
    );
    assert!(
        super::read_hdiff_chunk(b"abcd", 0, 8, 4, HdiffCompression::NoComp, "cover")
            .expect_err("compressed nocomp chunk")
            .to_string()
            .contains("HDIFF_CHUNK_COMPRESSED_BYTES_WITH_NOCOMP")
    );
}

#[test]
fn reader_chunk_reads_report_ranges_past_the_patch_and_compressed_nocomp_chunks() {
    let temp = TestDir::new();
    let patch_path = temp.child("chunks.bin");
    fs::write(&patch_path, b"abcd").expect("fixture");
    let reader = Arc::new(
        SharedBlockCacheReader::open(
            &patch_path,
            DEFAULT_BLOCK_CACHE_SIZE_BYTES,
            DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
        )
        .expect("reader"),
    );

    assert_eq!(
        super::read_hdiff_chunk_from_reader(&reader, 4, 1, 2, 0, HdiffCompression::NoComp, "cover")
            .expect("chunk"),
        b"bc"
    );
    assert!(
        super::read_hdiff_chunk_from_reader(&reader, 4, 0, 8, 0, HdiffCompression::NoComp, "cover")
            .expect_err("past patch end")
            .to_string()
            .contains("HDIFF_CHUNK_EXCEEDED_PATCH_LENGTH")
    );
    assert!(
        super::read_hdiff_chunk_from_reader(&reader, 8, 0, 8, 4, HdiffCompression::NoComp, "cover")
            .expect_err("compressed nocomp chunk")
            .to_string()
            .contains("HDIFF_CHUNK_COMPRESSED_BYTES_WITH_NOCOMP")
    );
}

#[test]
fn payload_decompression_rejects_nocomp_chunks() {
    let error = super::decompress_hdiff_payload(HdiffCompression::NoComp, b"", 0, "cover")
        .expect_err("nocomp payload");
    assert!(
        error
            .to_string()
            .contains("HDIFF_CHUNK_COMPRESSED_BYTES_WITH_NOCOMP")
    );
}

#[test]
fn zstd_decompression_reports_a_codec_failure() {
    let error = super::decompress_hdiff_payload(HdiffCompression::Zstd, b"not zstd", 4, "cover")
        .expect_err("bad zstd payload");
    let message = error.to_string();
    assert!(message.contains("HDIFF_DECODE_FAILED"), "{message}");
    assert!(message.contains("codec=zstd"), "{message}");
}

#[test]
fn zlib_decompression_reads_the_window_bits_prefix() {
    let payload = b"hello hdiffpatch world";
    let expected_len = payload.len() as u64;

    let mut raw_deflate = vec![0xF1]; // window_bits -15: a raw deflate stream
    raw_deflate.extend_from_slice(&stored_deflate_block(payload));
    assert_eq!(
        super::decompress_hdiff_payload(
            HdiffCompression::Zlib,
            &raw_deflate,
            expected_len,
            "cover"
        )
        .expect("raw deflate"),
        payload
    );

    let mut wrapped = vec![15u8]; // window_bits 15: a zlib-wrapped stream
    wrapped.extend_from_slice(&zlib_stream(payload));
    assert_eq!(
        super::decompress_hdiff_payload(HdiffCompression::Zlib, &wrapped, expected_len, "cover")
            .expect("zlib"),
        payload
    );
}

#[test]
fn zlib_decompression_reports_prefix_and_codec_failures() {
    assert!(
        super::decompress_hdiff_payload(HdiffCompression::Zlib, b"", 0, "cover")
            .expect_err("missing prefix")
            .to_string()
            .contains("HDIFF_ZLIB_WINDOW_BITS_PREFIX_MISSING")
    );
    assert!(
        super::decompress_hdiff_payload(HdiffCompression::Zlib, &[0u8, 1, 2], 4, "cover")
            .expect_err("unsupported window bits")
            .to_string()
            .contains("HDIFF_ZLIB_WINDOW_BITS_UNSUPPORTED")
    );
    assert!(
        super::decompress_hdiff_payload(HdiffCompression::Zlib, &[0xF1, 0xFF, 0xFF], 4, "cover")
            .expect_err("bad deflate")
            .to_string()
            .contains("codec=zlib(deflate)")
    );
    assert!(
        super::decompress_hdiff_payload(HdiffCompression::Zlib, &[0x0F, 0xFF, 0xFF], 4, "cover")
            .expect_err("bad zlib")
            .to_string()
            .contains("codec=zlib")
    );
}

#[test]
fn bz2_decompression_reports_a_codec_failure() {
    let error = super::decompress_hdiff_payload(HdiffCompression::Bz2, b"not bz2", 4, "cover")
        .expect_err("bad bz2 payload");
    assert!(error.to_string().contains("codec=bz2"), "{error}");
}

#[test]
fn lzma_decompression_validates_the_props_prefix() {
    for (payload, code) in [
        (vec![], "HDIFF_LZMA_PROPS_MISSING"),
        (vec![0u8], "HDIFF_LZMA_PROPS_SIZE_ZERO"),
        (vec![9u8, 1, 2], "HDIFF_LZMA_PROPS_EXCEEDED_PAYLOAD"),
        (vec![3u8, 1, 2, 3], "HDIFF_LZMA_PROPS_TOO_SHORT"),
    ] {
        let error = super::decompress_hdiff_payload(HdiffCompression::Lzma, &payload, 4, "cover")
            .expect_err(code);
        assert!(error.to_string().contains(code), "{error}");
    }
}

#[test]
fn lzma_decompression_reports_a_codec_failure() {
    let mut payload = vec![5u8, 0x5D, 0x00, 0x00, 0x10, 0x00];
    payload.extend_from_slice(b"garbage");
    let error = super::decompress_hdiff_payload(HdiffCompression::Lzma, &payload, 16, "cover")
        .expect_err("bad lzma payload");
    assert!(error.to_string().contains("codec=lzma"), "{error}");
}

#[test]
fn lzma2_decompression_validates_the_property_byte() {
    assert!(
        super::decompress_hdiff_payload(HdiffCompression::Lzma2, b"", 4, "cover")
            .expect_err("missing property byte")
            .to_string()
            .contains("HDIFF_LZMA2_PROPS_MISSING")
    );
    let error = super::decompress_hdiff_payload(HdiffCompression::Lzma2, &[0x00, 0xFF], 4, "cover")
        .expect_err("bad lzma2 payload");
    assert!(error.to_string().contains("codec=lzma2"), "{error}");
}

#[test]
fn lzma2_dictionary_sizes_follow_the_property_byte() {
    assert_eq!(
        super::decode_lzma2_dict_size(0, "cover").expect("smallest dictionary"),
        4096
    );
    assert_eq!(
        super::decode_lzma2_dict_size(1, "cover").expect("odd property"),
        6144
    );
    assert_eq!(
        super::decode_lzma2_dict_size(40, "cover").expect("largest dictionary"),
        u32::MAX
    );
    assert!(
        super::decode_lzma2_dict_size(0x40, "cover")
            .expect_err("reserved flag bits")
            .to_string()
            .contains("HDIFF_LZMA2_PROPERTY_FLAG_BITS_UNSUPPORTED")
    );
    assert!(
        super::decode_lzma2_dict_size(41, "cover")
            .expect_err("above the maximum")
            .to_string()
            .contains("HDIFF_LZMA2_PROPERTY_MAX_EXCEEDED")
    );
}

/// One HDIFFSF20 step: `cover_buf_size`, `rle_buf_size`, the cover block, the
/// rle block, then the step's gap bytes.
fn sf20_step_payload(cover: &[u8], rle: &[u8], gap: &[u8]) -> Vec<u8> {
    let mut payload = Vec::new();
    write_var_u64(&mut payload, cover.len() as u64);
    write_var_u64(&mut payload, rle.len() as u64);
    payload.extend_from_slice(cover);
    payload.extend_from_slice(rle);
    payload.extend_from_slice(gap);
    payload
}

fn sf20_cover(sign_and_delta: u8, new_gap: u64, cover_length: u64) -> Vec<u8> {
    let mut cover = vec![sign_and_delta];
    write_var_u64(&mut cover, new_gap);
    write_var_u64(&mut cover, cover_length);
    cover
}

fn parsed_hdiffsf20(patch: Vec<u8>) -> (Vec<u8>, super::ParsedHdiffSf20) {
    let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse");
    let super::ParsedPatchVariant::SingleStream20(header) = parsed.variant else {
        panic!("expected an HDIFFSF20 patch");
    };
    (parsed.bytes, header)
}

#[test]
fn sf20_step_parsing_rejects_a_step_buffer_past_the_payload() {
    let mut payload = Vec::new();
    write_var_u64(&mut payload, 64);
    write_var_u64(&mut payload, 0);

    let error = super::parse_hdiffsf20_steps(&payload, 8, 8, 1).expect_err("step past payload");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 step buffer exceeded payload")
    );
}

#[test]
fn sf20_step_parsing_rejects_a_step_with_no_decodable_covers() {
    let payload = sf20_step_payload(&[], &[], &[]);
    let error = super::parse_hdiffsf20_steps(&payload, 8, 8, 1).expect_err("no covers");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 step declared no decodable covers")
    );
}

#[test]
fn sf20_step_parsing_rejects_a_cover_that_moves_before_the_start_of_the_source() {
    let payload = sf20_step_payload(&sf20_cover(0x81, 0, 1), &[], &[]);
    let error = super::parse_hdiffsf20_steps(&payload, 8, 8, 1).expect_err("old position");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 old position underflowed")
    );
}

#[test]
fn sf20_step_parsing_rejects_a_cover_that_reads_past_the_source() {
    let payload = sf20_step_payload(&sf20_cover(0x00, 0, 16), &[], &[]);
    let error = super::parse_hdiffsf20_steps(&payload, 8, 8, 1).expect_err("cover past source");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 cover exceeded source bounds")
    );
}

#[test]
fn sf20_step_parsing_rejects_gap_bytes_past_the_payload() {
    let payload = sf20_step_payload(&sf20_cover(0x00, 64, 1), &[], &[]);
    let error = super::parse_hdiffsf20_steps(&payload, 8, 128, 1).expect_err("gap past payload");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 gap bytes exceeded payload")
    );
}

#[test]
fn sf20_step_parsing_rejects_covers_that_produce_more_than_the_declared_output() {
    let payload = sf20_step_payload(&sf20_cover(0x00, 0, 8), &[], &[]);
    let error = super::parse_hdiffsf20_steps(&payload, 8, 4, 1).expect_err("output size");
    let message = error.to_string();
    assert!(
        message.contains("HDIFFSF20_OUTPUT_SIZE_MISMATCH"),
        "{message}"
    );
    assert!(message.contains("actual=8"), "{message}");
}

#[test]
fn sf20_step_parsing_rejects_a_tail_that_runs_past_the_payload() {
    let payload = sf20_step_payload(&sf20_cover(0x00, 0, 4), &[], &[]);
    let error = super::parse_hdiffsf20_steps(&payload, 8, 8, 1).expect_err("tail past payload");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 tail diff bytes exceeded payload")
    );
}

#[test]
fn sf20_step_parsing_reports_the_step_layout() {
    let mut rle = Vec::new();
    write_var_u64(&mut rle, 4); // len_zero covering the whole cover
    let payload = sf20_step_payload(&sf20_cover(0x00, 0, 4), &rle, &[]);

    let plan = super::parse_hdiffsf20_steps(&payload, 4, 4, 1).expect("plan");
    assert_eq!(plan.steps.len(), 1);
    assert_eq!(plan.produced_len, 4);
    assert_eq!(plan.steps[0].output_start, 0);
    assert_eq!(plan.steps[0].output_len, 4);
    assert_eq!(plan.steps[0].covers.len(), 1);
    assert_eq!(plan.tail_range, payload.len()..payload.len());
}

#[test]
fn sf20_step_rendering_rejects_ranges_past_the_payload() {
    let step = super::Sf20StepPlan {
        output_start: 0,
        output_len: 1,
        rle_range: 0..8,
        gap_range: 0..0,
        covers: Vec::new(),
    };
    let old = super::HdiffOldData::Bytes(b"abcd".to_vec());

    let error = super::render_hdiffsf20_step(&old, b"ab", &step).expect_err("past payload");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 step referenced bytes past payload")
    );
}

#[test]
fn sf20_step_rendering_rejects_a_gap_buffer_that_ends_early() {
    let step = super::Sf20StepPlan {
        output_start: 0,
        output_len: 4,
        rle_range: 0..1,
        gap_range: 1..1,
        covers: vec![super::Sf20CoverPlan {
            old_start: 0,
            cover_len: 2,
            gap_len: 2,
        }],
    };
    let old = super::HdiffOldData::Bytes(b"abcd".to_vec());

    let error = super::render_hdiffsf20_step(&old, &[0x02], &step).expect_err("short gap buffer");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 step gap bytes ended unexpectedly")
    );
}

#[test]
fn sf20_step_rendering_rejects_a_cover_past_the_source() {
    let step = super::Sf20StepPlan {
        output_start: 0,
        output_len: 8,
        rle_range: 0..0,
        gap_range: 0..0,
        covers: vec![super::Sf20CoverPlan {
            old_start: 0,
            cover_len: 8,
            gap_len: 0,
        }],
    };
    let old = super::HdiffOldData::Bytes(b"abcd".to_vec());

    let error = super::render_hdiffsf20_step(&old, b"", &step).expect_err("cover past source");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 cover exceeded source bounds")
    );
}

#[test]
fn sf20_step_rendering_rejects_leftover_gap_bytes() {
    let step = super::Sf20StepPlan {
        output_start: 0,
        output_len: 2,
        rle_range: 0..1,
        gap_range: 1..3,
        covers: vec![super::Sf20CoverPlan {
            old_start: 0,
            cover_len: 2,
            gap_len: 0,
        }],
    };
    let old = super::HdiffOldData::Bytes(b"abcd".to_vec());

    let error = super::render_hdiffsf20_step(&old, &[0x02, b'X', b'Y'], &step)
        .expect_err("leftover gap bytes");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 step left unused gap bytes")
    );
}

#[test]
fn sf20_step_rendering_rejects_a_step_shorter_than_its_declared_length() {
    let step = super::Sf20StepPlan {
        output_start: 0,
        output_len: 3,
        rle_range: 0..1,
        gap_range: 1..1,
        covers: vec![super::Sf20CoverPlan {
            old_start: 0,
            cover_len: 2,
            gap_len: 0,
        }],
    };
    let old = super::HdiffOldData::Bytes(b"abcd".to_vec());

    let error =
        super::render_hdiffsf20_step(&old, &[0x02], &step).expect_err("rendered size mismatch");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 rendered step size mismatch")
    );
}

#[test]
fn sf20_step_writes_reject_length_and_range_mismatches() {
    let step = super::Sf20StepPlan {
        output_start: 0,
        output_len: 2,
        rle_range: 0..0,
        gap_range: 0..0,
        covers: Vec::new(),
    };
    let mut output = [0u8; 4];

    assert!(
        super::write_hdiffsf20_step_bytes(&mut output, &step, b"abc")
            .expect_err("length mismatch")
            .to_string()
            .contains("HDIFFSF20 rendered step length mismatch")
    );
    super::write_hdiffsf20_step_bytes(&mut output, &step, b"ab").expect("step write");
    assert_eq!(&output, b"ab\0\0");

    let past_end = super::Sf20StepPlan {
        output_start: 3,
        output_len: 2,
        rle_range: 0..0,
        gap_range: 0..0,
        covers: Vec::new(),
    };
    assert!(
        super::write_hdiffsf20_step_bytes(&mut output, &past_end, b"ab")
            .expect_err("past target end")
            .to_string()
            .contains("HDIFFSF20 step output exceeded target size")
    );
}

#[test]
fn sf20_payload_reads_report_a_payload_past_the_patch() {
    let mut patch = build_hdiffsf20_header(4, 4, 1, b"ABCD");
    patch.truncate(patch.len() - 2);
    let (bytes, header) = parsed_hdiffsf20(patch);

    let error = super::read_hdiffsf20_diff_from_patch_bytes(&bytes, &header)
        .expect_err("payload past patch end");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 payload exceeded patch length")
    );
}

#[test]
fn sf20_payload_reads_decompress_a_compressed_payload() {
    let plain = b"single stream payload bytes bytes bytes bytes";
    let compressed = rom_weaver_core::codecs::encode_zstd(plain, 3).expect("zstd encode");

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFFSF20&zstd");
    patch.push(0);
    write_var_u64(&mut patch, plain.len() as u64);
    write_var_u64(&mut patch, 4);
    write_var_u64(&mut patch, 1);
    write_var_u64(&mut patch, 256);
    write_var_u64(&mut patch, plain.len() as u64);
    write_var_u64(&mut patch, compressed.len() as u64);
    patch.extend_from_slice(&compressed);

    let (bytes, header) = parsed_hdiffsf20(patch);
    assert_eq!(
        super::read_hdiffsf20_diff_from_patch_bytes(&bytes, &header).expect("payload"),
        plain
    );
}

#[test]
fn sf20_apply_copies_the_tail_bytes_that_follow_the_last_cover() {
    let mut rle = Vec::new();
    write_var_u64(&mut rle, 2); // len_zero covering the single cover
    let payload = sf20_step_payload(&sf20_cover(0x00, 0, 2), &rle, b"TL");
    let (bytes, header) = parsed_hdiffsf20(build_hdiffsf20_header(4, 4, 1, &payload));

    assert_eq!(
        apply_hdiffsf20(b"abcd", &bytes, &header).expect("apply"),
        b"abTL"
    );
}

#[test]
fn sf20_parallel_and_serial_step_rendering_agree() {
    let source = b"single stream fixture bytes";
    let (bytes, header) = parsed_hdiffsf20(build_hdiffsf20_nocomp_identity_two_steps(source));
    let old = super::HdiffOldData::Bytes(source.to_vec());

    let serial = super::apply_hdiffsf20_with_step_parallelism(&old, &bytes, &header, false)
        .expect("serial steps");
    let parallel = super::apply_hdiffsf20_with_step_parallelism(&old, &bytes, &header, true)
        .expect("parallel steps");

    assert!(!serial.used_parallelism);
    assert!(parallel.used_parallelism);
    assert_eq!(serial.output, source);
    assert_eq!(parallel.output, serial.output);
}

#[test]
fn sf20_rle_decoder_reports_a_value_buffer_that_ends_early() {
    let bytes = [0x00u8, 0x04, 1, 2];
    let mut decoder = super::HdiffSf20RleDecoder::new(&bytes);
    let mut target = [0u8; 4];

    let error = decoder.add(&mut target).expect_err("short value buffer");
    assert!(
        error
            .to_string()
            .contains("HDIFFSF20 rle data ended unexpectedly")
    );
}

#[test]
fn hdiff13_rle_reports_a_code_buffer_that_ends_early() {
    let mut target = [0u8; 4];
    let mut ctrl_index = 0usize;
    let mut code_index = 0usize;
    let mut state = super::HdiffRleState::default();

    let error = super::apply_hdiff_rle(
        &mut target,
        &[0xC3], // rle_type 3 (copy), length 4
        &mut ctrl_index,
        &[1, 2], // only two code bytes
        &mut code_index,
        &mut state,
    )
    .expect_err("short code buffer");
    assert!(
        error
            .to_string()
            .contains("HDiffPatch rle_code ended unexpectedly")
    );
}

#[test]
fn hdiff13_rle_applies_a_set_run_then_a_copy_run() {
    let mut target = [0u8; 4];
    let mut ctrl_index = 0usize;
    let mut code_index = 0usize;
    let mut state = super::HdiffRleState::default();

    super::apply_hdiff_rle(
        &mut target,
        &[0x81, 0xC1], // set-value run of 2, then a copy run of 2
        &mut ctrl_index,
        &[5, 7, 9], // set value, then the two copy bytes
        &mut code_index,
        &mut state,
    )
    .expect("rle");

    assert_eq!(target, [5, 5, 7, 9]);
    assert_eq!(ctrl_index, 2);
    assert_eq!(code_index, 3);
}

#[test]
fn hdiff13_rle_leaves_the_target_untouched_without_control_bytes() {
    let mut target = [1u8, 2, 3, 4];
    let mut ctrl_index = 0usize;
    let mut code_index = 0usize;
    let mut state = super::HdiffRleState::default();

    super::apply_hdiff_rle(
        &mut target,
        &[],
        &mut ctrl_index,
        &[],
        &mut code_index,
        &mut state,
    )
    .expect("rle");
    assert_eq!(target, [1, 2, 3, 4]);
}
