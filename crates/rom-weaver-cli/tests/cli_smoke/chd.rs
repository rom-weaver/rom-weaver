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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ])
        .assert()
        .code(0);

    let expected_sha1 = checksum_value(temp.child("disc.bin").path(), "sha1");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            chd_path.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-trim-fix",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "cdlz",
            "--json",
        ])
        .assert()
        .code(0);

    let expected_sha1 = checksum_value(temp.child("disc.bin").path(), "sha1");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            chd_path.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--select",
            "disc.bin",
            "--no-trim-fix",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("video.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "avhuff",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    assert_eq!(
        fs::read(out_dir.child("disc.avi").path()).expect("extract bytes"),
        source
    );
    let inspect_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let inspect_json = parse_single_json_line(&inspect_output);
    assert!(
        inspect_json["label"]
            .as_str()
            .expect("label")
            .contains("codec=avhuff")
    );
    assert!(
        inspect_json["label"]
            .as_str()
            .expect("label")
            .contains("sha1=")
    );
    assert!(
        inspect_json["label"]
            .as_str()
            .expect("label")
            .contains("raw_sha1=")
    );
    assert!(
        inspect_json["details"]["chd"]["sha1"]
            .as_str()
            .expect("sha1 detail")
            .len()
            == 40
    );
    assert!(
        inspect_json["details"]["chd"]["raw_sha1"]
            .as_str()
            .expect("raw sha1 detail")
            .len()
            == 40
    );

    let alias_chd_path = temp.child("disc-alias.chd");
    let alias_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("video.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            alias_chd_path.path().to_str().expect("path"),
            "--codec",
            "avhu",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "huffman",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert!(json["label"].as_str().expect("label").contains("huff"));
    assert!(!json["label"].as_str().expect("label").contains("huffman"));

    let inspect_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let inspect_json = parse_single_json_line(&inspect_output);
    assert!(
        inspect_json["label"]
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
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", "chd");
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["format"], "chd");
    assert_eq!(compress_json["status"], "succeeded");

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract-split");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--split-bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
        out_dir.child("disc.track01.bin").path(),
        Some("bin"),
    );
    assert_emitted_file(
        extract_json,
        out_dir.child("disc.track02.bin").path(),
        Some("bin"),
    );
    let label = extract_json["label"].as_str().expect("label");
    assert!(label.contains("splitbin=true"));
    assert!(label.contains("emitted_files=disc.cue,disc.track01.bin,disc.track02.bin"));

    assert!(out_dir.child("disc.cue").path().exists());
    assert!(out_dir.child("disc.track01.bin").path().exists());
    assert!(out_dir.child("disc.track02.bin").path().exists());
    assert!(!out_dir.child("disc.bin").path().exists());
    let cue = fs::read_to_string(out_dir.child("disc.cue").path()).expect("cue output");
    assert!(cue.contains("FILE \"disc.track01.bin\" BINARY"));
    assert!(cue.contains("FILE \"disc.track02.bin\" BINARY"));
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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract-selected-cue");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--split-bin",
            "--select",
            "disc.cue",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let extract_json = parse_single_json_line(&extract_output);
    assert_eq!(extract_json["format"], "chd");
    assert_eq!(extract_json["status"], "succeeded");
    let label = extract_json["label"].as_str().expect("label");
    assert!(label.contains("splitbin=true"));

    assert!(out_dir.child("disc.cue").path().exists());
    assert!(out_dir.child("disc.track01.bin").path().exists());
    assert!(out_dir.child("disc.track02.bin").path().exists());
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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("selected");
    let missing_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--split-bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zlib",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("out");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--split-bin",
            "--select",
            "disc.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.gdi").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(out_dir.child("disc.track01.bin").path()).expect("extract track01"),
        track01
    );
    assert_eq!(
        fs::read(out_dir.child("disc.track02.bin").path()).expect("extract track02"),
        track02
    );
    let gdi = fs::read_to_string(out_dir.child("disc.gdi").path()).expect("gdi output");
    assert!(gdi.contains("2\n"));
    assert!(gdi.contains("1 0 4 2352 disc.track01.bin 0"));
    assert!(gdi.contains("2 4 4 2048 disc.track02.bin 0"));
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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "cdlz",
            "--json",
        ])
        .assert()
        .code(0);

    let inspect_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let inspect_json = parse_single_json_line(&inspect_output);
    assert_eq!(inspect_json["command"], "inspect");
    assert_eq!(inspect_json["status"], "succeeded");
    assert!(
        inspect_json["label"]
            .as_str()
            .expect("label")
            .contains("codec=cdlz")
    );

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "cdfl:9",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

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
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", "chd");
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["status"], "succeeded");

    let inspect_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            chd_path.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let inspect_json = parse_single_json_line(&inspect_output);
    assert_eq!(inspect_json["command"], "inspect");
    assert_eq!(inspect_json["status"], "succeeded");
    assert!(
        inspect_json["label"]
            .as_str()
            .expect("label")
            .contains("codec=cdzs+cdzl+cdfl")
    );

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

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
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "huffman:3",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

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
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("video.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "avhu:3",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ])
        .assert()
        .code(0);

    let selected_bin_out = temp.child("selected-bin");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--select",
            "disc.bin",
            "--out-dir",
            selected_bin_out.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(selected_bin_out.child("disc.bin").path()).expect("extract bytes"),
        source
    );
    assert!(!selected_bin_out.child("disc.cue").path().exists());

    let selected_cue_out = temp.child("selected-cue");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--select",
            "disc.cue",
            "--out-dir",
            selected_cue_out.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.bin").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("selected");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--select",
            "disc.bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("extract bytes"),
        source
    );

    let missing_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--select",
            "missing.bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.gdi").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "lzma",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            chd_path.path().to_str().expect("path"),
            "--select",
            "disc.gdi",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert!(out_dir.child("disc.gdi").path().exists());
    assert_eq!(
        fs::read(out_dir.child("disc.track01.bin").path()).expect("extract track01"),
        track01
    );
    assert_eq!(
        fs::read(out_dir.child("disc.track02.bin").path()).expect("extract track02"),
        track02
    );
}

#[test]
fn gcz_inspect_reports_succeeded() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x6000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_gcz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.gcz").path());

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("disc.gcz").path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
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
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.gcz").path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.gcz").path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--out-dir",
            selected_out.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(selected_out.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );

    let missing_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.gcz").path().to_str().expect("path"),
            "--select",
            "missing.iso",
            "--out-dir",
            selected_out.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
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
fn wbfs_inspect_reports_succeeded() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x6000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_wbfs_fixture_from_iso(
        temp.child("disc.iso").path(),
        temp.child("disc.wbfs").path(),
    );

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("disc.wbfs").path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
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
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.wbfs").path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.wbfs").path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );

    let missing_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.wbfs").path().to_str().expect("path"),
            "--select",
            "missing.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
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
fn wia_inspect_reports_succeeded() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x6000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_wia_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.wia").path());

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("disc.wia").path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.wia").path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );

    let missing_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.wia").path().to_str().expect("path"),
            "--select",
            "missing.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
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
