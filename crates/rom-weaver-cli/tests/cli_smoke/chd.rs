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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
        ],
        0,
    );

    let json = run_single_json_event(
        &["probe", "--input", chd_path.path().to_str().expect("path"), "--json"],
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
            "--json",
        ],
        0,
    );

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--json",
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
            "--json",
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
                "--json",
            ],
            0,
        );

        let probe_output = command_stdout(
            &[
                "probe",
                "--input",
                chd_path.path().to_str().expect("path"),
                "--no-extract",
                "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
        ],
        0,
    );

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--json",
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
            "--json",
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
            "--json",
        ],
        0,
    );

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--json",
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
            "--json",
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
            "--json",
        ],
        0,
    );
    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            gd_chd.path().to_str().expect("path"),
            "--no-extract",
            "--json",
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
            "--json",
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
            "--json",
        ],
        0,
    );

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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
            "--json",
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

// ---- relocated from shared.rs (single-module helpers) ----

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
            "--json",
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
            "--json",
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
