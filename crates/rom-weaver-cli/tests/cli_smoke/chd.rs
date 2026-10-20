use super::shared::*;

#[test]
fn chd_compress_and_extract_raw_round_trip() {
    let source = (0..16_384)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    run_chd_round_trip("disc.bin", &source, "lzma2", "disc.bin");
}

#[test]
fn chd_compress_and_extract_dvd_round_trip() {
    let source = (0..16_384)
        .map(|index| (index % 193) as u8)
        .collect::<Vec<_>>();
    run_chd_round_trip_with_format("chd-dvd", "movie.iso", &source, "zstd", "disc.iso");
}

#[test]
fn chd_compress_and_extract_hd_round_trip() {
    let source = (0..16_384)
        .map(|index| (index % 149) as u8)
        .collect::<Vec<_>>();
    run_chd_round_trip("disk.img", &source, "zlib", "disc.img");
}

#[test]
fn chd_compress_and_extract_flac_round_trip() {
    let source = (0..16_384)
        .map(|index| ((index as i16).wrapping_mul(17) as u16).to_le_bytes())
        .flat_map(|bytes| bytes.into_iter())
        .collect::<Vec<_>>();
    run_chd_round_trip("audio.bin", &source, "flac", "disc.bin");
}

#[test]
fn checksum_chd_uses_raw_sha1_fast_path_for_single_payload() {
    let temp = setup_temp_dir();
    let source = (0..32_768)
        .map(|index| (index % 211) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let expected_sha1 = checksum_value(temp.child("disc.bin").path(), "sha1");
    let output = command_stdout(
        &[
            "checksum",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-trim-fix",
            "--jsonl",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    let actual_sha1 = label_digest_value(label, "sha1").expect("sha1 digest");
    assert_eq!(actual_sha1, expected_sha1);
    assert!(label.contains("chd raw_sha1 fast path"));
}

#[test]
fn checksum_chd_reuses_raw_sha1_with_default_algorithms() {
    let temp = setup_temp_dir();
    let source = with_nes_header(
        &(0..32_768)
            .map(|index| (index % 211) as u8)
            .collect::<Vec<_>>(),
    );
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let output = command_stdout(
        &[
            "checksum",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    let checksums = json["details"]["checksums"]
        .as_object()
        .expect("checksum details");
    for algorithm in ["crc32", "md5", "sha1"] {
        assert_eq!(
            checksums[algorithm],
            checksum_value(temp.child("disc.bin").path(), algorithm),
            "unexpected {algorithm} checksum",
        );
    }
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("sha1 reused from chd raw_sha1 metadata"));
    assert!(
        json["details"]["checksum_variants"]
            .as_array()
            .expect("checksum variants")
            .iter()
            .any(|variant| variant["id"] == "remove-header")
    );
}

#[test]
fn checksum_chd_does_not_reuse_raw_sha1_after_nested_extract() {
    let temp = setup_temp_dir();
    let inner_path = temp.child("game.bin");
    fs::write(
        inner_path.path(),
        (0..32_768)
            .map(|index| (index % 211) as u8)
            .collect::<Vec<_>>(),
    )
    .expect("fixture");

    let nested_path = temp.child("disc.bin");
    command_stdout(
        &[
            "compress",
            "--input",
            inner_path.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            nested_path.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            nested_path.path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let output = command_stdout(
        &[
            "checksum",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    let checksums = json["details"]["checksums"]
        .as_object()
        .expect("checksum details");
    for algorithm in ["crc32", "md5", "sha1"] {
        assert_eq!(
            checksums[algorithm],
            checksum_value(inner_path.path(), algorithm),
            "unexpected {algorithm} checksum",
        );
    }
    assert!(
        !json["label"]
            .as_str()
            .expect("label")
            .contains("sha1 reused from chd raw_sha1 metadata")
    );
}

#[test]
fn checksum_chd_cd_does_not_use_raw_sha1_fast_path() {
    let temp = setup_temp_dir();
    let source = (0..(8 * 2352))
        .map(|index| (index % 211) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "cdlz",
            "--jsonl",
        ],
        0,
    );

    let expected_sha1 = checksum_value(temp.child("disc.bin").path(), "sha1");
    let output = command_stdout(
        &[
            "checksum",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--select",
            "disc.bin",
            "--no-trim-fix",
            "--jsonl",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    let actual_sha1 = label_digest_value(label, "sha1").expect("sha1 digest");
    assert_eq!(actual_sha1, expected_sha1);
    assert!(!label.contains("chd raw_sha1 fast path"));
}

#[test]
fn chd_compress_and_extract_avhuff_round_trip() {
    let temp = setup_temp_dir();
    let source = build_test_chav_stream(4, 32, 16);
    fs::write(temp.child("video.bin").path(), &source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    let compress_output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("video.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "avhuff",
            "--jsonl",
        ],
        0,
    );
    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", "chd");
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["status"], "succeeded");
    assert!(
        compress_json["label"]
            .as_str()
            .expect("label")
            .contains("avhuff")
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    assert_eq!(
        fs::read(out_dir.child("disc.avi").path()).expect("extract bytes"),
        source
    );
    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );
    let probe_json = parse_single_json_line(&probe_output);
    assert!(
        probe_json["label"]
            .as_str()
            .expect("label")
            .contains("codec=avhuff")
    );
    assert!(
        probe_json["label"]
            .as_str()
            .expect("label")
            .contains("sha1=")
    );
    assert!(
        probe_json["label"]
            .as_str()
            .expect("label")
            .contains("raw_sha1=")
    );
    assert!(
        probe_json["details"]["chd"]["sha1"]
            .as_str()
            .expect("sha1 detail")
            .len()
            == 40
    );
    assert!(
        probe_json["details"]["chd"]["raw_sha1"]
            .as_str()
            .expect("raw sha1 detail")
            .len()
            == 40
    );

    let alias_chd_path = temp.child("disc-alias.chd");
    let alias_output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("video.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            alias_chd_path.path().to_str().expect("path"),
            "--codec",
            "avhu",
            "--jsonl",
        ],
        0,
    );
    let alias_json = parse_single_json_line(&alias_output);
    assert_eq!(alias_json["status"], "succeeded");
    assert!(
        alias_json["label"]
            .as_str()
            .expect("label")
            .contains("avhuff")
    );
}

#[test]
fn probe_chd_reports_container_without_extracting() {
    // Probe must treat a disc-image codec (CHD) as terminal by default and report
    // the CHD container itself, instead of decompressing it to the inner payload.
    let temp = setup_temp_dir();
    let source = build_test_chav_stream(4, 32, 16);
    fs::write(temp.child("video.bin").path(), &source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("video.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "avhuff",
            "--jsonl",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "chd");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("codec=avhuff"));
    assert!(!label.contains("probe source resolved via"));
    assert_eq!(
        json["details"]["chd"]["sha1"]
            .as_str()
            .expect("sha1 detail")
            .len(),
        40
    );
}

#[test]
fn chd_compress_auto_detects_av_stream_without_explicit_codec() {
    // A `chav` A/V stream must be recognized as A/V media and default to the
    // avhuff codec even when the caller does not pass `--codec avhuff`.
    let temp = setup_temp_dir();
    let source = build_test_chav_stream(4, 32, 16);
    fs::write(temp.child("video.bin").path(), &source).expect("fixture");

    let chd_path = temp.child("auto.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("video.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );
    let probe_json = parse_single_json_line(&probe_output);
    let label = probe_json["label"].as_str().expect("label");
    assert!(label.contains("av chd"), "expected A/V media, got {label}");
    assert!(
        label.contains("codec=avhuff"),
        "expected avhuff codec, got {label}"
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    assert_eq!(
        fs::read(out_dir.child("auto.avi").path()).expect("extract bytes"),
        source
    );
}

#[test]
fn chd_av_and_ld_overrides_force_av_media() {
    let temp = setup_temp_dir();
    let source = build_test_chav_stream(4, 32, 16);
    fs::write(temp.child("video.bin").path(), &source).expect("fixture");

    for format in ["chd-av", "chd-ld"] {
        let chd_path = temp.child(format!("{format}.chd"));
        command_stdout(
            &[
                "compress",
                "--input",
                temp.child("video.bin").path().to_str().expect("path"),
                "--format",
                format,
                "--output",
                chd_path.path().to_str().expect("path"),
                "--jsonl",
            ],
            0,
        );

        let probe_output = command_stdout(
            &[
                "probe",
                "--input",
                chd_path.path().to_str().expect("path"),
                "--no-extract",
                "--jsonl",
            ],
            0,
        );
        let label = parse_single_json_line(&probe_output)["label"]
            .as_str()
            .expect("label")
            .to_string();
        assert!(
            label.contains("av chd"),
            "{format}: expected A/V media, got {label}"
        );
    }
}

#[test]
fn chd_compress_and_extract_huff_round_trip() {
    let source = (0..16_384)
        .map(|index| (index % 173) as u8)
        .collect::<Vec<_>>();
    run_chd_round_trip("disc.bin", &source, "huff", "disc.bin");
}

#[test]
fn chd_compress_huffman_alias_emits_huff_label() {
    let temp = setup_temp_dir();
    let source = (0..16_384)
        .map(|index| (index % 181) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    let chd_path = temp.child("disc.chd");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "huffman",
            "--jsonl",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert!(json["label"].as_str().expect("label").contains("huff"));
    assert!(!json["label"].as_str().expect("label").contains("huffman"));

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );
    let probe_json = parse_single_json_line(&probe_output);
    assert!(
        probe_json["label"]
            .as_str()
            .expect("label")
            .contains("codec=huff")
    );
}

#[test]
fn chd_compress_and_extract_cd_cue_round_trip() {
    let temp = setup_temp_dir();
    let frames = 8_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 211) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    let compress_output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", "chd");
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["format"], "chd");
    assert_eq!(compress_json["status"], "succeeded");

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let extract_events = parse_json_lines(&extract_output);
    assert_running_percent_event(&extract_events, "extract", "chd");
    let extract_json = extract_events.last().expect("extract terminal event");
    assert_eq!(extract_json["format"], "chd");
    assert_eq!(extract_json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );
    let cue = fs::read_to_string(out_dir.child("disc.cue").path()).expect("cue output");
    assert!(cue.contains("TRACK 01 MODE1/2352"));
    assert!(cue.contains("INDEX 01 00:00:00"));
}

/// Deterministic incompressible bytes (xorshift64), standing in for encrypted or random sectors.
fn incompressible_bytes(len: usize) -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

#[test]
fn chd_compress_and_extract_incompressible_cd_round_trip_with_default_codecs() {
    let temp = setup_temp_dir();
    let source = incompressible_bytes(64 * 2352);
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");

    // The default CD codecs include cdlz; LZMA1 grows incompressible sectors past the LZMA2 buffer
    // bound, which used to fail the whole create with "output buffer too small".
    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--output",
            chd_path.path().to_str().expect("path"),
        ],
        0,
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
        ],
        0,
    );
    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );
}

#[test]
fn chd_compress_and_extract_cd_with_index00_round_trip() {
    let temp = setup_temp_dir();
    let frames = 8_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 173) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str(
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:00:04\n    INDEX 01 00:00:06\n",
        )
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );
    let cue = fs::read_to_string(out_dir.child("disc.cue").path()).expect("cue output");
    assert!(cue.contains("TRACK 02 AUDIO"));
    assert!(cue.contains("INDEX 00 00:00:04"));
    assert!(cue.contains("INDEX 01 00:00:06"));
}

#[test]
fn chd_compress_cd_pads_tracks_to_four_frame_boundary() {
    // A non-final track whose frame count is not a multiple of 4 forces MAME's
    // implicit CD track padding. Track 1 is 6 frames (pad 2 -> 8); track 2 is 4
    // frames (pad 0). The hunk stream therefore holds 12 units of 2448 bytes,
    // even though the per-track FRAMES metadata stays unpadded. Omitting the
    // padding shifts every later track by the missing frames on a chdman-style
    // (padded) read; see the Sonic Adventure 2 GD-ROM regression.
    let temp = setup_temp_dir();
    let frames = 10_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 173) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str(
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:00:06\n",
        )
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    // Padded units: (6 + 2) + (4 + 0) = 12 frames of 2448 bytes = 29376 bytes.
    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );
    let probe_json = parse_single_json_line(&probe_output);
    assert!(
        probe_json["label"]
            .as_str()
            .expect("label")
            .contains("29376 bytes"),
        "expected padded logical size in probe label, got {}",
        probe_json["label"]
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );
}

// The split-bin test above pins the emitted `<name> (Track N).bin` names; the
// help text and CLI reference must describe that same naming.
#[test]
fn split_bin_help_and_reference_describe_emitted_track_names() {
    let help = String::from_utf8_lossy(&command_stdout(&["extract", "--help"], 0)).into_owned();
    assert!(help.contains("(Track N).bin"), "extract --help: {help}");
    let reference = fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/reference/cli.md"),
    )
    .expect("CLI reference");
    let split_bin = reference
        .lines()
        .find(|line| line.starts_with("`extract --split-bin`"))
        .expect("split-bin reference paragraph");
    assert!(split_bin.contains("(Track N).bin"), "{split_bin}");
}

#[test]
fn chd_extract_split_bin_forces_per_track_outputs_and_reports_emitted_files() {
    let temp = setup_temp_dir();
    let frames = 8_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 173) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str(
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:00:04\n    INDEX 01 00:00:06\n",
        )
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let out_dir = temp.child("extract-split");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--split-bin",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let extract_events = parse_json_lines(&extract_output);
    assert_running_percent_event(&extract_events, "extract", "chd");
    let extract_json = extract_events.last().expect("extract terminal event");
    assert_eq!(extract_json["format"], "chd");
    assert_eq!(extract_json["status"], "succeeded");
    let emitted = extract_json["details"]["emitted_files"]
        .as_array()
        .expect("emitted_files array");
    assert_eq!(emitted.len(), 3);
    assert_emitted_file(extract_json, out_dir.child("disc.cue").path(), Some("cue"));
    assert_emitted_file(
        extract_json,
        out_dir.child("disc (Track 1).bin").path(),
        Some("bin"),
    );
    assert_emitted_file(
        extract_json,
        out_dir.child("disc (Track 2).bin").path(),
        Some("bin"),
    );
    let label = extract_json["label"].as_str().expect("label");
    assert!(label.contains("splitbin=true"));
    assert!(label.contains("emitted_files=disc.cue,disc (Track 1).bin,disc (Track 2).bin"));

    assert!(out_dir.child("disc.cue").path().exists());
    assert!(out_dir.child("disc (Track 1).bin").path().exists());
    assert!(out_dir.child("disc (Track 2).bin").path().exists());
    assert!(!out_dir.child("disc.bin").path().exists());
    let cue = fs::read_to_string(out_dir.child("disc.cue").path()).expect("cue output");
    assert!(cue.contains("FILE \"disc (Track 1).bin\" BINARY"));
    assert!(cue.contains("FILE \"disc (Track 2).bin\" BINARY"));
}

#[test]
fn chd_extract_split_bin_selecting_cue_fanouts_track_outputs() {
    let temp = setup_temp_dir();
    let frames = 8_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 173) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str(
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:00:04\n    INDEX 01 00:00:06\n",
        )
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let out_dir = temp.child("extract-selected-cue");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--split-bin",
            "--select",
            "disc.cue",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let extract_json = parse_single_json_line(&extract_output);
    assert_eq!(extract_json["format"], "chd");
    assert_eq!(extract_json["status"], "succeeded");
    let label = extract_json["label"].as_str().expect("label");
    assert!(label.contains("splitbin=true"));

    assert!(out_dir.child("disc.cue").path().exists());
    assert!(out_dir.child("disc (Track 1).bin").path().exists());
    assert!(out_dir.child("disc (Track 2).bin").path().exists());
    assert!(!out_dir.child("disc.bin").path().exists());
}

#[test]
fn chd_extract_split_bin_rejects_non_cd_media() {
    let temp = setup_temp_dir();
    let source = (0..16_384)
        .map(|index| (index % 223) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let out_dir = temp.child("selected");
    let missing_output = command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--split-bin",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "chd");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("only supported for cd media")
    );
}

#[test]
fn chd_compress_and_extract_wave_audio_cue_round_trip() {
    let temp = setup_temp_dir();
    let pcm = (0..(4 * 2352))
        .map(|index| (index % 127) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("audio.wav").path(), build_pcm_wave(&pcm)).expect("wave fixture");
    temp.child("disc.cue")
        .write_str("FILE \"audio.wav\" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zlib",
            "--jsonl",
        ],
        0,
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        pcm
    );
    let cue = fs::read_to_string(out_dir.child("disc.cue").path()).expect("cue output");
    assert!(cue.contains("TRACK 01 AUDIO"));
}

#[test]
fn extract_split_bin_non_chd_is_ignored_with_warning() {
    let temp = setup_temp_dir();
    let expected = b"zip payload for extract split-bin ignore test".to_vec();
    fs::write(temp.child("disc.iso").path(), &expected).expect("fixture");
    let archive = temp.child("sample.zip");

    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let out_dir = temp.child("out");

    let output = command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--split-bin",
            "--select",
            "disc.iso",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let events = parse_json_lines(&output);
    assert_running_percent_event(&events, "extract", "zip");
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("ignored --split-bin for non-CHD input")
    );
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extract"),
        expected
    );
}

#[test]
fn chd_compress_and_extract_gdi_round_trip() {
    let temp = setup_temp_dir();
    let track01 = (0..(4 * 2352))
        .map(|index| (index % 101) as u8)
        .collect::<Vec<_>>();
    let track02 = (0..(3 * 2048))
        .map(|index| (index % 89) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("track01.bin").path(), &track01).expect("track01");
    fs::write(temp.child("track02.bin").path(), &track02).expect("track02");
    temp.child("disc.gdi")
        .write_str("2\n1 0 4 2352 track01.bin 0\n2 4 4 2048 track02.bin 0\n")
        .expect("gdi fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.gdi").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--jsonl",
        ],
        0,
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc (Track 1).bin").path()).expect("extract track01"),
        track01
    );
    assert_eq!(
        fs::read(out_dir.child("disc (Track 2).bin").path()).expect("extract track02"),
        track02
    );
    let gdi = fs::read_to_string(out_dir.child("disc.gdi").path()).expect("gdi output");
    assert!(gdi.contains("2\n"));
    assert!(gdi.contains("1 0 4 2352 \"disc (Track 1).bin\" 0"));
    assert!(gdi.contains("2 4 4 2048 \"disc (Track 2).bin\" 0"));
}

/// Writes a three-track synthetic GD-ROM (data, audio, data) with the given
/// frame counts and the audio/high-density `.gdi` offsets, then compresses it.
/// Returns the temp dir, CHD path and track contents.
fn compress_gdi_with(
    frames: [usize; 3],
    offsets: [u32; 2],
) -> (
    assert_fs::TempDir,
    assert_fs::fixture::ChildPath,
    Vec<Vec<u8>>,
) {
    let temp = setup_temp_dir();
    let tracks = frames
        .iter()
        .enumerate()
        .map(|(track, frames)| {
            (0..(frames * 2352))
                .map(|index| ((index + track * 7) % 251) as u8)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    for (index, bytes) in tracks.iter().enumerate() {
        fs::write(temp.child(format!("track{}.bin", index + 1)).path(), bytes).expect("track");
    }
    temp.child("disc.gdi")
        .write_str(&format!(
            "3\n1 0 4 2352 track1.bin 0\n2 {} 0 2352 track2.bin 0\n3 {} 4 2352 track3.bin 0\n",
            offsets[0], offsets[1]
        ))
        .expect("gdi fixture");
    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.gdi").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--jsonl",
        ],
        0,
    );
    (temp, chd_path, tracks)
}

/// 5/3/7-frame tracks: none is a multiple of the 4-frame alignment.
fn compress_unaligned_gdi() -> (
    assert_fs::TempDir,
    assert_fs::fixture::ChildPath,
    Vec<Vec<u8>>,
) {
    compress_gdi_with([5, 3, 7], [10, 45_000])
}

fn extract_chd_to(chd_path: &Path, out_dir: &Path) {
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.to_str().expect("path"),
            "--output",
            out_dir.to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
}

/// Asserts every probe-listed `.bin` size equals the extracted file's size.
fn assert_probe_sizes_match_extracted(chd_path: &Path, out_dir: &Path) {
    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            chd_path.to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let records = json["details"]["container"]["entry_records"]
        .as_array()
        .expect("entry records");
    let mut sized = 0;
    for record in records {
        let Some(size) = record["size_bytes"].as_u64() else {
            continue;
        };
        let name = record["file_name"].as_str().expect("file name");
        assert_eq!(
            size,
            fs::metadata(out_dir.join(name))
                .expect("extracted file")
                .len(),
            "listed size of `{name}` must equal the extracted size"
        );
        sized += 1;
    }
    assert!(sized > 0, "probe listed no sized entries");
}

#[test]
fn chd_gdi_tracks_are_padded_to_four_frames_like_chdman() {
    // chdman createcd on this gdi yields 45012 units (10 + 44990 + 7 data/pad
    // frames, plus 2 + 2 + 1 alignment frames) and extracts the original sizes.
    let (temp, chd_path, tracks) = compress_unaligned_gdi();
    let chd = fs::read(chd_path.path()).expect("chd");
    let logical = u64::from_be_bytes(chd[32..40].try_into().expect("logical size"));
    assert_eq!(logical, 45_012 * 2448);

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    for (index, bytes) in tracks.iter().enumerate() {
        assert_eq!(
            &fs::read(
                out_dir
                    .child(format!("disc (Track {}).bin", index + 1))
                    .path()
            )
            .expect("extracted track"),
            bytes,
            "track {} must extract at its original size",
            index + 1
        );
    }
}

#[test]
fn chd_gdi_extract_offsets_exclude_alignment_frames() {
    // chdman advances the `.gdi` offset by data + explicit PAD frames only, so
    // the 4-frame alignment never shifts later tracks. Both layouts have tracks
    // that are not a multiple of 4 frames (450 and 5/3/7).
    for (frames, offsets) in [([450, 3, 7], [450, 45_000]), ([5, 3, 7], [10, 45_000])] {
        let (temp, chd_path, tracks) = compress_gdi_with(frames, offsets);
        let out_dir = temp.child("extract");
        extract_chd_to(chd_path.path(), out_dir.path());
        let gdi = fs::read_to_string(out_dir.child("disc.gdi").path()).expect("gdi");
        assert_eq!(
            gdi,
            format!(
                "3\n1 0 4 2352 \"disc (Track 1).bin\" 0\n2 {} 0 2352 \"disc (Track 2).bin\" 0\n3 {} 4 2352 \"disc (Track 3).bin\" 0\n",
                offsets[0], offsets[1]
            )
        );
        for (index, bytes) in tracks.iter().enumerate() {
            assert_eq!(
                &fs::read(
                    out_dir
                        .child(format!("disc (Track {}).bin", index + 1))
                        .path()
                )
                .expect("track"),
                bytes
            );
        }
    }
}

#[test]
fn chd_gdi_probe_sizes_match_extracted_sizes() {
    let (temp, chd_path, _tracks) = compress_unaligned_gdi();
    let out_dir = temp.child("extract");
    extract_chd_to(chd_path.path(), out_dir.path());
    assert_probe_sizes_match_extracted(chd_path.path(), out_dir.path());
}

#[test]
fn chd_cd_probe_sizes_match_extracted_sizes() {
    let temp = setup_temp_dir();
    for (index, frames) in [5_usize, 3].iter().enumerate() {
        let bytes = (0..(frames * 2352))
            .map(|value| ((value + index) % 251) as u8)
            .collect::<Vec<_>>();
        fs::write(temp.child(format!("track{}.bin", index + 1)).path(), bytes).expect("track");
    }
    temp.child("disc.cue")
        .write_str("FILE \"track1.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"track2.bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");
    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--jsonl",
        ],
        0,
    );
    let out_dir = temp.child("extract");
    extract_chd_to(chd_path.path(), out_dir.path());
    assert_probe_sizes_match_extracted(chd_path.path(), out_dir.path());
}

#[test]
fn chd_cue_density_markers_report_mode1_pgtype_like_chdman() {
    // chdman reports the default MODE1 pregap type for every GD track, audio
    // included, whether the layout came from a `.gdi` or a density-marked cue.
    let temp = setup_temp_dir();
    fs::write(temp.child("track01.bin").path(), vec![1_u8; 4 * 2352]).expect("track01");
    fs::write(temp.child("track02.bin").path(), vec![2_u8; 4 * 2352]).expect("track02");
    temp.child("disc.cue")
        .write_str("REM SINGLE-DENSITY AREA\nFILE \"track01.bin\" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\nREM HIGH-DENSITY AREA\nFILE \"track02.bin\" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");
    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--jsonl",
        ],
        0,
    );
    let chd = String::from_utf8_lossy(&fs::read(chd_path.path()).expect("chd")).into_owned();
    for expected in [
        "TRACK:1 TYPE:AUDIO SUBTYPE:NONE FRAMES:45000 PAD:44996 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
        "TRACK:2 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:4 PAD:0 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
    ] {
        assert!(chd.contains(expected), "missing metadata `{expected}`");
    }
}

#[test]
fn chd_gdi_metadata_matches_chdman_track_fields() {
    // Reference lines captured from chdman 0.289 createcd on the same gdi:
    // FRAMES/PAD stay unaligned and every track reports PGTYPE:MODE1.
    let (_temp, chd_path, _tracks) = compress_unaligned_gdi();
    let chd = String::from_utf8_lossy(&fs::read(chd_path.path()).expect("chd")).into_owned();
    for expected in [
        "TRACK:1 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:10 PAD:5 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
        "TRACK:2 TYPE:AUDIO SUBTYPE:NONE FRAMES:44990 PAD:44987 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
        "TRACK:3 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:7 PAD:0 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
    ] {
        assert!(chd.contains(expected), "missing metadata `{expected}`");
    }
}

/// Writes one synthetic 2352-byte-sector track per `(name, frames)` entry (with
/// a WAVE header for `.wav` names) plus
/// `disc.cue`, then compresses the cue to `disc.chd`. The bytes are
/// `(index * 31 + file_number * 17) % 251`, so a reference CHD built by
/// chdman 0.289 from the same files has the hashes asserted by the callers.
fn compress_synthetic_cue(
    tracks: &[(&str, usize)],
    cue: &str,
) -> (assert_fs::TempDir, assert_fs::fixture::ChildPath) {
    let temp = setup_temp_dir();
    for (file_number, (name, frames)) in tracks.iter().enumerate() {
        let data = (0..(frames * 2352))
            .map(|index| ((index * 31 + (file_number + 1) * 17) % 251) as u8)
            .collect::<Vec<_>>();
        // A `.wav` track gets a 44-byte PCM header in front of its samples.
        let bytes = if name.ends_with(".wav") {
            let data_len = u32::try_from(data.len()).expect("wav length");
            let mut wav = b"RIFF".to_vec();
            wav.extend_from_slice(&(36 + data_len).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt ");
            wav.extend_from_slice(&16_u32.to_le_bytes());
            wav.extend_from_slice(&1_u16.to_le_bytes());
            wav.extend_from_slice(&2_u16.to_le_bytes());
            wav.extend_from_slice(&44_100_u32.to_le_bytes());
            wav.extend_from_slice(&(44_100_u32 * 4).to_le_bytes());
            wav.extend_from_slice(&4_u16.to_le_bytes());
            wav.extend_from_slice(&16_u16.to_le_bytes());
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&data_len.to_le_bytes());
            wav.extend_from_slice(&data);
            wav
        } else {
            data
        };
        fs::write(temp.child(name).path(), bytes).expect("track");
    }
    temp.child("disc.cue").write_str(cue).expect("cue fixture");
    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--jsonl",
        ],
        0,
    );
    (temp, chd_path)
}

/// The raw (data) SHA-1 and the overall SHA-1 from a v5 CHD header.
fn chd_header_sha1s(chd_path: &Path) -> (String, String) {
    let header = fs::read(chd_path).expect("chd");
    let hex = |bytes: &[u8]| {
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    (hex(&header[64..84]), hex(&header[84..104]))
}

fn chd_track_metadata_lines(chd_path: &Path) -> Vec<String> {
    let chd = String::from_utf8_lossy(&fs::read(chd_path).expect("chd")).into_owned();
    chd.match_indices("TRACK:")
        .map(|(start, _)| {
            chd[start..]
                .split('\0')
                .next()
                .expect("metadata entry")
                .to_owned()
        })
        .collect()
}

#[test]
fn chd_cd_pregap_pgtype_matches_chdman_for_every_pregap_kind() {
    // chdman 0.289 leaves the pregap type at MODE1 unless the pregap carries
    // data (`INDEX 00`), whatever the track type: a MODE2/2352 first track and
    // an AUDIO track with a `PREGAP` directive both report PGTYPE:MODE1, and
    // an AUDIO `INDEX 00` pregap reports VAUDIO. The hashes are chdman's.
    let (_temp, chd_path) = compress_synthetic_cue(
        &[("track1.bin", 4), ("track2.bin", 5), ("track3.bin", 6)],
        "FILE \"track1.bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\nFILE \"track2.bin\" BINARY\n  TRACK 02 AUDIO\n    PREGAP 00:00:02\n    INDEX 01 00:00:00\nFILE \"track3.bin\" BINARY\n  TRACK 03 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:00:02\n",
    );
    assert_eq!(
        chd_track_metadata_lines(chd_path.path()),
        [
            "TRACK:1 TYPE:MODE2_RAW SUBTYPE:NONE FRAMES:4 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:2 TYPE:AUDIO SUBTYPE:NONE FRAMES:5 PREGAP:2 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:3 TYPE:AUDIO SUBTYPE:NONE FRAMES:6 PREGAP:2 PGTYPE:VAUDIO PGSUB:NONE POSTGAP:0",
        ]
    );
    assert_eq!(
        chd_header_sha1s(chd_path.path()),
        (
            "f4bdecad9e1e216141d64f4466c26b422cb38873".to_string(),
            "14e4b87c43e96f5952c6d18c8b7228dbdcad235c".to_string()
        )
    );
}

#[test]
fn chd_gd_cue_index00_pregaps_move_to_previous_track_like_chdman() {
    // A Redump-style Dreamcast cue gives tracks 2 and up an `INDEX 00` pregap.
    // chdman files those frames under the end of the previous track (after the
    // density gap padding when the next track opens the high-density area), so
    // FRAMES, the physical .gdi offsets and the hashes all differ from keeping
    // the pregap in its own track. Reference values come from chdman 0.289.
    let (temp, chd_path) = compress_synthetic_cue(
        &[
            ("track01.bin", 6),
            ("track02.bin", 9),
            ("track03.bin", 8),
            ("track04.bin", 5),
        ],
        "REM SINGLE-DENSITY AREA\nFILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"track02.bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:00:03\nREM HIGH-DENSITY AREA\nFILE \"track03.bin\" BINARY\n  TRACK 03 MODE1/2352\n    INDEX 00 00:00:00\n    INDEX 01 00:00:02\nFILE \"track04.bin\" BINARY\n  TRACK 04 AUDIO\n    INDEX 01 00:00:00\n",
    );
    assert_eq!(
        chd_track_metadata_lines(chd_path.path()),
        [
            "TRACK:1 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:9 PAD:0 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:2 TYPE:AUDIO SUBTYPE:NONE FRAMES:44991 PAD:44983 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:3 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:6 PAD:0 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:4 TYPE:AUDIO SUBTYPE:NONE FRAMES:5 PAD:0 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
        ]
    );
    assert_eq!(
        chd_header_sha1s(chd_path.path()),
        (
            "03e27c995f4810722daba747415f2ed23f654a4c".to_string(),
            "0bee7f8d3b7b7b30e9026c16a712041aa690291e".to_string()
        )
    );

    // `chdman extractcd` of that CHD writes these offsets and sizes.
    let out_dir = temp.child("extract");
    extract_chd_to(chd_path.path(), out_dir.path());
    assert_eq!(
        fs::read_to_string(out_dir.child("disc.gdi").path()).expect("gdi"),
        "4\n1 0 4 2352 \"disc (Track 1).bin\" 0\n2 9 0 2352 \"disc (Track 2).bin\" 0\n3 45000 4 2352 \"disc (Track 3).bin\" 0\n4 45006 0 2352 \"disc (Track 4).bin\" 0\n"
    );
    for (track, bytes) in [(1, 21_168), (2, 18_816), (3, 14_112), (4, 11_760)] {
        assert_eq!(
            fs::metadata(out_dir.child(format!("disc (Track {track}).bin")).path())
                .expect("track")
                .len(),
            bytes,
            "track {track} size"
        );
    }
}

#[test]
fn chd_gd_cue_first_track_pregap_stays_and_keeps_its_own_pgtype_like_chdman() {
    // chdman only moves pregaps for tracks 2 and up. A first-track `INDEX 00`
    // pregap stays in the metadata with the track's own type (no `V` prefix),
    // and a later `PREGAP` directive moves to the end of the first track.
    let (_temp, chd_path) = compress_synthetic_cue(
        &[("track01.bin", 8), ("track02.bin", 6), ("track03.bin", 5)],
        "REM SINGLE-DENSITY AREA\nFILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 00 00:00:00\n    INDEX 01 00:00:03\nFILE \"track02.bin\" BINARY\n  TRACK 02 AUDIO\n    PREGAP 00:00:02\n    INDEX 01 00:00:00\nREM HIGH-DENSITY AREA\nFILE \"track03.bin\" BINARY\n  TRACK 03 MODE1/2352\n    INDEX 01 00:00:00\n",
    );
    assert_eq!(
        chd_track_metadata_lines(chd_path.path()),
        [
            "TRACK:1 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:10 PAD:0 PREGAP:3 PGTYPE:MODE1_RAW PGSUB:NONE POSTGAP:0",
            "TRACK:2 TYPE:AUDIO SUBTYPE:NONE FRAMES:44990 PAD:44986 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:3 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:5 PAD:0 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
        ]
    );
    assert_eq!(
        chd_header_sha1s(chd_path.path()),
        (
            "8ee360722b15f8b8b2fc1e3b76cd6cf74c9729f1".to_string(),
            "643af5118b1ccba14b6dcc0040d7ec1a7b3090ca".to_string()
        )
    );
}

/// Asserts the track metadata and the raw/overall header SHA-1s.
fn assert_chd_matches_chdman(chd_path: &Path, tracks: &[&str], raw_sha1: &str, overall_sha1: &str) {
    assert_eq!(chd_track_metadata_lines(chd_path), tracks);
    assert_eq!(
        chd_header_sha1s(chd_path),
        (raw_sha1.to_string(), overall_sha1.to_string())
    );
}

#[test]
fn chd_gd_cue_wave_track_pregap_is_read_from_the_wav_file_start_like_chdman() {
    // chdman moves the WAVE track's `INDEX 00` pregap onto the previous track
    // by reading that file from byte 0, so the 44-byte RIFF header is part of
    // the frames. Reference values come from chdman 0.289.
    let (_temp, chd_path) = compress_synthetic_cue(
        &[("track01.bin", 6), ("track02.wav", 9), ("track03.bin", 8)],
        "REM SINGLE-DENSITY AREA\nFILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"track02.wav\" WAVE\n  TRACK 02 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:00:03\nREM HIGH-DENSITY AREA\nFILE \"track03.bin\" BINARY\n  TRACK 03 MODE1/2352\n    INDEX 01 00:00:00\n",
    );
    assert_chd_matches_chdman(
        chd_path.path(),
        &[
            "TRACK:1 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:9 PAD:0 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:2 TYPE:AUDIO SUBTYPE:NONE FRAMES:44991 PAD:44985 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:3 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:8 PAD:0 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
        ],
        "4029119a37a34731f0021f7354ebbddfec015a2c",
        "8139198dc2472e8d9b296de4dfab6688674dd71d",
    );
}

#[test]
fn chd_cd_cue_shared_bin_tracks_split_by_index_difference_like_chdman() {
    // chdman sizes a shared-file track by the difference of the first indexes
    // (INDEX 01 at 00:00:02 and 00:00:10 give 8 and 12 frames, not 10 and
    // 10) and starts the next track where the previous one's frames end.
    let (_temp, chd_path) = compress_synthetic_cue(
        &[("a.bin", 20)],
        "FILE \"a.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:02\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:10\n",
    );
    assert_chd_matches_chdman(
        chd_path.path(),
        &[
            "TRACK:1 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:8 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:2 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:12 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
        ],
        "55d9daf85a9573346d5c3b6be9b399fca41900be",
        "ab7d93a1a1b8ca40a0aefca47f069435ce767140",
    );
}

#[test]
fn chd_cd_cue_shared_bin_after_another_file_starts_after_the_previous_frames_like_chdman() {
    // chdman starts a shared-file track at the previous track's byte offset
    // plus its frames even when the previous track lives in another file, so
    // track 2 reads b.bin from frame 6, not frame 0.
    let (_temp, chd_path) = compress_synthetic_cue(
        &[("a.bin", 6), ("b.bin", 20)],
        "FILE \"a.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"b.bin\" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n  TRACK 03 MODE1/2352\n    INDEX 01 00:00:10\n",
    );
    assert_chd_matches_chdman(
        chd_path.path(),
        &[
            "TRACK:1 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:6 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:2 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:10 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:3 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:4 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
        ],
        "3381c9f35f57feb284eb86d83a1036c9eb51ea46",
        "0e894d1b7cc5421012444b8a2699b141e4c60587",
    );
}

#[test]
fn chd_cd_cue_zero_length_index00_pregap_still_reports_a_data_pgtype_like_chdman() {
    // An `INDEX 00` equal to `INDEX 01` is a zero-length pregap, but chdman
    // still records the pregap as data: PREGAP:0 PGTYPE:VAUDIO.
    let (_temp, chd_path) = compress_synthetic_cue(
        &[("track01.bin", 8), ("track02.bin", 6)],
        "FILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"track02.bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:00:00\n",
    );
    assert_chd_matches_chdman(
        chd_path.path(),
        &[
            "TRACK:1 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:8 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:2 TYPE:AUDIO SUBTYPE:NONE FRAMES:6 PREGAP:0 PGTYPE:VAUDIO PGSUB:NONE POSTGAP:0",
        ],
        "afc64deb1539fc3a33788800e45c73997084ddd5",
        "e2be0a7927b3c1b6827ceec6c145ea4b04a39743",
    );
}

#[test]
fn chd_gd_cue_first_track_zero_length_index00_keeps_its_own_pgtype_like_chdman() {
    // The same zero-length `INDEX 00` on a GD cue's first track reports the
    // track's own type, PGTYPE:MODE1_RAW, not the default MODE1.
    let (_temp, chd_path) = compress_synthetic_cue(
        &[("track01.bin", 8), ("track02.bin", 6), ("track03.bin", 5)],
        "REM SINGLE-DENSITY AREA\nFILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 00 00:00:00\n    INDEX 01 00:00:00\nFILE \"track02.bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\nREM HIGH-DENSITY AREA\nFILE \"track03.bin\" BINARY\n  TRACK 03 MODE1/2352\n    INDEX 01 00:00:00\n",
    );
    assert_chd_matches_chdman(
        chd_path.path(),
        &[
            "TRACK:1 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:8 PAD:0 PREGAP:0 PGTYPE:MODE1_RAW PGSUB:NONE POSTGAP:0",
            "TRACK:2 TYPE:AUDIO SUBTYPE:NONE FRAMES:44992 PAD:44986 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
            "TRACK:3 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:5 PAD:0 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0",
        ],
        "0ca6e7a401bcb73bacfd4e75490228eb92958a55",
        "d294998e173abe3fe2de6d4f8097a1f4af3feb54",
    );
}

#[test]
fn chd_compress_cue_with_sibling_gdi_detects_gdrom() {
    // A redump-style GD-ROM dump ships a `.cue` next to an authoritative `.gdi`.
    // Compressing the `.cue` must auto-detect GD-ROM media and frame the disc
    // from the `.gdi` (here the inner track is contiguous to keep the fixture
    // small), not silently fall back to a plain CD-ROM.
    let temp = setup_temp_dir();
    let track01 = (0..(4 * 2352))
        .map(|index| (index % 101) as u8)
        .collect::<Vec<_>>();
    let track02 = (0..(4 * 2352))
        .map(|index| (index % 89) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("track01.bin").path(), &track01).expect("track01");
    fs::write(temp.child("track02.bin").path(), &track02).expect("track02");
    temp.child("disc.gdi")
        .write_str("2\n1 0 4 2352 track01.bin 0\n2 4 4 2352 track02.bin 0\n")
        .expect("gdi fixture");
    temp.child("disc.cue")
        .write_str(
            "REM SINGLE-DENSITY AREA\nFILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nREM HIGH-DENSITY AREA\nFILE \"track02.bin\" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );
    let probe_json = parse_single_json_line(&probe_output);
    assert!(
        probe_json["label"]
            .as_str()
            .expect("label")
            .contains("gd chd"),
        "expected GD-ROM media, got {}",
        probe_json["label"]
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc (Track 1).bin").path()).expect("extract track01"),
        track01
    );
    assert_eq!(
        fs::read(out_dir.child("disc (Track 2).bin").path()).expect("extract track02"),
        track02
    );
}

#[test]
fn chd_compress_cue_density_markers_without_gdi_synthesizes_gdrom() {
    // Without a sibling `.gdi`, the `REM HIGH-DENSITY AREA` marker alone must
    // still route to GD-ROM, anchoring the inner area at its standard physical
    // start LBA (45000) and round-tripping byte-for-byte.
    let temp = setup_temp_dir();
    let track01 = (0..(4 * 2352))
        .map(|index| (index % 101) as u8)
        .collect::<Vec<_>>();
    let track02 = (0..(4 * 2352))
        .map(|index| (index % 89) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("track01.bin").path(), &track01).expect("track01");
    fs::write(temp.child("track02.bin").path(), &track02).expect("track02");
    temp.child("disc.cue")
        .write_str(
            "REM SINGLE-DENSITY AREA\nFILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nREM HIGH-DENSITY AREA\nFILE \"track02.bin\" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );
    let probe_json = parse_single_json_line(&probe_output);
    assert!(
        probe_json["label"]
            .as_str()
            .expect("label")
            .contains("gd chd"),
        "expected GD-ROM media, got {}",
        probe_json["label"]
    );
    // Inner track anchored at LBA 45000: (45000) + 4 frames = 45004 units * 2448.
    assert!(
        probe_json["label"]
            .as_str()
            .expect("label")
            .contains(&format!("{} bytes", 45004_u64 * 2448)),
        "expected high-density anchor in logical size, got {}",
        probe_json["label"]
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc (Track 1).bin").path()).expect("extract track01"),
        track01
    );
    assert_eq!(
        fs::read(out_dir.child("disc (Track 2).bin").path()).expect("extract track02"),
        track02
    );
}

#[test]
fn chd_gd_override_forces_gdrom_and_rejects_plain_cd() {
    let temp = setup_temp_dir();
    let track01 = (0..(4 * 2352))
        .map(|index| (index % 101) as u8)
        .collect::<Vec<_>>();
    let track02 = (0..(4 * 2352))
        .map(|index| (index % 89) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("track01.bin").path(), &track01).expect("track01");
    fs::write(temp.child("track02.bin").path(), &track02).expect("track02");

    // chd-gd forces GD-ROM when the cue carries a high-density signal.
    temp.child("gd.cue")
        .write_str(
            "REM SINGLE-DENSITY AREA\nFILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nREM HIGH-DENSITY AREA\nFILE \"track02.bin\" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("gd cue");
    let gd_chd = temp.child("gd.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("gd.cue").path().to_str().expect("path"),
            "--format",
            "chd-gd",
            "--output",
            gd_chd.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            gd_chd.path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );
    assert!(
        parse_single_json_line(&probe_output)["label"]
            .as_str()
            .expect("label")
            .contains("gd chd")
    );

    // chd-gd on a plain CD cue (no high-density signal) is rejected.
    temp.child("cd.cue")
        .write_str("FILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cd cue");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("cd.cue").path().to_str().expect("path"),
            "--format",
            "chd-gd",
            "--output",
            temp.child("cd.chd").path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
}

#[test]
fn chd_compress_accepts_supported_codecs() {
    let source = (0..16_384)
        .map(|index| (index % 199) as u8)
        .collect::<Vec<_>>();
    run_chd_round_trip("disc.bin", &source, "zstd", "disc.bin");
}

#[test]
fn chd_compress_accepts_cd_codec_aliases() {
    let temp = setup_temp_dir();
    let frames = 8_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 211) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "cdlz",
            "--jsonl",
        ],
        0,
    );

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );
    let probe_json = parse_single_json_line(&probe_output);
    assert_eq!(probe_json["command"], "probe");
    assert_eq!(probe_json["status"], "succeeded");
    assert!(
        probe_json["label"]
            .as_str()
            .expect("label")
            .contains("codec=cdlz")
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );
}

#[test]
fn chd_compress_and_extract_cdfl_with_level_round_trip() {
    let temp = setup_temp_dir();
    let frames = 8_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 197) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");
    let chd_path = temp.child("disc.chd");

    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "cdfl:9",
            "--jsonl",
        ],
        0,
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );
}

#[test]
fn chd_compress_accepts_multiple_codecs_from_repeated_flags() {
    let temp = setup_temp_dir();
    let frames = 10_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 157) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    let compress_output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "cdzs",
            "--codec",
            "cdzl",
            "--codec",
            "cdfl",
            "--jsonl",
        ],
        0,
    );
    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", "chd");
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["status"], "succeeded");

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );
    let probe_json = parse_single_json_line(&probe_output);
    assert_eq!(probe_json["command"], "probe");
    assert_eq!(probe_json["status"], "succeeded");
    assert!(
        probe_json["label"]
            .as_str()
            .expect("label")
            .contains("codec=cdzs+cdzl+cdfl")
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );
}

#[test]
fn chd_compress_rejects_level_for_huffman_codec() {
    let temp = setup_temp_dir();
    let source = (0..16_384)
        .map(|index| (index % 179) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "huffman:3",
            "--jsonl",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["format"], "chd");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("does not accept --level")
    );
}

#[test]
fn chd_compress_rejects_level_for_avhuff_codec() {
    let temp = setup_temp_dir();
    let source = build_test_chav_stream(4, 32, 16);
    fs::write(temp.child("video.bin").path(), &source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("video.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "avhu:3",
            "--jsonl",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["format"], "chd");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("does not accept --level")
    );
}

#[test]
fn chd_extract_selects_cd_outputs() {
    let temp = setup_temp_dir();
    let frames = 8_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 157) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");
    temp.child("disc.cue")
        .write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let selected_bin_out = temp.child("selected-bin");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--select",
            "disc.bin",
            "--output",
            selected_bin_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(selected_bin_out.child("disc.bin").path()).expect("extract bytes"),
        source
    );
    assert!(!selected_bin_out.child("disc.cue").path().exists());

    let selected_cue_out = temp.child("selected-cue");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--select",
            "disc.cue",
            "--output",
            selected_cue_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert!(selected_cue_out.child("disc.cue").path().exists());
    assert_eq!(
        fs::read(selected_cue_out.child("disc.bin").path()).expect("extract bytes"),
        source
    );
}

#[test]
fn chd_extract_selects_raw_output_and_rejects_missing_selection() {
    let temp = setup_temp_dir();
    let source = (0..16_384)
        .map(|index| (index % 223) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--jsonl",
        ],
        0,
    );

    let out_dir = temp.child("selected");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--select",
            "disc.bin",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );

    let missing_output = command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--select",
            "missing.bin",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "chd");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
    );
}

#[test]
fn chd_extract_selecting_gdi_descriptor_includes_tracks() {
    let temp = setup_temp_dir();
    let track01 = (0..(4 * 2352))
        .map(|index| (index % 101) as u8)
        .collect::<Vec<_>>();
    let track02 = (0..(3 * 2048))
        .map(|index| (index % 89) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("track01.bin").path(), &track01).expect("track01");
    fs::write(temp.child("track02.bin").path(), &track02).expect("track02");
    temp.child("disc.gdi")
        .write_str("2\n1 0 4 2352 track01.bin 0\n2 4 4 2048 track02.bin 0\n")
        .expect("gdi fixture");

    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.gdi").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--jsonl",
        ],
        0,
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--select",
            "disc.gdi",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert!(out_dir.child("disc.gdi").path().exists());
    assert_eq!(
        fs::read(out_dir.child("disc (Track 1).bin").path()).expect("extract track01"),
        track01
    );
    assert_eq!(
        fs::read(out_dir.child("disc (Track 2).bin").path()).expect("extract track02"),
        track02
    );
}

#[test]
fn gcz_probe_reports_succeeded() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x6000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_gcz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.gcz").path());

    let output = command_stdout(
        &[
            "probe",
            "--input",
            temp.child("disc.gcz").path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "gcz");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .to_ascii_lowercase()
            .contains("compression")
    );
}

#[test]
fn gcz_extract_round_trips_to_iso() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_gcz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.gcz").path());

    let out_dir = temp.child("extract");
    let output = command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.gcz").path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let events = parse_json_lines(&output);
    assert_running_percent_event(&events, "extract", "gcz");
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "gcz");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );
}

#[test]
fn gcz_extract_supports_single_output_selection() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_gcz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.gcz").path());

    let selected_out = temp.child("selected");
    command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.gcz").path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--output",
            selected_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(selected_out.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );

    let missing_output = command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.gcz").path().to_str().expect("path"),
            "--select",
            "missing.iso",
            "--output",
            selected_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "gcz");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
    );
}

#[test]
fn wbfs_probe_reports_succeeded() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x6000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_wbfs_fixture_from_iso(
        temp.child("disc.iso").path(),
        temp.child("disc.wbfs").path(),
    );

    let output = command_stdout(
        &[
            "probe",
            "--input",
            temp.child("disc.wbfs").path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "wbfs");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .to_ascii_lowercase()
            .contains("compression")
    );
}

#[test]
fn wbfs_extract_round_trips_to_iso() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_wbfs_fixture_from_iso(
        temp.child("disc.iso").path(),
        temp.child("disc.wbfs").path(),
    );

    let out_dir = temp.child("extract");
    let output = command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.wbfs").path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "wbfs");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );
}

#[test]
fn wbfs_extract_supports_single_output_selection() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_wbfs_fixture_from_iso(
        temp.child("disc.iso").path(),
        temp.child("disc.wbfs").path(),
    );

    let out_dir = temp.child("selected");
    command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.wbfs").path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );

    let missing_output = command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.wbfs").path().to_str().expect("path"),
            "--select",
            "missing.iso",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "wbfs");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
    );
}

#[test]
fn wia_probe_reports_succeeded() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x6000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_wia_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.wia").path());

    let output = command_stdout(
        &[
            "probe",
            "--input",
            temp.child("disc.wia").path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "wia");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .to_ascii_lowercase()
            .contains("compression")
    );
}

#[test]
fn wia_extract_supports_single_output_selection() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_wia_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.wia").path());

    let out_dir = temp.child("selected");
    command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.wia").path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );

    let missing_output = command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.wia").path().to_str().expect("path"),
            "--select",
            "missing.iso",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "wia");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
    );
}

fn run_chd_round_trip(input_name: &str, source: &[u8], codec: &str, expected_extract_name: &str) {
    run_chd_round_trip_with_format("chd", input_name, source, codec, expected_extract_name);
}

fn run_chd_round_trip_with_format(
    format: &str,
    input_name: &str,
    source: &[u8],
    codec: &str,
    expected_extract_name: &str,
) {
    let temp = setup_temp_dir();
    fs::write(temp.child(input_name).path(), source).expect("fixture");

    let chd_path = temp.child("disc.chd");
    let compress_output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child(input_name).path().to_str().expect("path"),
            "--format",
            format,
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            codec,
            "--jsonl",
        ],
        0,
    );

    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", "chd");
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], "chd");
    assert_eq!(compress_json["status"], "succeeded");

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let extract_events = parse_json_lines(&extract_output);
    assert_running_percent_event(&extract_events, "extract", "chd");
    let extract_json = extract_events.last().expect("extract terminal event");
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "chd");
    assert_eq!(extract_json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child(expected_extract_name).path()).expect("extract bytes"),
        source
    );
}

fn build_test_chav_stream(frame_count: usize, width: u16, height: u16) -> Vec<u8> {
    let pixels_per_frame = usize::from(width) * usize::from(height) * 2;
    let frame_bytes = 12 + pixels_per_frame;
    let mut data = Vec::with_capacity(frame_count * frame_bytes);
    for frame in 0..frame_count {
        data.extend_from_slice(b"chav");
        data.push(0); // metadata bytes
        data.push(0); // channels
        data.extend_from_slice(&0_u16.to_be_bytes()); // samples per channel
        data.extend_from_slice(&width.to_be_bytes());
        data.extend_from_slice(&height.to_be_bytes());
        for pixel in 0..pixels_per_frame {
            data.push(((frame * 29 + pixel) % 251) as u8);
        }
    }
    data
}

fn write_gcz_fixture_from_iso(iso_path: &Path, gcz_path: &Path) {
    const GCZ_BLOCK_SIZE: usize = 0x8000;
    const GCZ_UNCOMPRESSED_BLOCK_FLAG: u64 = 1 << 63;

    let iso = fs::read(iso_path).expect("read iso fixture");
    let disc_size = iso.len() as u64;
    let block_count = disc_size.div_ceil(GCZ_BLOCK_SIZE as u64) as u32;
    let compressed_size = block_count as u64 * GCZ_BLOCK_SIZE as u64;

    let mut output = File::create(gcz_path).expect("create gcz fixture");
    output
        .write_all(&[0x01, 0xC0, 0x0B, 0xB1])
        .expect("write gcz magic");
    output
        .write_all(&0_u32.to_le_bytes())
        .expect("write gcz disc type");
    output
        .write_all(&compressed_size.to_le_bytes())
        .expect("write gcz compressed size");
    output
        .write_all(&disc_size.to_le_bytes())
        .expect("write gcz disc size");
    output
        .write_all(&(GCZ_BLOCK_SIZE as u32).to_le_bytes())
        .expect("write gcz block size");
    output
        .write_all(&block_count.to_le_bytes())
        .expect("write gcz block count");

    let mut blocks = Vec::with_capacity(block_count as usize);
    let mut data_offset = 0_u64;
    let mut hashes = Vec::with_capacity(block_count as usize);
    for block_index in 0..block_count as usize {
        output
            .write_all(&(data_offset | GCZ_UNCOMPRESSED_BLOCK_FLAG).to_le_bytes())
            .expect("write gcz block map");
        let start = block_index * GCZ_BLOCK_SIZE;
        let end = (start + GCZ_BLOCK_SIZE).min(iso.len());
        let mut block = vec![0_u8; GCZ_BLOCK_SIZE];
        block[..end - start].copy_from_slice(&iso[start..end]);
        hashes.push(adler32(&block));
        data_offset = data_offset.saturating_add(block.len() as u64);
        blocks.push(block);
    }
    for hash in hashes {
        output
            .write_all(&hash.to_le_bytes())
            .expect("write gcz block hash");
    }
    for block in blocks {
        output.write_all(&block).expect("write gcz block");
    }
    output.flush().expect("flush gcz");
}

fn build_pcm_wave(data: &[u8]) -> Vec<u8> {
    let fmt_chunk_size = 16_u32;
    let data_chunk_size = u32::try_from(data.len()).expect("wave data fits");
    let riff_size = 4 + (8 + fmt_chunk_size) + (8 + data_chunk_size);

    let mut bytes = Vec::with_capacity(44 + data.len());
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&riff_size.to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&fmt_chunk_size.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&44_100u32.to_le_bytes());
    bytes.extend_from_slice(&(44_100u32 * 4).to_le_bytes());
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_chunk_size.to_le_bytes());
    bytes.extend_from_slice(data);
    bytes
}

/// `formats --json` advertises each codec's level range, and the named level
/// profiles must resolve to a level every CHD codec accepts (`min` used to map
/// to 0, which CHD zlib/cdzl reject). Levels just outside that range are rejected.
#[test]
fn chd_compress_accepts_advertised_level_range_and_min_profile_for_every_codec() {
    let formats: Value =
        serde_json::from_slice(&command_stdout(&["formats", "--json"], 0)).expect("formats json");
    let chd_codecs = formats["containers"]
        .as_array()
        .expect("containers")
        .iter()
        .find(|format| format["name"] == "chd")
        .expect("chd format")["codecs"]
        .clone();
    let temp = setup_temp_dir();
    fs::write(temp.child("disc.bin").path(), vec![0x5a_u8; 8 * 2352]).expect("fixture");
    temp.child("disc.cue")
        .write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");
    let cue = temp.child("disc.cue");
    let mut checked = 0;
    for codec in formats["codecs"].as_array().expect("codecs") {
        let name = codec["name"].as_str().expect("codec name");
        if !chd_codecs
            .as_array()
            .expect("chd codecs")
            .contains(&Value::from(name))
            || codec["minLevel"].is_null()
        {
            continue;
        }
        let min = codec["minLevel"].as_i64().expect("min");
        let max = codec["maxLevel"].as_i64().expect("max");
        let attempts = [
            (format!("{name}:{min}"), None),
            (format!("{name}:{max}"), None),
            (name.to_string(), Some("min")),
        ];
        for (codec_arg, profile) in &attempts {
            let out = temp.child(format!("{name}.chd"));
            let _ = fs::remove_file(out.path());
            let mut args = vec![
                "compress",
                "--input",
                cue.path().to_str().expect("path"),
                "--output",
                out.path().to_str().expect("path"),
                "--codec",
                codec_arg.as_str(),
                "--quiet",
            ];
            if let Some(profile) = profile {
                args.extend(["--level", profile]);
            }
            command_stdout(&args, 0);
            assert!(out.path().exists(), "{codec_arg} {profile:?}");
        }
        // FLAC also accepts an extended level 9 above its advertised `max` profile (see
        // chd_compress_and_extract_cdfl_with_level_round_trip), so only its lower bound is out of range.
        let above = (!matches!(name, "flac" | "cdfl")).then_some(max + 1);
        for outside in std::iter::once(min - 1).chain(above) {
            let codec_arg = format!("{name}:{outside}");
            let out = temp.child(format!("{name}-outside.chd"));
            command_stdout(
                &[
                    "compress",
                    "--input",
                    cue.path().to_str().expect("path"),
                    "--output",
                    out.path().to_str().expect("path"),
                    "--codec",
                    codec_arg.as_str(),
                    "--quiet",
                ],
                1,
            );
            assert!(!out.path().exists(), "{codec_arg} must be rejected");
        }
        checked += 1;
    }
    assert!(
        checked >= 8,
        "expected every levelled CHD codec, got {checked}"
    );
}

/// Deterministic xorshift32 bytes, so synthetic tracks do not compress away.
fn xorshift_bytes(seed: u32, len: usize) -> Vec<u8> {
    let mut state = seed;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 24) as u8
        })
        .collect()
}

/// Compress a cue whose files hold exactly the given bytes.
fn compress_cue_files(
    files: &[(&str, Vec<u8>)],
    cue: &str,
) -> (assert_fs::TempDir, assert_fs::fixture::ChildPath) {
    let temp = setup_temp_dir();
    for (name, bytes) in files {
        fs::write(temp.child(name).path(), bytes).expect("track");
    }
    temp.child("disc.cue").write_str(cue).expect("cue fixture");
    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--jsonl",
        ],
        0,
    );
    (temp, chd_path)
}

/// The hunk size from a v5 CHD header.
fn chd_hunk_bytes(chd_path: &Path) -> u32 {
    let header = fs::read(chd_path).expect("chd");
    u32::from_be_bytes(header[56..60].try_into().expect("hunk bytes"))
}

/// Label, files, cue, header SHA-1s, extracted cue, merged bin length and SHA-1.
type MixedCueCase<'a> = (
    &'a str,
    Vec<(&'a str, Vec<u8>)>,
    &'a str,
    (&'a str, &'a str),
    &'a str,
    u64,
    &'a str,
);

#[test]
fn chd_mixed_sector_size_cues_match_chdman() {
    // Cue sheets mixing 2048-byte and 2352-byte tracks. chdman 0.289 always
    // writes 19584-byte hunks, keeps the `.cue` track layout, and
    // `extractcd` merges every track into one bin whatever the sector sizes.
    // Reference values come from `chdman createcd` / `extractcd` on the same
    // synthetic files.
    let cases: [MixedCueCase; 3] = [
        (
            "separate files, MODE2/2352 track with INDEX 00",
            vec![
                ("t1.bin", xorshift_bytes(1, 5 * 2048)),
                ("t2.bin", xorshift_bytes(2, 3 * 2352)),
            ],
            "FILE \"t1.bin\" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\nFILE \"t2.bin\" BINARY\n  TRACK 02 MODE2/2352\n    INDEX 00 00:00:00\n    INDEX 01 00:00:01\n",
            (
                "55baa280cd9318ad3609263f5ce745ebc165acd4",
                "3951488ba7c860739752327b7b4cd40f3936e894",
            ),
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n  TRACK 02 MODE2/2352\n    INDEX 00 00:00:05\n    INDEX 01 00:00:06\n",
            17_296,
            "b004a4786951452bbe36d1d31b5199373fb2bb52",
        ),
        (
            "one file shared by a 2048 track and an audio track",
            vec![("disc.bin", xorshift_bytes(3, 5 * 2048 + 6 * 2352))],
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:00:05\n",
            (
                "0cea1dcb1ad6a11bd32a73983aacdc755cdda80c",
                "7c3eebf54bdec197362b9efb7439b0a7cf950fa9",
            ),
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:00:05\n",
            24_352,
            "ed4e3afcbf7d71f788f521adcde7f00d44f7b2e3",
        ),
        (
            "audio track before a 2048 track",
            vec![
                ("t1.bin", xorshift_bytes(4, 5 * 2352)),
                ("t2.bin", xorshift_bytes(5, 7 * 2048)),
            ],
            "FILE \"t1.bin\" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\nFILE \"t2.bin\" BINARY\n  TRACK 02 MODE1/2048\n    INDEX 01 00:00:00\n",
            (
                "2f9d2be9561618e43d35fcef475f65a211dc5a4c",
                "214f7c0cbb345a1900834a8b8c73898359f6d869",
            ),
            "FILE \"disc.bin\" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 MODE1/2048\n    INDEX 01 00:00:05\n",
            26_096,
            "731283f66ae40bd16895ef2d114fa27eb905feed",
        ),
    ];
    for (label, files, cue, (raw_sha1, overall_sha1), extracted_cue, bin_len, bin_sha1) in cases {
        let (temp, chd_path) = compress_cue_files(&files, cue);
        assert_eq!(
            chd_hunk_bytes(chd_path.path()),
            19_584,
            "{label}: hunk bytes"
        );
        assert_eq!(
            chd_header_sha1s(chd_path.path()),
            (raw_sha1.to_string(), overall_sha1.to_string()),
            "{label}: header sha1s"
        );
        let out_dir = temp.child("extract");
        extract_chd_to(chd_path.path(), out_dir.path());
        assert_eq!(
            fs::read_to_string(out_dir.child("disc.cue").path()).expect("cue"),
            extracted_cue,
            "{label}: extracted cue"
        );
        let bin = out_dir.child("disc.bin");
        assert_eq!(
            fs::metadata(bin.path()).expect("bin").len(),
            bin_len,
            "{label}: merged bin length"
        );
        assert_eq!(
            checksum_value(bin.path(), "sha1"),
            bin_sha1,
            "{label}: merged bin sha1"
        );
    }
}

#[test]
fn chd_short_cd_uses_full_hunks_like_chdman() {
    // chdman writes 8-frame hunks even when the whole disc is shorter.
    let (_temp, chd_path) = compress_cue_files(
        &[("disc.bin", xorshift_bytes(9, 5 * 2352))],
        "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
    );
    assert_eq!(chd_hunk_bytes(chd_path.path()), 19_584);
}

#[test]
fn chd_gd_mode2_raw_tracks_extract_to_gdi_like_chdman() {
    // A Redump-style Dreamcast cue with MODE2/2352 data tracks yields MODE2_RAW
    // GD tracks. `chdman extractcd` writes them as `.gdi` type 4, size 2352.
    let (temp, chd_path) = compress_cue_files(
        &[
            ("track01.bin", xorshift_bytes(6, 6 * 2352)),
            ("track02.bin", xorshift_bytes(7, 9 * 2352)),
            ("track03.bin", xorshift_bytes(8, 8 * 2352)),
        ],
        "REM SINGLE-DENSITY AREA\nFILE \"track01.bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\nFILE \"track02.bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\nREM HIGH-DENSITY AREA\nFILE \"track03.bin\" BINARY\n  TRACK 03 MODE2/2352\n    INDEX 01 00:00:00\n",
    );
    assert_eq!(
        chd_header_sha1s(chd_path.path()),
        (
            "18532ed3b52b96d7a8d90b2606bdb5f6c6eaaba7".to_string(),
            "42572e479794caa582fd44a5335230184849bcea".to_string()
        )
    );
    assert!(
        chd_track_metadata_lines(chd_path.path())[0].starts_with("TRACK:1 TYPE:MODE2_RAW"),
        "{:?}",
        chd_track_metadata_lines(chd_path.path())
    );
    let out_dir = temp.child("extract");
    extract_chd_to(chd_path.path(), out_dir.path());
    assert_eq!(
        fs::read_to_string(out_dir.child("disc.gdi").path()).expect("gdi"),
        "3\n1 0 4 2352 \"disc (Track 1).bin\" 0\n2 6 0 2352 \"disc (Track 2).bin\" 0\n3 45000 4 2352 \"disc (Track 3).bin\" 0\n"
    );
    for (track, bytes, sha1) in [
        (1, 14_112, "965c5cc887659b46491d960966f5517b5070e22d"),
        (2, 21_168, "9dfa165cbc0f975c6152966d2429a3dad32276a4"),
        (3, 18_816, "982e6d27794e822db982030ddcc00c826c06342f"),
    ] {
        let path = out_dir.child(format!("disc (Track {track}).bin"));
        assert_eq!(
            fs::metadata(path.path()).expect("track").len(),
            bytes,
            "track {track} size"
        );
        assert_eq!(
            checksum_value(path.path(), "sha1"),
            sha1,
            "track {track} sha1"
        );
    }
}

#[test]
fn chd_cue_track_past_end_of_shared_file_is_rejected_before_compressing() {
    // a.bin holds 5 frames but track 2 starts at frame 50 of the same file, so
    // the previous track's frames already run past the end of the file. This
    // must be a cue validation error, not a mid-compress short read.
    let temp = setup_temp_dir();
    fs::write(temp.child("a.bin").path(), vec![0x11_u8; 5 * 2352]).expect("a.bin");
    fs::write(temp.child("b.bin").path(), vec![0x22_u8; 4 * 2352]).expect("b.bin");
    temp.child("disc.cue")
        .write_str("FILE \"a.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:00:50\nFILE \"b.bin\" BINARY\n  TRACK 03 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue fixture");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            temp.child("disc.chd").path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--jsonl",
        ])
        .output()
        .expect("run compress");
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !output.status.success() && combined.contains("cue track 2 starts past the end of"),
        "expected the early cue validation error `cue track 2 starts past the end of`, got: {combined}"
    );
}

#[test]
fn weave_create_resolves_cd_chd_track_member_with_split_bin_listing() {
    // `weave create --rom-member` lists and extracts CHD tracks through
    // source_resolution with split_bin=true, so `<stem> (Track N).bin` names
    // must be listed even for a plain CD CHD.
    let (temp, chd_path) = compress_synthetic_cue(
        &[("a.bin", 6), ("b.bin", 6)],
        "FILE \"a.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"b.bin\" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n",
    );
    let patch = temp.child("p.ips");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![0xAA],
            }],
            None,
        ),
    )
    .expect("ips fixture");
    let output = temp.child("out.weave");
    let create = run_single_json_event(
        &[
            "weave",
            "create",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--rom-member",
            "disc (Track 2).bin",
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    assert_eq!(create["status"], "succeeded", "{create}");
    assert!(output.path().exists());
}
