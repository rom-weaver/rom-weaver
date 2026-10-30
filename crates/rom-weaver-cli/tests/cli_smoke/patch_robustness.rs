//! End-to-end checks that corrupt or ambiguous patches fail (or warn) instead of silently
//! producing a wrong result: PAT without records, implausible output sizes, EBP content
//! sniffing, window-less VCDIFF and the `--select` help wording.

use super::shared::*;

fn apply_args<'a>(rom: &'a str, patch: &'a str, output: &'a str) -> Vec<&'a str> {
    vec![
        "patch",
        "apply",
        "--input",
        rom,
        "--patch",
        patch,
        "--output",
        output,
        "--no-compress",
        "--json",
    ]
}

/// The final JSON event of a run (a window-less VCDIFF apply emits no progress events).
fn terminal_event(args: &[&str], expected_code: i32) -> Value {
    run_json_events(args, expected_code)
        .pop()
        .expect("at least one JSON event")
}

fn path_str(path: &Path) -> &str {
    path.to_str().expect("utf-8 path")
}

#[test]
fn pat_patches_without_a_valid_record_are_rejected() {
    let temp = setup_temp_dir();
    let rom = temp.child("base.bin");
    fs::write(rom.path(), [0x61_u8; 16]).expect("rom fixture");
    for (name, bytes) in [
        ("empty.pat", &b""[..]),
        ("garbage.pat", b"garbage line\n"),
        ("fragment.pat", b"000000"),
    ] {
        let patch = temp.child(name);
        fs::write(patch.path(), bytes).expect("patch fixture");
        let output = temp.child(format!("{name}.out"));
        let json = terminal_event(
            &apply_args(
                path_str(rom.path()),
                path_str(patch.path()),
                path_str(output.path()),
            ),
            1,
        );
        assert_eq!(json["status"], "failed", "{name}: {json}");
        assert!(!output.path().exists(), "{name}: no output may remain");
    }
}

#[test]
fn corrupt_offsets_that_imply_gigabyte_outputs_are_rejected_without_output() {
    let temp = setup_temp_dir();
    let rom = temp.child("base.bin");
    fs::write(rom.path(), [0_u8; 512]).expect("rom fixture");
    let patch = temp.child("corrupt.ips32");
    let mut bytes = b"IPS32".to_vec();
    bytes.extend_from_slice(&0xFF00_0000_u32.to_be_bytes());
    bytes.extend_from_slice(&1_u16.to_be_bytes());
    bytes.push(b'Z');
    bytes.extend_from_slice(b"EEOF");
    fs::write(patch.path(), bytes).expect("patch fixture");
    let output = temp.child("out.bin");

    let json = terminal_event(
        &apply_args(
            path_str(rom.path()),
            path_str(patch.path()),
            path_str(output.path()),
        ),
        1,
    );

    assert_eq!(json["status"], "failed", "{json}");
    assert_eq!(json["error_kind"], "validation", "{json}");
    // Validation codes travel in the message as `[code]`; the JSON error code stays generic.
    assert!(
        json["error"]["message"]
            .as_str()
            .is_some_and(
                |message| message.contains("[patch.output_size_implausible]")
                    && message.contains("probably corrupt")
            ),
        "{json}"
    );
    assert!(!output.path().exists(), "no output may remain");
}

#[test]
fn implausible_output_size_patch_is_reported_unreadable_in_the_plan() {
    let temp = setup_temp_dir();
    let rom = temp.child("base.bin");
    fs::write(rom.path(), [0_u8; 512]).expect("rom fixture");
    let patch = temp.child("corrupt.ips32");
    let mut bytes = b"IPS32".to_vec();
    bytes.extend_from_slice(&0xFF00_0000_u32.to_be_bytes());
    bytes.extend_from_slice(&1_u16.to_be_bytes());
    bytes.push(b'Z');
    bytes.extend_from_slice(b"EEOF");
    fs::write(patch.path(), bytes).expect("patch fixture");

    let events = run_json_events(
        &[
            "patch",
            "validate",
            "--input",
            path_str(rom.path()),
            "--patch",
            path_str(patch.path()),
            "--plan",
            "--jsonl",
        ],
        0,
    );
    let verdicts = events
        .iter()
        .filter_map(|event| event["details"]["patch_validation"]["per_patch"].as_array())
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(verdicts.len(), 1, "{events:?}");
    let verdict = verdicts[0];
    assert_eq!(verdict["input_verdict"], "failed", "{verdict}");
    assert_eq!(verdict["unreadable"], true, "{verdict}");
    assert!(
        verdict["message"]
            .as_str()
            .is_some_and(|message| message.contains("probably corrupt")),
        "{verdict}"
    );
}

#[test]
fn pat_create_from_identical_inputs_fails_without_output() {
    let temp = setup_temp_dir();
    let rom = temp.child("a.bin");
    fs::write(rom.path(), [0x61_u8; 16]).expect("rom fixture");
    let output = temp.child("x.pat");

    let json = terminal_event(
        &[
            "patch",
            "create",
            "--original",
            path_str(rom.path()),
            "--modified",
            path_str(rom.path()),
            "--output",
            path_str(output.path()),
            "--json",
        ],
        1,
    );

    assert_eq!(json["status"], "failed", "{json}");
    assert!(
        json["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("have no differences")),
        "{json}"
    );
    assert!(!output.path().exists(), "no output may remain");
}

#[test]
fn ebp_patches_apply_under_a_non_ebp_extension() {
    let temp = setup_temp_dir();
    let rom = temp.child("base.bin");
    fs::write(rom.path(), b"abcdefgh").expect("rom fixture");
    let patch = temp.child("update.bin");
    let mut bytes = b"PATCH".to_vec();
    bytes.extend_from_slice(&[0, 0, 2, 0, 3]);
    bytes.extend_from_slice(b"XYZ");
    bytes.extend_from_slice(b"EOF");
    bytes.extend_from_slice(br#"{"patcher":"EBPatcher","Title":"Sniffed"}"#);
    fs::write(patch.path(), bytes).expect("patch fixture");
    let output = temp.child("out.bin");

    let json = terminal_event(
        &apply_args(
            path_str(rom.path()),
            path_str(patch.path()),
            path_str(output.path()),
        ),
        0,
    );

    assert_eq!(json["status"], "succeeded", "{json}");
    assert_eq!(fs::read(output.path()).expect("output"), b"abXYZfgh");
}

#[test]
fn window_less_vcdiff_warning_is_in_the_json_result() {
    // RFC 3284 allows a delta file with no windows, so a header-only patch cannot be told from a
    // truncated one: it must succeed, loudly.
    let temp = setup_temp_dir();
    let rom = temp.child("base.bin");
    fs::write(rom.path(), [0x44_u8; 64]).expect("rom fixture");
    let patch = temp.child("empty.vcdiff");
    fs::write(patch.path(), [0xd6, 0xc3, 0xc4, 0x00, 0x00]).expect("patch fixture");
    let output = temp.child("out.bin");

    let json = terminal_event(
        &apply_args(
            path_str(rom.path()),
            path_str(patch.path()),
            path_str(output.path()),
        ),
        0,
    );

    assert_eq!(json["status"], "succeeded", "{json}");
    assert!(
        json["warnings"]
            .as_array()
            .is_some_and(
                |warnings| warnings.iter().any(|warning| warning.as_str().is_some_and(
                    |text| text.contains("has no delta windows; it produces an empty ROM")
                ))
            ),
        "{json}"
    );
    assert_eq!(fs::metadata(output.path()).expect("output").len(), 0);
}

#[test]
fn select_help_describes_folder_matching_not_prefix_matching() {
    for command in [["patch", "apply"], ["patch", "validate"], ["extract", ""]] {
        let mut args = vec![command[0]];
        if !command[1].is_empty() {
            args.push(command[1]);
        }
        args.push("--help");
        let help = String::from_utf8(command_stdout(&args, 0)).expect("utf-8 help");
        assert!(
            help.contains("exact name, folder, or glob"),
            "{command:?}: {help}"
        );
        assert!(!help.contains("prefix, or glob"), "{command:?}: {help}");
    }
}
