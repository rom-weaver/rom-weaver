use super::shared::*;

#[test]
fn compress_routes_through_registered_container_format() {
    let temp = setup_temp_dir();
    temp.child("file.bin")
        .write_str("payload")
        .expect("fixture");
    let output_path = temp.child("out.zip");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("file.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

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

fn assert_no_compressed_write_progress(events: &[Value], format: &str) {
    assert!(
        !events.iter().any(|event| {
            event["command"] == "compress"
                && event["status"] == "running"
                && event["format"] == format
                && event["stage"] == "write"
                && event["details"]["compressedBytesWritten"]
                    .as_u64()
                    .is_some()
        }),
        "expected {format} compression byte telemetry to stay out of progress events"
    );
}

fn assert_compress_extract_only_rejection(format: &str, output_name: &str) {
    let temp = setup_temp_dir();
    fs::write(temp.child("source.bin").path(), b"payload").expect("fixture");
    let output_path = temp.child(output_name);

    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("source.bin").path().to_str().expect("path"),
            "--format",
            format,
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], format);
    assert_eq!(json["stage"], "validate");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("extract-only")
    );
    assert!(!output_path.path().exists());
}

#[test]
fn compress_gcz_rejects_extract_only_output() {
    assert_compress_extract_only_rejection("gcz", "out.gcz");
}

#[test]
fn compress_wbfs_rejects_create_but_extract_round_trips() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x7000);
    let iso_path = temp.child("disc.iso");
    fs::write(iso_path.path(), &iso_bytes).expect("iso fixture");
    let wbfs_path = temp.child("disc.wbfs");

    assert_compress_extract_only_rejection("wbfs", "out.wbfs");
    write_wbfs_fixture_from_iso(iso_path.path(), wbfs_path.path());

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            wbfs_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

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
fn compress_cso_rejects_extract_only_output() {
    assert_compress_extract_only_rejection("cso", "out.cso");
}

#[test]
fn compress_wia_rejects_create_but_extract_round_trips() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x7000);
    let iso_path = temp.child("disc.iso");
    fs::write(iso_path.path(), &iso_bytes).expect("iso fixture");
    let wia_path = temp.child("disc.wia");

    assert_compress_extract_only_rejection("wia", "out.wia");
    write_wia_fixture_from_iso(iso_path.path(), wia_path.path());

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            wia_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

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
fn compress_nfs_rejects_extract_only_output() {
    assert_compress_extract_only_rejection("nfs", "out.nfs");
}

#[test]
fn compress_tgc_rejects_extract_only_output() {
    assert_compress_extract_only_rejection("tgc", "out.tgc");
}

#[test]
fn extract_nfs_invalid_source_emits_running_progress() {
    let temp = setup_temp_dir();
    fs::write(temp.child("disc.nfs").path(), b"not-a-real-nfs").expect("fixture");
    let out_dir = temp.child("extract");

    let output = command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.nfs").path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let events = parse_json_lines(&output);
    assert_running_event(&events, "extract", "nfs");
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

    let output = command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.tgc").path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let events = parse_json_lines(&output);
    assert_running_event(&events, "extract", "tgc");
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

    let output = command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.xiso").path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let events = parse_json_lines(&output);
    assert_running_event(&events, "extract", "xiso");
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "xiso");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("is not an Xbox XDVDFS image")
    );
}

#[test]
fn compress_rejects_unregistered_output_format() {
    let temp = setup_temp_dir();
    let source = temp.child("source.bin");
    fs::write(source.path(), [0_u8; 16]).expect("fixture");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            source.path().to_str().expect("path"),
            "--format",
            "not-a-format",
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("requested output format is not registered")
    );
}

#[test]
fn compress_without_format_infers_7z_from_output_extension() {
    let temp = setup_temp_dir();
    let source_path = temp.child("source.iso");
    let payload = (0..(256 * 1024))
        .map(|index| ((index * 17) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(source_path.path(), payload).expect("fixture");
    let output_path = temp.child("out.7z");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            source_path.path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "7z");
    assert_eq!(json["status"], "succeeded");
    assert!(output_path.path().exists());
}

#[test]
fn compress_without_format_infers_zip_from_output_extension() {
    let temp = setup_temp_dir();
    fs::write(temp.child("source.bin").path(), b"payload").expect("fixture");
    let output_path = temp.child("out.zip");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("source.bin").path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert!(output_path.path().exists());
}

#[test]
fn compress_without_format_infers_rvz_from_output_extension_for_iso_inputs() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("source.iso").path(),
        build_test_gamecube_iso(512 * 1024),
    )
    .expect("fixture");
    let output_path = temp.child("out.rvz");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("source.iso").path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    assert!(output_path.path().exists());
}

#[test]
fn compress_without_format_infers_rvz_from_output_extension_for_wbfs_inputs() {
    let temp = setup_temp_dir();
    let source_iso = temp.child("source.iso");
    fs::write(source_iso.path(), build_test_gamecube_iso(512 * 1024)).expect("fixture");
    let source_wbfs = temp.child("source.wbfs");
    write_wbfs_fixture_from_iso(source_iso.path(), source_wbfs.path());
    let output_path = temp.child("out.rvz");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            source_wbfs.path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    assert!(output_path.path().exists());
}

#[test]
fn compress_without_format_infers_rvz_from_output_extension_for_wia_inputs() {
    let temp = setup_temp_dir();
    let source_iso = temp.child("source.iso");
    fs::write(source_iso.path(), build_test_gamecube_iso(512 * 1024)).expect("fixture");
    let source_wia = temp.child("source.wia");
    write_wia_fixture_from_iso(source_iso.path(), source_wia.path());
    let output_path = temp.child("out.rvz");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            source_wia.path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    assert!(output_path.path().exists());
}

#[test]
fn compress_format_flag_overrides_mismatched_extension_with_warning() {
    let temp = setup_temp_dir();
    fs::write(temp.child("source.bin").path(), b"payload").expect("fixture");
    // Name the output `.zip` but force 7z: the flag wins and the misleading name is warned about.
    let output_path = temp.child("out.zip");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("source.bin").path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["format"], "7z");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("warning"));
    assert!(label.contains("does not match"));
    // The output keeps the exact name the user requested.
    assert!(output_path.path().exists());
}

#[test]
fn compress_without_format_rejects_extensionless_output() {
    let temp = setup_temp_dir();
    fs::write(temp.child("source.bin").path(), b"payload").expect("fixture");
    let output_path = temp.child("out");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("source.bin").path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("output has no file extension")
    );
    assert!(!output_path.path().exists());
}

#[test]
fn compress_without_format_rejects_extract_only_output_extension() {
    let temp = setup_temp_dir();
    fs::write(temp.child("source.bin").path(), b"payload").expect("fixture");
    let output_path = temp.child("out.cso");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("source.bin").path().to_str().expect("path"),
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("extract-only")
    );
    assert!(!output_path.path().exists());
}

#[test]
fn compress_rejects_auto_format_keyword() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("source.iso").path(),
        build_test_gamecube_iso(512 * 1024),
    )
    .expect("fixture");
    let output_path = temp.child("out.rvz");

    // `auto` is no longer a supported format; it resolves to no registered handler.
    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("source.iso").path().to_str().expect("path"),
            "--format",
            "auto",
            "--output",
            output_path.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("requested output format is not registered")
    );
}

#[test]
fn compress_without_format_rejects_unsupported_output_extension() {
    let temp = setup_temp_dir();
    fs::write(temp.child("source-a.bin").path(), b"a").expect("fixture");

    // `.auto` matches no registered container; with no --format this is an error.
    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("source-a.bin").path().to_str().expect("path"),
            "--output",
            temp.child("out.auto").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["status"], "failed");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("is not a supported format"));
    assert!(label.contains("--format"));
}

#[test]
fn compress_rejects_wua_output_format() {
    let temp = setup_temp_dir();
    fs::write(temp.child("source.bin").path(), [1_u8; 64]).expect("fixture");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("source.bin").path().to_str().expect("path"),
            "--format",
            "wua",
            "--output",
            temp.child("out.wua").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "wua");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("requested output format is not registered")
    );
}

#[test]
fn compress_rejects_invalid_codec_level_value() {
    let temp = setup_temp_dir();
    temp.child("file.bin")
        .write_str("payload")
        .expect("fixture");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("file.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            temp.child("out.zip").path().to_str().expect("path"),
            "--codec",
            "deflate:fast",
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("not a valid integer")
    );
}

#[test]
fn compress_accepts_global_level_profiles_for_creatable_archives() {
    let profiles = [
        "min",
        "very-low",
        "low",
        "medium",
        "high",
        "very-high",
        "max",
    ];
    for (format, codec, extension) in [("7z", "lzma2", "7z"), ("zip", "zstd", "zip")] {
        for profile in profiles {
            let temp = setup_temp_dir();
            fs::write(temp.child("payload.bin").path(), vec![0x41; 16 * 1024]).expect("fixture");
            let output_path = temp.child(format!("out-{profile}.{extension}"));

            let output = command_stdout(
                &[
                    "compress",
                    "--input",
                    temp.child("payload.bin").path().to_str().expect("path"),
                    "--format",
                    format,
                    "--output",
                    output_path.path().to_str().expect("path"),
                    "--codec",
                    codec,
                    "--level",
                    profile,
                    "--json",
                ],
                0,
            );

            let json = parse_single_json_line(&output);
            assert_eq!(json["command"], "compress");
            assert_eq!(json["family"], "container");
            assert_eq!(json["format"], format);
            assert_eq!(json["status"], "succeeded");
            assert!(output_path.path().exists());
        }
    }
}

#[test]
fn compress_rejects_extract_only_stream_formats() {
    for (format, output_name) in [
        ("gz", "out.gz"),
        ("bz2", "out.bz2"),
        ("xz", "out.xz"),
        ("zst", "out.zst"),
        ("tar", "out.tar"),
        ("tar.gz", "out.tar.gz"),
        ("tar.bz2", "out.tar.bz2"),
        ("tar.xz", "out.tar.xz"),
        ("zipx", "out.zipx"),
    ] {
        assert_compress_extract_only_rejection(format, output_name);
    }
}

#[test]
fn compress_defaults_to_max_global_level_profile() {
    for (format, codec, extension) in [("7z", "lzma2", "7z"), ("zip", "zstd", "zip")] {
        let temp = setup_temp_dir();
        let payload = vec![0x5A; 64 * 1024];
        fs::write(temp.child("payload.bin").path(), &payload).expect("fixture");

        let default_output = temp.child(format!("default.{extension}"));
        command_stdout(
            &[
                "compress",
                "--input",
                temp.child("payload.bin").path().to_str().expect("path"),
                "--format",
                format,
                "--output",
                default_output.path().to_str().expect("path"),
                "--codec",
                codec,
                "--json",
            ],
            0,
        );

        let explicit_output = temp.child(format!("explicit-max.{extension}"));
        command_stdout(
            &[
                "compress",
                "--input",
                temp.child("payload.bin").path().to_str().expect("path"),
                "--format",
                format,
                "--output",
                explicit_output.path().to_str().expect("path"),
                "--codec",
                codec,
                "--level",
                "max",
                "--json",
            ],
            0,
        );

        assert_eq!(
            fs::read(default_output.path()).expect("default output"),
            fs::read(explicit_output.path()).expect("explicit output")
        );
    }
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
        .arg("--input")
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
    assert_running_event(&compress_events, "compress", format);
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], format);
    assert_eq!(compress_json["status"], "succeeded");

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            archive.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ],
        0,
    );
    let probe_json = parse_single_json_line(&probe_output);
    assert_eq!(probe_json["command"], "probe");
    assert_eq!(probe_json["family"], "container");
    assert_eq!(probe_json["format"], format);
    assert_eq!(probe_json["status"], "succeeded");

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--select",
            "source.bin",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

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
        ("zip", "sample-zstd.zip", Some("zstd")),
        ("7z", "sample.7z", Some("lzma2")),
    ];

    for (format, archive_name, codec) in cases {
        run_archive_round_trip(format, archive_name, codec);
    }
}

#[test]
fn extract_zst_reports_parallel_decode_threads() {
    let temp = setup_temp_dir();
    let payload = (0..131_072)
        .map(|index| ((index * 17) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("source.bin").path(), &payload).expect("fixture");
    let archive = temp.child("source.bin.zst");
    let compressed = zstd::bulk::compress(&payload, 3).expect("zstd fixture");
    fs::write(archive.path(), compressed).expect("write zst fixture");

    let out_dir = temp.child("extract");
    let output = command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--select",
            "source.bin",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

    let events = parse_json_lines(&output);
    // Stream extract emits indeterminate (percent-less) running progress: learning the total for a
    // percent would decompress the whole payload a second time (see stream.rs extract_with_libarchive).
    assert!(
        events.iter().any(|event| {
            event["command"] == "extract"
                && event["status"] == "running"
                && event["format"] == "zst"
                && event["stage"] == "extract"
        }),
        "expected extract (zst) to emit a running progress event"
    );
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
fn zip_emits_incremental_running_progress_beyond_placeholders() {
    let temp = setup_temp_dir();
    let input_dir = temp.child("input");
    fs::create_dir_all(input_dir.path()).expect("input dir");
    for index in 0..3usize {
        let payload = vec![index as u8; 10_240 + (index * 2_048)];
        fs::write(input_dir.child(format!("file-{index}.bin")).path(), payload).expect("fixture");
    }

    let archive = temp.child("sample.zip");
    let compress_output = command_stdout(
        &[
            "compress",
            "--input",
            input_dir.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let compress_events = parse_json_lines(&compress_output);
    assert!(
        compress_events.iter().any(|event| {
            event["command"] == "compress"
                && event["status"] == "running"
                && event["format"] == "zip"
                && event["stage"] == "create"
                && event["label"] == "creating `zip`"
                && event["percent"]
                    .as_f64()
                    .map(|percent| percent > 0.0 && percent < 100.0)
                    .unwrap_or(false)
        }),
        "expected zip compress to emit running create progress between 0 and 100"
    );
    assert_no_compressed_write_progress(&compress_events, "zip");
    assert!(!compress_events.iter().any(|event| {
        event["command"] == "compress"
            && event["status"] == "running"
            && event["format"] == "zip"
            && event["stage"] == "create"
            && event["percent"].as_f64() == Some(100.0)
    }));

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let extract_events = parse_json_lines(&extract_output);
    assert_running_percent_event_in_range(&extract_events, "extract", "zip", 1.0, 95.0);
}

fn assert_no_running_hundred_percent(events: &[Value], format: &str) {
    assert!(
        !events.iter().any(|event| {
            event["command"] == "compress"
                && event["status"] == "running"
                && event["format"] == format
                && event["percent"].as_f64() == Some(100.0)
        }),
        "expected {format} compression to keep 100% for the terminal event"
    );
}

fn assert_no_finalizing_percent(events: &[Value], format: &str) {
    assert!(
        !events.iter().any(|event| {
            event["command"] == "compress"
                && event["status"] == "running"
                && event["format"] == format
                && event["label"] == format!("finalizing `{format}` archive")
                && event["percent"].as_f64().is_some()
        }),
        "expected {format} finalization progress to stay indeterminate"
    );
}

#[test]
fn seven_z_lzma2_threaded_single_chunk_emits_codec_progress() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    let payload: Vec<u8> = (0..(2 * 1024 * 1024))
        .map(|offset| (offset % 251) as u8)
        .collect();
    fs::write(input.path(), &payload).expect("fixture");

    let archive = temp.child("sample.7z");
    let compress_output = command_stdout(
        &[
            "compress",
            "--input",
            input.path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            archive.path().to_str().expect("path"),
            "--codec",
            "lzma2:5",
            "--threads",
            "10",
            "--json",
        ],
        0,
    );
    let compress_events = parse_json_lines(&compress_output);
    assert_no_compressed_write_progress(&compress_events, "7z");
    assert_no_finalizing_percent(&compress_events, "7z");
    assert_no_running_hundred_percent(&compress_events, "7z");
    assert!(!compress_events.iter().any(|event| {
        event["command"] == "compress"
            && event["status"] == "running"
            && event["format"] == "7z"
            && event["stage"] == "create"
            && event["label"] == "queueing input for `7z`"
    }));
    assert!(compress_events.iter().any(|event| {
        event["command"] == "compress"
            && event["status"] == "running"
            && event["format"] == "7z"
            && event["stage"] == "create"
            && event["label"] == "compressing `7z`"
            && event["percent"].as_f64() == Some(99.0)
    }));

    let out_dir = temp.child("threaded-extract");
    command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "1",
        ],
        0,
    );
    assert_eq!(
        fs::read(out_dir.path().join("input.bin")).expect("extracted input"),
        payload
    );
}

#[test]
fn seven_z_lzma2_single_thread_emits_running_codec_progress() {
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
    let compress_output = command_stdout(
        &[
            "compress",
            "--input",
            input_dir.path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            archive.path().to_str().expect("path"),
            "--codec",
            "lzma2",
            "--threads",
            "1",
            "--level",
            "low",
            "--json",
        ],
        0,
    );
    let compress_events = parse_json_lines(&compress_output);
    assert_no_compressed_write_progress(&compress_events, "7z");
    assert_no_finalizing_percent(&compress_events, "7z");
    assert_no_running_hundred_percent(&compress_events, "7z");
    let codec_progress_event_count = compress_events
        .iter()
        .filter(|event| {
            event["command"] == "compress"
                && event["status"] == "running"
                && event["format"] == "7z"
                && event["stage"] == "create"
                && event["label"] == "compressing `7z`"
                && event["percent"]
                    .as_f64()
                    .map(|percent| percent > 0.0 && percent < 100.0)
                    .unwrap_or(false)
        })
        .count();
    assert!(
        codec_progress_event_count >= 2,
        "expected single-thread 7z/lzma2 to emit repeated codec progress"
    );

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let extract_events = parse_json_lines(&extract_output);
    assert_running_percent_event_in_range(&extract_events, "extract", "7z", 1.0, 95.0);
}

#[test]
fn extract_recursively_handles_nested_containers() {
    let temp = setup_temp_dir();
    let payload = (0..24_576)
        .map(|index| (index % 197) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &payload).expect("fixture");

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

    let zip_path = temp.child("inner.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            chd_path.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            zip_path.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let seven_z_path = temp.child("outer.7z");
    command_stdout(
        &[
            "compress",
            "--input",
            zip_path.path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            seven_z_path.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            seven_z_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let extract_json = parse_single_json_line(&extract_output);
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "7z");
    assert_eq!(extract_json["status"], "succeeded");
    assert!(
        extract_json["label"]
            .as_str()
            .expect("label")
            .contains("recursively extracted 2 nested container(s)")
    );

    assert_eq!(
        fs::read(out_dir.child("inner/disc/disc.bin").path()).expect("nested extract payload"),
        payload
    );
}

#[test]
fn extract_nested_checksum_reports_only_leaf_with_step_events() {
    let temp = setup_temp_dir();
    let payload = b"leaf rom payload for nested checksum test".to_vec();
    fs::write(temp.child("leaf.bin").path(), &payload).expect("fixture");

    let inner_zip = temp.child("inner.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("leaf.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner_zip.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let outer_7z = temp.child("outer.7z");
    command_stdout(
        &[
            "compress",
            "--input",
            inner_zip.path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            outer_7z.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract");
    let events = run_json_events(
        &[
            "extract",
            "--input",
            outer_7z.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--checksum",
            "sha1",
            "--json",
        ],
        0,
    );

    // Terminal report carries only the bottom/leaf output, with its checksum - not the intermediate
    // `inner.zip` container we descended through.
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["status"], "succeeded");
    let emitted = json["details"]["emitted_files"]
        .as_array()
        .expect("emitted_files array");
    let names = emitted
        .iter()
        .filter_map(|entry| entry["file_name"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["leaf.bin"], "expected only the leaf output");
    let leaf = emitted_file_entry(json, "leaf.bin");
    assert_eq!(
        leaf["checksums"]["sha1"].as_str().map(str::len),
        Some(40),
        "leaf output should carry a sha1 digest"
    );

    // Each descended level emits a structured `extract-step` event; the deepest level reports the
    // leaf output, and the whole command still ends with exactly one terminal event.
    let step_events = events
        .iter()
        .filter(|event| event["stage"] == "extract-step")
        .collect::<Vec<_>>();
    assert!(
        step_events
            .iter()
            .any(|event| event["details"]["extract_step"]["depth"] == 0),
        "expected a depth-0 (input container) step event"
    );
    let leaf_step = step_events.iter().find(|event| {
        event["details"]["extract_step"]["status"] == "succeeded"
            && event["details"]["extract_step"]["outputs"]
                .as_array()
                .map(|outputs| {
                    outputs
                        .iter()
                        .any(|output| output["file_name"] == "leaf.bin")
                })
                .unwrap_or(false)
    });
    assert!(
        leaf_step.is_some(),
        "expected a succeeded step event reporting the leaf output"
    );
    // Every completed level reports its own extract time so the host can render a per-level time in
    // the extraction tree (the `running` step, which precedes the work, carries none).
    for event in &step_events {
        let step = &event["details"]["extract_step"];
        if step["status"] == "succeeded" {
            assert!(
                step["extract_time_ms"].is_u64(),
                "succeeded step events must carry a per-level extract_time_ms"
            );
        }
    }
    for event in &step_events {
        assert_eq!(
            event["status"], "running",
            "step events must stay live so they are not treated as the command terminal"
        );
    }
    let terminal_count = events
        .iter()
        .filter(|event| event["status"] == "succeeded" || event["status"] == "failed")
        .count();
    assert_eq!(
        terminal_count, 1,
        "exactly one terminal finish for the command"
    );
}

#[test]
fn extract_nested_scan_ignores_existing_output_archives() {
    let temp = setup_temp_dir();
    let out_dir = temp.child("extract");
    fs::create_dir_all(out_dir.path()).expect("extract dir");

    fs::write(temp.child("fresh.bin").path(), b"fresh payload").expect("fresh fixture");
    let fresh_archive = temp.child("fresh.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("fresh.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            fresh_archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    fs::write(temp.child("stale.bin").path(), b"stale payload").expect("stale fixture");
    let stale_archive = out_dir.child("stale.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("stale.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            stale_archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            fresh_archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let extract_json = parse_single_json_line(&extract_output);
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["status"], "succeeded");
    assert!(
        !extract_json["label"]
            .as_str()
            .expect("label")
            .contains("recursively extracted")
    );
    assert_eq!(
        fs::read(out_dir.child("fresh.bin").path()).expect("fresh extract"),
        b"fresh payload"
    );
    assert!(stale_archive.path().exists());
    assert!(!out_dir.child("stale/stale.bin").path().exists());
}

// ---- relocated from shared.rs (single-module helpers) ----

fn assert_running_event(events: &[Value], command: &str, format: &str) {
    assert!(
        events.iter().any(|event| {
            event["command"] == command && event["status"] == "running" && event["format"] == format
        }),
        "expected {command} ({format}) to emit running progress"
    );
}
