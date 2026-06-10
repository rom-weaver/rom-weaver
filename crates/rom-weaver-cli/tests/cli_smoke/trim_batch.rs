use super::shared::*;

#[test]
fn trim_reports_percent_100_in_json() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    let output = temp.child("sample.trim.nds");
    let rom = build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false);
    fs::write(source.path(), &rom).expect("fixture");

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let first_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output_a.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let second_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output_b.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source_a.path().to_str().expect("path"),
            source_b.path().to_str().expect("path"),
            "--extension",
            "tokyo.nds",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", root.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            root.path().to_str().expect("path"),
            "--no-recursive",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--dry-run",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--simulate",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--simulate",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source_wbfs.path().to_str().expect("path"),
            "--simulate",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "-i",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--revert",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

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

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source_wbfs.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
    let extract_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            trimmed.to_str().expect("path"),
            "--out-dir",
            extract_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source_wbfs.path().to_str().expect("path"),
            "--revert",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

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

    let trim_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let trim_terminal = parse_single_json_line(&trim_output);
    assert_eq!(trim_terminal["status"], "succeeded");

    let trimmed = source.path().with_extension("trim.gba");
    assert_eq!(fs::read(&trimmed).expect("trimmed gba").len(), 0x3456);

    let revert_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            trimmed.to_str().expect("path"),
            "--revert",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let revert_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            trimmed.to_str().expect("path"),
            "--untrim",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            source.path().to_str().expect("path"),
            "--revert",
            "-i",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", source.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
fn batch_header_fixer_repairs_headers_and_reports_json_contract() {
    let temp = setup_temp_dir();
    let root = temp.child("input");
    fs::create_dir_all(root.path()).expect("mkdir");

    let mut gba = build_test_gba_rom(0x5000);
    gba[0x1BD] ^= 0x7F;
    fs::write(root.child("game.gba").path(), &gba).expect("fixture");

    let mut genesis = vec![0_u8; 0x300];
    genesis[0x100..0x104].copy_from_slice(b"SEGA");
    genesis[0x200..0x208].copy_from_slice(&[0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]);
    fs::write(root.child("genesis.md").path(), &genesis).expect("fixture");

    fs::write(root.child("notes.txt").path(), b"ignore me").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "batch-header-fixer",
            root.path().to_str().expect("path"),
            "--extension",
            "fixed.{ext}",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "batch-header-fixer");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["format"], "header-fix");
    assert_eq!(terminal["status"], "succeeded");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("processed=2"));
    assert!(label.contains("repaired=2"));
    assert!(label.contains("skipped_non_rom=1"));
    assert!(label.contains("supported_system_count=19"));

    assert_eq!(
        terminal["details"]["batch_header_fixer"]["supported_system_count"],
        19
    );
    assert_eq!(
        terminal["details"]["batch_header_fixer"]["processed_files"],
        2
    );
    assert_eq!(
        terminal["details"]["batch_header_fixer"]["repaired_files"],
        2
    );
    assert_eq!(terminal["details"]["batch_header_fixer"]["failed_files"], 0);
    assert_eq!(
        terminal["details"]["batch_header_fixer"]["skipped_non_rom"],
        1
    );

    let repaired_profiles = terminal["details"]["batch_header_fixer"]["repaired_profiles"]
        .as_array()
        .expect("repaired profile list")
        .iter()
        .filter_map(|value| value.as_str())
        .collect::<Vec<_>>();
    assert!(repaired_profiles.contains(&"gba"));
    assert!(repaired_profiles.contains(&"sega-genesis"));

    let gba_output = root.child("game.fixed.gba");
    let genesis_output = root.child("genesis.fixed.md");
    assert_emitted_file(&terminal, gba_output.path(), Some("rom"));
    assert_emitted_file(&terminal, genesis_output.path(), Some("rom"));

    let gba_fixed = fs::read(gba_output.path()).expect("gba output");
    assert_eq!(gba_fixed[0x1BD], gba_header_checksum(&gba_fixed));

    let genesis_fixed = fs::read(genesis_output.path()).expect("genesis output");
    let genesis_checksum = u16::from_be_bytes([genesis_fixed[0x18E], genesis_fixed[0x18F]]);
    assert_eq!(genesis_checksum, sega_genesis_checksum(&genesis_fixed));
}

#[test]
fn batch_header_fixer_fixture_roundtrip_covers_19_profile_matrix() {
    let temp = setup_temp_dir();
    let root = temp.child("matrix");
    fs::create_dir_all(root.path()).expect("mkdir");

    let mut snes = vec![0_u8; 0x10000];
    for (index, value) in snes.iter_mut().enumerate().skip(0x200) {
        *value = (index as u8).wrapping_mul(3).wrapping_add(1);
    }
    snes[0x7FC0..0x7FD5].copy_from_slice(b"ROMWEAVER SNES TEST!!");
    fs::write(root.child("snes.sfc").path(), &snes).expect("fixture");

    let mut nes = with_nes_header(b"nes-payload-1234");
    nes[11] = 0xFF;
    fs::write(root.child("nes.nes").path(), &nes).expect("fixture");

    fs::write(
        root.child("fds.fds").path(),
        with_fds_header(b"fds-payload"),
    )
    .expect("fixture");

    let mut game_boy = build_test_game_boy_rom(0x3000);
    game_boy[0x14D] = 0;
    game_boy[0x14E] = 0;
    game_boy[0x14F] = 0;
    fs::write(root.child("gameboy.gb").path(), &game_boy).expect("fixture");

    let mut gba = build_test_gba_rom(0x5000);
    gba[0x1BD] ^= 0x55;
    fs::write(root.child("gba.gba").path(), &gba).expect("fixture");

    let mut genesis = vec![0_u8; 0x300];
    genesis[0x100..0x104].copy_from_slice(b"SEGA");
    genesis[0x200..0x210].copy_from_slice(&[
        0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF, 0x10, 0x32, 0x54, 0x76, 0x98, 0xBA, 0xDC,
        0xFE,
    ]);
    fs::write(root.child("genesis.md").path(), &genesis).expect("fixture");

    let mut sms = vec![0_u8; 0x8000];
    for (index, value) in sms.iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(5).wrapping_add(0x2D);
    }
    sms[0x7FF0..0x7FF8].copy_from_slice(b"TMR SEGA");
    sms[0x7FFF] = 0x0E;
    sms[0x7FFA] = 0;
    sms[0x7FFB] = 0;
    fs::write(root.child("sms.gg").path(), &sms).expect("fixture");

    let mut n64 = vec![0_u8; 0x101000];
    n64[..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
    for (index, value) in n64[0x1000..].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(9).wrapping_add(0x11);
    }
    fs::write(root.child("n64.z64").path(), &n64).expect("fixture");

    let mut a7800 = with_a78_header(&vec![0xAB; 0x800]);
    for value in &mut a7800[0x64..0x80] {
        *value = 0x7E;
    }
    fs::write(root.child("a7800.a78").path(), &a7800).expect("fixture");

    let mut lynx = with_lnx_header(&vec![0x55; 0x400]);
    lynx[4] = 0;
    lynx[5] = 0;
    for value in &mut lynx[59..64] {
        *value = 0xAA;
    }
    fs::write(root.child("lynx.lnx").path(), &lynx).expect("fixture");

    let mut pce = vec![0xCC; 512 + 8192];
    pce[512..520].copy_from_slice(b"PCE-DATA");
    fs::write(root.child("pcengine.pce").path(), &pce).expect("fixture");

    let mut virtual_boy = vec![0_u8; 0x600];
    let vb_header_offset = virtual_boy.len() - 0x220;
    for value in &mut virtual_boy[vb_header_offset + 0x14..vb_header_offset + 0x19] {
        *value = 0x5A;
    }
    fs::write(root.child("virtualboy.vb").path(), &virtual_boy).expect("fixture");

    let mut ngp = vec![0_u8; 0x80];
    ngp[..16].copy_from_slice(b"COPYRIGHT BY SNK");
    for value in &mut ngp[0x24..0x30] {
        *value = 0x21;
    }
    fs::write(root.child("ngp.ngp").path(), &ngp).expect("fixture");

    let mut msx = vec![0_u8; 0x80];
    msx[..2].copy_from_slice(b"AB");
    for value in &mut msx[0x0A..0x10] {
        *value = 0xF0;
    }
    fs::write(root.child("msx.mx1").path(), &msx).expect("fixture");

    let mut nds = build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, false);
    nds[0xC0..0xC4].copy_from_slice(&[0x24, 0xFF, 0xAE, 0x51]);
    nds[0x15E] = 0;
    nds[0x15F] = 0;
    fs::write(root.child("nds.nds").path(), &nds).expect("fixture");

    fs::write(root.child("jaguar.j64").path(), vec![0_u8; 0x2000]).expect("fixture");

    let mut coleco = vec![0_u8; 64];
    coleco[0] = 0xAA;
    coleco[1] = 0x55;
    fs::write(root.child("coleco.col").path(), &coleco).expect("fixture");

    fs::write(root.child("watara.sv").path(), vec![0_u8; 64]).expect("fixture");
    fs::write(root.child("intellivision.int").path(), vec![0_u8; 0x50]).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "batch-header-fixer",
            root.path().to_str().expect("path"),
            "--extension",
            "fixed.{ext}",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "batch-header-fixer");
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(
        terminal["details"]["batch_header_fixer"]["supported_system_count"],
        19
    );
    assert_eq!(
        terminal["details"]["batch_header_fixer"]["processed_files"],
        19
    );
    assert_eq!(
        terminal["details"]["batch_header_fixer"]["repaired_files"],
        14
    );
    assert_eq!(
        terminal["details"]["batch_header_fixer"]["matched_files"],
        5
    );
    assert_eq!(
        terminal["details"]["batch_header_fixer"]["unsupported_files"],
        0
    );
    assert_eq!(terminal["details"]["batch_header_fixer"]["failed_files"], 0);

    let repaired_profiles = terminal["details"]["batch_header_fixer"]["repaired_profiles"]
        .as_array()
        .expect("repaired profile array")
        .iter()
        .filter_map(|value| value.as_str())
        .collect::<BTreeSet<_>>();
    let matched_profiles = terminal["details"]["batch_header_fixer"]["matched_profiles"]
        .as_array()
        .expect("matched profile array")
        .iter()
        .filter_map(|value| value.as_str())
        .collect::<BTreeSet<_>>();
    let mut all_profiles = repaired_profiles.clone();
    all_profiles.extend(matched_profiles.iter().copied());

    let expected_profiles = [
        "snes",
        "nes",
        "fds",
        "game-boy",
        "gba",
        "sega-genesis",
        "sms-gg",
        "n64",
        "atari-7800",
        "atari-lynx",
        "pce-tg16",
        "virtual-boy",
        "neo-geo-pocket",
        "msx",
        "nds",
        "atari-jaguar",
        "colecovision",
        "watara-supervision",
        "intellivision",
    ];
    assert_eq!(all_profiles.len(), expected_profiles.len());
    for profile in expected_profiles {
        assert!(all_profiles.contains(profile), "missing profile {profile}");
    }

    let pce_fixed = root.child("pcengine.fixed.pce");
    assert_eq!(
        fs::read(pce_fixed.path()).expect("fixed pce").len(),
        fs::read(root.child("pcengine.pce").path())
            .expect("source pce")
            .len()
            - 512
    );
}

#[test]
fn batch_header_fixer_dry_run_does_not_write_outputs() {
    let temp = setup_temp_dir();
    let source = temp.child("dry-run.gba");
    let mut gba = build_test_gba_rom(0x4000);
    gba[0x1BD] ^= 0x40;
    fs::write(source.path(), &gba).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "batch-header-fixer",
            source.path().to_str().expect("path"),
            "--dry-run",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "batch-header-fixer");
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["details"]["batch_header_fixer"]["dry_run"], true);
    assert_eq!(
        terminal["details"]["batch_header_fixer"]["repaired_files"],
        1
    );
    assert_eq!(terminal["details"]["batch_header_fixer"]["failed_files"], 0);
    assert_eq!(fs::read(source.path()).expect("source bytes"), gba);
    assert!(!source.path().with_extension("fixed.gba").exists());
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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["trim", archive.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            "--in-place",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
