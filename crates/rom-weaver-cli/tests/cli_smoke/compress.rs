#[test]
fn compress_routes_through_registered_container_format() {
    let temp = setup_temp_dir();
    temp.child("file.bin")
        .write_str("payload")
        .expect("fixture");
    let output_path = temp.child("out.zip");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("file.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    let emitted = json["details"]["emitted_files"]
        .as_array()
        .expect("emitted_files array");
    assert_eq!(emitted.len(), 1);
    assert_emitted_file(&json, output_path.path(), Some("archive"));
    assert!(output_path.path().exists());
}

#[test]
fn compress_gcz_warns_and_rejects_output() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x4000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    let output_path = temp.child("out.gcz");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "gcz",
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let events = parse_json_lines(&output);
    assert_running_percent_event(&events, "compress", "gcz");
    let json = events.last().expect("compress terminal event");
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "gcz");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("warning: gcz compression is not supported"));
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("--format rvz"));
    assert!(!output_path.path().exists());
}

#[test]
fn compress_wbfs_and_extract_round_trip() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x7000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    let wbfs_path = temp.child("disc.wbfs");

    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "wbfs",
            "--output",
            wbfs_path.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", "wbfs");
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], "wbfs");
    assert_eq!(compress_json["requested_threads"], 8);
    assert_eq!(compress_json["effective_threads"], 8);
    assert_eq!(compress_json["used_parallelism"], true);
    assert_eq!(compress_json["status"], "succeeded");
    assert!(wbfs_path.path().exists());

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            wbfs_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let extract_events = parse_json_lines(&extract_output);
    assert_running_percent_event(&extract_events, "extract", "wbfs");
    let extract_json = extract_events.last().expect("extract terminal event");
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "wbfs");
    assert_eq!(extract_json["requested_threads"], 8);
    assert_eq!(extract_json["effective_threads"], 8);
    assert_eq!(extract_json["used_parallelism"], true);
    assert_eq!(extract_json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );
}

#[test]
fn compress_cso_and_extract_round_trip() {
    let temp = setup_temp_dir();
    let mut iso_bytes = (0..(2 * 1024 * 4))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    if let Some(last) = iso_bytes.last_mut() {
        *last = 0;
    }
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    let cso_path = temp.child("disc.cso");

    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "cso",
            "--output",
            cso_path.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", "cso");
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], "cso");
    assert_eq!(compress_json["requested_threads"], 8);
    assert_eq!(compress_json["effective_threads"], 1);
    assert_eq!(compress_json["used_parallelism"], false);
    assert_eq!(compress_json["status"], "succeeded");
    assert!(cso_path.path().exists());

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            cso_path.path().to_str().expect("path"),
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
    assert_running_percent_event(&extract_events, "extract", "cso");
    let extract_json = extract_events.last().expect("extract terminal event");
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "cso");
    assert_eq!(extract_json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );
}

#[test]
fn compress_wia_and_extract_round_trip() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x7000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    let wia_path = temp.child("disc.wia");

    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "wia",
            "--output",
            wia_path.path().to_str().expect("path"),
            "--codec",
            "lzma2",
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", "wia");
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], "wia");
    assert_eq!(compress_json["requested_threads"], 8);
    assert_eq!(compress_json["effective_threads"], 8);
    assert_eq!(compress_json["used_parallelism"], true);
    assert_eq!(compress_json["status"], "succeeded");
    assert!(wia_path.path().exists());

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            wia_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let extract_events = parse_json_lines(&extract_output);
    assert_running_percent_event(&extract_events, "extract", "wia");
    let extract_json = extract_events.last().expect("extract terminal event");
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "wia");
    assert_eq!(extract_json["requested_threads"], 8);
    assert_eq!(extract_json["effective_threads"], 8);
    assert_eq!(extract_json["used_parallelism"], true);
    assert_eq!(extract_json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );
}

#[test]
fn compress_nfs_warns_and_rejects_output() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x4000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    let output_path = temp.child("out.nfs");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "nfs",
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let events = parse_json_lines(&output);
    assert_running_percent_event(&events, "compress", "nfs");
    let json = events.last().expect("compress terminal event");
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "nfs");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("nfs compression is not supported"));
    assert!(!output_path.path().exists());
}

#[test]
fn compress_tgc_routes_through_handler_and_reports_invalid_source() {
    let temp = setup_temp_dir();
    let source = temp.child("source.iso");
    fs::write(source.path(), build_test_gamecube_iso(0x4000)).expect("fixture");
    let output_path = temp.child("out.tgc");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            source.path().to_str().expect("path"),
            "--format",
            "tgc",
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let events = parse_json_lines(&output);
    assert_running_percent_event(&events, "compress", "tgc");
    let json = events.last().expect("compress terminal event");
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "tgc");
    assert_eq!(json["status"], "failed");
    let label = json["label"].as_str().expect("label").to_ascii_lowercase();
    assert!(
        label.contains("tgc writer") || label.contains("reading gcm header"),
        "unexpected label: {label}"
    );
}

#[test]
fn extract_nfs_invalid_source_emits_running_progress() {
    let temp = setup_temp_dir();
    fs::write(temp.child("disc.nfs").path(), b"not-a-real-nfs").expect("fixture");
    let out_dir = temp.child("extract");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.nfs").path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let events = parse_json_lines(&output);
    assert_running_percent_event(&events, "extract", "nfs");
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "nfs");
    assert_eq!(json["status"], "failed");
}

#[test]
fn extract_tgc_invalid_source_emits_running_progress() {
    let temp = setup_temp_dir();
    fs::write(temp.child("disc.tgc").path(), b"not-a-real-tgc").expect("fixture");
    let out_dir = temp.child("extract");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.tgc").path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let events = parse_json_lines(&output);
    assert_running_percent_event(&events, "extract", "tgc");
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "tgc");
    assert_eq!(json["status"], "failed");
}

#[test]
fn extract_xiso_invalid_source_emits_running_progress() {
    let temp = setup_temp_dir();
    fs::write(temp.child("disc.xiso").path(), b"not-a-real-xiso").expect("fixture");
    let out_dir = temp.child("extract");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("disc.xiso").path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let events = parse_json_lines(&output);
    assert_running_percent_event(&events, "extract", "xiso");
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "xiso");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("is not an Xbox XDVDFS image"));
}

#[test]
fn compress_rejects_unregistered_output_format() {
    let temp = setup_temp_dir();
    let source = temp.child("source.bin");
    fs::write(source.path(), [0_u8; 16]).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            source.path().to_str().expect("path"),
            "--format",
            "not-a-format",
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("requested output format is not registered"));
}

#[test]
fn compress_auto_mode_selects_chd_for_unrecognized_iso() {
    let temp = setup_temp_dir();
    let source_path = temp.child("source.iso");
    let payload = (0..(256 * 1024))
        .map(|index| ((index * 17) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(source_path.path(), payload).expect("fixture");
    let output_path = temp.child("out.chd");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            source_path.path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "chd");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("auto format=chd"));
    assert!(label.contains("reason=not-wii-gc-or-unrecognized"));
}

#[test]
fn compress_without_format_auto_selects_rvz_for_disc_like_inputs() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("source.iso").path(),
        build_test_gamecube_iso(512 * 1024),
    )
    .expect("fixture");
    let output_path = temp.child("out.rvz");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source.iso").path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("auto format=rvz"));
    assert!(label.contains("reason=wii-gc-disc"));
    assert!(output_path.path().exists());
}

#[test]
fn compress_without_format_auto_selects_rvz_for_wbfs_inputs() {
    let temp = setup_temp_dir();
    let source_iso = temp.child("source.iso");
    fs::write(source_iso.path(), build_test_gamecube_iso(512 * 1024)).expect("fixture");
    let source_wbfs = temp.child("source.wbfs");
    write_wbfs_fixture_from_iso(source_iso.path(), source_wbfs.path());
    let output_path = temp.child("out.rvz");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            source_wbfs.path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("auto format=rvz"));
    assert!(label.contains("reason=wii-gc-disc"));
    assert!(output_path.path().exists());
}

#[test]
fn compress_without_format_auto_selects_rvz_for_wia_inputs() {
    let temp = setup_temp_dir();
    let source_iso = temp.child("source.iso");
    fs::write(source_iso.path(), build_test_gamecube_iso(512 * 1024)).expect("fixture");
    let source_wia = temp.child("source.wia");
    write_wia_fixture_from_iso(source_iso.path(), source_wia.path());
    let output_path = temp.child("out.rvz");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            source_wia.path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("auto format=rvz"));
    assert!(label.contains("reason=wii-gc-disc"));
    assert!(output_path.path().exists());
}

#[test]
fn compress_with_explicit_auto_format_selects_rvz_for_disc_like_inputs() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("source.iso").path(),
        build_test_gamecube_iso(512 * 1024),
    )
    .expect("fixture");
    let output_path = temp.child("out.rvz");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source.iso").path().to_str().expect("path"),
            "--format",
            "auto",
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("auto format=rvz"));
    assert!(label.contains("reason=wii-gc-disc"));
    assert!(output_path.path().exists());
}

#[test]
fn compress_without_format_auto_selects_chd_for_non_disc_inputs() {
    let temp = setup_temp_dir();
    let payload = (0..(256 * 1024))
        .map(|index| ((index * 13) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("source.bin").path(), payload).expect("fixture");
    let output_path = temp.child("out.chd");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source.bin").path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "chd");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("auto format=chd"));
    assert!(label.contains("reason=not-wii-gc-or-unrecognized"));
    assert!(output_path.path().exists());
}

#[test]
fn compress_auto_mode_rejects_multiple_inputs_without_explicit_format() {
    let temp = setup_temp_dir();
    fs::write(temp.child("source-a.bin").path(), b"a").expect("fixture");
    fs::write(temp.child("source-b.bin").path(), b"b").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source-a.bin").path().to_str().expect("path"),
            temp.child("source-b.bin").path().to_str().expect("path"),
            "--output",
            temp.child("out.auto").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "auto");
    assert_eq!(json["stage"], "validate");
    assert_eq!(json["status"], "failed");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("requires exactly one input file"));
    assert!(label.contains("--format"));
}

#[test]
fn compress_rejects_wua_output_format() {
    let temp = setup_temp_dir();
    fs::write(temp.child("source.bin").path(), [1_u8; 64]).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source.bin").path().to_str().expect("path"),
            "--format",
            "wua",
            "--output",
            temp.child("out.wua").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "wua");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("requested output format is not registered"));
}

#[test]
fn compress_rejects_invalid_codec_level_value() {
    let temp = setup_temp_dir();
    temp.child("file.bin")
        .write_str("payload")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("file.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            temp.child("out.zip").path().to_str().expect("path"),
            "--codec",
            "deflate:fast",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("not a valid integer"));
}

#[test]
fn compress_accepts_global_level_profiles() {
    let profiles = [
        "min",
        "very-low",
        "low",
        "medium",
        "high",
        "very-high",
        "max",
    ];
    for profile in profiles {
        let temp = setup_temp_dir();
        fs::write(temp.child("payload.bin").path(), vec![0x41; 16 * 1024]).expect("fixture");
        let output_path = temp.child(format!("out-{profile}.zst"));

        let output = Command::cargo_bin("rom-weaver")
            .expect("binary")
            .args([
                "compress",
                temp.child("payload.bin").path().to_str().expect("path"),
                "--format",
                "zst",
                "--output",
                output_path.path().to_str().expect("path"),
                "--level",
                profile,
                "--json",
            ])
            .assert()
            .code(0)
            .get_output()
            .stdout
            .clone();

        let json = parse_single_json_line(&output);
        assert_eq!(json["command"], "compress");
        assert_eq!(json["family"], "container");
        assert_eq!(json["format"], "zst");
        assert_eq!(json["status"], "succeeded");
    }
}

#[test]
fn compress_defaults_to_max_global_level_profile() {
    let temp = setup_temp_dir();
    let payload = vec![0x5A; 64 * 1024];
    fs::write(temp.child("payload.bin").path(), &payload).expect("fixture");

    let default_output = temp.child("default.zst");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("payload.bin").path().to_str().expect("path"),
            "--format",
            "zst",
            "--output",
            default_output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let explicit_output = temp.child("explicit-max.zst");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("payload.bin").path().to_str().expect("path"),
            "--format",
            "zst",
            "--output",
            explicit_output.path().to_str().expect("path"),
            "--level",
            "max",
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(
        fs::read(default_output.path()).expect("default output"),
        fs::read(explicit_output.path()).expect("explicit output")
    );
}

fn run_archive_round_trip(format: &str, archive_name: &str, codec: Option<&str>) {
    let temp = setup_temp_dir();
    let payload = (0..8192)
        .map(|index| ((index * 7) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("source.bin").path(), &payload).expect("fixture");

    let archive = temp.child(archive_name);
    let mut compress = Command::cargo_bin("rom-weaver").expect("binary");
    compress
        .arg("compress")
        .arg(temp.child("source.bin").path())
        .arg("--format")
        .arg(format)
        .arg("--output")
        .arg(archive.path());
    if let Some(codec) = codec {
        compress.arg("--codec").arg(codec);
    }
    compress.arg("--json");
    let compress_output = compress.assert().code(0).get_output().stdout.clone();

    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", format);
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], format);
    assert_eq!(compress_json["status"], "succeeded");

    let probe_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "probe",
            archive.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let probe_json = parse_single_json_line(&probe_output);
    assert_eq!(probe_json["command"], "probe");
    assert_eq!(probe_json["family"], "container");
    assert_eq!(probe_json["format"], format);
    assert_eq!(probe_json["status"], "succeeded");

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "source.bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let extract_events = parse_json_lines(&extract_output);
    assert_running_percent_event(&extract_events, "extract", format);
    let extract_json = extract_events.last().expect("extract terminal event");
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], format);
    assert_eq!(extract_json["requested_threads"], 8);
    let effective_threads = extract_json["effective_threads"]
        .as_u64()
        .expect("effective_threads");
    assert!((1..=8).contains(&effective_threads));
    assert_eq!(extract_json["thread_mode"], "fixed");
    assert_eq!(extract_json["used_parallelism"], effective_threads > 1);
    assert_eq!(extract_json["status"], "succeeded");

    let extracted = fs::read(out_dir.child("source.bin").path()).expect("read extract");
    assert_eq!(extracted, payload);
}

#[test]
fn archive_container_formats_round_trip() {
    let cases = [
        ("zip", "sample.zip", None),
        ("zipx", "sample.zipx", Some("zstd")),
        ("7z", "sample.7z", Some("lzma2")),
        ("7z", "sample-level.7z", Some("lzma")),
        ("tar", "sample.tar", None),
        ("tar.gz", "sample.tar.gz", Some("gzip")),
        ("tar.bz2", "sample.tar.bz2", Some("bzip2")),
        ("tar.xz", "sample.tar.xz", Some("xz")),
        ("tar.xz", "sample-lzma2.tar.xz", Some("lzma2")),
        ("gz", "source.bin.gz", Some("gzip")),
        ("bz2", "source.bin.bz2", Some("bzip2")),
        ("xz", "source.bin.xz", Some("xz")),
        ("xz", "source.bin.xz", Some("lzma2")),
        ("zst", "source.bin.zst", Some("zstd")),
    ];

    for (format, archive_name, codec) in cases {
        run_archive_round_trip(format, archive_name, codec);
    }
}

#[test]
fn stream_formats_emit_incremental_running_progress() {
    let cases = [
        ("gz", "source.bin.gz", Some("gzip")),
        ("bz2", "source.bin.bz2", Some("bzip2")),
        ("xz", "source.bin.xz", Some("xz")),
        ("zst", "source.bin.zst", Some("zstd")),
    ];

    for (format, archive_name, codec) in cases {
        let temp = setup_temp_dir();
        let payload = (0..(512 * 1024))
            .map(|index| ((index * 13) % 251) as u8)
            .collect::<Vec<_>>();
        fs::write(temp.child("source.bin").path(), &payload).expect("fixture");
        let archive = temp.child(archive_name);

        let mut compress = Command::cargo_bin("rom-weaver").expect("binary");
        compress
            .arg("compress")
            .arg(temp.child("source.bin").path())
            .arg("--format")
            .arg(format)
            .arg("--output")
            .arg(archive.path())
            .arg("--threads")
            .arg("8");
        if let Some(codec) = codec {
            compress.arg("--codec").arg(codec);
        }
        compress.arg("--json");
        let compress_output = compress.assert().code(0).get_output().stdout.clone();
        let compress_events = parse_json_lines(&compress_output);
        assert_unique_integer_running_progress(
            &compress_events,
            "compress",
            format,
            &format!("creating `{format}`"),
        );
        let compress_json = compress_events.last().expect("compress terminal event");
        assert_eq!(compress_json["status"], "succeeded");

        let out_dir = temp.child("extract");
        let extract_output = Command::cargo_bin("rom-weaver")
            .expect("binary")
            .args([
                "extract",
                archive.path().to_str().expect("path"),
                "--select",
                "source.bin",
                "--out-dir",
                out_dir.path().to_str().expect("path"),
                "--threads",
                "8",
                "--json",
            ])
            .assert()
            .code(0)
            .get_output()
            .stdout
            .clone();

        let extract_events = parse_json_lines(&extract_output);
        assert_unique_integer_running_progress(
            &extract_events,
            "extract",
            format,
            &format!("extracting `{format}`"),
        );
        let extract_json = extract_events.last().expect("extract terminal event");
        assert_eq!(extract_json["status"], "succeeded");
        assert_eq!(
            fs::read(out_dir.child("source.bin").path()).expect("read extract"),
            payload
        );
    }
}

#[test]
fn extract_xz_reports_parallel_decode_threads() {
    let temp = setup_temp_dir();
    let payload = (0..131_072)
        .map(|index| ((index * 11) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("source.bin").path(), &payload).expect("fixture");
    let archive = temp.child("source.bin.xz");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source.bin").path().to_str().expect("path"),
            "--format",
            "xz",
            "--output",
            archive.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "source.bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let events = parse_json_lines(&output);
    assert_running_percent_event(&events, "extract", "xz");
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "xz");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 8);
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("source.bin").path()).expect("extracted"),
        payload
    );
}

#[test]
fn extract_zst_reports_parallel_decode_threads() {
    let temp = setup_temp_dir();
    let payload = (0..131_072)
        .map(|index| ((index * 17) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("source.bin").path(), &payload).expect("fixture");
    let archive = temp.child("source.bin.zst");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("source.bin").path().to_str().expect("path"),
            "--format",
            "zst",
            "--output",
            archive.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "source.bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let events = parse_json_lines(&output);
    assert_running_percent_event(&events, "extract", "zst");
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zst");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 8);
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("source.bin").path()).expect("extracted"),
        payload
    );
}

#[test]
fn tar_gz_emits_incremental_running_progress() {
    let temp = setup_temp_dir();
    let input_dir = temp.child("input");
    fs::create_dir_all(input_dir.path()).expect("input dir");
    for index in 0..4usize {
        let payload = vec![index as u8; 8_192 + index * 1_024];
        fs::write(input_dir.child(format!("file-{index}.bin")).path(), payload).expect("fixture");
    }

    let archive = temp.child("sample.tar.gz");
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            input_dir.path().to_str().expect("path"),
            "--format",
            "tar.gz",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let compress_events = parse_json_lines(&compress_output);
    assert!(
        compress_events.iter().any(|event| {
            event["command"] == "compress"
                && event["status"] == "running"
                && event["format"] == "tar.gz"
                && event["percent"]
                    .as_f64()
                    .map(|percent| percent > 0.0 && percent < 100.0)
                    .unwrap_or(false)
        }),
        "expected tar.gz compress to emit running progress between 0 and 100"
    );

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
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
    assert!(
        extract_events.iter().any(|event| {
            event["command"] == "extract"
                && event["status"] == "running"
                && event["format"] == "tar.gz"
                && event["percent"]
                    .as_f64()
                    .map(|percent| percent > 0.0 && percent < 100.0)
                    .unwrap_or(false)
        }),
        "expected tar.gz extract to emit running progress between 0 and 100"
    );
}

#[test]
fn zip_emits_incremental_running_progress_beyond_placeholders() {
    let temp = setup_temp_dir();
    let input_dir = temp.child("input");
    fs::create_dir_all(input_dir.path()).expect("input dir");
    for index in 0..3usize {
        let payload = vec![index as u8; 10_240 + (index * 2_048)];
        fs::write(input_dir.child(format!("file-{index}.bin")).path(), payload).expect("fixture");
    }

    let archive = temp.child("sample.zip");
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            input_dir.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let compress_events = parse_json_lines(&compress_output);
    assert!(compress_events.iter().any(|event| {
        event["command"] == "compress"
            && event["status"] == "running"
            && event["format"] == "zip"
            && event["stage"] == "write"
            && event["percent"].is_null()
            && event["details"]["compressedBytesWritten"]
                .as_u64()
                .map(|bytes| bytes > 0)
                .unwrap_or(false)
    }));
    assert!(!compress_events.iter().any(|event| {
        event["command"] == "compress"
            && event["status"] == "running"
            && event["format"] == "zip"
            && event["stage"] == "create"
            && event["percent"].as_f64() == Some(100.0)
    }));

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
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
    assert_running_percent_event_in_range(&extract_events, "extract", "zip", 1.0, 95.0);
}

#[test]
fn seven_z_does_not_emit_synthetic_running_progress() {
    let temp = setup_temp_dir();
    let input_dir = temp.child("input");
    fs::create_dir_all(input_dir.path()).expect("input dir");
    for index in 0..3usize {
        let payload: Vec<u8> = (0..(2 * 1024 * 1024 + index * 1024))
            .map(|offset| ((offset + index) % 251) as u8)
            .collect();
        fs::write(input_dir.child(format!("file-{index}.bin")).path(), payload).expect("fixture");
    }

    let archive = temp.child("sample.7z");
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            input_dir.path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            archive.path().to_str().expect("path"),
            "--codec",
            "lzma2",
            "--threads",
            "10",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let compress_events = parse_json_lines(&compress_output);
    assert!(compress_events.iter().any(|event| {
        event["command"] == "compress"
            && event["status"] == "running"
            && event["format"] == "7z"
            && event["stage"] == "write"
            && event["percent"].is_null()
            && event["details"]["compressedBytesWritten"]
                .as_u64()
                .map(|bytes| bytes > 0)
                .unwrap_or(false)
    }));
    assert!(!compress_events.iter().any(|event| {
        event["command"] == "compress"
            && event["status"] == "running"
            && event["format"] == "7z"
            && event["label"] == "finalizing `7z` archive"
            && event["percent"].as_f64() == Some(99.0)
    }));
    assert!(!compress_events.iter().any(|event| {
        event["command"] == "compress"
            && event["status"] == "running"
            && event["format"] == "7z"
            && event["stage"] == "create"
            && event["percent"]
                .as_f64()
                .map(|percent| percent >= 99.0)
                .unwrap_or(false)
    }));

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
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
    assert_running_percent_event_in_range(&extract_events, "extract", "7z", 1.0, 95.0);
}

#[test]
fn tar_gz_single_large_file_emits_running_progress_before_completion() {
    let temp = setup_temp_dir();
    let payload = (0..(4 * 1024 * 1024))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    let source_path = temp.child("single.bin");
    fs::write(source_path.path(), &payload).expect("fixture");

    let archive = temp.child("single.tar.gz");
    let compress_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            source_path.path().to_str().expect("path"),
            "--format",
            "tar.gz",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event_in_range(&compress_events, "compress", "tar.gz", 0.0, 100.0);
    assert_unique_integer_running_progress(&compress_events, "compress", "tar.gz", "creating `");

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
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
    assert_running_percent_event_in_range(&extract_events, "extract", "tar.gz", 0.0, 100.0);
    assert_unique_integer_running_progress(&extract_events, "extract", "tar.gz", "extracting `");
}

#[test]
fn extract_recursively_handles_nested_containers() {
    let temp = setup_temp_dir();
    let payload = (0..24_576)
        .map(|index| (index % 197) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &payload).expect("fixture");

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

    let zip_path = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            chd_path.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            zip_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let seven_z_path = temp.child("outer.7z");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            zip_path.path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            seven_z_path.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract");
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            seven_z_path.path().to_str().expect("path"),
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
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "7z");
    assert_eq!(extract_json["status"], "succeeded");
    assert!(extract_json["label"]
        .as_str()
        .expect("label")
        .contains("recursively extracted 2 nested container(s)"));

    assert_eq!(
        fs::read(out_dir.child("inner/disc/disc.bin").path()).expect("nested extract payload"),
        payload
    );
}

#[test]
fn extract_nested_scan_ignores_existing_output_archives() {
    let temp = setup_temp_dir();
    let out_dir = temp.child("extract");
    fs::create_dir_all(out_dir.path()).expect("extract dir");

    fs::write(temp.child("fresh.bin").path(), b"fresh payload").expect("fresh fixture");
    let fresh_archive = temp.child("fresh.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("fresh.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            fresh_archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    fs::write(temp.child("stale.bin").path(), b"stale payload").expect("stale fixture");
    let stale_archive = out_dir.child("stale.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("stale.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            stale_archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            fresh_archive.path().to_str().expect("path"),
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
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["status"], "succeeded");
    assert!(!extract_json["label"]
        .as_str()
        .expect("label")
        .contains("recursively extracted"));
    assert_eq!(
        fs::read(out_dir.child("fresh.bin").path()).expect("fresh extract"),
        b"fresh payload"
    );
    assert!(stale_archive.path().exists());
    assert!(!out_dir.child("stale/stale.bin").path().exists());
}
