use super::shared::*;

#[test]
fn scalar_commands_accept_a_file_before_or_after_options() {
    let temp = setup_temp_dir();
    let input = temp.child("game.bin");
    fs::write(input.path(), with_nes_header(b"input")).expect("fixture");
    let path = input.path().to_str().expect("path");

    command_stdout(&["probe", path, "--no-extract", "--json"], 0);
    command_stdout(&["checksum", "--algo", "sha1", path, "--json"], 0);
    let archive = temp.child("input.zip");
    command_stdout(
        &["compress", path, "-o", archive.path().to_str().unwrap()],
        0,
    );
    let output = temp.child("extracted");
    command_stdout(
        &[
            "extract",
            archive.path().to_str().unwrap(),
            "-o",
            output.path().to_str().unwrap(),
        ],
        0,
    );
    assert_eq!(
        fs::read(output.path().join("game.bin")).unwrap(),
        fs::read(input.path()).unwrap()
    );
}

#[test]
fn scalar_commands_reject_a_file_with_input_flag() {
    command_stdout(&["probe", "one.bin", "--input", "two.bin"], 2);
    command_stdout(&["checksum", "one.bin", "--input", "two.bin"], 2);
    command_stdout(
        &[
            "extract", "one.bin", "--input", "two.bin", "--output", "out",
        ],
        2,
    );
    command_stdout(&["identify", "one.bin", "--input", "two.bin"], 2);
}

#[test]
fn scalar_commands_keep_missing_input_errors() {
    command_stdout(&["probe"], 2);
    command_stdout(&["checksum"], 2);
    command_stdout(&["extract", "--output", "out"], 2);
    command_stdout(&["compress", "--output", "out.zip"], 2);
    command_stdout(&["trim"], 2);
}

#[test]
fn inspect_and_stdin_use_the_positional_alias() {
    command_stdout_with_stdin(
        &["inspect", "-", "--no-extract", "--json"],
        &with_nes_header(b"input"),
        0,
    );
    command_stdout_with_stdin(&["checksum", "-", "--algo", "sha1", "--json"], b"input", 0);
}

#[test]
fn positional_file_accepts_a_leading_dash_after_separator() {
    let temp = setup_temp_dir();
    fs::write(temp.child("-game.nes").path(), with_nes_header(b"input")).unwrap();
    Command::new(assert_cmd::cargo::cargo_bin!("rom-weaver"))
        .current_dir(temp.path())
        .args(["probe", "--json", "--", "-game.nes"])
        .assert()
        .success();
}

#[test]
fn identify_non_file_queries_stay_valid() {
    // A fixture pack keeps the name search independent of the packs installed
    // on the machine that runs the test.
    let temp = setup_temp_dir();
    let pack = temp.child("test.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_crc([0, 0, 0, 1], "Mario (USA)"),
    )
    .unwrap();
    let pack = pack.path().to_str().unwrap();
    command_stdout(&["identify", "--hash", "00000000", "--json"], 0);
    command_stdout(
        &["identify", "--name", "Mario", "--database", pack, "--json"],
        0,
    );
    command_stdout(&["identify", "database", "--help"], 0);
    let input = temp.child("sample.bin");
    fs::write(input.path(), b"sample").unwrap();
    let path = input.path().to_str().unwrap();
    let result = run_single_json_event(&["identify", path, "--json"], 0);
    assert_eq!(result["details"]["identify"]["input"], path);
    command_stdout(&["identify", path, "--hash", "00000000"], 1);
    command_stdout(
        &["identify", path, "--name", "Mario", "--database", pack],
        1,
    );
}

#[cfg(unix)]
#[test]
fn identify_preserves_backslashes_in_file_names() {
    let temp = setup_temp_dir();
    let input = temp.child("sample\\name.bin");
    fs::write(input.path(), b"sample").expect("fixture");
    let path = input.path().to_str().expect("path");
    let result = run_single_json_event(&["identify", path, "--json"], 0);
    assert_eq!(result["details"]["identify"]["input"], path);
}

#[test]
fn compress_and_trim_accept_and_order_mixed_file_inputs() {
    let temp = setup_temp_dir();
    let first = temp.child("first.bin");
    let second = temp.child("second.bin");
    fs::write(first.path(), b"first").expect("fixture");
    fs::write(second.path(), b"second").expect("fixture");
    let archive = temp.child("out.zip");

    command_stdout(
        &[
            "compress",
            first.path().to_str().expect("path"),
            "--input",
            second.path().to_str().expect("path"),
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let listing = run_single_json_event(
        &[
            "probe",
            archive.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ],
        0,
    );
    assert_eq!(listing["details"]["container"]["entries"][0], "first.bin");
    assert_eq!(listing["details"]["container"]["entries"][1], "second.bin");

    let reverse = temp.child("reverse.zip");
    command_stdout(
        &[
            "compress",
            "-i",
            second.path().to_str().unwrap(),
            first.path().to_str().unwrap(),
            "-o",
            reverse.path().to_str().unwrap(),
        ],
        0,
    );
    let listing = run_single_json_event(
        &[
            "probe",
            reverse.path().to_str().unwrap(),
            "--no-extract",
            "--json",
        ],
        0,
    );
    assert_eq!(listing["details"]["container"]["entries"][0], "second.bin");
    assert_eq!(listing["details"]["container"]["entries"][1], "first.bin");

    let planned = temp.child("planned.zip");
    let plan = run_single_json_event(
        &[
            "compress",
            first.path().to_str().unwrap(),
            second.path().to_str().unwrap(),
            "-o",
            planned.path().to_str().unwrap(),
            "--dry-run",
            "--json",
        ],
        0,
    );
    assert_eq!(plan["details"]["dry_run"], true);
    assert!(!planned.path().exists());

    command_stdout(
        &[
            "trim",
            first.path().to_str().expect("path"),
            "--input",
            second.path().to_str().expect("path"),
            "--dry-run",
            "--json",
        ],
        0,
    );
}

#[test]
fn input_alias_appears_in_native_help() {
    for args in [
        ["probe", "--help"].as_slice(),
        ["compress", "--help"].as_slice(),
        ["man", "probe"].as_slice(),
    ] {
        let output = command_stdout(args, 0);
        assert!(
            String::from_utf8_lossy(&output).contains("FILE"),
            "{args:?}"
        );
    }
    let output = command_stdout(&["completions", "zsh"], 0);
    assert!(String::from_utf8_lossy(&output).contains("File input"));
}
