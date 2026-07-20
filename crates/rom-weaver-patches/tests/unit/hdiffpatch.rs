use std::{fs, path::PathBuf};

use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

use super::{
    HdiffPatchHandler, apply_hdiff13, apply_hdiffsf20, build_uncompressed_hdiff13_patch,
    write_var_u64,
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
