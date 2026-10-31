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
            "--input",
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
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--json",
        ],
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
            "--input",
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
            "--input",
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
            "--input",
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
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--json",
        ],
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
            "--input",
            source_a.path().to_str().expect("path"),
            "--input",
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

    let output = command_stdout(
        &[
            "trim",
            "--input",
            root.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

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
fn trim_on_a_directory_is_quiet_unless_verbose() {
    let temp = setup_temp_dir();
    let root = temp.child("input");
    fs::create_dir_all(root.path()).expect("mkdir");
    let rom = root.child("top.nds");
    fs::write(
        rom.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("fixture");
    let root_s = root.path().to_str().expect("path");

    let quiet = command_output_with_env(&["trim", "--input", root_s], &[], 0);
    assert!(
        quiet.stdout.is_empty(),
        "stdout: {}",
        String::from_utf8_lossy(&quiet.stdout)
    );
    assert!(rom.path().with_extension("trim.nds").exists());

    fs::remove_file(rom.path().with_extension("trim.nds")).expect("remove first output");
    let verbose = command_output_with_env(&["trim", "--input", root_s, "-v"], &[], 0);
    let streams = format!(
        "{}{}",
        String::from_utf8_lossy(&verbose.stdout),
        String::from_utf8_lossy(&verbose.stderr)
    );
    assert!(streams.contains("top.trim.nds"), "{streams}");
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
            "--input",
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
            "--input",
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
fn trim_dry_run_does_not_create_output_directory() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.nds");
    let original = build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false);
    fs::write(source.path(), &original).expect("fixture");
    let destination = temp.child("missing/output.nds");
    let output = command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--output",
            destination.path().to_str().expect("path"),
            "--dry-run",
            "--json",
        ],
        0,
    );
    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["status"], "succeeded");
    assert!(!temp.child("missing").path().exists());
    assert_eq!(fs::read(source.path()).expect("source"), original);
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
            "--input",
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
            "--input",
            source.path().to_str().expect("path"),
            "--dry-run",
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
            "--input",
            source_wbfs.path().to_str().expect("path"),
            "--dry-run",
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
    assert!(label.contains("mode=rvz-convert"));
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
            "--input",
            source.path().to_str().expect("path"),
            "--in-place",
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
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--json",
        ],
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
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--json",
        ],
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
    let mut rom = build_test_padded_rom(0x4567, 0x8000, 0xFF);
    rom[0x100..0x104].copy_from_slice(b"NCCH");
    rom[0x104..0x108].copy_from_slice(&0x22_u32.to_le_bytes());
    rom[0x18E] = 0;
    fs::write(source.path(), rom).expect("fixture");

    let output = command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--json",
        ],
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
            "--input",
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
    let volume =
        rom_weaver_containers::xdvdfs::read::read_volume(&mut output_image).expect("xdvdfs volume");
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
            "--input",
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
fn trim_wbfs_uses_rvz_convert_output() {
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
        &[
            "trim",
            "--input",
            source_wbfs.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&trim_output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["family"], "command");
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["details"]["output_format"], "rvz");
    assert_eq!(terminal["details"]["input_size"], iso_bytes.len() as u64);
    assert_eq!(terminal["details"]["raw_size"], iso_bytes.len() as u64);
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("mode=rvz-convert"));
    assert!(label.contains("revert_supported=false"));
    assert!(label.contains(
        "warning=RVZ conversion preserves logical disc bytes; use extract to recover ISO"
    ));
    // A plain trim never asked for --revert, so the warning must not mention it.
    assert!(!label.contains("--revert"), "{label}");

    let trimmed = source_wbfs.path().with_extension("trim.rvz");
    assert!(trimmed.exists(), "expected trimmed rvz output");

    let extract_dir = temp.child("extract");
    let extract_output = command_stdout(
        &[
            "extract",
            "--input",
            trimmed.to_str().expect("path"),
            "--output",
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
fn trim_wbfs_revert_is_rejected_for_rvz_convert() {
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
            "--input",
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
            .contains("rvz-convert trim revert is not supported")
    );
}

/// The failure label a single rejected trim input reports around the engine's message.
fn rejected_trim_label(source: &Path, dry_run: bool, message: &str) -> String {
    let verb = if dry_run { "trim simulation" } else { "trim" };
    format!(
        "{verb} completed with failures; processed=1 trimmed=0 already_trimmed=0 failed=1 skipped_unsupported=0; first_error={}: validation failed: {message}",
        source.display()
    )
}

#[test]
fn trim_gamecube_disc_rejects_non_rvz_container_outputs() {
    let temp = setup_temp_dir();
    let source = temp.child("disc.iso");
    fs::write(source.path(), build_test_gamecube_iso(0x4000)).expect("iso fixture");

    for (extension, label) in [
        ("chd", "CHD"),
        ("wbfs", "WBFS"),
        ("gcz", "GCZ"),
        ("z3ds", "Z3DS"),
        ("tar.gz", "TAR.GZ"),
    ] {
        let output = temp.child(format!("trimmed.{extension}"));
        let terminal = parse_single_json_line(&command_stdout(
            &[
                "trim",
                "--input",
                source.path().to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--json",
            ],
            1,
        ));
        assert_eq!(terminal["status"], "failed", "{extension}");
        let message = terminal["label"].as_str().expect("label");
        // Every plain extension is rejected for these discs, so the message must not offer one.
        assert_eq!(
            message,
            rejected_trim_label(
                source.path(),
                false,
                &format!(
                    "{label} is not a valid trim output for GameCube/Wii discs: `{}` must end in one of .rvz, .zip, .7z",
                    output.path().display()
                )
            ),
            "{extension}"
        );
        assert!(!output.path().exists(), "{extension} must not be written");
    }

    let dry_run = parse_single_json_line(&command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--output",
            temp.child("dry.chd").path().to_str().expect("path"),
            "--dry-run",
            "--json",
        ],
        1,
    ));
    assert_eq!(dry_run["status"], "failed");

    let rvz = temp.child("trimmed.rvz");
    let terminal = parse_single_json_line(&command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--output",
            rvz.path().to_str().expect("path"),
            "--json",
        ],
        0,
    ));
    assert_eq!(terminal["status"], "succeeded");
    assert!(rvz.path().exists());
}

#[test]
fn trim_revert_restores_gba_to_next_power_of_two() {
    let temp = setup_temp_dir();
    let source = temp.child("sample.gba");
    fs::write(source.path(), build_test_padded_rom(0x3456, 0x4000, 0x00)).expect("fixture");

    let trim_output = command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let trim_terminal = parse_single_json_line(&trim_output);
    assert_eq!(trim_terminal["status"], "succeeded");

    let trimmed = source.path().with_extension("trim.gba");
    assert_eq!(fs::read(&trimmed).expect("trimmed gba").len(), 0x3456);

    let revert_output = command_stdout(
        &[
            "trim",
            "--input",
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
    let mut rom = build_test_padded_rom(0x4567, 0x8000, 0xFF);
    rom[0x100..0x104].copy_from_slice(b"NCCH");
    rom[0x104..0x108].copy_from_slice(&0x22_u32.to_le_bytes());
    rom[0x18E] = 0;
    fs::write(source.path(), rom).expect("fixture");

    command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let trimmed = source.path().with_extension("trim.3ds");
    assert_eq!(fs::read(&trimmed).expect("trimmed 3ds").len(), 0x4567);

    let revert_output = command_stdout(
        &[
            "trim",
            "--input",
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

    command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--in-place",
            "--json",
        ],
        0,
    );

    assert_eq!(fs::read(source.path()).expect("trimmed nds").len(), 0x3000);

    let output = command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--revert",
            "--in-place",
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
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "trim");
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["details"]["processed"], 0);
    assert_eq!(terminal["details"]["trimmed"], 0);
    assert_eq!(terminal["details"]["already_target"], 0);
    assert_eq!(terminal["details"]["skipped_unsupported"], 1);
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

    command_stdout(
        &[
            "compress",
            "--input",
            rom_path.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
        ],
        0,
    );

    // Drop the loose ROM so the archive is the only trim input.
    fs::remove_file(rom_path.path()).expect("remove loose rom");

    let output = command_stdout(
        &[
            "trim",
            "--input",
            archive.path().to_str().expect("path"),
            "--json",
        ],
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

    command_stdout(
        &[
            "compress",
            "--input",
            rom_path.path().to_str().expect("path"),
            "--input",
            note.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
        ],
        0,
    );

    let before = fs::read(archive.path()).expect("archive bytes");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "trim",
            "--in-place",
            "--input",
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

    command_stdout(
        &[
            "compress",
            "--input",
            rom_path.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
        ],
        0,
    );
    fs::remove_file(rom_path.path()).expect("remove loose rom");

    let output = command_stdout(
        &[
            "trim",
            "--in-place",
            "--input",
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
    command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            extract_dir.path().to_str().expect("path"),
            "--no-nested-extract",
        ],
        0,
    );
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
    command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--revert-marker",
            "--output",
            trimmed.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    // Trimmed payload plus the 14-byte revert footer.
    assert_eq!(
        fs::read(trimmed.path()).expect("trimmed gba").len(),
        0x3456 + 14
    );

    let reverted = temp.child("game.revert.gba");
    command_stdout(
        &[
            "trim",
            "--input",
            trimmed.path().to_str().expect("path"),
            "--revert",
            "--output",
            reverted.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    // Revert reconstructs the original byte-for-byte, including the 0x00 padding.
    assert_eq!(fs::read(reverted.path()).expect("reverted gba"), original);
}

#[test]
fn trim_revert_marker_round_trips_in_place_padding() {
    let temp = setup_temp_dir();
    let source = temp.child("game.gba");
    for pad_byte in [0x00, 0xFF] {
        let original = build_test_padded_rom(0x3456, 0x4000, pad_byte);
        fs::write(source.path(), &original).expect("fixture");
        command_stdout(
            &[
                "trim",
                "--input",
                source.path().to_str().expect("path"),
                "--revert-marker",
                "--in-place",
                "--json",
            ],
            0,
        );
        let trimmed = fs::read(source.path()).expect("trimmed ROM");
        assert_eq!(trimmed.len(), 0x3456 + 14);
        assert_eq!(trimmed[0x3456 + 4], pad_byte);
        command_stdout(
            &[
                "trim",
                "--input",
                source.path().to_str().expect("path"),
                "--revert",
                "--in-place",
                "--json",
            ],
            0,
        );
        assert_eq!(fs::read(source.path()).expect("restored ROM"), original);
    }
}

#[test]
fn trim_without_revert_marker_writes_no_footer() {
    let temp = setup_temp_dir();
    let source = temp.child("game.gba");
    fs::write(source.path(), build_test_padded_rom(0x3456, 0x4000, 0xFF)).expect("fixture");

    let trimmed = temp.child("game.trim.gba");
    command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--output",
            trimmed.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    // Opt-in: without --revert-marker the trim is a clean truncation with no footer appended.
    assert_eq!(fs::read(trimmed.path()).expect("trimmed gba").len(), 0x3456);
}

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

#[test]
fn trim_xiso_rejects_hard_link_output_without_touching_source() {
    let temp = setup_temp_dir();
    let source = temp.child("source.iso");
    let output = temp.child("alias.xiso");
    write_xiso_fixture_from_directory(temp.child("tree").path(), source.path());
    let original = fs::read(source.path()).expect("source bytes");
    fs::hard_link(source.path(), output.path()).expect("hard link");

    let stdout = command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("source path"),
            "--output",
            output.path().to_str().expect("output path"),
            "--force",
            "--json",
        ],
        1,
    );
    assert_eq!(
        fs::read(source.path()).expect("source after trim"),
        original
    );
    assert_eq!(fs::read(output.path()).expect("alias after trim"), original);
    let terminal = parse_single_json_line(&stdout);
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("--in-place"),
        "{terminal}"
    );
}

#[cfg(unix)]
#[test]
fn trim_xiso_rejects_symlink_output_without_touching_source() {
    let temp = setup_temp_dir();
    let source = temp.child("source.iso");
    let output = temp.child("alias.xiso");
    write_xiso_fixture_from_directory(temp.child("tree").path(), source.path());
    let original = fs::read(source.path()).expect("source bytes");
    std::os::unix::fs::symlink(source.path(), output.path()).expect("symlink");

    let stdout = command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("source path"),
            "--output",
            output.path().to_str().expect("output path"),
            "--force",
            "--json",
        ],
        1,
    );
    assert_eq!(
        fs::read(source.path()).expect("source after trim"),
        original
    );
    assert_eq!(fs::read(output.path()).expect("alias after trim"), original);
    let terminal = parse_single_json_line(&stdout);
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("--in-place"),
        "{terminal}"
    );
}

#[test]
fn trim_xiso_rejects_revert_marker_before_writing() {
    let temp = setup_temp_dir();
    let source = temp.child("source.iso");
    let output = temp.child("marked.xiso");
    write_xiso_fixture_from_directory(temp.child("tree").path(), source.path());
    let original = fs::read(source.path()).expect("source bytes");
    let stdout = command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("source path"),
            "--output",
            output.path().to_str().expect("output path"),
            "--revert-marker",
            "--json",
        ],
        1,
    );
    let terminal = parse_single_json_line(&stdout);
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("does not support --revert-marker"),
        "{terminal}"
    );
    assert!(!output.path().exists());
    assert_eq!(
        fs::read(source.path()).expect("source after trim"),
        original
    );
}

#[test]
fn trim_archive_preserves_dotted_member_names() {
    let temp = setup_temp_dir();
    let first = temp.child("game.v1.gba");
    let second = temp.child("game.v2.gba");
    let archive = temp.child("games.zip");
    for (source, byte) in [(&first, 1_u8), (&second, 2_u8)] {
        let mut data = vec![byte; 8192];
        data.extend(vec![0xff; 8192]);
        fs::write(source.path(), data).unwrap();
    }
    command_stdout(
        &[
            "compress",
            "-i",
            first.path().to_str().unwrap(),
            "-i",
            second.path().to_str().unwrap(),
            "-o",
            archive.path().to_str().unwrap(),
        ],
        0,
    );
    command_stdout(
        &["trim", "-i", archive.path().to_str().unwrap(), "--force"],
        0,
    );
    assert_eq!(
        fs::read(temp.child("game.v1.trim.gba").path()).unwrap(),
        vec![1_u8; 8192]
    );
    assert_eq!(
        fs::read(temp.child("game.v2.trim.gba").path()).unwrap(),
        vec![2_u8; 8192]
    );
}

#[test]
fn trim_rejects_archive_output_collisions_before_writing() {
    let temp = setup_temp_dir();
    let first = temp.child("one.gba");
    let second = temp.child("two.gba");
    let archive = temp.child("games.zip");
    for source in [&first, &second] {
        let mut data = vec![1_u8; 8192];
        data.extend(vec![0xff; 8192]);
        fs::write(source.path(), data).unwrap();
    }
    command_stdout(
        &[
            "compress",
            "-i",
            first.path().to_str().unwrap(),
            "--entry-name",
            "a/game.gba",
            "-i",
            second.path().to_str().unwrap(),
            "--entry-name",
            "b/game.gba",
            "-o",
            archive.path().to_str().unwrap(),
        ],
        0,
    );
    for flags in [&["--force"][..], &["--dry-run"][..]] {
        let mut args = vec!["trim", "-i", archive.path().to_str().unwrap()];
        args.extend_from_slice(flags);
        command_stdout(&args, 1);
        assert!(!temp.child("game.trim.gba").path().exists());
    }
}

#[test]
fn trim_rejects_patch_only_archive_filter() {
    let temp = setup_temp_dir();
    let source = temp.child("game.gba");
    let archive = temp.child("games.zip");
    let mut data = vec![1_u8; 8192];
    data.extend(vec![0xff; 8192]);
    fs::write(source.path(), &data).unwrap();
    command_stdout(
        &[
            "compress",
            "-i",
            source.path().to_str().unwrap(),
            "-o",
            archive.path().to_str().unwrap(),
        ],
        0,
    );
    command_stdout(
        &[
            "trim",
            "-i",
            archive.path().to_str().unwrap(),
            "--filter",
            "patch",
        ],
        1,
    );
    assert!(!temp.child("game.trim.gba").path().exists());
    assert_eq!(fs::read(source.path()).unwrap(), data);
}

#[test]
fn trim_revert_conflicts_with_revert_marker() {
    let temp = setup_temp_dir();
    let source = temp.child("source.gba");
    fs::write(source.path(), vec![0xFF_u8; 4096]).expect("fixture");
    command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("source path"),
            "--revert",
            "--revert-marker",
        ],
        2,
    );
}

#[test]
fn trim_extension_conflicts_with_output_and_in_place() {
    let temp = setup_temp_dir();
    let source = temp.child("source.gba");
    fs::write(source.path(), vec![0xFF_u8; 4096]).expect("fixture");
    let source = source.path().to_str().expect("source path");
    for conflicting in [["--output", "out.gba"], ["--in-place", "--force"]] {
        let mut args = vec!["trim", "--input", source, "--extension", "small.{ext}"];
        args.extend(conflicting);
        command_stdout(&args, 2);
    }
}

/// Runs `trim --input <source> --output <output>` and returns the terminal report.
fn trim_to_output(source: &Path, output: &Path, extra: &[&str], code: i32) -> Value {
    let mut args = vec![
        "trim",
        "--input",
        source.to_str().expect("path"),
        "--output",
        output.to_str().expect("path"),
    ];
    args.extend_from_slice(extra);
    args.push("--json");
    parse_single_json_line(&command_stdout(&args, code))
}

fn extracted_entries(archive: &Path, destination: &Path) -> Vec<String> {
    command_stdout(
        &[
            "extract",
            "--input",
            archive.to_str().expect("path"),
            "--output",
            destination.to_str().expect("path"),
            "--no-nested-extract",
        ],
        0,
    );
    let mut names = fs::read_dir(destination)
        .expect("extract dir")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[test]
fn trim_output_zip_or_7z_packs_the_trimmed_rom_inside() {
    let temp = setup_temp_dir();
    let source = temp.child("game.nds");
    let rom = build_test_nds_rom(0x00, 0x2000, 0x2000, 0x4000, false);
    fs::write(source.path(), &rom).expect("fixture");

    for (name, entry) in [
        ("out.zip", "out.nds"),
        ("out.7z", "out.nds"),
        ("named.nds.zip", "named.nds"),
        ("v1.2.zip", "v1.2.nds"),
    ] {
        let output = temp.child(name);
        let terminal = trim_to_output(source.path(), output.path(), &[], 0);
        assert_eq!(terminal["status"], "succeeded", "{name}");
        let destination = temp.child(format!("unpacked-{name}"));
        assert_eq!(
            extracted_entries(output.path(), destination.path()),
            vec![entry.to_string()],
            "{name}"
        );
        assert_eq!(
            fs::read(destination.child(entry).path()).expect("packed rom"),
            &rom[..0x2000],
            "{name}"
        );
    }
    assert!(!temp.child("game.trim.nds").path().exists());
}

#[test]
fn trim_output_archive_dry_run_reports_the_container_and_writes_nothing() {
    let temp = setup_temp_dir();
    let source = temp.child("game.nds");
    fs::write(
        source.path(),
        build_test_nds_rom(0x00, 0x2000, 0x2000, 0x4000, false),
    )
    .expect("fixture");
    let output = temp.child("out.zip");

    let terminal = trim_to_output(source.path(), output.path(), &["--dry-run"], 0);

    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(
        terminal["details"]["writes"],
        serde_json::json!([output.path().display().to_string()])
    );
    assert!(!output.path().exists());
}

#[test]
fn trim_output_archive_replaces_existing_file_only_with_force() {
    let temp = setup_temp_dir();
    let source = temp.child("game.nds");
    fs::write(
        source.path(),
        build_test_nds_rom(0x00, 0x2000, 0x2000, 0x4000, false),
    )
    .expect("fixture");
    let output = temp.child("out.zip");
    fs::write(output.path(), b"keep me").expect("existing output");

    let terminal = trim_to_output(source.path(), output.path(), &[], 1);
    assert_eq!(terminal["status"], "failed");
    assert_eq!(fs::read(output.path()).expect("output"), b"keep me");

    let terminal = trim_to_output(source.path(), output.path(), &["--force"], 0);
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(
        extracted_entries(output.path(), temp.child("unpacked").path()),
        vec!["out.nds".to_string()]
    );
}

#[test]
fn trim_output_container_must_be_valid_for_the_input_type() {
    let temp = setup_temp_dir();
    let source = temp.child("game.nds");
    fs::write(
        source.path(),
        build_test_nds_rom(0x00, 0x2000, 0x2000, 0x4000, false),
    )
    .expect("fixture");

    for (name, label) in [
        ("out.chd", "CHD"),
        ("out.z3ds", "Z3DS"),
        ("out.rvz", "RVZ"),
        ("out.tar.gz", "TAR.GZ"),
    ] {
        for dry_run in [false, true] {
            let output = temp.child(name);
            let extra: &[&str] = if dry_run { &["--dry-run"] } else { &[] };
            let terminal = trim_to_output(source.path(), output.path(), extra, 1);
            assert_eq!(terminal["status"], "failed", "{name} dry_run={dry_run}");
            let message = terminal["label"].as_str().expect("label");
            assert!(
                message.contains(&format!(
                    "{label} is not a valid trim output for NDS/DSi ROMs"
                )),
                "{name}: {message}"
            );
            assert!(message.contains(".zip, .7z"), "{name}: {message}");
            assert_eq!(
                message,
                rejected_trim_label(
                    source.path(),
                    dry_run,
                    &format!(
                        "{label} is not a valid trim output for NDS/DSi ROMs: `{}` must end in one of .zip, .7z, or be a plain name such as `.nds` that writes the trimmed file itself",
                        output.path().display()
                    )
                ),
                "{name}"
            );
            assert!(!output.path().exists(), "{name} must not be written");
        }
    }

    // A name that is not a container still writes the trimmed ROM itself.
    let plain = temp.child("out.bin");
    let terminal = trim_to_output(source.path(), plain.path(), &[], 0);
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(
        fs::metadata(plain.path()).expect("plain output").len(),
        0x2000
    );
}

#[test]
fn trim_output_z3ds_packs_a_3ds_rom_and_chd_packs_an_xiso() {
    let temp = setup_temp_dir();
    let rom_3ds = temp.child("sample.3ds");
    let mut rom = build_test_padded_rom(0x4567, 0x8000, 0xFF);
    rom[0x100..0x104].copy_from_slice(b"NCCH");
    rom[0x104..0x108].copy_from_slice(&0x22_u32.to_le_bytes());
    rom[0x18E] = 0;
    fs::write(rom_3ds.path(), &rom).expect("3ds fixture");
    let z3ds = temp.child("out.z3ds");
    let terminal = trim_to_output(rom_3ds.path(), z3ds.path(), &[], 0);
    assert_eq!(terminal["status"], "succeeded");
    let unpacked = temp.child("unpacked-3ds");
    command_stdout(
        &[
            "extract",
            "--input",
            z3ds.path().to_str().expect("path"),
            "--output",
            unpacked.path().to_str().expect("path"),
        ],
        0,
    );
    let extracted = fs::read_dir(unpacked.path())
        .expect("extract dir")
        .next()
        .expect("extracted file")
        .expect("entry")
        .path();
    assert_eq!(fs::read(extracted).expect("3ds payload"), &rom[..0x4567]);

    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    let xiso = temp.child("source.iso");
    write_xiso_fixture_from_directory(source_tree.path(), xiso.path());
    let chd = temp.child("out.chd");
    let terminal = trim_to_output(xiso.path(), chd.path(), &[], 0);
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(&fs::read(chd.path()).expect("chd")[..8], b"MComprHD");

    // An XISO is not a 3DS ROM, and a 3DS ROM is not a disc.
    let terminal = trim_to_output(xiso.path(), temp.child("bad.z3ds").path(), &[], 1);
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("Z3DS is not a valid trim output for Xbox XISO discs")
    );
    let terminal = trim_to_output(rom_3ds.path(), temp.child("bad.chd").path(), &[], 1);
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("CHD is not a valid trim output for 3DS ROMs")
    );
}

#[test]
fn trim_3ds_output_rejects_z3ds_descriptor_extensions_other_than_z3ds() {
    let temp = setup_temp_dir();
    let rom_3ds = temp.child("game.3ds");
    let mut rom = build_test_padded_rom(0x4567, 0x8000, 0xFF);
    rom[0x100..0x104].copy_from_slice(b"NCCH");
    rom[0x104..0x108].copy_from_slice(&0x22_u32.to_le_bytes());
    rom[0x18E] = 0;
    fs::write(rom_3ds.path(), &rom).expect("3ds fixture");

    for name in [
        "game.zcia",
        "game.zcci",
        "game.zcxi",
        "game.z3dsx",
        "GAME.ZCIA",
    ] {
        for dry_run in [false, true] {
            let output = temp.child(name);
            let extra: &[&str] = if dry_run { &["--dry-run"] } else { &[] };
            let terminal = trim_to_output(rom_3ds.path(), output.path(), extra, 1);
            assert_eq!(terminal["status"], "failed", "{name} dry_run={dry_run}");
            assert_eq!(
                terminal["label"].as_str().expect("label"),
                rejected_trim_label(
                    rom_3ds.path(),
                    dry_run,
                    &format!(
                        "`{}` is not a valid trim output for 3DS ROMs: a trimmed .3ds is a cartridge image, so a Z3DS output must end in .z3ds (the .zcci, .zcxi, .zcia and .z3dsx names mark other 3DS file types)",
                        output.path().display()
                    )
                ),
                "{name} dry_run={dry_run}"
            );
            assert!(!output.path().exists(), "{name} must not be written");
        }
    }

    let z3ds = temp.child("game.z3ds");
    let terminal = trim_to_output(rom_3ds.path(), z3ds.path(), &[], 0);
    assert_eq!(terminal["status"], "succeeded");
    assert!(z3ds.path().exists());
}

#[test]
fn trim_gamecube_disc_output_zip_packs_the_rvz_and_other_extensions_are_rejected() {
    let temp = setup_temp_dir();
    let source = temp.child("disc.iso");
    let iso = build_test_gamecube_iso(0x4000);
    fs::write(source.path(), &iso).expect("iso fixture");

    for (name, entry) in [("pack.zip", "pack.rvz"), ("pack.iso.7z", "pack.iso.rvz")] {
        let output = temp.child(name);
        let terminal = trim_to_output(source.path(), output.path(), &[], 0);
        assert_eq!(terminal["status"], "succeeded", "{name}");
        // The logical sizes come from the RVZ before it is packed into the archive.
        assert_eq!(terminal["details"]["input_size"], iso.len(), "{name}");
        assert_eq!(terminal["details"]["raw_size"], iso.len(), "{name}");
        assert_eq!(
            terminal["details"]["output_format"],
            name.rsplit('.').next().expect("ext")
        );
        let destination = temp.child(format!("unpacked-{name}"));
        assert_eq!(
            extracted_entries(output.path(), destination.path()),
            vec![entry.to_string()],
            "{name}"
        );
        let packed = fs::read(destination.child(entry).path()).expect("packed rvz");
        assert_eq!(&packed[..3], b"RVZ", "{name}");
    }

    for name in [
        "plain.iso",
        "plain.bin",
        "plain.GCM",
        "plain.img",
        "plain.nds",
        "plain.foo",
        "trimmed.disc",
    ] {
        for dry_run in [false, true] {
            let output = temp.child(name);
            let extra: &[&str] = if dry_run { &["--dry-run"] } else { &[] };
            let terminal = trim_to_output(source.path(), output.path(), extra, 1);
            let message = terminal["label"].as_str().expect("label");
            assert!(
                message.contains("is not a valid trim output for GameCube/Wii discs"),
                "{name}: {message}"
            );
            assert!(message.contains(".rvz, .zip, or .7z"), "{name}: {message}");
            assert!(message.contains("`extract`"), "{name}: {message}");
            assert!(!output.path().exists(), "{name} must not be written");
        }
    }
}

/// CHD infers its media from the packed file's name and size, which turns a small XISO into a
/// CD CHD and a `.xiso` into a raw one; an XISO is a DVD-class disc and must always be a DVD CHD.
#[test]
fn trim_xiso_into_chd_builds_a_dvd_chd_for_xiso_and_iso_sources() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    fs::write(source_tree.child("default.xbe").path(), vec![7_u8; 4096]).expect("xbe");
    for name in ["source.iso", "source.xiso"] {
        let xiso = temp.child(name);
        write_xiso_fixture_from_directory(source_tree.path(), xiso.path());
        let chd = temp.child(format!("{name}.chd"));
        let terminal = trim_to_output(xiso.path(), chd.path(), &[], 0);
        assert_eq!(terminal["status"], "succeeded", "{name}");
        let probe = parse_single_json_line(&command_stdout(
            &[
                "probe",
                "--input",
                chd.path().to_str().expect("path"),
                "--json",
            ],
            0,
        ));
        assert_eq!(probe["details"]["chd"]["media_kind"], "dvd", "{name}");
    }
}

/// A name that is not valid UTF-8 still has an extension: `.rvz` must be read as `.rvz`
/// (not rejected as a non-rvz name) and `.zip` must pack rather than write a raw ROM.
#[cfg(unix)]
#[test]
fn trim_reads_the_extension_of_a_non_utf8_file_name() {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};

    let temp = setup_temp_dir();
    let run = |args: &[&OsStr], code: i32| {
        let output = Command::cargo_bin("rom-weaver")
            .expect("binary")
            .args(args)
            .assert()
            .code(code)
            .get_output()
            .stdout
            .clone();
        parse_single_json_line(&output)
    };
    let name = |bytes: &[u8]| temp.path().join(OsStr::from_bytes(bytes));

    let disc = name(b"disc\xe9.iso");
    fs::write(&disc, build_test_gamecube_iso(0x4000)).expect("iso fixture");
    let terminal = run(
        &[OsStr::new("trim"), disc.as_os_str(), OsStr::new("--json")],
        0,
    );
    assert_eq!(terminal["status"], "succeeded", "default destination");
    assert!(name(b"disc\xe9.trim.rvz").exists());

    let rvz = name(b"o\xe9.rvz");
    let terminal = run(
        &[
            OsStr::new("trim"),
            disc.as_os_str(),
            OsStr::new("--output"),
            rvz.as_os_str(),
            OsStr::new("--json"),
        ],
        0,
    );
    assert_eq!(terminal["status"], "succeeded", "-o .rvz");
    assert_eq!(&fs::read(&rvz).expect("rvz")[..3], b"RVZ");

    let rom = name(b"x\xe9.nds");
    fs::write(
        &rom,
        build_test_nds_rom(0x00, 0x2000, 0x2000, 0x4000, false),
    )
    .expect("nds fixture");
    let zip = name(b"x\xe9.zip");
    let terminal = run(
        &[
            OsStr::new("trim"),
            rom.as_os_str(),
            OsStr::new("--output"),
            zip.as_os_str(),
            OsStr::new("--json"),
        ],
        0,
    );
    assert_eq!(terminal["status"], "succeeded", "-o .zip");
    assert_eq!(&fs::read(&zip).expect("zip")[..2], b"PK");
}
