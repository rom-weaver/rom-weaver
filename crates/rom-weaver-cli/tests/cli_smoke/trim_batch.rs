use super::shared::*;

#[test]
fn trim_reports_percent_100_in_json() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    let output = temp.child("sample.trim.nds");
    let rom = build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false);
    fs::write(source.path(), &rom).expect("fixture");

    let trim_output = command_stdout(
        &[
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let terminal = parse_json_lines(&trim_output)
        .into_iter()
        .last()
        .expect("trim terminal event");
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["format"], "nds");
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["percent"], 100.0);
}

#[test]
fn trim_nds_preserves_download_play_certificate_boundary() {
    let temp = setup_temp_dir();
    let source = temp.child("downloadplay.nds");
    let rom = build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true);
    fs::write(source.path(), &rom).expect("fixture");

    let trim_output = command_stdout(
        &["trim", source.path().to_str().expect("path"), "--json"],
        0,
    );

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["format"], "nds");
    assert_eq!(terminal["status"], "succeeded");

    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=ds"));
    assert!(label.contains("preserved_download_play_cert=true"));
    assert!(label.contains("trimmed_size=12936"));

    let trimmed_path = source.path().with_extension("trim.nds");
    let trimmed = fs::read(&trimmed_path).expect("trimmed output");
    assert_eq!(trimmed.len(), 0x3200 + 0x88);
    assert_eq!(&trimmed[..trimmed.len()], &rom[..trimmed.len()]);
}

#[test]
fn trim_dsi_uses_ntr_twl_size_boundary() {
    let temp = setup_temp_dir();
    let source = temp.child("enhanced.nds");
    let output = temp.child("enhanced.out.nds");
    let rom = build_test_nds_rom(0x02, 0x2800, 0x3A00, 0x7000, false);
    fs::write(source.path(), &rom).expect("fixture");

    let trim_output = command_stdout(
        &[
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=dsi"));
    assert!(label.contains("trimmed_size=14848"));
    assert!(label.contains("preserved_download_play_cert=false"));

    let trimmed = fs::read(output.path()).expect("trimmed output");
    assert_eq!(trimmed.len(), 0x3A00);
    assert_eq!(&trimmed[..], &rom[..0x3A00]);
}

fn assert_trim_fixture_parity_and_determinism(
    fixture_base: &str,
    expected_mode: &str,
    expected_trimmed_size: usize,
    expected_download_play_cert: bool,
) {
    let temp = setup_temp_dir();
    let source = temp.child(format!("{fixture_base}.input.nds"));
    let output_a = temp.child(format!("{fixture_base}.trim-a.nds"));
    let output_b = temp.child(format!("{fixture_base}.trim-b.nds"));

    let source_fixture = trim_fixture_path(&format!("{fixture_base}.input.nds"));
    let expected_fixture = trim_fixture_path(&format!("{fixture_base}.expected.trim.nds"));
    fs::copy(&source_fixture, source.path()).expect("copy input fixture");
    let expected = fs::read(expected_fixture).expect("expected trimmed fixture");

    let first_output = command_stdout(
        &[
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output_a.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let first_terminal = parse_single_json_line(&first_output);
    assert_eq!(first_terminal["command"], "trim");
    assert_eq!(first_terminal["family"], "command");
    assert_eq!(first_terminal["format"], "nds");
    assert_eq!(first_terminal["status"], "succeeded");

    let first_label = first_terminal["label"].as_str().expect("label");
    assert!(first_label.contains(&format!("mode={expected_mode}")));
    assert!(first_label.contains(&format!("trimmed_size={expected_trimmed_size}")));
    assert!(first_label.contains(&format!(
        "preserved_download_play_cert={expected_download_play_cert}"
    )));

    let first_trimmed = fs::read(output_a.path()).expect("first trimmed output");
    assert_eq!(first_trimmed, expected);

    let second_output = command_stdout(
        &[
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output_b.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let second_terminal = parse_single_json_line(&second_output);
    assert_eq!(second_terminal["command"], "trim");
    assert_eq!(second_terminal["family"], "command");
    assert_eq!(second_terminal["format"], "nds");
    assert_eq!(second_terminal["status"], "succeeded");

    let second_trimmed = fs::read(output_b.path()).expect("second trimmed output");
    assert_eq!(second_trimmed, expected);
    assert_eq!(first_trimmed, second_trimmed);
}

#[test]
fn trim_nds_fixture_matches_expected_output_deterministically() {
    assert_trim_fixture_parity_and_determinism("nds-downloadplay", "ds", 0x3200 + 0x88, true);
}

#[test]
fn trim_dsi_fixture_matches_expected_output_deterministically() {
    assert_trim_fixture_parity_and_determinism("dsi-ntr-twl", "dsi", 0x3A00, false);
}

#[test]
fn trim_rejects_invalid_header_crc() {
    let temp = setup_temp_dir();
    let source = temp.child("bad.nds");
    let mut rom = build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false);
    rom[0x15E] ^= 0x01;
    fs::write(source.path(), &rom).expect("fixture");

    let trim_output = command_stdout(
        &["trim", source.path().to_str().expect("path"), "--json"],
        1,
    );

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["format"], "nds");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("header CRC mismatch")
    );
}

#[test]
fn trim_supports_batch_inputs_with_custom_extension() {
    let temp = setup_temp_dir();
    let source_a = temp.child("a.nds");
    let source_b = temp.child("b.nds");
    fs::write(
        source_a.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("fixture");
    fs::write(
        source_b.path(),
        build_test_nds_rom(0x00, 0x3200, 0x3200, 0x5800, true),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "trim",
            source_a.path().to_str().expect("path"),
            source_b.path().to_str().expect("path"),
            "--extension",
            "tokyo.nds",
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("processed=2"));
    assert!(label.contains("trimmed=2"));

    let trimmed_a = source_a.path().with_extension("tokyo.nds");
    let trimmed_b = source_b.path().with_extension("tokyo.nds");
    assert_eq!(fs::read(trimmed_a).expect("trimmed a").len(), 0x3000);
    assert_eq!(fs::read(trimmed_b).expect("trimmed b").len(), 0x3200 + 0x88);
}

#[test]
fn trim_recursively_scans_directories_by_default() {
    let temp = setup_temp_dir();
    let root = temp.child("input");
    fs::create_dir_all(root.child("nested").path()).expect("mkdir");

    let top_level = root.child("top.nds");
    let nested = root.child("nested/deep.nds");
    fs::write(
        top_level.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("fixture");
    fs::write(
        nested.path(),
        build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true),
    )
    .expect("fixture");
    fs::write(root.child("readme.txt").path(), b"ignore me").expect("fixture");

    let output = command_stdout(&["trim", root.path().to_str().expect("path"), "--json"], 0);

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("processed=2"));
    assert!(label.contains("skipped_unsupported=1"));
    assert!(top_level.path().with_extension("trim.nds").exists());
    assert!(nested.path().with_extension("trim.nds").exists());
}

#[test]
fn trim_no_recursive_only_processes_top_level() {
    let temp = setup_temp_dir();
    let root = temp.child("input");
    fs::create_dir_all(root.child("nested").path()).expect("mkdir");

    let top_level = root.child("top.nds");
    let nested = root.child("nested/deep.nds");
    fs::write(
        top_level.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("fixture");
    fs::write(
        nested.path(),
        build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "trim",
            root.path().to_str().expect("path"),
            "--no-recursive",
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("processed=1"));
    assert!(top_level.path().with_extension("trim.nds").exists());
    assert!(!nested.path().with_extension("trim.nds").exists());
}

#[test]
fn trim_dry_run_does_not_write_outputs() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    fs::write(
        source.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "trim",
            source.path().to_str().expect("path"),
            "--dry-run",
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("trim simulation complete")
    );
    assert!(!source.path().with_extension("trim.nds").exists());
}

#[test]
fn trim_simulate_alias_does_not_write_outputs() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    fs::write(
        source.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "trim",
            source.path().to_str().expect("path"),
            "--simulate",
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("trim simulation complete")
    );
    assert!(!source.path().with_extension("trim.nds").exists());
}

#[test]
fn trim_xiso_simulate_does_not_write_outputs() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    let source = temp.child("disc.xiso");
    write_xiso_fixture_from_directory(source_tree.path(), source.path());
    let mut source_file = File::options()
        .read(true)
        .write(true)
        .open(source.path())
        .expect("open xiso");
    source_file
        .seek(std::io::SeekFrom::End(0))
        .expect("seek xiso end");
    source_file
        .write_all(&vec![0_u8; 64 * 2048])
        .expect("append xiso padding");
    source_file.flush().expect("flush xiso padding");

    let output = command_stdout(
        &[
            "trim",
            source.path().to_str().expect("path"),
            "--simulate",
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("trim simulation complete"));
    assert!(label.contains("mode=xiso"));
    assert!(!source.path().with_extension("trim.xiso").exists());
}

#[test]
fn trim_wbfs_simulate_does_not_write_outputs() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x4000);
    let source_iso = temp.child("disc.iso");
    let source_wbfs = temp.child("disc.wbfs");
    fs::write(source_iso.path(), &iso_bytes).expect("iso fixture");
    let disc = NodDiscReader::new(source_iso.path(), &NodDiscOptions::default()).expect("open iso");
    let options = NodFormatOptions {
        format: NodFormat::Wbfs,
        compression: NodCompression::None,
        block_size: NodFormat::Wbfs.default_block_size(),
    };
    let writer = NodDiscWriter::new(disc, &options).expect("create wbfs writer");
    let mut output = File::create(source_wbfs.path()).expect("create wbfs");
    let finalization = writer
        .process(
            |data, _processed, _total| output.write_all(data.as_ref()),
            &NodProcessOptions::default(),
        )
        .expect("write wbfs");
    if !finalization.header.is_empty() {
        output.rewind().expect("seek wbfs");
        output
            .write_all(finalization.header.as_ref())
            .expect("write wbfs header");
    }
    output.flush().expect("flush wbfs");

    let trim_output = command_stdout(
        &[
            "trim",
            source_wbfs.path().to_str().expect("path"),
            "--simulate",
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("trim simulation complete"));
    assert!(label.contains("mode=rvz-scrub"));
    assert!(!source_wbfs.path().with_extension("trim.rvz").exists());
}

#[test]
fn trim_short_inplace_flag_trims_source_file() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    let rom = build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, true);
    fs::write(source.path(), &rom).expect("fixture");
    let original_len = fs::metadata(source.path()).expect("metadata").len();

    let output = command_stdout(
        &[
            "trim",
            source.path().to_str().expect("path"),
            "-i",
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("output=")
    );
    let trimmed_len = fs::metadata(source.path()).expect("trimmed metadata").len();
    assert!(trimmed_len < original_len);
    assert_eq!(trimmed_len, 0x3000 + 0x88);
}

#[test]
fn trim_gba_uses_zero_padding_boundary() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.gba");
    fs::write(source.path(), build_test_padded_rom(0x3456, 0x4000, 0x00)).expect("fixture");

    let output = command_stdout(
        &["trim", source.path().to_str().expect("path"), "--json"],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=gba"));
    assert!(label.contains("trimmed_size=13398"));

    let trimmed = source.path().with_extension("trim.gba");
    assert_eq!(fs::read(trimmed).expect("trimmed gba").len(), 0x3456);
}

#[test]
fn trim_gba_detects_ff_padding_boundary() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.gba");
    // Real GBA carts pad with 0xFF; trim must auto-detect and remove it just like 0x00 padding.
    fs::write(source.path(), build_test_padded_rom(0x3456, 0x4000, 0xFF)).expect("fixture");

    let output = command_stdout(
        &["trim", source.path().to_str().expect("path"), "--json"],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=gba"));
    assert!(label.contains("trimmed_size=13398"));

    let trimmed = source.path().with_extension("trim.gba");
    assert_eq!(fs::read(trimmed).expect("trimmed gba").len(), 0x3456);
}

#[test]
fn trim_3ds_uses_ff_padding_boundary() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.3ds");
    fs::write(source.path(), build_test_padded_rom(0x4567, 0x8000, 0xFF)).expect("fixture");

    let output = command_stdout(
        &["trim", source.path().to_str().expect("path"), "--json"],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=3ds"));
    assert!(label.contains("trimmed_size=17767"));

    let trimmed = source.path().with_extension("trim.3ds");
    assert_eq!(fs::read(trimmed).expect("trimmed 3ds").len(), 0x4567);
}

#[test]
fn trim_xiso_rebuilds_and_warns_irreversible() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    let source = temp.child("source.iso");
    write_xiso_fixture_from_directory(source_tree.path(), source.path());

    let mut source_file = File::options()
        .append(true)
        .open(source.path())
        .expect("open xiso");
    source_file
        .write_all(&vec![0_u8; 64 * 1024])
        .expect("append trailing padding");
    source_file.flush().expect("flush xiso padding");
    drop(source_file);

    let original_len = fs::metadata(source.path()).expect("source metadata").len();
    let output = temp.child("trimmed.xiso");

    let trim_output = command_stdout(
        &[
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=xiso"));
    assert!(label.contains("revert_supported=false"));
    assert!(label.contains(
        "warning=trimmed xiso output cannot be reverted to original padding; keep backup"
    ));

    let trimmed_len = fs::metadata(output.path()).expect("trimmed metadata").len();
    assert!(trimmed_len < original_len);

    let output_file = File::open(output.path()).expect("trimmed xiso output");
    let output_reader = std::io::BufReader::new(output_file);
    let mut output_image = XdvdfsOffsetWrapper::new(output_reader).expect("offset wrapper");
    let volume = xdvdfs::read::read_volume(&mut output_image).expect("xdvdfs volume");
    let root_entries = volume
        .root_table
        .walk_dirent_tree(&mut output_image)
        .expect("root entry tree");
    let names = root_entries
        .into_iter()
        .map(|entry| {
            entry
                .name_str::<std::io::Error>()
                .expect("entry name")
                .into_owned()
        })
        .collect::<Vec<_>>();
    assert!(
        names
            .iter()
            .any(|name| name.eq_ignore_ascii_case("default.xbe"))
    );
}

#[test]
fn trim_xiso_revert_is_rejected() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    let source = temp.child("source.iso");
    write_xiso_fixture_from_directory(source_tree.path(), source.path());

    let trim_output = command_stdout(
        &[
            "trim",
            source.path().to_str().expect("path"),
            "--revert",
            "--json",
        ],
        1,
    );

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("xiso trim revert is not supported")
    );
}

#[test]
fn trim_wbfs_uses_rvz_scrub_output() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x8000);
    let source_iso = temp.child("disc.iso");
    let source_wbfs = temp.child("disc.wbfs");
    fs::write(source_iso.path(), &iso_bytes).expect("iso fixture");
    let disc = NodDiscReader::new(source_iso.path(), &NodDiscOptions::default()).expect("open iso");
    let options = NodFormatOptions {
        format: NodFormat::Wbfs,
        compression: NodCompression::None,
        block_size: NodFormat::Wbfs.default_block_size(),
    };
    let writer = NodDiscWriter::new(disc, &options).expect("create wbfs writer");
    let mut output = File::create(source_wbfs.path()).expect("create wbfs");
    let finalization = writer
        .process(
            |data, _processed, _total| output.write_all(data.as_ref()),
            &NodProcessOptions::default(),
        )
        .expect("write wbfs");
    if !finalization.header.is_empty() {
        output.rewind().expect("seek wbfs");
        output
            .write_all(finalization.header.as_ref())
            .expect("write wbfs header");
    }
    output.flush().expect("flush wbfs");

    let trim_output = command_stdout(
        &["trim", source_wbfs.path().to_str().expect("path"), "--json"],
        0,
    );

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=rvz-scrub"));
    assert!(label.contains("revert_supported=false"));
    assert!(label.contains(
        "warning=trimmed rvz-scrub output cannot be reverted to original source format; keep backup"
    ));

    let trimmed = source_wbfs.path().with_extension("trim.rvz");
    assert!(trimmed.exists(), "expected trimmed rvz output");

    let extract_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            trimmed.to_str().expect("path"),
            "--out-dir",
            extract_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let extract_terminal = parse_single_json_line(&extract_output);
    assert_eq!(extract_terminal["command"], "extract");
    assert_eq!(extract_terminal["format"], "rvz");
    assert_eq!(extract_terminal["status"], "succeeded");
    assert_eq!(
        fs::read(extract_dir.child("disc.trim.iso").path()).expect("extracted iso"),
        iso_bytes
    );
}

#[test]
fn trim_wbfs_revert_is_rejected_for_rvz_scrub() {
    let temp = setup_temp_dir();
    let iso_bytes = build_test_gamecube_iso(0x4000);
    let source_iso = temp.child("disc.iso");
    let source_wbfs = temp.child("disc.wbfs");
    fs::write(source_iso.path(), &iso_bytes).expect("iso fixture");
    let disc = NodDiscReader::new(source_iso.path(), &NodDiscOptions::default()).expect("open iso");
    let options = NodFormatOptions {
        format: NodFormat::Wbfs,
        compression: NodCompression::None,
        block_size: NodFormat::Wbfs.default_block_size(),
    };
    let writer = NodDiscWriter::new(disc, &options).expect("create wbfs writer");
    let mut output = File::create(source_wbfs.path()).expect("create wbfs");
    let finalization = writer
        .process(
            |data, _processed, _total| output.write_all(data.as_ref()),
            &NodProcessOptions::default(),
        )
        .expect("write wbfs");
    if !finalization.header.is_empty() {
        output.rewind().expect("seek wbfs");
        output
            .write_all(finalization.header.as_ref())
            .expect("write wbfs header");
    }
    output.flush().expect("flush wbfs");

    let trim_output = command_stdout(
        &[
            "trim",
            source_wbfs.path().to_str().expect("path"),
            "--revert",
            "--json",
        ],
        1,
    );

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("rvz-scrub trim revert is not supported")
    );
}

#[test]
fn trim_revert_restores_gba_to_next_power_of_two() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.gba");
    fs::write(source.path(), build_test_padded_rom(0x3456, 0x4000, 0x00)).expect("fixture");

    let trim_output = command_stdout(
        &["trim", source.path().to_str().expect("path"), "--json"],
        0,
    );
    let trim_terminal = parse_single_json_line(&trim_output);
    assert_eq!(trim_terminal["status"], "succeeded");

    let trimmed = source.path().with_extension("trim.gba");
    assert_eq!(fs::read(&trimmed).expect("trimmed gba").len(), 0x3456);

    let revert_output = command_stdout(
        &[
            "trim",
            trimmed.to_str().expect("path"),
            "--revert",
            "--json",
        ],
        0,
    );

    let revert_terminal = parse_single_json_line(&revert_output);
    assert_eq!(revert_terminal["command"], "trim");
    assert_eq!(revert_terminal["status"], "succeeded");
    assert!(
        revert_terminal["label"]
            .as_str()
            .expect("label")
            .contains("reverted_size=16384")
    );
    assert!(
        revert_terminal["label"]
            .as_str()
            .expect("label")
            .contains("mode=gba")
    );

    let reverted = trimmed.with_extension("untrim.gba");
    assert_eq!(fs::read(reverted).expect("reverted gba").len(), 0x4000);
}

#[test]
fn trim_revert_restores_3ds_to_next_power_of_two() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.3ds");
    fs::write(source.path(), build_test_padded_rom(0x4567, 0x8000, 0xFF)).expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0);

    let trimmed = source.path().with_extension("trim.3ds");
    assert_eq!(fs::read(&trimmed).expect("trimmed 3ds").len(), 0x4567);

    let revert_output = command_stdout(
        &[
            "trim",
            trimmed.to_str().expect("path"),
            "--untrim",
            "--json",
        ],
        0,
    );

    let revert_terminal = parse_single_json_line(&revert_output);
    assert_eq!(revert_terminal["command"], "trim");
    assert_eq!(revert_terminal["status"], "succeeded");
    assert!(
        revert_terminal["label"]
            .as_str()
            .expect("label")
            .contains("reverted_size=32768")
    );
    assert!(
        revert_terminal["label"]
            .as_str()
            .expect("label")
            .contains("mode=3ds")
    );

    let reverted = trimmed.with_extension("untrim.3ds");
    assert_eq!(fs::read(reverted).expect("reverted 3ds").len(), 0x8000);
}

#[test]
fn trim_revert_restores_nds_to_power_of_two() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    let rom = build_test_nds_rom(0x00, 0x3000, 0x3000, 0x8000, false);
    fs::write(source.path(), &rom).expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "-i",
            "--json",
        ])
        .assert()
        .code(0);

    assert_eq!(fs::read(source.path()).expect("trimmed nds").len(), 0x3000);

    let output = command_stdout(
        &[
            "trim",
            source.path().to_str().expect("path"),
            "--revert",
            "-i",
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("mode=ds")
    );
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("reverted_size=16384")
    );
    assert_eq!(fs::read(source.path()).expect("reverted nds").len(), 0x4000);
}

#[test]
fn trim_skips_non_nds_inputs() {
    let temp = setup_temp_dir();
    let source = temp.child("notes.txt");
    fs::write(source.path(), b"not an nds file").expect("fixture");

    let output = command_stdout(
        &["trim", source.path().to_str().expect("path"), "--json"],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("no trim-eligible inputs found; skipped_unsupported=1")
    );
}

#[test]
fn trim_extracts_rom_from_zip_and_writes_side_by_side() {
    let temp = setup_temp_dir();
    let rom_path = temp.child("game.nds");
    let archive = temp.child("game.zip");
    let rom = build_test_nds_rom(0x00, 0x2000, 0x2000, 0x4000, false);
    fs::write(rom_path.path(), &rom).expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            rom_path.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
        ])
        .assert()
        .code(0);

    // Drop the loose ROM so the archive is the only trim input.
    fs::remove_file(rom_path.path()).expect("remove loose rom");

    let output = command_stdout(
        &["trim", archive.path().to_str().expect("path"), "--json"],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("processed=1"));
    assert!(label.contains("skipped_unsupported=0"));
    assert!(label.contains("mode=ds"));

    // Side-by-side output lands next to the archive using the payload stem.
    let side_by_side = temp.child("game.trim.nds");
    let trimmed = fs::read(side_by_side.path()).expect("trimmed side-by-side output");
    assert_eq!(trimmed.len(), 0x2000);
    assert_eq!(&trimmed[..], &rom[..0x2000]);
    // The archive itself is left in place.
    assert!(archive.path().exists());
}

#[test]
fn trim_in_place_archive_with_sidecar_fails_without_tty() {
    let temp = setup_temp_dir();
    let rom_path = temp.child("game.nds");
    let note = temp.child("readme.txt");
    let archive = temp.child("game.zip");
    let rom = build_test_nds_rom(0x00, 0x2000, 0x2000, 0x4000, false);
    fs::write(rom_path.path(), &rom).expect("fixture");
    fs::write(note.path(), b"keep me").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            rom_path.path().to_str().expect("path"),
            note.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
        ])
        .assert()
        .code(0);

    let before = fs::read(archive.path()).expect("archive bytes");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            "--in-place",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .failure()
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("refusing to repack")
    );
    // Non-interactive repack must not touch the archive.
    assert_eq!(fs::read(archive.path()).expect("archive bytes"), before);
}

#[test]
fn trim_in_place_rom_only_archive_repacks() {
    let temp = setup_temp_dir();
    let rom_path = temp.child("game.nds");
    let archive = temp.child("game.zip");
    let extract_dir = temp.child("out");
    let rom = build_test_nds_rom(0x00, 0x2000, 0x2000, 0x4000, false);
    fs::write(rom_path.path(), &rom).expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            rom_path.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
        ])
        .assert()
        .code(0);
    fs::remove_file(rom_path.path()).expect("remove loose rom");

    let output = command_stdout(
        &[
            "trim",
            "--in-place",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("processed=1")
    );

    // The repacked archive contains the trimmed ROM.
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--out-dir",
            extract_dir.path().to_str().expect("path"),
            "--no-nested-extract",
        ])
        .assert()
        .code(0);
    let trimmed = fs::read(extract_dir.child("game.nds").path()).expect("repacked rom");
    assert_eq!(trimmed.len(), 0x2000);
    assert_eq!(&trimmed[..], &rom[..0x2000]);
}

#[test]
fn trim_revert_marker_round_trips_byte_identical() {
    let temp = setup_temp_dir();
    let source = temp.child("game.gba");
    // 0x00 padding cannot be reconstructed from convention alone; the revert marker must record it.
    let original = build_test_padded_rom(0x3456, 0x4000, 0x00);
    fs::write(source.path(), &original).expect("fixture");

    let trimmed = temp.child("game.trim.gba");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--revert-marker",
            "--output",
            trimmed.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    // Trimmed payload plus the 14-byte revert footer.
    assert_eq!(
        fs::read(trimmed.path()).expect("trimmed gba").len(),
        0x3456 + 14
    );

    let reverted = temp.child("game.revert.gba");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            trimmed.path().to_str().expect("path"),
            "--revert",
            "--output",
            reverted.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    // Revert reconstructs the original byte-for-byte, including the 0x00 padding.
    assert_eq!(fs::read(reverted.path()).expect("reverted gba"), original);
}

#[test]
fn trim_without_revert_marker_writes_no_footer() {
    let temp = setup_temp_dir();
    let source = temp.child("game.gba");
    fs::write(source.path(), build_test_padded_rom(0x3456, 0x4000, 0xFF)).expect("fixture");

    let trimmed = temp.child("game.trim.gba");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            trimmed.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    // Opt-in: without --revert-marker the trim is a clean truncation with no footer appended.
    assert_eq!(fs::read(trimmed.path()).expect("trimmed gba").len(), 0x3456);
}

// ---- relocated from shared.rs (single-module helpers) ----

fn trim_fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/trim")
        .join(name)
}

fn build_test_padded_rom(payload_size: usize, full_size: usize, pad_byte: u8) -> Vec<u8> {
    assert!(payload_size > 0, "payload size must be non-zero");
    assert!(
        full_size > payload_size,
        "full ROM size must exceed payload size"
    );

    let mut rom = vec![pad_byte; full_size];
    for (index, byte) in rom[..payload_size].iter_mut().enumerate() {
        let mut value = ((index * 17 + 3) % 253 + 1) as u8;
        if value == pad_byte {
            value = value.wrapping_sub(1);
            if value == pad_byte {
                value = value.wrapping_add(2);
            }
        }
        *byte = value;
    }
    rom
}
