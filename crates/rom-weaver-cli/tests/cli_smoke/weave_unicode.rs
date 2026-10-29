use super::shared::*;

fn run_weave_command(temp: &TempDir, args: &[&str], mode: &str) {
    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    for (key, directory) in [
        ("HOME", "home"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_STATE_HOME", "state"),
        ("XDG_CACHE_HOME", "cache"),
    ] {
        command.env(key, temp.path().join(directory));
    }
    let stdout = command
        .args(args)
        .arg(mode)
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let report: Value = if mode == "--jsonl" {
        parse_json_lines(&stdout).pop().expect("terminal")
    } else {
        serde_json::from_slice(&stdout).expect("JSON report")
    };
    assert_eq!(report["status"], "succeeded");
}

#[test]
fn weave_create_unicode_output_name() {
    for mode in ["--json", "--jsonl"] {
        for name in ["é.txt", "💾.txt", "é.JsOn", "notes.txt"] {
            let temp = setup_temp_dir();
            let patch = temp.child("fix.ips");
            fs::write(patch.path(), b"PATCHEOF").expect("patch");
            let output = temp.child(name);
            run_weave_command(
                &temp,
                &[
                    "weave",
                    "create",
                    "--patch",
                    patch.path().to_str().expect("path"),
                    "--output",
                    output.path().to_str().expect("path"),
                ],
                mode,
            );
            let recipe: Value = serde_json::from_slice(&fs::read(output.path()).expect("recipe"))
                .expect("valid recipe");
            assert_eq!(recipe["patches"][0]["path"], "fix.ips");
        }
    }
}

#[test]
fn weave_unicode_archive_roundtrips_through_parse_and_apply() {
    for mode in ["--json", "--jsonl"] {
        let temp = setup_temp_dir();
        let rom = temp.child("original.bin");
        fs::write(rom.path(), b"abcdefgh").expect("ROM");
        let patch = temp.child("fix ü.ips");
        fs::write(patch.path(), b"PATCH\x00\x00\x03\x00\x01XEOF").expect("patch");
        let recipe = temp.child("recipe.json");
        let archive = temp.child("recipe.zip");
        run_weave_command(
            &temp,
            &[
                "weave",
                "create",
                "--input",
                rom.path().to_str().expect("path"),
                "--patch",
                patch.path().to_str().expect("path"),
                "--output",
                recipe.path().to_str().expect("path"),
                "--weave",
                archive.path().to_str().expect("path"),
            ],
            mode,
        );
        let extracted = temp.child("parsed");
        run_weave_command(
            &temp,
            &[
                "weave",
                "parse",
                "--input",
                archive.path().to_str().expect("path"),
                "--output",
                extracted.path().to_str().expect("path"),
            ],
            mode,
        );
        assert_eq!(
            fs::read(extracted.path().join("fix ü.ips")).expect("extracted patch"),
            fs::read(patch.path()).expect("original patch"),
        );
        let output = temp.child("patched.bin");
        run_weave_command(
            &temp,
            &[
                "patch",
                "apply",
                "--input",
                archive.path().to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--no-compress",
            ],
            mode,
        );
        assert_eq!(fs::read(output.path()).expect("patched ROM"), b"abcXefgh");
    }
}
