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
    assert_eq!(terminal["details"]["output_format"], "xiso");
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

/// The failure label a single rejected trim input reports around the engine's message.
fn rejected_trim_label(source: &Path, dry_run: bool, message: &str) -> String {
    let verb = if dry_run { "trim simulation" } else { "trim" };
    format!(
        "{verb} completed with failures; processed=1 trimmed=0 already_trimmed=0 failed=1 skipped_unsupported=0; first_error={}: validation failed: {message}",
        source.display()
    )
}

/// One of each GameCube/Wii disc form trim used to convert to RVZ: a raw `.iso`, a `.gcm` copy of
/// it, a `.wbfs`, and an `.rvz` made by `compress`.
fn write_gamecube_wii_trim_fixtures(temp: &TempDir) -> Vec<std::path::PathBuf> {
    let iso = temp.child("disc.iso");
    fs::write(iso.path(), build_test_gamecube_iso(0x4000)).expect("iso fixture");
    let gcm = temp.child("disc.gcm");
    fs::copy(iso.path(), gcm.path()).expect("gcm fixture");
    let wbfs = temp.child("disc.wbfs");
    write_wbfs_fixture_from_iso(iso.path(), wbfs.path());
    let rvz = temp.child("disc.rvz");
    command_stdout(
        &[
            "compress",
            "--input",
            iso.path().to_str().expect("path"),
            "--output",
            rvz.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    vec![
        iso.path().to_path_buf(),
        gcm.path().to_path_buf(),
        wbfs.path().to_path_buf(),
        rvz.path().to_path_buf(),
    ]
}

#[test]
fn trim_rejects_gamecube_wii_discs_and_points_to_compress() {
    let temp = setup_temp_dir();
    for source in write_gamecube_wii_trim_fixtures(&temp) {
        for extra in [&["--dry-run"][..], &["--revert"][..], &[][..]] {
            let mut args = vec!["trim", "--input", source.to_str().expect("path"), "--json"];
            args.extend_from_slice(extra);
            let terminal = parse_single_json_line(&command_stdout(&args, 1));
            assert_eq!(terminal["command"], "trim", "{}", source.display());
            assert_eq!(terminal["status"], "failed", "{}", source.display());
            assert_eq!(
                terminal["label"],
                format!(
                    "validation failed: `{}` is a GameCube/Wii disc, which trim does not support; use `rom-weaver compress` to convert it to RVZ",
                    source.display()
                ),
                "{extra:?}"
            );
        }
        // Nothing is written next to the source, whatever the extension.
        let siblings = fs::read_dir(source.parent().expect("parent"))
            .expect("read dir")
            .count();
        assert_eq!(
            siblings,
            4,
            "{} must not create an output",
            source.display()
        );
    }
}

#[test]
fn trim_batch_skips_gamecube_wii_discs_as_unsupported() {
    let temp = setup_temp_dir();
    let folder = temp.child("roms");
    fs::create_dir_all(folder.path()).expect("folder");
    let nds = folder.child("game.nds");
    fs::write(
        nds.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("nds fixture");
    let discs = write_gamecube_wii_trim_fixtures(&temp);
    for disc in &discs {
        fs::copy(disc, folder.path().join(disc.file_name().expect("name"))).expect("copy disc");
    }

    let terminal = parse_single_json_line(&command_stdout(
        &[
            "trim",
            "--input",
            folder.path().to_str().expect("path"),
            "--json",
        ],
        0,
    ));
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["details"]["processed"], 1);
    assert_eq!(terminal["details"]["skipped_unsupported"], 4);
    assert_eq!(terminal["details"]["skipped_gamecube_wii"], 4);
    let warnings = terminal["details"]["warnings"].to_string();
    assert!(
        warnings.contains("4 GameCube/Wii disc(s) were not trimmed")
            && warnings.contains(COMPRESS_HINT),
        "{warnings}"
    );
    assert!(folder.child("game.trim.nds").path().exists());
    for disc in &discs {
        let name = disc.file_name().expect("name").to_string_lossy();
        let stem = name.rsplit_once('.').expect("extension").0;
        for output in ["trim.rvz", "trim.iso", "trim.gcm", "trim.wbfs"] {
            assert!(
                !folder.child(format!("{stem}.{output}")).path().exists(),
                "{name} must not produce {output}"
            );
        }
    }
}

#[test]
fn trim_batch_of_only_gamecube_wii_discs_reports_them_unsupported() {
    let temp = setup_temp_dir();
    let discs = write_gamecube_wii_trim_fixtures(&temp);
    let mut args = vec!["trim", "--json"];
    for disc in &discs {
        args.push("--input");
        args.push(disc.to_str().expect("path"));
    }
    let terminal = parse_single_json_line(&command_stdout(&args, 0));
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["details"]["processed"], 0);
    assert_eq!(terminal["details"]["skipped_unsupported"], 4);
}

const COMPRESS_HINT: &str = "use `rom-weaver compress` to convert";

/// A small GameCube disc written as RVZ and then packed into `archive` (a `.zip` or `.7z`),
/// leaving only the archive on disk next to `temp`'s other files.
fn write_gamecube_disc_archive(temp: &TempDir, name: &str) -> std::path::PathBuf {
    let iso = temp.child(format!("{name}.iso"));
    fs::write(iso.path(), build_test_gamecube_iso(0x4000)).expect("iso fixture");
    let rvz = temp.child(format!("{name}.rvz"));
    command_stdout(
        &[
            "compress",
            "--input",
            iso.path().to_str().expect("path"),
            "--output",
            rvz.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let archive = temp.child(name);
    command_stdout(
        &[
            "compress",
            "--input",
            rvz.path().to_str().expect("path"),
            "--format",
            if name.ends_with(".7z") { "7z" } else { "zip" },
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    fs::remove_file(iso.path()).expect("remove iso");
    fs::remove_file(rvz.path()).expect("remove rvz");
    archive.path().to_path_buf()
}

#[test]
fn trim_batch_never_extracts_gamecube_wii_discs_inside_archives() {
    let temp = setup_temp_dir();
    let staging = setup_temp_dir();
    let archive = write_gamecube_disc_archive(&staging, "kururin.zip");
    let folder = temp.child("roms");
    fs::create_dir_all(folder.path()).expect("folder");
    fs::copy(&archive, folder.path().join("kururin.zip")).expect("copy archive");
    fs::write(
        folder.child("game.nds").path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("nds fixture");

    let output = command_output_with_env(
        &[
            "--log-level",
            "trace",
            "trim",
            "--input",
            folder.path().to_str().expect("path"),
            "--json",
        ],
        &[],
        0,
    );
    let terminal = parse_single_json_line(&output.stdout);
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["details"]["processed"], 1);
    assert_eq!(terminal["details"]["skipped_unsupported"], 1);
    assert_eq!(terminal["details"]["skipped_gamecube_wii"], 1);
    let warnings = terminal["details"]["warnings"].to_string();
    assert!(
        warnings.contains("GameCube/Wii disc") && warnings.contains(COMPRESS_HINT),
        "{warnings}"
    );
    assert!(folder.child("game.trim.nds").path().exists());

    // The zip is listed to look inside, but the disc it holds is never written to temp space.
    let extractions = trim_extraction_lines(&output.stderr);
    assert!(
        extractions.is_empty(),
        "the zip holds no trim input to extract: {extractions:#?}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.contains("\"format\":\"rvz\""),
        "the disc must not be decoded by the rvz handler"
    );
}

#[test]
fn trim_rejects_a_lone_archive_that_holds_only_gamecube_wii_discs() {
    let temp = setup_temp_dir();
    for name in ["Kururin Squash! (Japan).zip", "Kururin Squash! (Japan).7z"] {
        let archive = write_gamecube_disc_archive(&temp, name);
        for extra in [&["--dry-run"][..], &[][..]] {
            let mut args = vec!["trim", "--input", archive.to_str().expect("path"), "--json"];
            args.extend_from_slice(extra);
            let terminal = parse_single_json_line(&command_stdout(&args, 1));
            assert_eq!(terminal["status"], "failed", "{name}");
            assert_eq!(
                terminal["label"],
                format!(
                    "validation failed: `{}` holds a GameCube/Wii disc, which trim does not support; {COMPRESS_HINT} it to RVZ",
                    archive.display()
                ),
                "{name} {extra:?}"
            );
        }
        // Nothing is written beside the archive.
        let siblings = fs::read_dir(temp.path()).expect("read dir").count();
        assert_eq!(siblings, 1 + usize::from(name.ends_with(".7z")));
    }
}

/// Pack `inputs` into a new archive at `archive` with `compress` (zip or 7z by its extension).
fn pack_archive(archive: &std::path::Path, inputs: &[&std::path::Path]) {
    let mut args = vec!["compress"];
    for input in inputs {
        args.extend(["--input", input.to_str().expect("path")]);
    }
    let is_7z = archive
        .extension()
        .is_some_and(|extension| extension == "7z");
    args.extend([
        "--format",
        if is_7z { "7z" } else { "zip" },
        "--output",
        archive.to_str().expect("path"),
        "--json",
    ]);
    command_stdout(&args, 0);
}

/// The `--log-level trace` stderr lines where trim extracts an archive to temp space.
fn trim_extraction_lines(stderr: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(stderr)
        .lines()
        .filter(|line| {
            line.contains("extracting archive for trim")
                || line.contains("extracting full archive contents for in-place trim repack")
        })
        .map(str::to_string)
        .collect()
}

#[test]
fn trim_classifies_gamecube_wii_discs_in_archives_without_extracting_them() {
    let staging = setup_temp_dir();
    let iso = staging.child("disc.iso");
    fs::write(iso.path(), build_test_gamecube_iso(0x4000)).expect("iso fixture");
    let wbfs = staging.child("disc.wbfs");
    write_wbfs_fixture_from_iso(iso.path(), wbfs.path());
    let rvz = staging.child("disc.rvz");
    command_stdout(
        &[
            "compress",
            "--input",
            iso.path().to_str().expect("path"),
            "--output",
            rvz.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    // A raw `.iso` is recognized from its header; the other forms by name.
    for disc in [rvz.path(), wbfs.path(), iso.path()] {
        for archive_extension in ["zip", "7z"] {
            let temp = setup_temp_dir();
            let archive = temp.child(format!("Kururin Squash! (Japan).{archive_extension}"));
            pack_archive(archive.path(), &[disc]);
            for extra in [&["--dry-run"][..], &[][..], &["--in-place", "--yes"][..]] {
                let mut args = vec![
                    "--log-level",
                    "trace",
                    "trim",
                    "--input",
                    archive.path().to_str().expect("path"),
                    "--json",
                ];
                args.extend_from_slice(extra);
                let output = command_output_with_env(&args, &[], 1);
                let terminal = parse_single_json_line(&output.stdout);
                let case = format!("{} in {archive_extension} {extra:?}", disc.display());
                assert_eq!(
                    terminal["label"],
                    format!(
                        "validation failed: `{}` holds a GameCube/Wii disc, which trim does not support; {COMPRESS_HINT} it to RVZ",
                        archive.path().display()
                    ),
                    "{case}"
                );
                let extractions = trim_extraction_lines(&output.stderr);
                assert!(
                    extractions.is_empty(),
                    "{case}: the disc must not be extracted: {extractions:#?}"
                );
            }
        }
    }
}

#[test]
fn trim_skips_a_disc_inside_an_archive_folder() {
    let staging = setup_temp_dir();
    let folder = staging.child("roms");
    fs::create_dir_all(folder.path()).expect("folder");
    fs::write(
        folder.child("game.nds").path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("nds fixture");
    let iso = staging.child("disc.iso");
    fs::write(iso.path(), build_test_gamecube_iso(0x4000)).expect("iso fixture");
    command_stdout(
        &[
            "compress",
            "--input",
            iso.path().to_str().expect("path"),
            "--output",
            folder.child("disc.rvz").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    for archive_extension in ["zip", "7z"] {
        let temp = setup_temp_dir();
        let archive = temp.child(format!("roms.{archive_extension}"));
        pack_archive(archive.path(), &[folder.path()]);
        let output = command_output_with_env(
            &[
                "--log-level",
                "trace",
                "trim",
                "--input",
                archive.path().to_str().expect("path"),
                "--json",
            ],
            &[],
            0,
        );
        let terminal = parse_single_json_line(&output.stdout);
        assert_eq!(terminal["details"]["processed"], 1, "{archive_extension}");
        assert_eq!(
            terminal["details"]["skipped_gamecube_wii"], 1,
            "{archive_extension}"
        );
        let extractions = trim_extraction_lines(&output.stderr);
        assert_eq!(
            extractions.len(),
            1,
            "{archive_extension}: {extractions:#?}"
        );
        assert!(
            extractions[0].contains("\"selections\":1"),
            "{archive_extension}: only the ROM may be selected: {}",
            extractions[0]
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !stderr.contains("trim skipped a GameCube/Wii disc inside an archive"),
            "{archive_extension}: the disc must be skipped before extraction"
        );
    }
}

#[test]
fn trim_extracts_only_the_rom_from_an_archive_beside_a_disc() {
    let temp = setup_temp_dir();
    let staging = setup_temp_dir();
    let rom = staging.child("game.nds");
    fs::write(
        rom.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("nds fixture");
    let iso = staging.child("disc.iso");
    fs::write(iso.path(), build_test_gamecube_iso(0x4000)).expect("iso fixture");
    let rvz = staging.child("disc.rvz");
    command_stdout(
        &[
            "compress",
            "--input",
            iso.path().to_str().expect("path"),
            "--output",
            rvz.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let archive = temp.child("mixed.7z");
    pack_archive(archive.path(), &[rom.path(), rvz.path(), iso.path()]);

    let output = command_output_with_env(
        &[
            "--log-level",
            "trace",
            "trim",
            "--input",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        &[],
        0,
    );
    let terminal = parse_single_json_line(&output.stdout);
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["details"]["processed"], 1);
    assert_eq!(terminal["details"]["skipped_gamecube_wii"], 2);
    assert!(temp.child("game.trim.nds").path().exists());

    let extractions = trim_extraction_lines(&output.stderr);
    assert_eq!(extractions.len(), 1, "{extractions:#?}");
    assert!(
        extractions[0].contains("\"selections\":1"),
        "only the ROM may be selected: {}",
        extractions[0]
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.contains("trim skipped a GameCube/Wii disc inside an archive"),
        "the discs must be skipped before extraction"
    );
    assert!(
        !stderr.contains("\"format\":\"rvz\""),
        "the disc must not be decoded by the rvz handler"
    );
}

#[test]
fn trim_batch_of_only_gamecube_wii_discs_points_to_compress() {
    let temp = setup_temp_dir();
    let staging = setup_temp_dir();
    let folder = temp.child("roms");
    fs::create_dir_all(folder.path()).expect("folder");
    for disc in write_gamecube_wii_trim_fixtures(&staging) {
        fs::copy(&disc, folder.path().join(disc.file_name().expect("name"))).expect("copy disc");
    }
    let archive = write_gamecube_disc_archive(&staging, "inside.zip");
    fs::copy(&archive, folder.path().join("inside.zip")).expect("copy archive");

    let args = [
        "trim",
        "--input",
        folder.path().to_str().expect("path"),
        "--json",
    ];
    let terminal = parse_single_json_line(&command_stdout(&args, 0));
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["details"]["processed"], 0);
    assert_eq!(terminal["details"]["skipped_unsupported"], 5);
    assert_eq!(terminal["details"]["skipped_gamecube_wii"], 5);
    assert_eq!(
        terminal["label"],
        "no trim-eligible inputs found; skipped_unsupported=5; GameCube/Wii discs are not trimmed (skipped_gamecube_wii=5); use `rom-weaver compress` to convert them to RVZ"
    );

    // The human summary carries the same hint.
    let human =
        String::from_utf8_lossy(&command_output_with_env(&args[..3], &[], 0).stderr).into_owned();
    assert!(
        human.contains("GameCube/Wii discs are not trimmed")
            && human.contains("rom-weaver compress"),
        "{human}"
    );
}

#[test]
fn trim_batch_without_gamecube_wii_discs_reports_no_disc_note() {
    let temp = setup_temp_dir();
    let folder = temp.child("roms");
    fs::create_dir_all(folder.path()).expect("folder");
    fs::write(folder.child("notes.txt").path(), b"not a rom").expect("text fixture");

    let terminal = parse_single_json_line(&command_stdout(
        &[
            "trim",
            "--input",
            folder.path().to_str().expect("path"),
            "--json",
        ],
        0,
    ));
    assert_eq!(
        terminal["label"],
        "no trim-eligible inputs found; skipped_unsupported=1"
    );
    assert!(terminal["details"].get("skipped_gamecube_wii").is_none());
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
fn trim_and_revert_accept_a_cci_cart_image() {
    // Z3DS cart images extract as `.cci`, so a trimmed `.z3ds` must trim and restore under that name.
    let temp = setup_temp_dir();
    let source = temp.child("sample.cci");
    let mut rom = build_test_padded_rom(0x4567, 0x8000, 0xFF);
    rom[0x100..0x104].copy_from_slice(b"NCCH");
    rom[0x104..0x108].copy_from_slice(&0x22_u32.to_le_bytes());
    rom[0x18E] = 0;
    fs::write(source.path(), &rom).expect("fixture");

    let trimmed = temp.child("sample.trim.cci");
    command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--output",
            trimmed.path().to_str().expect("path"),
            "--revert-marker",
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read(trimmed.path()).expect("trimmed cci").len(),
        0x4567 + 12
    );

    let restored = temp.child("sample.restored.cci");
    command_stdout(
        &[
            "trim",
            "--input",
            trimmed.path().to_str().expect("path"),
            "--output",
            restored.path().to_str().expect("path"),
            "--revert",
            "--json",
        ],
        0,
    );
    assert_eq!(fs::read(restored.path()).expect("restored cci"), rom);
}

#[test]
fn trim_revert_restores_an_ncsd_cart_image_to_its_declared_card_size() {
    // The NCSD header declares a 48 KiB card, which is not the next power of two (32 KiB) above
    // the 0x4567 bytes of data, so only the header can rebuild the original without a marker.
    let temp = setup_temp_dir();
    let source = temp.child("cart.3ds");
    let mut rom = build_test_padded_rom(0x4567, 0xC000, 0xFF);
    rom[0x100..0x104].copy_from_slice(b"NCSD");
    rom[0x104..0x108].copy_from_slice(&0x60_u32.to_le_bytes());
    rom[0x108..0x200].fill(0);
    rom[0x400..0x600].fill(0);
    rom[0x120..0x124].copy_from_slice(&2_u32.to_le_bytes());
    rom[0x124..0x128].copy_from_slice(&0x20_u32.to_le_bytes());
    rom[0x500..0x504].copy_from_slice(b"NCCH");
    rom[0x504..0x508].copy_from_slice(&0x20_u32.to_le_bytes());
    fs::write(source.path(), &rom).expect("fixture");

    let trimmed = temp.child("cart.trim.3ds");
    let restored = temp.child("cart.restored.3ds");
    for (input, output, extra) in [
        (source.path(), trimmed.path(), None),
        (trimmed.path(), restored.path(), Some("--revert")),
    ] {
        let mut args = vec![
            "trim",
            "--input",
            input.to_str().expect("path"),
            "--output",
            output.to_str().expect("path"),
            "--json",
        ];
        args.extend(extra);
        command_stdout(&args, 0);
    }
    assert_eq!(fs::read(trimmed.path()).expect("trimmed").len(), 0x4567);
    assert_eq!(fs::read(restored.path()).expect("restored"), rom);
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
    // Trimmed payload plus the 12-byte revert footer, which starts with the `RW` magic.
    let trimmed_bytes = fs::read(trimmed.path()).expect("trimmed gba");
    assert_eq!(trimmed_bytes.len(), 0x3456 + 12);
    assert_eq!(&trimmed_bytes[0x3456..0x3456 + 2], b"RW");

    let reverted = temp.child("game.revert.gba");
    for (input, revert_marker) in [(&trimmed, true), (&source, false)] {
        let plan = parse_single_json_line(&command_stdout(
            &[
                "trim",
                "--input",
                input.path().to_str().expect("path"),
                "--revert",
                "--dry-run",
                "--output",
                reverted.path().to_str().expect("path"),
                "--json",
            ],
            0,
        ));
        assert_eq!(plan["details"]["revert_marker"], revert_marker);
        assert_eq!(plan["details"]["would_change"], u64::from(revert_marker));
    }

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
        assert_eq!(trimmed.len(), 0x3456 + 12);
        assert_eq!(trimmed[0x3456 + 2], pad_byte);
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

/// Hand-built legacy footer shipped since v0.10.0: `RWT\x01` + pad byte + 40-bit LE pad length +
/// CRC-32 of the preceding 10 bytes.
fn legacy_revert_footer(pad_byte: u8, pad_len: u64) -> Vec<u8> {
    let mut footer = b"RWT\x01".to_vec();
    footer.push(pad_byte);
    footer.extend_from_slice(&pad_len.to_le_bytes()[..5]);
    let crc = crc32fast::hash(&footer);
    footer.extend_from_slice(&crc.to_le_bytes());
    footer
}

#[test]
fn trim_revert_restores_a_legacy_rwt_footer_byte_identically() {
    let temp = setup_temp_dir();
    let original = build_test_padded_rom(0x3456, 0x4000, 0x00);
    let mut legacy = original[..0x3456].to_vec();
    legacy.extend_from_slice(&legacy_revert_footer(0x00, 0x4000 - 0x3456));
    assert_eq!(legacy.len(), 0x3456 + 14);
    let source = temp.child("legacy.gba");
    fs::write(source.path(), &legacy).expect("fixture");

    let plan = parse_single_json_line(&command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--revert",
            "--dry-run",
            "--json",
        ],
        0,
    ));
    assert_eq!(plan["details"]["revert_marker"], true);

    let reverted = temp.child("legacy.revert.gba");
    command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--revert",
            "--output",
            reverted.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(fs::read(reverted.path()).expect("reverted gba"), original);
}

#[test]
fn retrimming_a_legacy_rwt_footer_writes_a_new_rw_footer_that_restores_the_original() {
    let temp = setup_temp_dir();
    // The 0x00 fill differs from the 0xFF fallback, so only the recorded footer can restore it.
    let mut original = build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false);
    original[0x3000..].fill(0x00);
    let mut legacy = original[..0x3000].to_vec();
    legacy.extend_from_slice(&legacy_revert_footer(0x00, 0x5000 - 0x3000));
    let source = temp.child("legacy.nds");
    fs::write(source.path(), &legacy).expect("fixture");

    // Re-trimming keeps the legacy footer's recorded size and fill but writes the current footer.
    let retrimmed = temp.child("legacy.retrim.nds");
    command_stdout(
        &[
            "trim",
            "--input",
            source.path().to_str().expect("path"),
            "--revert-marker",
            "--output",
            retrimmed.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let retrimmed_bytes = fs::read(retrimmed.path()).expect("re-trimmed nds");
    assert_eq!(retrimmed_bytes.len(), 0x3000 + 12);
    assert_eq!(&retrimmed_bytes[..0x3000], &original[..0x3000]);
    assert_eq!(&retrimmed_bytes[0x3000..0x3002], b"RW");

    let reverted = temp.child("legacy.retrim.revert.nds");
    command_stdout(
        &[
            "trim",
            "--input",
            retrimmed.path().to_str().expect("path"),
            "--revert",
            "--output",
            reverted.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(fs::read(reverted.path()).expect("reverted nds"), original);
}

#[test]
fn trim_revert_ignores_a_revert_footer_with_a_corrupt_crc() {
    let temp = setup_temp_dir();
    let source = temp.child("game.gba");
    fs::write(source.path(), build_test_padded_rom(0x3456, 0x4000, 0x00)).expect("fixture");
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
    let mut corrupt = fs::read(trimmed.path()).expect("trimmed gba");
    *corrupt.last_mut().expect("footer byte") ^= 0xFF;
    let corrupt_path = temp.child("corrupt.gba");
    fs::write(corrupt_path.path(), &corrupt).expect("corrupt fixture");

    let plan = parse_single_json_line(&command_stdout(
        &[
            "trim",
            "--input",
            corrupt_path.path().to_str().expect("path"),
            "--revert",
            "--dry-run",
            "--json",
        ],
        0,
    ));
    assert_eq!(plan["details"]["revert_marker"], false);
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
fn trim_output_z3ds_packs_a_3ds_rom_and_zip_packs_an_xiso() {
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
    let zip = temp.child("out.zip");
    let terminal = trim_to_output(xiso.path(), zip.path(), &[], 0);
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(&fs::read(zip.path()).expect("zip")[..2], b"PK");

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
fn trim_repacks_a_z3ds_input_as_compress_would_pack_the_trimmed_rom() {
    let temp = setup_temp_dir();
    let rom_3ds = temp.child("sample.3ds");
    let mut rom = build_test_padded_rom(0x4567, 0x8000, 0xFF);
    rom[0x100..0x104].copy_from_slice(b"NCCH");
    rom[0x104..0x108].copy_from_slice(&0x22_u32.to_le_bytes());
    rom[0x18E] = 0;
    fs::write(rom_3ds.path(), &rom).expect("3ds fixture");
    let compress = |input: &Path, output: &Path| {
        command_stdout(
            &[
                "compress",
                "--input",
                input.to_str().expect("path"),
                "--output",
                output.to_str().expect("path"),
            ],
            0,
        );
    };
    let packed = temp.child("sample.z3ds");
    compress(rom_3ds.path(), packed.path());

    // Extract, trim, and repack in one step.
    let trimmed_z3ds = temp.child("trimmed.z3ds");
    let terminal = trim_to_output(packed.path(), trimmed_z3ds.path(), &[], 0);
    assert_eq!(terminal["status"], "succeeded");

    let trimmed_raw = temp.child("trimmed-raw.3ds");
    fs::write(trimmed_raw.path(), &rom[..0x4567]).expect("trimmed fixture");
    let expected = temp.child("expected.z3ds");
    compress(trimmed_raw.path(), expected.path());
    assert_eq!(
        fs::read(trimmed_z3ds.path()).expect("trimmed z3ds"),
        fs::read(expected.path()).expect("expected z3ds")
    );
}

#[test]
fn trim_3ds_output_accepts_only_the_z3ds_descriptor_extensions_that_match_the_payload() {
    let temp = setup_temp_dir();
    let build_3ds = |magic: &[u8; 4], name: &str| {
        let path = temp.child(name);
        let mut rom = build_test_padded_rom(0x4567, 0x8000, 0xFF);
        rom[0x100..0x104].copy_from_slice(magic);
        rom[0x104..0x108].copy_from_slice(&0x22_u32.to_le_bytes());
        rom[0x18E] = 0;
        if magic == b"NCSD" {
            rom[0x108..0x200].fill(0);
            rom[0x400..0x600].fill(0);
            rom[0x120..0x124].copy_from_slice(&2_u32.to_le_bytes());
            rom[0x124..0x128].copy_from_slice(&0x20_u32.to_le_bytes());
            rom[0x500..0x504].copy_from_slice(b"NCCH");
            rom[0x504..0x508].copy_from_slice(&0x20_u32.to_le_bytes());
        }
        fs::write(path.path(), &rom).expect("3ds fixture");
        path
    };

    // (payload magic, accepted descriptor extensions, rejected names)
    let cases: [(&[u8; 4], &[&str], &[&str]); 2] = [
        (
            b"NCSD",
            &["game.z3ds", "game.zcci", "GAME.ZCCI"],
            &["game.zcia", "game.zcxi", "game.z3dsx", "GAME.ZCIA"],
        ),
        (
            b"NCCH",
            &["game.z3ds", "game.zcxi"],
            &["game.zcia", "game.zcci", "game.z3dsx", "GAME.ZCIA"],
        ),
    ];
    for (magic, accepted, rejected) in cases {
        let payload = String::from_utf8_lossy(magic).into_owned();
        let rom_3ds = build_3ds(magic, &format!("{payload}.3ds"));
        let descriptor = if magic == b"NCSD" { ".zcci" } else { ".zcxi" };
        for name in rejected {
            for dry_run in [false, true] {
                let output = temp.child(format!("{payload}-{name}"));
                let extra: &[&str] = if dry_run { &["--dry-run"] } else { &[] };
                let terminal = trim_to_output(rom_3ds.path(), output.path(), extra, 1);
                let extension = name.rsplit('.').next().expect("ext").to_ascii_lowercase();
                assert_eq!(
                    terminal["status"], "failed",
                    "{payload} {name} dry_run={dry_run}"
                );
                assert_eq!(
                    terminal["label"].as_str().expect("label"),
                    rejected_trim_label(
                        rom_3ds.path(),
                        dry_run,
                        &format!(
                            "`{}` is not a valid trim output for 3DS ROMs: the Z3DS name `.{extension}` marks a different 3DS file type than this trimmed image, so a Z3DS output must end in .z3ds or {descriptor} for the {payload} image in this file",
                            output.path().display()
                        )
                    ),
                    "{payload} {name} dry_run={dry_run}"
                );
                assert!(
                    !output.path().exists(),
                    "{payload} {name} must not be written"
                );
            }
        }
        // Each accepted name gets its own directory: `game.zcci` and `GAME.ZCCI` are
        // one file on a case-insensitive filesystem (macOS, Windows), so sharing a
        // directory would make the later runs collide with the earlier output.
        for (index, name) in accepted.iter().enumerate() {
            let output_dir = temp.child(format!("{payload}-accepted-{index}"));
            fs::create_dir_all(output_dir.path()).expect("accepted output dir");
            for dry_run in [true, false] {
                let output = output_dir.child(name);
                let extra: &[&str] = if dry_run { &["--dry-run"] } else { &[] };
                let terminal = trim_to_output(rom_3ds.path(), output.path(), extra, 0);
                assert_eq!(
                    terminal["status"], "succeeded",
                    "{payload} {name} dry_run={dry_run}"
                );
                assert_eq!(
                    output.path().exists(),
                    !dry_run,
                    "{payload} {name} dry_run={dry_run}"
                );
            }
        }
        // A packed descriptor extracts back to the payload type it names.
        let packed = temp.child(format!("{payload}-roundtrip{descriptor}"));
        trim_to_output(rom_3ds.path(), packed.path(), &[], 0);
        let extracted = temp.child(format!("{payload}-extracted"));
        assert_eq!(
            extracted_entries(packed.path(), extracted.path()),
            vec![format!(
                "{}-roundtrip.{}",
                payload,
                if magic == b"NCSD" { "cci" } else { "cxi" }
            )]
        );
    }
}

#[test]
fn trim_3ds_output_rejects_a_descriptor_extension_when_the_payload_is_unrecognized() {
    let temp = setup_temp_dir();
    let rom_3ds = temp.child("game.3ds");
    let mut rom = build_test_padded_rom(0x4567, 0x8000, 0xFF);
    rom[0x18E] = 0;
    fs::write(rom_3ds.path(), &rom).expect("3ds fixture");
    let output = temp.child("game.zcci");
    let terminal = trim_to_output(rom_3ds.path(), output.path(), &["--dry-run"], 1);
    assert_eq!(terminal["status"], "failed");
    assert_eq!(
        terminal["label"].as_str().expect("label"),
        rejected_trim_label(
            rom_3ds.path(),
            true,
            &format!(
                "`{}` is not a valid trim output for 3DS ROMs: the Z3DS name `.zcci` marks a different 3DS file type than this trimmed image, so a Z3DS output must end in .z3ds",
                output.path().display()
            )
        )
    );
}

/// An Xbox XISO is not storable as CHD, so a trim whose output name resolves to CHD is refused
/// before anything is written, for `.iso` and `.xiso` sources, in a real run and a dry run.
#[test]
fn trim_xiso_into_chd_is_rejected_before_writing() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    fs::write(source_tree.child("default.xbe").path(), vec![7_u8; 4096]).expect("xbe");
    for name in ["source.iso", "source.xiso"] {
        let xiso = temp.child(name);
        write_xiso_fixture_from_directory(source_tree.path(), xiso.path());
        for dry_run in [false, true] {
            let chd = temp.child(format!("{name}.chd"));
            let extra: &[&str] = if dry_run { &["--dry-run"] } else { &[] };
            let terminal = trim_to_output(xiso.path(), chd.path(), extra, 1);
            assert_eq!(terminal["status"], "failed", "{name} dry_run={dry_run}");
            assert_eq!(
                terminal["label"].as_str().expect("label"),
                rejected_trim_label(
                    xiso.path(),
                    dry_run,
                    &format!(
                        "`{}` is an Xbox XISO image, which cannot be stored as CHD: `{}` must end in .xiso, .zip, or .7z",
                        xiso.path().display(),
                        chd.path().display()
                    )
                ),
                "{name} dry_run={dry_run}"
            );
            assert!(!chd.path().exists(), "{name} must not write a CHD");
        }
    }
}

/// `trim --in-place` on an XISO inside a CHD would rebuild the CHD, which the engine refuses for an
/// Xbox XISO. The run is rejected up front (before any trimming) and identically in a dry run, and
/// the CHD stays byte-identical.
#[test]
fn trim_in_place_xiso_inside_chd_is_rejected_before_trimming() {
    // XGD3 layout: the XDVDFS volume sits 0x2080000 bytes in. The leading gap keeps the CHD
    // creator's own Xbox check (which only looks at offset 0x10000) from refusing to build the
    // fixture, while the trim detector still finds the volume.
    const XGD3_VOLUME_OFFSET: usize = 0x0208_0000;
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    fs::write(source_tree.child("default.xbe").path(), vec![7_u8; 4096]).expect("xbe");
    let plain = temp.child("plain.xiso");
    write_xiso_fixture_from_directory(source_tree.path(), plain.path());
    let mut wrapped = vec![0_u8; XGD3_VOLUME_OFFSET];
    wrapped.extend(fs::read(plain.path()).expect("xiso bytes"));
    let image = temp.child("game.iso");
    fs::write(image.path(), &wrapped).expect("wrapped xiso");
    let chd = temp.child("game.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            image.path().to_str().expect("path"),
            "--format",
            "chd-dvd",
            "--output",
            chd.path().to_str().expect("path"),
        ],
        0,
    );
    let before = fs::read(chd.path()).expect("chd bytes");

    for dry_run in [true, false] {
        let mut args = vec![
            "trim",
            "--in-place",
            "--input",
            chd.path().to_str().expect("path"),
            "--json",
        ];
        if dry_run {
            args.push("--dry-run");
        }
        let terminal = parse_single_json_line(&command_stdout(&args, 1));
        assert_eq!(terminal["status"], "failed", "dry_run={dry_run}");
        let label = terminal["label"].as_str().expect("label");
        assert!(
            label.contains(&format!(
                "`{}` holds an Xbox XISO image, which cannot be stored as CHD, so --in-place cannot repack it: use --output <name>.xiso, <name>.zip, or <name>.7z",
                chd.path().display()
            )),
            "dry_run={dry_run}: {label}"
        );
        assert_eq!(
            fs::read(chd.path()).expect("chd bytes"),
            before,
            "dry_run={dry_run}: the CHD must be left unchanged"
        );
    }
}

/// A caller that writes the trim to an extensionless path (the webapp does) learns that the file is
/// an XISO from the same run, since the name no longer says so.
#[test]
fn trim_xiso_to_an_extensionless_path_reports_the_xiso_output_format() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    fs::write(source_tree.child("default.xbe").path(), vec![7_u8; 4096]).expect("xbe");
    let xiso = temp.child("game.iso");
    write_xiso_fixture_from_directory(source_tree.path(), xiso.path());
    let output = temp.child("trim-output");
    let terminal = trim_to_output(xiso.path(), output.path(), &[], 0);
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["details"]["output_format"], "xiso");
    assert!(
        terminal["details"].get("chd_create_mode").is_none(),
        "an XISO is never handed to a CHD step: {}",
        terminal["details"]
    );
    assert_eq!(terminal["details"]["mode_counts"]["xiso"], 1);
    assert!(output.path().exists());
}

/// A trimmed XISO is never handed to a CHD step, so a packed output (`.zip`) reports its container
/// and no `chd_create_mode`.
#[test]
fn trim_xiso_into_packed_outputs_reports_the_container_and_no_chd_create_mode() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    fs::write(source_tree.child("default.xbe").path(), vec![7_u8; 4096]).expect("xbe");
    let xiso = temp.child("game.iso");
    write_xiso_fixture_from_directory(source_tree.path(), xiso.path());
    for (name, format) in [("packed.zip", "zip"), ("packed.7z", "7z")] {
        let output = temp.child(name);
        let terminal = trim_to_output(xiso.path(), output.path(), &[], 0);
        assert_eq!(terminal["status"], "succeeded", "{name}");
        assert_eq!(terminal["details"]["output_format"], format, "{name}");
        assert!(
            terminal["details"].get("chd_create_mode").is_none(),
            "{name}: {}",
            terminal["details"]
        );
    }
}

/// A batch emits several files, so no single output format or CHD mode describes the run.
#[test]
fn trim_xiso_batch_reports_neither_output_format_nor_chd_create_mode() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    fs::write(source_tree.child("default.xbe").path(), vec![7_u8; 4096]).expect("xbe");
    let first = temp.child("first.iso");
    let second = temp.child("second.iso");
    write_xiso_fixture_from_directory(source_tree.path(), first.path());
    write_xiso_fixture_from_directory(source_tree.path(), second.path());
    let terminal = parse_single_json_line(&command_stdout(
        &[
            "trim",
            "--input",
            first.path().to_str().expect("path"),
            "--input",
            second.path().to_str().expect("path"),
            "--extension",
            "small.xiso",
            "--json",
        ],
        0,
    ));
    assert_eq!(terminal["status"], "succeeded");
    for field in ["output_format", "chd_create_mode"] {
        assert!(
            terminal["details"].get(field).is_none(),
            "{field}: {}",
            terminal["details"]
        );
    }
}

/// An in-place archive repack rewrites the archive, so the XISO inside it must not make the run
/// claim an `xiso` output that a CHD step could consume: the emitted file is the `.zip`.
#[test]
fn trim_in_place_archive_repack_of_an_xiso_reports_no_image_metadata() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    fs::create_dir_all(source_tree.path()).expect("source tree root");
    fs::write(source_tree.child("default.xbe").path(), vec![7_u8; 4096]).expect("xbe");
    for (name, source_name) in [("game.zip", "game.xiso"), ("game-iso.zip", "game.iso")] {
        let xiso = temp.child(source_name);
        write_xiso_fixture_from_directory(source_tree.path(), xiso.path());
        let archive = temp.child(name);
        command_stdout(
            &[
                "compress",
                "--input",
                xiso.path().to_str().expect("path"),
                "--format",
                "zip",
                "--output",
                archive.path().to_str().expect("path"),
            ],
            0,
        );
        fs::remove_file(xiso.path()).expect("remove loose xiso");
        let terminal = parse_single_json_line(&command_stdout(
            &[
                "trim",
                "--in-place",
                "--input",
                archive.path().to_str().expect("path"),
                "--json",
            ],
            0,
        ));
        assert_eq!(terminal["status"], "succeeded", "{name}");
        assert!(
            terminal["label"]
                .as_str()
                .expect("label")
                .contains("processed=1"),
            "{name}: {}",
            terminal["label"]
        );
        for field in ["output_format", "chd_create_mode"] {
            assert!(
                terminal["details"].get(field).is_none(),
                "{name} {field}: {}",
                terminal["details"]
            );
        }
        assert_eq!(&fs::read(archive.path()).expect("archive")[..2], b"PK");
    }
}

/// A name that is not valid UTF-8 still has an extension: `.zip` must pack rather than write a
/// raw ROM.
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
