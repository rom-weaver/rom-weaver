use super::shared::*;

#[test]
fn rvz_probe_reports_succeeded() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x6000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_rvz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.rvz").path());

    let output = command_stdout(
        &[
            "probe",
            "--input",
            temp.child("disc.rvz").path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
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
fn rvz_compress_and_extract_round_trips() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(4 * 1024 * 1024);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");

    let rvz_path = temp.child("disc.rvz");
    let compress_output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "rvz",
            "--output",
            rvz_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event_in_range(&compress_events, "compress", "rvz", 0.99, 100.0);
    assert!(
        !compress_events.iter().any(|event| {
            event["command"] == "compress"
                && event["status"] == "running"
                && event["format"] == "rvz"
                && event["stage"] == "create"
                && event["percent"]
                    .as_f64()
                    .map(|percent| percent > 0.0 && percent < 1.0)
                    .unwrap_or(false)
        }),
        "rvz create progress should not emit sub-1% events that render as 0%"
    );
    assert!(
        compress_events.iter().any(|event| {
            event["command"] == "compress"
                && event["status"] == "running"
                && event["format"] == "rvz"
                && event["stage"] == "create"
                && event["label"] == "finalizing `rvz` archive"
                && event["percent"].as_f64() == Some(99.0)
        }),
        "rvz finalization should stay determinate at 99%"
    );
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], "rvz");
    assert_eq!(compress_json["requested_threads"], 8);
    assert_eq!(compress_json["effective_threads"], 8);
    assert_eq!(compress_json["used_parallelism"], true);
    assert_eq!(compress_json["status"], "succeeded");

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            rvz_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

    let extract_events = parse_json_lines(&extract_output);
    assert_running_percent_event(&extract_events, "extract", "rvz");
    let extract_json = extract_events.last().expect("extract terminal event");
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "rvz");
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
fn rvz_compress_rejects_non_zstd_codec() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x4000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");

    let output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "rvz",
            "--output",
            temp.child("disc.rvz").path().to_str().expect("path"),
            "--codec",
            "store",
            "--level",
            "min",
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("supported codec is zstd")
    );
}

#[test]
fn rvz_extract_round_trips_to_iso() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_rvz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.rvz").path());

    let out_dir = temp.child("extract");
    let output = command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.rvz").path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rvz");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );
}

#[test]
fn rvz_extract_probe_emits_platform_and_container_details() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_rvz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.rvz").path());

    let out_dir = temp.child("extract");
    let output = command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.rvz").path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--probe",
            "--json",
        ],
        0,
    );

    let events = parse_json_lines(&output);
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["status"], "succeeded");
    // `--probe` folds the container probe block into the extract result.
    assert!(!json["details"]["container"]["recommended_compress_format"].is_null());
    // Single-payload disc image identity, backfilled from the decoded output without `--checksum`.
    let entry = emitted_file_entry(json, "disc.iso");
    assert_eq!(entry["platform"], "Nintendo GameCube");
    assert_eq!(entry["disc_format"], "DVD");
}

#[test]
fn rvz_extract_supports_single_output_selection() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");
    write_rvz_fixture_from_iso(temp.child("disc.iso").path(), temp.child("disc.rvz").path());

    let out_dir = temp.child("selected");
    command_stdout(
        &[
            "extract",
            "--input",
            temp.child("disc.rvz").path().to_str().expect("path"),
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
            temp.child("disc.rvz").path().to_str().expect("path"),
            "--select",
            "missing.iso",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "rvz");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
    );
}

#[test]
fn z3ds_compress_probe_and_extract_round_trip() {
    let temp = setup_temp_dir();
    let source = (0..65_536)
        .map(|index| (index % 239) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.3ds").path(), &source).expect("fixture");

    let z3ds_path = temp.child("disc.z3ds");
    let compress_output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.3ds").path().to_str().expect("path"),
            "--format",
            "z3ds",
            "--output",
            z3ds_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ],
        0,
    );

    let compress_events = parse_json_lines(&compress_output);
    assert_running_percent_event(&compress_events, "compress", "z3ds");
    let compress_json = compress_events.last().expect("compress terminal event");
    assert_eq!(compress_json["command"], "compress");
    assert_eq!(compress_json["family"], "container");
    assert_eq!(compress_json["format"], "z3ds");
    assert_eq!(compress_json["status"], "succeeded");

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            z3ds_path.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ],
        0,
    );
    let probe_json = parse_single_json_line(&probe_output);
    assert_eq!(probe_json["command"], "probe");
    assert_eq!(probe_json["family"], "container");
    assert_eq!(probe_json["format"], "z3ds");
    assert_eq!(probe_json["status"], "succeeded");
    assert!(
        probe_json["label"]
            .as_str()
            .expect("label")
            .contains("underlying_magic")
    );

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            z3ds_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let extract_events = parse_json_lines(&extract_output);
    assert_running_percent_event(&extract_events, "extract", "z3ds");
    let extract_json = extract_events.last().expect("extract terminal event");
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "z3ds");
    assert_eq!(extract_json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.3ds").path()).expect("extracted 3ds"),
        source
    );
}

#[test]
fn z3ds_extract_uses_underlying_magic_for_output_extension() {
    let temp = setup_temp_dir();
    let mut source = (0..65_536)
        .map(|index| (index % 239) as u8)
        .collect::<Vec<_>>();
    source[..4].copy_from_slice(b"NCSD");
    fs::write(temp.child("disc.cci").path(), &source).expect("fixture");

    let z3ds_path = temp.child("disc.z3ds");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cci").path().to_str().expect("path"),
            "--format",
            "z3ds",
            "--output",
            z3ds_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            z3ds_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let extract_json = parse_single_json_line(&extract_output);
    assert_eq!(extract_json["command"], "extract");
    assert_eq!(extract_json["family"], "container");
    assert_eq!(extract_json["format"], "z3ds");
    assert_eq!(extract_json["status"], "succeeded");

    assert_eq!(
        fs::read(out_dir.child("disc.cci").path()).expect("extracted cci"),
        source
    );
    assert!(!out_dir.child("disc.3ds").path().exists());
}

#[test]
fn z3ds_extract_reports_parallel_threads_for_large_file() {
    let temp = setup_temp_dir();
    let source = (0..(10 * 1024 * 1024))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("large.3ds").path(), &source).expect("fixture");

    let z3ds_path = temp.child("large.z3ds");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("large.3ds").path().to_str().expect("path"),
            "--format",
            "z3ds",
            "--output",
            z3ds_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            z3ds_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&extract_output);
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "z3ds");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 8);
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("large.3ds").path()).expect("extracted 3ds"),
        source
    );
}

#[test]
fn z3ds_extract_supports_single_output_selection() {
    let temp = setup_temp_dir();
    let source = (0..65_536)
        .map(|index| (index % 199) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.3ds").path(), &source).expect("fixture");

    let z3ds_path = temp.child("disc.z3ds");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.3ds").path().to_str().expect("path"),
            "--format",
            "z3ds",
            "--output",
            z3ds_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ],
        0,
    );

    let selected_out = temp.child("selected");
    command_stdout(
        &[
            "extract",
            "--input",
            z3ds_path.path().to_str().expect("path"),
            "--select",
            "disc.3ds",
            "--output",
            selected_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    assert_eq!(
        fs::read(selected_out.child("disc.3ds").path()).expect("extracted 3ds"),
        source
    );

    let missing_output = command_stdout(
        &[
            "extract",
            "--input",
            z3ds_path.path().to_str().expect("path"),
            "--select",
            "missing.3ds",
            "--output",
            selected_out.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let missing_json = parse_single_json_line(&missing_output);
    assert_eq!(missing_json["format"], "z3ds");
    assert_eq!(missing_json["status"], "failed");
    assert!(
        missing_json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
    );
}

#[test]
fn z3ds_compress_reports_parallel_threads_for_large_file() {
    let temp = setup_temp_dir();
    let source = (0..(10 * 1024 * 1024))
        .map(|index| (index % 241) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("large.3ds").path(), &source).expect("fixture");

    let z3ds_path = temp.child("large.z3ds");
    let compress_output = command_stdout(
        &[
            "compress",
            "--input",
            temp.child("large.3ds").path().to_str().expect("path"),
            "--format",
            "z3ds",
            "--output",
            z3ds_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&compress_output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "z3ds");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 8);
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");
    assert!(z3ds_path.path().exists());
}

#[test]
fn z3ds_extract_rejects_invalid_header() {
    let temp = setup_temp_dir();
    let invalid = temp.child("invalid.z3ds");
    let mut bytes = vec![0_u8; 32];
    bytes[..4].copy_from_slice(b"BAD!");
    fs::write(invalid.path(), bytes).expect("fixture");

    let output = command_stdout(
        &[
            "extract",
            "--input",
            invalid.path().to_str().expect("path"),
            "--output",
            temp.child("out").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "z3ds");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("missing Z3DS magic")
    );
}

// ---- relocated from shared.rs (single-module helpers) ----

fn write_rvz_fixture_from_iso(iso_path: &std::path::Path, rvz_path: &std::path::Path) {
    let disc = NodDiscReader::new(iso_path, &NodDiscOptions::default()).expect("open iso");
    let options = NodFormatOptions {
        format: NodFormat::Rvz,
        compression: NodCompression::Zstandard(5),
        block_size: NodFormat::Rvz.default_block_size(),
    };
    let writer = NodDiscWriter::new(disc, &options).expect("create rvz writer");
    let mut output = File::create(rvz_path).expect("create rvz");
    let finalization = writer
        .process(
            |data, _processed, _total| output.write_all(data.as_ref()),
            &NodProcessOptions::default(),
        )
        .expect("write rvz");
    if !finalization.header.is_empty() {
        output.rewind().expect("seek rvz");
        output
            .write_all(finalization.header.as_ref())
            .expect("write rvz header");
    }
    output.flush().expect("flush rvz");
}

#[test]
fn rvz_compress_recovers_junk_seeds_when_game_id_differs() {
    // Regression: a disc whose junk data was generated under a different game ID than its
    // header claims (e.g. a translation patch retagging the region byte). Junk detection must
    // recover seeds from the data itself instead of storing ~all of it as incompressible bytes.
    let temp = setup_temp_dir();
    let payload_len = 2 * 1024 * 1024;
    let mut iso_bytes = build_test_gamecube_iso(payload_len);
    // Overwrite everything from sector 1 with junk seeded from an ID that does NOT match the
    // header ("RWTEST"), mirroring a post-patch header.
    let junk_start = 0x8000;
    let mut lfg = rom_weaver_containers::nod::util::lfg::LaggedFibonacci::default();
    lfg.fill_sector_chunked(&mut iso_bytes[junk_start..], *b"GKQJ", 0, junk_start as u64);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");

    let rvz_path = temp.child("disc.rvz");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "rvz",
            "--output",
            rvz_path.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let rvz_len = fs::metadata(rvz_path.path()).expect("rvz metadata").len();
    assert!(
        rvz_len < (payload_len / 4) as u64,
        "junk with a mismatched game ID should pack via recovered seeds, got {rvz_len} bytes"
    );

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            rvz_path.path().to_str().expect("path"),
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
}
