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
            "--json",
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
            "--json",
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

#[test]
fn missing_input_is_still_reported_as_missing() {
    let temp = setup_temp_dir();
    let missing = temp.child("nope.bin");
    let events = run_json_events(
        &[
            "probe",
            "--input",
            missing.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let label = terminal_label(&events);
    assert!(
        label.starts_with("input path does not exist: `"),
        "a missing input must keep its own wording: {label}"
    );
}
