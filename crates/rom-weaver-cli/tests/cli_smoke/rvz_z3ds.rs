use super::shared::*;

// The nod create thread plan parks ~1/4 of the budget on the preloader, so counts 1-3 leave the
// preloader with zero threads while 2 and 3 still run multiple concurrent block processors. That
// band regressed in the browser (rvz-wasm-threads-2-and-3-fail); pin it natively too.
#[test]
fn rvz_compress_succeeds_across_low_thread_counts() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(4 * 1024 * 1024);
    fs::write(temp.child("disc.iso").path(), &iso_bytes).expect("iso fixture");

    for threads in 1..=4 {
        let rvz_path = temp.child(format!("disc-{threads}.rvz"));
        let output = command_stdout(
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
                &threads.to_string(),
                "--jsonl",
            ],
            0,
        );
        let events = parse_json_lines(&output);
        let terminal = events.last().expect("compress terminal event");
        assert_eq!(
            terminal["status"], "succeeded",
            "rvz compress failed at --threads {threads}: {terminal}"
        );
    }
}

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
            "--jsonl",
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
    // The metadata-only probe decodes a bounded prefix, so hosts learn the
    // platform before extraction and can stage the right identify pack.
    assert_eq!(json["details"]["platform"], "Nintendo GameCube");
    assert_eq!(json["details"]["disc_format"], "DVD");
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
        ],
        0,
    );

    let events = parse_json_lines(&output);
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["status"], "succeeded");
    // `--probe` folds the container probe block into the extract result.
    assert!(!json["details"]["container"]["recommended_compress_format"].is_null());
    // Single-payload codec identity, backfilled from the decoded output without `--checksum`.
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
            temp.child("disc.rvz").path().to_str().expect("path"),
            "--select",
            "missing.iso",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
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
    // The container magic alone pins the platform, so hosts can stage the 3DS
    // identify pack before hashing.
    assert_eq!(probe_json["details"]["platform"], "Nintendo 3DS");

    let out_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            z3ds_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
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
    source[0x100..0x104].copy_from_slice(b"NCSD");
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
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
            "--jsonl",
        ],
        0,
    );
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extracted iso"),
        iso_bytes
    );
}

#[test]
fn wia_rvz_extract_nkit_warnings_in_human_json_and_jsonl() {
    let temp = setup_temp_dir();
    let iso = build_test_gamecube_iso(0x20000);
    let input = temp.child("disc.iso");
    fs::write(input.path(), &iso).unwrap();
    for format in [NodFormat::Wia, NodFormat::Rvz] {
        let name = if format == NodFormat::Wia {
            "wia"
        } else {
            "rvz"
        };
        let disc = NodDiscReader::new(input.path(), &NodDiscOptions::default()).unwrap();
        let writer = NodDiscWriter::new(
            disc,
            &NodFormatOptions {
                format,
                compression: NodCompression::None,
                block_size: format.default_block_size(),
            },
        )
        .unwrap();
        let mut image = Vec::new();
        let finalization = writer
            .process(
                |data, _, _| {
                    image.extend_from_slice(&data);
                    Ok(())
                },
                &NodProcessOptions {
                    digest_sha1: true,
                    ..Default::default()
                },
            )
            .unwrap();
        image[..finalization.header.len()].copy_from_slice(&finalization.header);
        assert_eq!(&image[0x124..0x12c], b"NKIT  v2");
        // NKit v2's size field precedes the only requested digest, SHA-1.
        image[0x124 + 12 + 8] ^= 1;
        let source = temp.child(format!("disc.{name}"));
        fs::write(source.path(), &image).unwrap();
        for mode in ["human", "--json", "--jsonl"] {
            let out = temp.child(format!("{name}-{mode}"));
            let mut args = vec![
                "extract",
                "--input",
                source.path().to_str().unwrap(),
                "--output",
                out.path().to_str().unwrap(),
                "--threads",
                "1",
            ];
            if mode != "human" {
                args.push(mode);
            }
            let mut command = Command::cargo_bin("rom-weaver").unwrap();
            command.args(&args);
            let assertion = command.assert().code(0);
            let output = assertion.get_output();
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(text.contains("NKit SHA-1 checksum mismatch"), "{text}");
            assert!(text.contains("ISO extracted as-is"), "{text}");
            if mode != "human" {
                let report = if mode == "--jsonl" {
                    parse_single_json_line(&output.stdout)
                } else {
                    serde_json::from_slice(&output.stdout).unwrap()
                };
                if mode == "--json" {
                    assert_eq!(report["warnings"].as_array().unwrap().len(), 1);
                }
                assert_eq!(report["status"], "succeeded");
                assert_eq!(report["details"]["warnings"].as_array().unwrap().len(), 1);
            }
            assert!(fs::read(out.child("disc.iso").path()).unwrap() == iso);
        }
    }
}

fn write_hash_mismatching_wii_wia(temp: &TempDir) -> (PathBuf, Vec<u8>) {
    let mut iso = vec![0; 0x90000];
    iso[..6].copy_from_slice(b"RWIIT0");
    iso[0x18..0x1c].copy_from_slice(&0x5d1c9ea3u32.to_be_bytes());
    iso[0x61] = 1;
    iso.copy_within(..0x400, 0x70400);
    for sector in 0..4 {
        iso[0x70000 + sector * 0x8000] = 1;
    }
    let issuer = b"Root-CA00000001-XS00000003";
    iso[0x50140..0x50140 + issuer.len()].copy_from_slice(issuer);
    for (offset, value) in [
        (0x40000, 1u32),
        (0x40004, 0x40020 >> 2),
        (0x40020, 0x50000 >> 2),
        (0x502b4, 0x8000 >> 2),
        (0x502b8, 0x20000 >> 2),
        (0x502bc, 0x20000 >> 2),
        (0x70824, 0x2800 >> 2),
        (0x70828, 12 >> 2),
        (0x7082c, 12 >> 2),
        (0x72c00, 0x01000000),
        (0x72c08, 1),
    ] {
        iso[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
    }
    // The H3 table MUST remain incorrect to trigger partition warnings.
    let source = temp.child("damaged.iso");
    fs::write(source.path(), &iso).unwrap();
    let wia = temp.child("damaged.wia");
    write_wia_fixture_from_iso(source.path(), wia.path());
    let mut reader = NodDiscReader::new(wia.path(), &NodDiscOptions::default()).unwrap();
    let mut decoded = Vec::new();
    std::io::Read::read_to_end(&mut reader, &mut decoded).unwrap();
    (wia.path().to_path_buf(), decoded)
}

fn assert_auto_extract_hash_warning(command: &str) {
    let temp = setup_temp_dir();
    let (wia, iso) = write_hash_mismatching_wii_wia(&temp);
    let patch = temp.child("update.ips");
    fs::write(patch.path(), b"PATCH\x00\x00\x07\x00\x01XEOF").unwrap();
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        r#"{"version":1,"rom":{"path":"damaged.wia"},"patches":[{"path":"update.ips"}]}"#,
    )
    .unwrap();
    let nested = temp.child("damaged.tar.gz");
    if command == "nested-extract" {
        write_tar_gz_fixture(&[(&wia, "damaged.wia")], nested.path());
    }
    for mode in ["human", "--json", "--jsonl"] {
        let out = temp.child(format!("patched-{mode}.iso"));
        let mut args = match command {
            "patch-apply" => vec![
                "patch",
                "apply",
                "--input",
                wia.to_str().unwrap(),
                "--patch",
                patch.path().to_str().unwrap(),
                "--output",
                out.path().to_str().unwrap(),
                "--no-compress",
            ],
            "checksum" => vec![
                "checksum",
                "--input",
                wia.to_str().unwrap(),
                "--algo",
                "sha1",
            ],
            "patch-validate" => vec![
                "patch",
                "validate",
                "--input",
                wia.to_str().unwrap(),
                "--patch",
                patch.path().to_str().unwrap(),
            ],
            "ingest" => vec![
                "ingest",
                "--input",
                wia.to_str().unwrap(),
                "--output",
                out.path().to_str().unwrap(),
            ],
            "nested-extract" => vec![
                "extract",
                "--input",
                nested.path().to_str().unwrap(),
                "--output",
                out.path().to_str().unwrap(),
            ],
            "weave-apply" => vec![
                "patch",
                "apply",
                "--input",
                wia.to_str().unwrap(),
                "--weave",
                weave.path().to_str().unwrap(),
                "--output",
                out.path().to_str().unwrap(),
                "--no-compress",
            ],
            _ => unreachable!(),
        };
        args.extend(["--threads", "1"]);
        if mode != "human" {
            args.push(mode);
        }
        let mut process = Command::cargo_bin("rom-weaver").unwrap();
        let root = temp.path();
        process.env("HOME", root);
        for name in [
            "XDG_CACHE_HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_STATE_HOME",
        ] {
            process.env(name, root);
        }
        let assertion = process.args(args).assert().code(0);
        let output = assertion.get_output();
        if mode == "human" {
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert_eq!(
                stderr
                    .matches("warning: wia partition 0 hash mismatch")
                    .count(),
                1,
                "{stderr}"
            );
        } else {
            let report: Value = if mode == "--json" {
                serde_json::from_slice(&output.stdout).unwrap()
            } else {
                parse_single_json_line(&output.stdout)
            };
            let warnings = report["details"]["warnings"]
                .as_array()
                .expect("warnings must survive auto-extraction");
            assert_eq!(warnings.len(), 1, "{report}");
            assert!(
                warnings[0]
                    .as_str()
                    .unwrap()
                    .starts_with("wia partition 0 hash mismatch")
            );
            if mode == "--json" {
                assert_eq!(report["warnings"], report["details"]["warnings"]);
            }
            assert_eq!(report["status"], "succeeded");
        }
        if matches!(command, "patch-apply" | "weave-apply") {
            let mut expected = iso.clone();
            expected[7] = b'X';
            let actual = fs::read(out.path()).unwrap();
            assert!(
                actual == expected,
                "patched ISO lengths {} vs {}; first differing offsets: {:?}",
                actual.len(),
                expected.len(),
                actual
                    .iter()
                    .zip(&expected)
                    .enumerate()
                    .filter_map(|(index, (a, b))| (a != b).then_some(index))
                    .take(8)
                    .collect::<Vec<_>>()
            );
        }
    }
}

#[test]
fn patch_apply_preserves_wii_wia_hash_warnings() {
    assert_auto_extract_hash_warning("patch-apply");
}

#[test]
fn checksum_preserves_wii_wia_hash_warnings() {
    assert_auto_extract_hash_warning("checksum");
}

#[test]
fn patch_validate_preserves_wii_wia_hash_warnings() {
    assert_auto_extract_hash_warning("patch-validate");
}

#[test]
fn ingest_preserves_wii_wia_hash_warnings() {
    assert_auto_extract_hash_warning("ingest");
}

#[test]
fn nested_extract_preserves_wii_wia_hash_warnings() {
    assert_auto_extract_hash_warning("nested-extract");
}

#[test]
fn weave_apply_preserves_wii_wia_hash_warnings() {
    assert_auto_extract_hash_warning("weave-apply");
}

#[test]
fn concurrent_extract_keeps_wii_wia_hash_warnings_with_their_source() {
    use rom_weaver_app::{ExtractBatchOptions, ExtractCommand, run_extract_batch};
    use rom_weaver_core::{
        NoninteractivePrompter, OperationStatus, ProgressEvent, ProgressSink, ThreadBudget,
    };
    use std::sync::{Arc, Barrier, Condvar, Mutex};

    struct Reporter {
        ready: Barrier,
        clean_thread: Mutex<Option<std::thread::ThreadId>>,
        clean_finished: (Mutex<bool>, Condvar),
        reports: Mutex<Vec<ProgressEvent>>,
    }
    impl ProgressSink for Reporter {
        fn emit(&self, event: ProgressEvent) {
            if let Some(step) = event
                .details
                .as_ref()
                .and_then(|details| details.get("extract_step"))
                && step["depth"] == 0
                && step["status"] == "succeeded"
            {
                let clean = step["source_name"] == "clean.wia";
                if clean {
                    *self.clean_thread.lock().unwrap() = Some(std::thread::current().id());
                }
                // Both jobs MUST finish decoding before the clean job reports its result.
                self.ready.wait();
                if !clean {
                    let (finished, condition) = &self.clean_finished;
                    let (finished, _) = condition
                        .wait_timeout_while(
                            finished.lock().unwrap(),
                            std::time::Duration::from_secs(5),
                            |done| !*done,
                        )
                        .unwrap();
                    assert!(*finished, "clean extraction did not finish");
                }
            }
            if event.status == OperationStatus::Succeeded {
                self.reports.lock().unwrap().push(event);
                if *self.clean_thread.lock().unwrap() == Some(std::thread::current().id()) {
                    let (finished, condition) = &self.clean_finished;
                    *finished.lock().unwrap() = true;
                    condition.notify_all();
                }
            }
        }
    }
    let temp = setup_temp_dir();
    let (damaged, _) = write_hash_mismatching_wii_wia(&temp);
    let clean_iso = temp.child("clean.iso");
    fs::write(clean_iso.path(), build_test_gamecube_iso(0x6000)).unwrap();
    let clean = temp.child("clean.wia");
    write_wia_fixture_from_iso(clean_iso.path(), clean.path());
    let reporter = Arc::new(Reporter {
        ready: Barrier::new(2),
        clean_thread: Mutex::new(None),
        clean_finished: (Mutex::new(false), Condvar::new()),
        reports: Mutex::new(Vec::new()),
    });
    let jobs = [damaged, clean.path().to_path_buf()]
        .into_iter()
        .enumerate()
        .map(|(index, input)| ExtractCommand {
            input,
            select: Vec::new(),
            filter: Vec::new(),
            output: temp.child(format!("out-{index}")).path().to_path_buf(),
            split_bin: false,
            no_ignore: false,
            no_nested_extract: true,
            force: false,
            checksum: Vec::new(),
            checksum_rom: Vec::new(),
            probe: false,
            threads: ThreadBudget::Fixed(1),
        })
        .collect();
    let result = run_extract_batch(
        jobs,
        ExtractBatchOptions {
            emit_progress_events: true,
            interactive_selection_enabled: false,
            threads: ThreadBudget::Fixed(2),
            sequential: false,
        },
        reporter.clone(),
        Arc::new(NoninteractivePrompter),
    );
    assert_eq!(result.waves, vec![vec![0, 1]]);
    assert!(
        result
            .outcomes
            .iter()
            .all(|outcome| outcome.status == OperationStatus::Succeeded)
    );
    let reports = reporter.reports.lock().unwrap();
    assert_eq!(reports.len(), 2);
    let clean = reports
        .iter()
        .find(|report| {
            report.details.as_ref().unwrap()["emitted_files"][0]["file_name"] == "clean.iso"
        })
        .unwrap();
    assert!(
        clean.details.as_ref().unwrap().get("warnings").is_none(),
        "{clean:?}"
    );
    let damaged = reports
        .iter()
        .find(|report| {
            report.details.as_ref().unwrap()["emitted_files"][0]["file_name"] == "damaged.iso"
        })
        .unwrap();
    assert_eq!(
        damaged.details.as_ref().unwrap()["warnings"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
