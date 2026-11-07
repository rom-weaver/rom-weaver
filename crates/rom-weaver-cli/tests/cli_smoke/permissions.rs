use super::shared::*;

/// Root bypasses the permission bits these tests rely on, so the denial would
/// never happen and the assertions would be meaningless.
#[cfg(unix)]
fn running_as_root() -> bool {
    rom_weaver_core::effective_ids().is_some_and(|(uid, _)| uid == 0)
}

fn terminal_label(events: &[Value]) -> String {
    events
        .last()
        .and_then(|event| event.get("label"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[cfg(unix)]
#[test]
fn unreadable_input_fails_validation_naming_the_path_and_identity() {
    use std::os::unix::fs::PermissionsExt;

    if running_as_root() {
        return;
    }
    let temp = setup_temp_dir();
    let input = temp.child("locked.bin");
    fs::write(input.path(), vec![0u8; 64]).expect("input fixture");
    fs::set_permissions(input.path(), fs::Permissions::from_mode(0o000)).expect("chmod");

    let events = run_json_events(
        &[
            "probe",
            "--input",
            input.path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
    let label = terminal_label(&events);
    assert!(
        label.starts_with("i/o error: cannot open `"),
        "the failure must name the operation: {label}"
    );
    assert!(
        label.contains(input.path().to_str().expect("path")),
        "the failure must name the file: {label}"
    );
    assert!(
        label.contains("this process runs as"),
        "the failure must name the identity that was refused: {label}"
    );
    // An unreadable file is not a missing file, and saying so would send the
    // user looking for the wrong problem.
    assert!(
        !label.contains("does not exist"),
        "a denial must not be reported as a missing path: {label}"
    );
}

#[cfg(unix)]
#[test]
fn read_only_output_directory_fails_before_any_work() {
    use std::os::unix::fs::PermissionsExt;

    if running_as_root() {
        return;
    }
    let temp = setup_temp_dir();
    let input = temp.child("rom.bin");
    fs::write(input.path(), vec![7u8; 4096]).expect("input fixture");
    let output = temp.child("out");
    fs::create_dir_all(output.path()).expect("output dir");
    fs::set_permissions(output.path(), fs::Permissions::from_mode(0o555)).expect("chmod");

    let events = run_json_events(
        &[
            "extract",
            "--input",
            input.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
    fs::set_permissions(output.path(), fs::Permissions::from_mode(0o755)).expect("restore");

    let label = terminal_label(&events);
    assert!(
        label.contains("cannot write to `"),
        "the failure must name the write that was refused: {label}"
    );
    assert!(
        label.contains(output.path().to_str().expect("path")),
        "the failure must name the directory: {label}"
    );
    // `validate` is the proof this ran as a preflight rather than mid-extract.
    let stage = events
        .last()
        .and_then(|event| event.get("stage"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert_eq!(stage, "validate", "the check must run before any work");
}

#[cfg(unix)]
#[test]
fn compress_force_keeps_the_original_when_the_create_fails() {
    use std::os::unix::fs::PermissionsExt;

    if running_as_root() {
        return;
    }
    let temp = setup_temp_dir();
    let inputs = temp.child("inputs");
    fs::create_dir_all(inputs.path()).expect("input dir");
    fs::write(inputs.path().join("a.bin"), vec![1u8; 65536]).expect("readable input");
    let locked = inputs.path().join("b.bin");
    fs::write(&locked, vec![2u8; 65536]).expect("locked input");
    // The archive is open and part written by the time this entry fails to read.
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("chmod");
    let output = temp.child("out.zip");
    fs::write(output.path(), b"the original").expect("existing output");

    let events = run_json_events(
        &[
            "compress",
            "--input",
            inputs.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--force",
            "--jsonl",
        ],
        1,
    );
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).expect("restore");

    assert_eq!(
        fs::read(output.path()).expect("original"),
        b"the original",
        "a failed --force run must leave the file it would have replaced"
    );
    let leftovers = fs::read_dir(temp.path())
        .expect("list output dir")
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".rw-partial-")
        })
        .count();
    assert_eq!(leftovers, 0);
    let label = terminal_label(&events);
    assert!(!label.contains(".rw-partial-"), "{label}");
}

#[test]
fn missing_input_is_still_reported_as_missing() {
    let temp = setup_temp_dir();
    let missing = temp.child("nope.bin");
    let events = run_json_events(
        &[
            "probe",
            "--input",
            missing.path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
    let label = terminal_label(&events);
    assert!(
        label.starts_with("input path does not exist: `"),
        "a missing input must keep its own wording: {label}"
    );
}

/// Runs `args` (with `--json` appended) expecting exit 1 and returns the result document.
fn failed_json(args: &[String]) -> Value {
    let mut args: Vec<&str> = args.iter().map(String::as_str).collect();
    args.push("--json");
    run_single_json_event(&args, 1)
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_string()).collect()
}

/// A readable file, a directory, a patch file, and an output folder, as one fixture.
struct InputFixture {
    _temp: TempDir,
    dir: String,
    file: String,
    patch: String,
    out: String,
}

fn input_fixture() -> InputFixture {
    let temp = setup_temp_dir();
    let dir = temp.child("adir");
    fs::create_dir(dir.path()).expect("dir fixture");
    let file = temp.child("base.bin");
    fs::write(file.path(), vec![0u8; 64]).expect("file fixture");
    let patch = temp.child("p.ips");
    fs::write(patch.path(), b"PATCHEOF").expect("patch fixture");
    let text = |path: &Path| path.to_str().expect("utf8 path").to_string();
    InputFixture {
        dir: text(dir.path()),
        file: text(file.path()),
        patch: text(patch.path()),
        out: text(&temp.path().join("out")),
        _temp: temp,
    }
}

#[test]
fn directory_input_gets_one_shared_message_in_every_command() {
    let f = input_fixture();
    let out = |name: &str| format!("{}/{name}", f.out);
    let cases: Vec<Vec<String>> = vec![
        strings(&["probe", "--input", &f.dir]),
        strings(&["extract", "--input", &f.dir, "--output", &out("x")]),
        strings(&["checksum", "--input", &f.dir]),
        strings(&["identify", "--input", &f.dir]),
        strings(&["playlist", "--input", &f.dir, "--output", &out("p.m3u")]),
        strings(&[
            "patch",
            "apply",
            "--input",
            &f.dir,
            "--patch",
            &f.patch,
            "--no-compress",
            "--output",
            &out("a.bin"),
        ]),
        strings(&[
            "patch",
            "apply",
            "--input",
            &f.file,
            "--patch",
            &f.dir,
            "--no-compress",
            "--output",
            &out("b.bin"),
        ]),
        strings(&["patch", "validate", "--input", &f.dir, "--patch", &f.patch]),
        strings(&["patch", "validate", "--input", &f.file, "--patch", &f.dir]),
        strings(&[
            "weave",
            "create",
            "--input",
            &f.dir,
            "--patch",
            &f.patch,
            "--output",
            &out("w.json"),
        ]),
        strings(&[
            "weave",
            "create",
            "--input",
            &f.file,
            "--patch",
            &f.dir,
            "--output",
            &out("v.json"),
        ]),
        strings(&["weave", "parse", "--input", &f.dir]),
        strings(&["--dry-run", "probe", "--input", &f.dir]),
        strings(&["--dry-run", "weave", "parse", "--input", &f.dir]),
    ];
    let expected = format!("input is a directory, not a file: `{}`", f.dir);
    for args in cases {
        let json = failed_json(&args);
        assert_eq!(json["error"]["message"], expected.as_str(), "{args:?}");
        assert_eq!(json["error_kind"], "validation", "{args:?}");
    }
}

#[test]
fn missing_input_gets_one_shared_message_and_kind_in_every_command() {
    let f = input_fixture();
    let missing = format!("{}/nope.bin", f.out);
    let out = |name: &str| format!("{}/{name}", f.out);
    let cases: Vec<Vec<String>> = vec![
        strings(&["probe", "--input", &missing]),
        strings(&["checksum", "--input", &missing]),
        strings(&["trim", &missing]),
        strings(&["--dry-run", "trim", &missing]),
        strings(&["cheat", "list", "--input", &missing]),
        strings(&["weave", "parse", "--input", &missing]),
        strings(&[
            "weave",
            "create",
            "--input",
            &missing,
            "--patch",
            &f.patch,
            "--output",
            &out("w.json"),
        ]),
        strings(&["playlist", "--input", &missing, "--output", &out("p.m3u")]),
    ];
    let expected = format!("input path does not exist: `{missing}`");
    for args in cases {
        let json = failed_json(&args);
        assert_eq!(json["error"]["message"], expected.as_str(), "{args:?}");
        assert_eq!(json["error_kind"], "validation", "{args:?}");
    }
}

#[test]
fn dry_run_checks_the_input_of_save_readers_and_cheat_list() {
    let f = input_fixture();
    let missing = format!("{}/nope.sav", f.out);
    let cases: Vec<Vec<String>> = vec![
        strings(&["--dry-run", "save", "inspect", &missing]),
        strings(&["--dry-run", "save", "get", &missing, "a.b"]),
        strings(&["--dry-run", "save", "identify", &missing]),
        strings(&["--dry-run", "save", "export-schema", &missing]),
        strings(&["--dry-run", "cheat", "list", "--input", &missing]),
    ];
    let expected = format!("input path does not exist: `{missing}`");
    for args in cases {
        let json = failed_json(&args);
        assert_eq!(json["error"]["message"], expected.as_str(), "{args:?}");
    }
}

#[cfg(unix)]
#[test]
fn unreadable_input_fails_with_the_denial_in_trim_weave_and_playlist() {
    use std::os::unix::fs::PermissionsExt;

    if running_as_root() {
        return;
    }
    let f = input_fixture();
    fs::set_permissions(&f.file, fs::Permissions::from_mode(0o000)).expect("chmod");
    let out = |name: &str| format!("{}/{name}", f.out);
    let cases: Vec<Vec<String>> = vec![
        strings(&["trim", &f.file]),
        strings(&["--dry-run", "trim", &f.file]),
        strings(&["weave", "parse", "--input", &f.file]),
        strings(&[
            "weave",
            "create",
            "--input",
            &f.file,
            "--patch",
            &f.patch,
            "--output",
            &out("w.json"),
        ]),
        strings(&["playlist", "--input", &f.file, "--output", &out("p.m3u")]),
    ];
    for args in cases {
        let json = failed_json(&args);
        let message = json["error"]["message"].as_str().expect("message");
        assert!(
            message.starts_with(&format!("i/o error: cannot open `{}`", f.file)),
            "{args:?}: {message}"
        );
        assert!(
            message.contains("this process runs as"),
            "{args:?}: {message}"
        );
    }
    for name in ["w.json", "p.m3u"] {
        assert!(
            !Path::new(&out(name)).exists(),
            "{name} must not be written"
        );
    }
}
