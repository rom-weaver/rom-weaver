use super::shared::*;
use serde_json::json;

fn write_min_ips(temp: &TempDir, name: &str) -> PathBuf {
    let patch = temp.child(name);
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![0xAA],
            }],
            None,
        ),
    )
    .expect("ips fixture");
    patch.path().to_path_buf()
}

#[test]
fn weave_parse_plain_json_resolves_refs_verbatim() {
    let temp = setup_temp_dir();
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        r#"{
            "version": 1,
            "rom": { "url": "https://example.test/roms/game.sfc" },
            "patches": [
                { "path": "main.ips", "label": "stable" },
                { "url": "patches/extra.bps", "optional": true }
            ],
            "output": { "name": "out.sfc" }
        }"#,
    )
    .expect("weave fixture");

    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            weave.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["weave"];
    assert_eq!(result["source_kind"], "json");
    assert_eq!(result["weave"]["version"], 1);
    assert!(
        result["weave"].get("name").is_none(),
        "weaves carry no display name"
    );
    assert!(
        result["weave"]["patches"][0].get("optional").is_none(),
        "non-optional patches omit the flag"
    );
    assert_eq!(result["weave"]["patches"][1]["optional"], true);
    assert_eq!(result["weave"]["patches"][0]["label"], "stable");
    assert!(result["weave"]["output"].get("compress").is_none());
    assert_eq!(
        result["rom_source"]["url"], "https://example.test/roms/game.sfc",
        "url refs pass through verbatim"
    );
    assert_eq!(
        result["patch_sources"][0]["source"]["path"], "main.ips",
        "path refs stay weave-relative for a plain weave"
    );
    assert_eq!(
        result["patch_sources"][1]["source"]["url"], "patches/extra.bps",
        "relative urls pass through verbatim (the caller resolves them)"
    );
    assert!(
        result["patch_sources"][0]["descriptor"].is_null(),
        "unextracted entries carry no descriptor"
    );
    assert_eq!(result["warnings"].as_array().expect("warnings").len(), 0);
}

#[test]
fn weave_parse_reads_gzipped_weave() {
    let temp = setup_temp_dir();
    let weave = temp.child("rom-weaver-weave.json.gz");
    let json = r#"{ "version": 1, "patches": [ { "path": "main.ips" } ] }"#;
    let file = File::create(weave.path()).expect("create rom-weaver-weave.json.gz");
    let mut encoder = GzEncoder::new(file, DeflateCompression::default());
    encoder.write_all(json.as_bytes()).expect("gzip weave");
    encoder.finish().expect("finish gzip weave");

    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            weave.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["weave"];
    assert_eq!(result["source_kind"], "compressed-json");
    assert_eq!(result["weave"]["patches"][0]["path"], "main.ips");
}

#[test]
fn weave_parse_archive_extracts_referenced_members() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"0123456789abcdef").expect("rom fixture");
    let patch_path = write_min_ips(&temp, "main.ips");
    let weave_json = temp.child("rom-weaver-weave.json");
    fs::write(
        weave_json.path(),
        r#"{
            "version": 1,
            "rom": { "path": "roms/game.bin" },
            "patches": [ { "path": "patches/main.ips", "description": "main hack" } ]
        }"#,
    )
    .expect("weave fixture");
    let archive = temp.child("weave.tar.gz");
    write_tar_gz_fixture(
        &[
            (weave_json.path(), "rom-weaver-weave.json"),
            (rom.path(), "roms/game.bin"),
            (&patch_path, "patches/main.ips"),
        ],
        archive.path(),
    );
    let extract_dir = temp.child("weave-out");

    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            extract_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["weave"];
    assert_eq!(result["source_kind"], "archive");
    assert_eq!(result["archive_member"], "rom-weaver-weave.json");

    let rom_path = result["rom_source"]["extracted_path"]
        .as_str()
        .expect("rom extracted path");
    assert!(
        rom_path.ends_with("roms/game.bin"),
        "unexpected rom path: {rom_path}"
    );
    assert_eq!(
        fs::read(rom_path).expect("extracted rom readable"),
        b"0123456789abcdef"
    );

    let patch_source = &result["patch_sources"][0];
    let extracted_patch = patch_source["source"]["extracted_path"]
        .as_str()
        .expect("patch extracted path");
    assert!(
        fs::metadata(extracted_patch)
            .expect("extracted patch")
            .is_file()
    );
    assert_eq!(patch_source["descriptor"]["format"], "IPS");
    assert_eq!(patch_source["descriptor"]["is_valid_patch"], true);
}

#[test]
fn weave_parse_archive_treats_unbundled_rom_path_as_user_supplied() {
    let temp = setup_temp_dir();
    let patch_path = write_min_ips(&temp, "main.ips");
    let weave_json = temp.child("rom-weaver-weave.json");
    fs::write(
        weave_json.path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.nes" },
            "patches": [ { "path": "patches/main.ips" } ]
        }"#,
    )
    .expect("weave fixture");
    let archive = temp.child("weave.tar.gz");
    write_tar_gz_fixture(
        &[
            (weave_json.path(), "rom-weaver-weave.json"),
            (&patch_path, "patches/main.ips"),
        ],
        archive.path(),
    );
    let extract_dir = temp.child("weave-out");

    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            extract_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["weave"];
    assert!(result["rom_source"].is_null(), "rom source: {result}");
    assert!(result["patch_sources"][0]["source"]["extracted_path"].is_string());
    assert!(
        result["warnings"]
            .as_array()
            .expect("warnings")
            .iter()
            .any(|warning| warning
                .as_str()
                .is_some_and(|text| text.contains("`game.nes` is not bundled in the archive"))),
        "warnings: {result}"
    );
}

#[test]
fn weave_parse_archive_still_rejects_unbundled_patch_path() {
    let temp = setup_temp_dir();
    let weave_json = temp.child("rom-weaver-weave.json");
    fs::write(
        weave_json.path(),
        r#"{ "version": 1, "rom": { "path": "game.nes" }, "patches": [ { "path": "missing.ips" } ] }"#,
    )
    .expect("weave fixture");
    let archive = temp.child("weave.tar.gz");
    write_tar_gz_fixture(
        &[(weave_json.path(), "rom-weaver-weave.json")],
        archive.path(),
    );
    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            archive.path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("failure label");
    assert!(label.contains("bundle.path.unresolved"), "{label}");
}

#[test]
fn weave_parse_archive_content_probes_noncanonical_member() {
    // A pre-rename archive whose index is named `rw.json`, not the canonical
    // `rom-weaver-weave.json`, must still be found by content probing. A decoy
    // `config.json` that is not a weave sits alongside to prove the probe is
    // gated on a successful parse, not on the `.json` extension.
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"0123456789abcdef").expect("rom fixture");
    let patch_path = write_min_ips(&temp, "main.ips");
    let decoy = temp.child("config.json");
    fs::write(decoy.path(), r#"{ "unrelated": true }"#).expect("decoy fixture");
    let weave_json = temp.child("rw.json");
    fs::write(
        weave_json.path(),
        r#"{
            "version": 1,
            "rom": { "path": "roms/game.bin" },
            "patches": [ { "path": "patches/main.ips" } ]
        }"#,
    )
    .expect("weave fixture");
    let archive = temp.child("legacy-weave.tar.gz");
    write_tar_gz_fixture(
        &[
            (decoy.path(), "config.json"),
            (weave_json.path(), "rw.json"),
            (rom.path(), "roms/game.bin"),
            (&patch_path, "patches/main.ips"),
        ],
        archive.path(),
    );
    let extract_dir = temp.child("legacy-out");

    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            extract_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["weave"];
    assert_eq!(result["source_kind"], "archive");
    assert_eq!(result["archive_member"], "rw.json");
    let rom_path = result["rom_source"]["extracted_path"]
        .as_str()
        .expect("rom extracted path");
    assert!(
        rom_path.ends_with("roms/game.bin"),
        "unexpected rom path: {rom_path}"
    );
    assert_eq!(result["patch_sources"][0]["descriptor"]["format"], "IPS");
}

#[test]
fn weave_parse_archive_without_weave_fails() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"0123456789abcdef").expect("rom fixture");
    let weave = temp.child("weave.tar.gz");
    write_tar_gz_fixture(&[(rom.path(), "roms/game.bin")], weave.path());

    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            weave.path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("failure label");
    assert!(
        label.contains("bundle.missing"),
        "expected weave.missing code in label: {label}"
    );
}

const WEAVE_ROM_BYTES: &[u8] = b"0123456789abcdef";

fn write_weave_rom(temp: &TempDir, name: &str) -> PathBuf {
    let rom = temp.child(name);
    fs::write(rom.path(), WEAVE_ROM_BYTES).expect("rom fixture");
    rom.path().to_path_buf()
}

fn write_offset_ips(temp: &TempDir, name: &str, offset: u32, value: u8) -> PathBuf {
    let patch = temp.child(name);
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset,
                data: vec![value],
            }],
            None,
        ),
    )
    .expect("ips fixture");
    patch.path().to_path_buf()
}

fn create_patch_file(original: &Path, modified: &Path, format: &str, output: &Path) {
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.to_str().expect("path"),
            "--modified",
            modified.to_str().expect("path"),
            "--format",
            format,
            "--output",
            output.to_str().expect("path"),
            "--json",
        ],
        0,
    );
}

fn patched_rom_bytes(edits: &[(usize, u8)]) -> Vec<u8> {
    let mut bytes = WEAVE_ROM_BYTES.to_vec();
    for (offset, value) in edits {
        bytes[*offset] = *value;
    }
    bytes
}

fn weave_check_state<'a>(weave: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
    weave["checkStates"]
        .as_array()
        .expect("check states")
        .iter()
        .find(|state| state["id"] == id)
        .expect("named check state")
}

#[test]
fn weave_apply_plain_weave_input_uses_output_name() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rom-weaver-weave.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "name": "out.bin" }
        }"#,
    )
    .expect("weave fixture");

    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.current_dir(temp.path());
    command.args([
        "patch",
        "apply",
        "--input",
        "rom-weaver-weave.json",
        "--no-compress",
        "--json",
    ]);
    let stdout = command.assert().code(0).get_output().stdout.clone();
    let terminal = parse_json_lines(&stdout).last().expect("terminal").clone();
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("out.bin").path()).expect("weave-named output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn weave_apply_gzipped_weave_with_cli_output() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave = temp.child("rom-weaver-weave.json.gz");
    let json = r#"{ "version": 1,
                    "rom": { "path": "game.bin" },
                    "patches": [ { "path": "main.ips" } ],
                    "output": {} }"#;
    let file = File::create(weave.path()).expect("create rom-weaver-weave.json.gz");
    let mut encoder = GzEncoder::new(file, DeflateCompression::default());
    encoder.write_all(json.as_bytes()).expect("gzip weave");
    encoder.finish().expect("finish gzip weave");
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

fn write_everything_archive(temp: &TempDir, weave_json: &str) -> PathBuf {
    let rom = write_weave_rom(temp, "game.bin");
    let main = write_offset_ips(temp, "main.ips", 0, 0xAA);
    let extra = write_offset_ips(temp, "extra.ips", 1, 0xBB);
    let weave_file = temp.child("rom-weaver-weave.json");
    fs::write(weave_file.path(), weave_json).expect("weave fixture");
    let archive = temp.child("weave.tar.gz");
    write_tar_gz_fixture(
        &[
            (weave_file.path(), "rom-weaver-weave.json"),
            (&rom, "roms/game.bin"),
            (&main, "patches/main.ips"),
            (&extra, "patches/extra.ips"),
        ],
        archive.path(),
    );
    archive.path().to_path_buf()
}

const EVERYTHING_WEAVE: &str = r#"{
    "version": 1,
    "rom": { "path": "roms/game.bin" },
    "patches": [
        { "path": "patches/main.ips",  "name": "Main hack" },
        { "path": "patches/extra.ips", "name": "Extra",     "optional": true }
    ],
    "output": {}
}"#;

#[test]
fn weave_apply_everything_archive_skips_optional() {
    let temp = setup_temp_dir();
    let weave = write_everything_archive(&temp, EVERYTHING_WEAVE);
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)]),
        "optional patch must not apply without --with"
    );
}

#[test]
fn weave_apply_with_flag_includes_optional() {
    let temp = setup_temp_dir();
    let weave = write_everything_archive(&temp, EVERYTHING_WEAVE);
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.to_str().expect("path"),
            "--with",
            "Extra",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA), (1, 0xBB)])
    );
}

#[test]
fn weave_apply_without_can_disable_default_patch() {
    let temp = setup_temp_dir();
    let weave = write_everything_archive(&temp, EVERYTHING_WEAVE);

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.to_str().expect("path"),
            "--without",
            "Main*",
            "--with",
            "Extra",
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("patched.bin").path()).expect("output exists"),
        patched_rom_bytes(&[(1, 0xBB)])
    );
}

#[test]
fn weave_apply_rejects_with_and_without_patterns_that_match_nothing() {
    for flag in ["--with", "--without"] {
        let temp = setup_temp_dir();
        let weave = write_everything_archive(&temp, EVERYTHING_WEAVE);
        let output = temp.child("patched.bin");

        let events = run_json_events(
            &[
                "patch-apply",
                "--input",
                weave.to_str().expect("path"),
                flag,
                "NoSuchPatch",
                "--output",
                output.path().to_str().expect("path"),
                "--no-compress",
                "--jsonl",
            ],
            1,
        );
        let terminal = events.last().expect("terminal");
        assert_eq!(terminal["status"], "failed");
        let label = terminal["label"].as_str().expect("label");
        assert!(
            label.contains(flag) && label.contains("NoSuchPatch"),
            "{flag} typo must be named in the error: {label}"
        );
        assert!(!output.path().exists(), "no ROM is written on a typo");
    }
}

#[test]
fn weave_apply_credits_name_and_file_name_patterns_for_the_same_entry() {
    let temp = setup_temp_dir();
    let weave = write_everything_archive(&temp, EVERYTHING_WEAVE);
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.to_str().expect("path"),
            "--with",
            "Extra",
            "--with",
            "extra.ips",
            "--without",
            "Main hack",
            "--without",
            "main.ips",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(1, 0xBB)])
    );
}

#[test]
fn patch_apply_rejects_weave_only_flags_without_a_weave() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let rom = temp.child("game.bin");
    let patch = temp.child("main.ips");
    for (flag, value) in [
        ("--with", Some("main*")),
        ("--without", Some("main*")),
        ("--without-cheats", None),
    ] {
        let output = temp.child("patched.bin");
        let mut args = vec![
            "patch-apply",
            "--input",
            rom.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
            flag,
        ];
        args.extend(value);
        let events = run_json_events(&args, 1);
        let terminal = events.last().expect("terminal");
        assert_eq!(terminal["status"], "failed");
        assert!(
            terminal["label"]
                .as_str()
                .expect("label")
                .contains(&format!("{flag} only applies to a weave")),
            "{flag}: {terminal}"
        );
        assert!(!output.path().exists());
    }
}

#[test]
fn weave_apply_rom_checks_mismatch_fails() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rom-weaver-weave.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin", "checks": { "checksums": { "crc32": "00000000" } } },
            "patches": [ { "path": "main.ips" } ],
            "output": {}
        }"#,
    )
    .expect("weave fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("label");
    assert!(
        label.contains("crc32") && label.contains("00000000"),
        "expected crc32 mismatch in label: {label}"
    );
}

#[test]
fn weave_apply_explicit_weave_flag_keeps_input_rom() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    // The weave's rom entry points at a nonexistent URL host on purpose:
    // with --weave the positional input supplies the ROM, so the rom
    // source must be ignored (its checks are not - none set here).
    fs::write(
        temp.child("rom-weaver-weave.json").path(),
        r#"{
            "version": 1,
            "rom": { "url": "https://example.test/never-fetched.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": {}
        }"#,
    )
    .expect("weave fixture");
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("path"),
            "--weave",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn weave_apply_cli_output_overrides_weave_name() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rom-weaver-weave.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "name": "weave-named.bin" }
        }"#,
    )
    .expect("weave fixture");
    let output = temp.child("cli-named.bin");

    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.current_dir(temp.path());
    command.args([
        "patch",
        "apply",
        "--input",
        "rom-weaver-weave.json",
        "--output",
        "cli-named.bin",
        "--no-compress",
        "--json",
    ]);
    command.assert().code(0);
    assert!(output.path().is_file(), "explicit --output path must win");
    assert!(
        !temp.child("weave-named.bin").path().exists(),
        "weave output.name must not be written when --output is given"
    );
}

#[test]
fn weave_apply_missing_output_fails_with_code() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rom-weaver-weave.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": {}
        }"#,
    )
    .expect("weave fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--jsonl",
        ],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("bundle.output.missing"),
        "unexpected label: {}",
        terminal["label"]
    );
}

#[test]
fn weave_parse_rejects_output_compression() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rom-weaver-weave.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "name": "out.zip", "compress": { "format": "zip", "level": "min" } }
        }"#,
    )
    .expect("weave fixture");

    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--jsonl",
        ],
        1,
    );
    assert_eq!(events.last().expect("terminal")["status"], "failed");
}

/// One-shot threaded HTTP responder: serves `files` (matched by path suffix)
/// for up to `requests` connections, then exits. Returns the base URL.
fn serve_files(files: Vec<(&'static str, Vec<u8>)>, requests: usize) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind test http server");
    let address = listener.local_addr().expect("server address");
    std::thread::spawn(move || {
        for _ in 0..requests {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buffer = [0u8; 4096];
            let mut total = 0usize;
            while let Ok(read) = std::io::Read::read(&mut stream, &mut buffer[total..]) {
                if read == 0 {
                    break;
                }
                total += read;
                if buffer[..total]
                    .windows(4)
                    .any(|window| window == b"\r\n\r\n")
                    || total == buffer.len()
                {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&buffer[..total]);
            let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
            let body = files
                .iter()
                .find(|(name, _)| path.ends_with(name))
                .map(|(_, bytes)| bytes.clone());
            match body {
                Some(body) => {
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(header.as_bytes());
                    let _ = stream.write_all(&body);
                }
                None => {
                    let _ = stream.write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
            }
        }
    });
    format!("http://{address}")
}

fn crc32_hex(bytes: &[u8]) -> String {
    let mut crc = flate2::Crc::new();
    crc.update(bytes);
    format!("{:08x}", crc.sum())
}

fn md5_hex(bytes: &[u8]) -> String {
    rom_weaver_checksum::md5_bytes(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn weave_apply_url_patch_downloads_and_applies() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    let patch_bytes = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: vec![0xAA],
        }],
        None,
    );
    let base_url = serve_files(vec![("/main.ips", patch_bytes)], 1);
    fs::write(
        temp.child("rom-weaver-weave.json").path(),
        format!(
            r#"{{
                "version": 1,
                "rom": {{ "path": "game.bin" }},
                "patches": [ {{ "url": "{base_url}/main.ips" }} ],
                "output": {{}}
            }}"#
        ),
    )
    .expect("weave fixture");
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn weave_apply_url_weave_resolves_relative_entries() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let patch_bytes = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: vec![0xAA],
        }],
        None,
    );
    let weave_json = br#"{
        "version": 1,
        "patches": [ { "url": "patches/main.ips" } ],
        "output": {}
    }"#
    .to_vec();
    let base_url = serve_files(
        vec![
            ("/rom-weaver-weave.json", weave_json),
            ("/patches/main.ips", patch_bytes),
        ],
        2,
    );
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("path"),
            "--weave",
            &format!("{base_url}/packs/rom-weaver-weave.json"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn weave_create_computes_checks_and_aligns_metadata() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let extra = write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    let weave_out = temp.child("rom-weaver-weave.json");

    let events = run_json_events(
        &[
            "weave",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--patch",
            main.to_str().expect("path"),
            "--patch-name",
            "Main hack",
            "--patch-version",
            "1.2",
            "--patch-author",
            "Weaver",
            "--patch-optional",
            "false",
            "--patch-label",
            "stable",
            "--patch",
            extra.to_str().expect("path"),
            "--patch-optional",
            "true",
            "--patch-description",
            "extra maps",
            "--output-name",
            "patched.bin",
            "--output",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "succeeded");
    let created = &terminal["details"]["weave_create"];
    assert!(
        created["bundle_path"]
            .as_str()
            .expect("weave path")
            .ends_with("rom-weaver-weave.json")
    );

    // Round-trip through weave parse and verify computed values.
    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let parsed = &events.last().expect("terminal")["details"]["weave"]["weave"];
    assert_eq!(parsed["version"], 2);
    assert_eq!(parsed["patchBasis"], "auto");
    assert!(parsed.get("name").is_none(), "weaves carry no name");
    assert_eq!(parsed["rom"]["path"], "game.bin");
    assert_eq!(parsed["rom"]["checksRef"], "rom");
    assert_eq!(
        weave_check_state(parsed, "rom")["checks"]["checksums"]["crc32"],
        crc32_hex(WEAVE_ROM_BYTES).as_str()
    );
    assert_eq!(
        weave_check_state(parsed, "rom")["checks"]["size"],
        WEAVE_ROM_BYTES.len() as u64
    );
    let first = &parsed["patches"][0];
    assert_eq!(first["name"], "Main hack");
    assert_eq!(first["version"], "1.2");
    assert_eq!(first["author"], "Weaver");
    assert!(
        first.get("optional").is_none(),
        "explicit --patch-optional false emits nothing"
    );
    assert_eq!(first["label"], "stable");
    assert!(first["description"].is_null());
    assert!(
        first.get("integrity").is_none(),
        "patch entries carry no file hashes"
    );
    let second = &parsed["patches"][1];
    assert_eq!(second["optional"], true);
    assert!(second["version"].is_null());
    assert!(second["author"].is_null());
    assert_eq!(second["description"], "extra maps");
    assert!(second["name"].is_null());
    assert_eq!(parsed["output"]["name"], "patched.bin");
    assert!(parsed["output"].get("compress").is_none());
}

#[test]
fn weave_create_upgrades_v1_with_auto_basis_and_omits_redundant_entry_basis() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let patch = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let spec = temp.child("v1.json");
    let output = temp.child("rom-weaver-weave.json");
    fs::write(
        spec.path(),
        format!(
            r#"{{
              "$schema": "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-weave-v1.schema.json",
              "version": 1,
              "rom": {{ "path": "{}" }},
              "patches": [{{ "path": "{}", "basis": "base" }}]
            }}"#,
            rom.file_name().expect("rom name").to_string_lossy(),
            patch.file_name().expect("patch name").to_string_lossy(),
        ),
    )
    .expect("v1 spec");

    let events = run_json_events(
        &[
            "weave",
            "create",
            "--from",
            spec.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let weave = &events.last().expect("terminal")["details"]["weave_create"]["weave"];
    assert_eq!(weave["version"], 2);
    assert_eq!(weave["patchBasis"], "auto");
    assert_eq!(
        weave["$schema"],
        "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-weave-v2.schema.json"
    );
    assert_eq!(weave["patches"][0]["basis"], "base");

    let base_output = temp.child("base.json");
    let events = run_json_events(
        &[
            "weave",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--patch",
            patch.to_str().expect("path"),
            "--patch-basis",
            "base",
            "--output",
            base_output.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let weave = &events.last().expect("terminal")["details"]["weave_create"]["weave"];
    assert_eq!(weave["patchBasis"], "auto");
    assert_eq!(weave["patches"][0]["basis"], "base");
}

#[test]
fn weave_create_uses_cached_rom_checks_and_size() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let patch = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave_out = temp.child("rom-weaver-weave.json");
    let cached_crc = "deadbeef";
    let cached_md5 = "00112233445566778899aabbccddeeff";
    let cached_sha1 = "00112233445566778899aabbccddeeff00112233";

    run_json_events(
        &[
            "weave",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--assume-in",
            &format!("crc32={cached_crc},md5={cached_md5},sha1={cached_sha1},size=999"),
            "--patch",
            patch.to_str().expect("path"),
            "--output",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let parsed = &events.last().expect("terminal")["details"]["weave"]["weave"];
    let rom_checks = &weave_check_state(parsed, "rom")["checks"];
    assert_eq!(rom_checks["checksums"]["crc32"], cached_crc);
    assert_eq!(rom_checks["checksums"]["md5"], cached_md5);
    assert_eq!(rom_checks["checksums"]["sha1"], cached_sha1);
    assert_eq!(rom_checks["size"], 999);
}

#[test]
fn weave_create_gzip_output_parses_back() {
    let temp = setup_temp_dir();
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave_out = temp.child("rom-weaver-weave.json.gz");

    run_json_events(
        &[
            "weave",
            "create",
            "--patch",
            main.to_str().expect("path"),
            "--output",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let result = &events.last().expect("terminal")["details"]["weave"];
    assert_eq!(result["source_kind"], "compressed-json");
    assert_eq!(result["weave"]["patches"][0]["path"], "main.ips");
}

#[test]
fn weave_create_weave_roundtrips_through_apply() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave_out = temp.child("rom-weaver-weave.json");
    let weave = temp.child("weave.zip");

    let events = run_json_events(
        &[
            "weave",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--patch",
            main.to_str().expect("path"),
            "--output",
            weave_out.path().to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["details"]["weave_create"]["archive_path"]
            .as_str()
            .expect("weave path")
            .ends_with("weave.zip")
    );

    let output = temp.child("patched.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn weave_create_reuses_equal_payloads_and_disambiguates_same_basename() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let first = write_offset_ips(&temp, "first.ips", 0, 0xAA);
    let identical = temp.child("identical.ips");
    fs::copy(first.as_path(), identical.path()).expect("copy identical patch");
    let same_name_a = temp.path().join("a/main.ips");
    let same_name_b = temp.path().join("b/main.ips");
    fs::create_dir_all(same_name_a.parent().expect("parent")).expect("first patch directory");
    fs::create_dir_all(same_name_b.parent().expect("parent")).expect("second patch directory");
    fs::write(
        &same_name_a,
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 1,
                data: vec![0xBB],
            }],
            None,
        ),
    )
    .expect("first colliding patch");
    fs::write(
        &same_name_b,
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 2,
                data: vec![0xCC],
            }],
            None,
        ),
    )
    .expect("second colliding patch");
    let weave_json = temp.child("rom-weaver-weave.json");
    let archive = temp.child("weave.zip");
    let events = run_json_events(
        &[
            "weave",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--patch",
            first.to_str().expect("path"),
            "--patch",
            identical.path().to_str().expect("path"),
            "--patch",
            same_name_a.to_str().expect("path"),
            "--patch",
            same_name_b.to_str().expect("path"),
            "--output",
            weave_json.path().to_str().expect("path"),
            "--weave",
            archive.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let weave = &events.last().expect("terminal")["details"]["weave_create"]["weave"];
    let paths: Vec<&str> = weave["patches"]
        .as_array()
        .expect("patches")
        .iter()
        .map(|patch| patch["path"].as_str().expect("weave path"))
        .collect();
    assert_eq!(
        paths[0], paths[1],
        "equal patch bytes must share one archive member"
    );
    assert_ne!(
        paths[2], paths[3],
        "different same-basename bytes need distinct archive members"
    );
    assert!(paths[2].starts_with("payload-main-") || paths[3].starts_with("payload-main-"));
}

#[test]
fn weave_create_from_preserves_shared_size_only_check_state() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let source = temp.child("source.json");
    fs::write(
        source.path(),
        r#"{
            "version": 2,
            "patchBasis": "base",
            "checkStates": [{ "id": "rom", "checks": { "size": 16 } }],
            "rom": { "path": "game.bin", "checksRef": "rom" },
            "patches": [{ "id": "main", "path": "main.ips", "input": { "rom": true }, "inputChecksRef": "rom" }]
        }"#,
    ).expect("source weave");
    let output = temp.child("rom-weaver-weave.json");
    let events = run_json_events(
        &[
            "weave",
            "create",
            "--from",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let weave = &events.last().expect("terminal")["details"]["weave_create"]["weave"];
    assert_eq!(weave["rom"]["checksRef"], "rom");
    assert_eq!(weave["patches"][0]["inputChecksRef"], "rom");
    assert_eq!(weave_check_state(weave, "rom")["checks"]["size"], 16);
}

#[test]
fn weave_create_from_preserves_an_explicit_shared_input_state_without_basis_inference() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "a.ips", 0, 0xAA);
    write_offset_ips(&temp, "b.ips", 1, 0xBB);
    let source = temp.child("source.json");
    fs::write(
        source.path(),
        r#"{
            "version": 2,
            "patchBasis": "auto",
            "checkStates": [{ "id": "shared-size", "checks": { "size": 16 } }],
            "rom": { "path": "game.bin" },
            "patches": [
                { "id": "a", "path": "a.ips", "inputChecksRef": "shared-size" },
                { "id": "b", "path": "b.ips", "inputChecksRef": "shared-size" }
            ]
        }"#,
    )
    .expect("source weave");
    let output = temp.child("rom-weaver-weave.json");
    let events = run_json_events(
        &[
            "weave",
            "create",
            "--from",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let weave = &events.last().expect("terminal")["details"]["weave_create"]["weave"];
    assert_eq!(weave["patches"][0]["inputChecksRef"], "shared-size");
    assert_eq!(weave["patches"][1]["inputChecksRef"], "shared-size");
    assert_eq!(
        weave_check_state(weave, "shared-size")["checks"]["size"],
        16
    );
}

#[test]
fn weave_create_keeps_equal_checks_for_a_different_rom_member() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let source = temp.child("source.json");
    fs::write(
        source.path(),
        r#"{
            "version": 2,
            "patchBasis": "base",
            "rom": { "path": "game.bin", "member": "root.bin", "checks": { "size": 16 } },
            "patches": [{ "id": "main", "path": "main.ips", "input": { "rom": true, "member": "other.bin" }, "inputChecks": { "size": 16 } }]
        }"#,
    ).expect("source weave");
    let output = temp.child("rom-weaver-weave.json");
    let events = run_json_events(
        &[
            "weave",
            "create",
            "--from",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let weave = &events.last().expect("terminal")["details"]["weave_create"]["weave"];
    assert_eq!(weave["patches"][0]["inputChecksRef"], "patch:main:input");
    assert_eq!(
        weave_check_state(weave, "patch:main:input")["checks"]["size"],
        16
    );
}

#[test]
fn weave_create_patch_check_emits_checks_and_apply_enforces() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave_out = temp.child("rom-weaver-weave.json");

    run_json_events(
        &[
            "weave",
            "create",
            "--patch",
            main.to_str().expect("path"),
            "--patch-expect-in",
            "crc32=00000000",
            "--output",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let entry = &events.last().expect("terminal")["details"]["weave"]["weave"]["patches"][0];
    assert_eq!(entry["inputChecksRef"], "patch:0:input");
    let parsed = &events.last().expect("terminal")["details"]["weave"]["weave"];
    assert_eq!(
        weave_check_state(parsed, "patch:0:input")["checks"]["checksums"]["crc32"],
        "00000000"
    );

    // The deliberately wrong expected checksum must fail the apply.
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("game.bin").path().to_str().expect("path"),
            "--weave",
            weave_out.path().to_str().expect("path"),
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("label");
    assert!(
        label.contains("crc32") && label.contains("00000000"),
        "expected crc32 mismatch in label: {label}"
    );
}

#[test]
fn weave_create_no_weave_rom_emits_checks_only_entry() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave_out = temp.child("rom-weaver-weave.json");
    let weave = temp.child("weave.zip");

    run_json_events(
        &[
            "weave",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--no-weave-rom",
            "--patch",
            main.to_str().expect("path"),
            "--output",
            weave_out.path().to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let result = &events.last().expect("terminal")["details"]["weave"];
    let rom_entry = &result["weave"]["rom"];
    assert!(
        rom_entry["path"].is_null() && rom_entry["url"].is_null(),
        "no-weave-rom entry must be sourceless: {rom_entry}"
    );
    assert_eq!(rom_entry["checksRef"], "rom");
    assert_eq!(
        weave_check_state(&result["weave"], "rom")["checks"]["checksums"]["crc32"],
        crc32_hex(WEAVE_ROM_BYTES).as_str()
    );
    assert_eq!(rom_entry["name"], "game.bin");
    assert!(result["rom_source"].is_null(), "no rom source to resolve");

    // The applying user supplies the ROM; the weave is patches-only.
    let output = temp.child("patched.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );

    // Using the patches-only weave as the apply input has no ROM to patch.
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            temp.child("nope.bin").path().to_str().expect("path"),
            "--jsonl",
        ],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("label");
    assert!(
        label.contains("provides no source"),
        "expected sourceless-rom guidance in label: {label}"
    );
    // The user must be told WHICH ROM to supply: the entry's checks surface
    // as expected_* fields in the failure.
    let expected_crc = crc32_hex(WEAVE_ROM_BYTES);
    assert!(
        label.contains("expected_checksums") && label.contains(&expected_crc),
        "expected rom expectation details in label: {label}"
    );
    assert!(
        label.contains("expected_size"),
        "expected rom size expectation in label: {label}"
    );
}

#[test]
fn weave_apply_input_zip_with_unbundled_rom_path_asks_for_the_rom() {
    // A hand-zipped `weave create` JSON records the input ROM as `rom.path`, which the
    // zip does not bundle: the guidance matches a `rom.name` weave, not bundle.path.unresolved,
    // and names the expected ROM by the path's basename since there is no `rom.name`.
    // Weave paths accept either separator, so a backslash path names the same basename.
    for rom_path in [r"dumps/game.bin", r"dumps\\game.bin"] {
        let temp = setup_temp_dir();
        let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
        let weave_json = temp.child("rom-weaver-weave.json");
        fs::write(
            weave_json.path(),
            format!(
                r#"{{ "version": 1, "rom": {{ "path": "{rom_path}" }}, "patches": [ {{ "path": "main.ips" }} ] }}"#
            ),
        )
        .expect("weave fixture");
        let archive = temp.child("weave.tar.gz");
        write_tar_gz_fixture(
            &[
                (weave_json.path(), "rom-weaver-weave.json"),
                (main.as_path(), "main.ips"),
            ],
            archive.path(),
        );
        let events = run_json_events(
            &[
                "patch-apply",
                "--input",
                archive.path().to_str().expect("path"),
                "--output",
                temp.child("nope.bin").path().to_str().expect("path"),
                "--jsonl",
            ],
            1,
        );
        let terminal = events.last().expect("terminal");
        assert_eq!(terminal["status"], "failed");
        let label = terminal["label"].as_str().expect("label");
        assert!(label.contains("bundle.rom.missing"), "{label}");
        assert!(!label.contains("bundle.path.unresolved"), "{label}");
        assert!(label.contains("not bundled in the archive"), "{label}");
        assert!(
            label.contains("expected_name=game.bin"),
            "expected name for {rom_path}: {label}"
        );
    }
}

/// Builds a tar.gz weave whose `rom.path` (`dumps/missing.bin`) is not bundled, with the ROM
/// bytes `member_bytes` stored as `roms/renamed.bin` and `rom.checks` given by `checks_json`.
fn write_rom_by_checks_archive(temp: &TempDir, member_bytes: &[u8], checks_json: &str) -> PathBuf {
    let main = write_offset_ips(temp, "main.ips", 0, 0xAA);
    let member = temp.child("renamed.bin");
    fs::write(member.path(), member_bytes).expect("rom member fixture");
    let weave_json = temp.child("rom-weaver-weave.json");
    fs::write(
        weave_json.path(),
        format!(
            r#"{{ "version": 1, "rom": {{ "path": "dumps/missing.bin", "checks": {checks_json} }}, "patches": [ {{ "path": "main.ips" }} ] }}"#
        ),
    )
    .expect("weave fixture");
    let archive = temp.child("weave.tar.gz");
    write_tar_gz_fixture(
        &[
            (weave_json.path(), "rom-weaver-weave.json"),
            (member.path(), "roms/renamed.bin"),
            (main.as_path(), "main.ips"),
        ],
        archive.path(),
    );
    archive.path().to_path_buf()
}

fn parse_rom_by_checks_archive(temp: &TempDir, archive: &Path) -> serde_json::Value {
    let extract_dir = temp.child("weave-out");
    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            archive.to_str().expect("path"),
            "--output",
            extract_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    terminal["details"]["weave"].clone()
}

fn assert_rom_not_bound(result: &serde_json::Value) {
    assert!(result["rom_source"].is_null(), "rom source: {result}");
    assert!(
        result["warnings"]
            .as_array()
            .expect("warnings")
            .iter()
            .any(|warning| warning
                .as_str()
                .is_some_and(|text| text.contains("`dumps/missing.bin` is not bundled"))),
        "warnings: {result}"
    );
}

fn apply_rom_by_checks_archive(
    temp: &TempDir,
    archive: &Path,
    expected_exit: i32,
) -> serde_json::Value {
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            archive.to_str().expect("path"),
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        expected_exit,
    );
    events.last().expect("terminal").clone()
}

#[test]
fn weave_parse_binds_unbundled_rom_path_to_member_with_matching_checksums() {
    let temp = setup_temp_dir();
    let checks = format!(
        r#"{{ "size": {}, "checksums": {{ "crc32": "{}", "md5": "{}" }} }}"#,
        WEAVE_ROM_BYTES.len(),
        crc32_hex(WEAVE_ROM_BYTES),
        md5_hex(WEAVE_ROM_BYTES)
    );
    let archive = write_rom_by_checks_archive(&temp, WEAVE_ROM_BYTES, &checks);
    let result = parse_rom_by_checks_archive(&temp, &archive);
    let rom_path = result["rom_source"]["extracted_path"]
        .as_str()
        .unwrap_or_else(|| panic!("rom bound: {result}"));
    assert!(
        rom_path.ends_with("roms/renamed.bin"),
        "rom path: {rom_path}"
    );
    assert_eq!(fs::read(rom_path).expect("extracted rom"), WEAVE_ROM_BYTES);
    assert!(
        !result["warnings"]
            .as_array()
            .expect("warnings")
            .iter()
            .any(|warning| warning
                .as_str()
                .is_some_and(|text| text.contains("not bundled"))),
        "unexpected warning: {result}"
    );
}

#[test]
fn weave_apply_input_archive_binds_unbundled_rom_path_by_checksum() {
    let temp = setup_temp_dir();
    let checks = format!(
        r#"{{ "checksums": {{ "crc32": "{}" }} }}"#,
        crc32_hex(WEAVE_ROM_BYTES)
    );
    let archive = write_rom_by_checks_archive(&temp, WEAVE_ROM_BYTES, &checks);
    let terminal = apply_rom_by_checks_archive(&temp, &archive, 0);
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("patched.bin").path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn weave_unbundled_rom_path_does_not_bind_a_member_with_other_checksums() {
    let temp = setup_temp_dir();
    let mut other = WEAVE_ROM_BYTES.to_vec();
    other[1] ^= 0xFF;
    let checks = format!(
        r#"{{ "size": {}, "checksums": {{ "crc32": "{}" }} }}"#,
        WEAVE_ROM_BYTES.len(),
        crc32_hex(WEAVE_ROM_BYTES)
    );
    let archive = write_rom_by_checks_archive(&temp, &other, &checks);
    assert_rom_not_bound(&parse_rom_by_checks_archive(&temp, &archive));
    let terminal = apply_rom_by_checks_archive(&temp, &archive, 1);
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("bundle.rom.missing"), "{label}");
}

#[test]
fn weave_unbundled_rom_path_does_not_bind_on_size_only_checks() {
    let temp = setup_temp_dir();
    let checks = format!(r#"{{ "size": {} }}"#, WEAVE_ROM_BYTES.len());
    let archive = write_rom_by_checks_archive(&temp, WEAVE_ROM_BYTES, &checks);
    assert_rom_not_bound(&parse_rom_by_checks_archive(&temp, &archive));
    let terminal = apply_rom_by_checks_archive(&temp, &archive, 1);
    let label = terminal["label"].as_str().expect("label");
    assert!(label.contains("bundle.rom.missing"), "{label}");
}

#[test]
fn weave_apply_warns_but_succeeds_when_rom_name_differs() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave = temp.child("rom-weaver-weave.json");

    run_json_events(
        &[
            "weave",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--no-weave-rom",
            "--rom-name",
            "expected.bin",
            "--patch",
            main.to_str().expect("path"),
            "--output",
            weave.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let patched = temp.child("patched.bin");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "--log-level",
            "warn",
            "patch",
            "apply",
            "--input",
            rom.to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            patched.path().to_str().expect("path"),
            "--no-compress",
        ])
        .assert()
        .code(0)
        .get_output()
        .clone();
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(
        stderr.contains("weave ROM name mismatch")
            && stderr.contains("expected.bin")
            && stderr.contains("game.bin"),
        "expected advisory name warning, got: {stderr}"
    );

    run_json_events(
        &[
            "weave",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--no-weave-rom",
            "--rom-name",
            "GAME.BIN",
            "--patch",
            main.to_str().expect("path"),
            // Rewriting the weave from the first half of this test now needs
            // --force: `weave create` refuses to clobber an existing output.
            "--force",
            "--output",
            weave.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let case_matched = temp.child("case-matched.bin");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "--log-level",
            "warn",
            "patch",
            "apply",
            "--input",
            rom.to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            case_matched.path().to_str().expect("path"),
            "--no-compress",
        ])
        .assert()
        .code(0)
        .get_output()
        .clone();
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(
        !stderr.contains("weave ROM name mismatch"),
        "case-only difference must match: {stderr}"
    );
}

#[test]
fn weave_create_empty_rom_name_suppresses_the_default() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let patch = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave = temp.child("rom-weaver-weave.json");

    run_json_events(
        &[
            "weave",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--no-weave-rom",
            "--rom-name",
            "",
            "--patch",
            patch.to_str().expect("path"),
            "--output",
            weave.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let parsed: serde_json::Value =
        serde_json::from_slice(&fs::read(weave.path()).expect("weave bytes")).expect("weave json");
    assert!(
        parsed["rom"].get("name").is_none(),
        "an explicitly cleared name must stay absent: {}",
        parsed["rom"]
    );
}

#[test]
fn weave_apply_enforces_mid_chain_declared_input_checks() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    let weave = temp.child("rom-weaver-weave.json");
    // The second entry declares an impossible mid-chain input state: strict
    // apply must verify it against the real intermediate and stop the chain.
    fs::write(
        weave.path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [
                { "path": "main.ips" },
                { "path": "extra.ips", "inputChecks": { "checksums": { "crc32": "00000000" } } }
            ],
            "output": { "name": "out.bin" }
        }"#,
    )
    .expect("weave fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("patch.chain.input_mismatch")
    );
}

#[test]
fn weave_apply_named_patch_input_uses_producer_bytes_not_current_chain_bytes() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "a.ips", 0, 0xAA);
    write_offset_ips(&temp, "b.ips", 1, 0xBB);
    write_offset_ips(&temp, "c.ips", 2, 0xCC);
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        r#"{
            "version": 2,
            "patchBasis": "previous",
            "rom": { "path": "game.bin" },
            "patches": [
                { "id": "a", "path": "a.ips", "input": { "rom": true } },
                { "id": "b", "path": "b.ips", "input": { "patch": "a" } },
                { "id": "c", "path": "c.ips", "input": { "patch": "a" } }
            ],
            "output": { "name": "out.bin" }
        }"#,
    )
    .expect("weave fixture");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("out.bin").path()).expect("output"),
        patched_rom_bytes(&[(0, 0xAA), (2, 0xCC)]),
        "C must consume A's stored output; B's byte must not leak through the current chain"
    );
}

#[test]
fn weave_apply_rom_member_selects_the_exact_archive_entry() {
    let temp = setup_temp_dir();
    let unwanted = temp.child("unwanted.bin");
    fs::write(unwanted.path(), WEAVE_ROM_BYTES).expect("unwanted ROM fixture");
    let wanted = temp.child("wanted.bin");
    fs::write(wanted.path(), patched_rom_bytes(&[(1, 0x11)])).expect("wanted ROM fixture");
    let archive = temp.child("roms.tar.gz");
    write_tar_gz_fixture(
        &[
            (unwanted.path(), "roms/unwanted.bin"),
            (wanted.path(), "roms/wanted.bin"),
        ],
        archive.path(),
    );
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        r#"{
            "version": 2,
            "patchBasis": "base",
            "rom": { "member": "roms/wanted.bin" },
            "patches": [{ "id": "main", "path": "main.ips", "input": { "rom": true } }]
        }"#,
    )
    .expect("weave fixture");
    let output = temp.child("out.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        patched_rom_bytes(&[(0, 0xAA), (1, 0x11)]),
    );
}

#[test]
fn weave_apply_verifies_checks_for_the_explicit_rom_member() {
    let temp = setup_temp_dir();
    let root = temp.child("root.bin");
    fs::write(root.path(), WEAVE_ROM_BYTES).expect("root ROM fixture");
    let selected = temp.child("selected.bin");
    let selected_bytes = patched_rom_bytes(&[(1, 0x11)]);
    fs::write(selected.path(), &selected_bytes).expect("selected ROM fixture");
    let archive = temp.child("roms.tar.gz");
    write_tar_gz_fixture(
        &[(root.path(), "root.bin"), (selected.path(), "selected.bin")],
        archive.path(),
    );
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        format!(
            r#"{{
                "version": 2,
                "patchBasis": "auto",
                "checkStates": [{{ "id": "selected", "checks": {{ "checksums": {{ "crc32": "{}" }} }} }}],
                "rom": {{ "member": "root.bin" }},
                "patches": [{{ "id": "main", "path": "main.ips", "input": {{ "rom": true, "member": "selected.bin" }}, "inputChecksRef": "selected" }}]
            }}"#,
            crc32_hex(&selected_bytes),
        ),
    ).expect("weave fixture");
    let output = temp.child("out.bin");
    run_json_events(
        &[
            "patch-apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(
        fs::read(output.path()).expect("output"),
        patched_rom_bytes(&[(0, 0xAA), (1, 0x11)])
    );
}

#[test]
fn weave_apply_verifies_a_declared_base_first_patch_against_its_rom_member() {
    let temp = setup_temp_dir();
    let root = temp.child("root.bin");
    fs::write(root.path(), WEAVE_ROM_BYTES).expect("root ROM fixture");
    let selected = temp.child("selected.bin");
    let selected_bytes = patched_rom_bytes(&[(1, 0x11)]);
    fs::write(selected.path(), &selected_bytes).expect("selected ROM fixture");
    let larger = temp.child("larger.bin");
    let larger_bytes = [WEAVE_ROM_BYTES, b"tail"].concat();
    fs::write(larger.path(), &larger_bytes).expect("larger ROM fixture");
    let archive = temp.child("roms.tar.gz");
    write_tar_gz_fixture(
        &[
            (root.path(), "root.bin"),
            (selected.path(), "selected.bin"),
            (larger.path(), "larger.bin"),
        ],
        archive.path(),
    );
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave = temp.child("rom-weaver-weave.json");

    // The first patch's base checks MUST be verified against the member it
    // reads, not against the weave's root ROM member.
    let apply = |weave_json: serde_json::Value, output: &str, expected_code: i32| {
        fs::write(weave.path(), weave_json.to_string()).expect("weave fixture");
        let output = temp.child(output);
        let events = run_json_events(
            &[
                "patch-apply",
                "--input",
                archive.path().to_str().expect("path"),
                "--weave",
                weave.path().to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--no-compress",
                "--jsonl",
            ],
            expected_code,
        );
        let terminal = events.last().expect("terminal").clone();
        (terminal, fs::read(output.path()).ok())
    };
    let entry = |member: &str, checks: serde_json::Value| {
        json!({
            "id": "main",
            "path": "main.ips",
            "input": { "rom": true, "member": member },
            "inputChecks": checks,
        })
    };
    let checks_for =
        |bytes: &[u8]| json!({ "checksums": { "crc32": crc32_hex(bytes) }, "size": bytes.len() });

    let mut per_entry = entry("selected.bin", checks_for(&selected_bytes));
    per_entry["basis"] = json!("base");
    let (terminal, bytes) = apply(
        json!({ "version": 1, "rom": { "member": "root.bin" }, "patches": [per_entry] }),
        "per-entry.bin",
        0,
    );
    assert_eq!(terminal["status"], "succeeded", "per-entry: {terminal}");
    assert_eq!(bytes, Some(patched_rom_bytes(&[(0, 0xAA), (1, 0x11)])));

    let (terminal, bytes) = apply(
        json!({
            "version": 2,
            "patchBasis": "base",
            "rom": { "member": "root.bin" },
            "patches": [entry("selected.bin", checks_for(&selected_bytes))],
        }),
        "shared.bin",
        0,
    );
    assert_eq!(terminal["status"], "succeeded", "shared: {terminal}");
    assert_eq!(bytes, Some(patched_rom_bytes(&[(0, 0xAA), (1, 0x11)])));

    // Naming the root ROM's own member still reads the base.
    let (terminal, bytes) = apply(
        json!({
            "version": 2,
            "patchBasis": "base",
            "rom": { "member": "root.bin" },
            "patches": [entry("root.bin", checks_for(WEAVE_ROM_BYTES))],
        }),
        "root-member.bin",
        0,
    );
    assert_eq!(terminal["status"], "succeeded", "root member: {terminal}");
    assert_eq!(bytes, Some(patched_rom_bytes(&[(0, 0xAA)])));

    // A pinned size that differs from the root ROM's is still the member's.
    let (terminal, bytes) = apply(
        json!({
            "version": 2,
            "patchBasis": "base",
            "rom": { "member": "root.bin" },
            "patches": [entry("larger.bin", checks_for(&larger_bytes))],
        }),
        "larger-member.bin",
        0,
    );
    assert_eq!(terminal["status"], "succeeded", "larger member: {terminal}");
    let mut larger_expected = larger_bytes.clone();
    larger_expected[0] = 0xAA;
    assert_eq!(bytes, Some(larger_expected));

    let (terminal, bytes) = apply(
        json!({
            "version": 2,
            "patchBasis": "base",
            "rom": { "member": "root.bin" },
            "patches": [entry(
                "selected.bin",
                json!({ "checksums": { "crc32": "00000000" }, "size": selected_bytes.len() }),
            )],
        }),
        "wrong.bin",
        1,
    );
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("patch.chain.input_mismatch"),
        "wrong member checks: {terminal}"
    );
    assert_eq!(bytes, None);
}

/// Runs `patch-apply` on a weave whose `rom.checks` are `rom_checks` and
/// returns the terminal event plus the output bytes, if any were written.
fn apply_weave_with_rom_checks(
    temp: &TempDir,
    rom_name: &str,
    patch_name: &str,
    rom_checks: serde_json::Value,
    output_name: &str,
    extra_args: &[&str],
    expected_code: i32,
) -> (serde_json::Value, Option<Vec<u8>>) {
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        json!({
            "version": 1,
            "rom": { "path": rom_name, "checks": rom_checks },
            "patches": [{ "path": patch_name }],
        })
        .to_string(),
    )
    .expect("weave fixture");
    let output = temp.child(output_name);
    let mut args = vec![
        "patch-apply",
        "--input",
        weave.path().to_str().expect("path"),
        "--output",
        output.path().to_str().expect("path"),
        "--no-compress",
        "--jsonl",
    ];
    args.extend_from_slice(extra_args);
    let events = run_json_events(&args, expected_code);
    (
        events.last().expect("terminal").clone(),
        fs::read(output.path()).ok(),
    )
}

#[test]
fn weave_rom_checks_match_a_headered_nes_rom_for_a_headerless_bps() {
    let temp = setup_temp_dir();
    let body: Vec<u8> = (0..64_u8).collect();
    let mut modified = body.clone();
    modified[0x20] = 0xAA;
    fs::write(temp.child("body.nes").path(), &body).expect("body fixture");
    fs::write(temp.child("modified.nes").path(), &modified).expect("modified fixture");
    create_patch_file(
        temp.child("body.nes").path(),
        temp.child("modified.nes").path(),
        "bps",
        temp.child("update.bps").path(),
    );
    let rom = with_nes_header(&body);
    fs::write(temp.child("game.nes").path(), &rom).expect("rom fixture");

    // `rom.checks` describe the headered file as supplied; the BPS was made
    // for the headerless bytes and its own source checksum decides the strip.
    let (terminal, bytes) = apply_weave_with_rom_checks(
        &temp,
        "game.nes",
        "update.bps",
        json!({ "checksums": { "crc32": crc32_hex(&rom), "md5": md5_hex(&rom) }, "size": rom.len() }),
        "out.nes",
        &[],
        0,
    );
    assert_eq!(terminal["status"], "succeeded", "matching ROM: {terminal}");
    let label = terminal["label"].as_str().expect("label");
    assert!(
        label.contains(&format!("input size verified (size={})", rom.len()))
            && label.contains(&format!(
                "input checksum(s) verified (crc32={}, md5={})",
                crc32_hex(&rom),
                md5_hex(&rom)
            )),
        "verified labels: {terminal}"
    );
    assert_eq!(bytes, Some(with_nes_header(&modified)));

    let (terminal, bytes) = apply_weave_with_rom_checks(
        &temp,
        "game.nes",
        "update.bps",
        json!({ "checksums": { "crc32": "00000000" }, "size": rom.len() }),
        "wrong.nes",
        &[],
        1,
    );
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("input checksum mismatch for crc32"),
        "wrong ROM: {terminal}"
    );
    assert_eq!(bytes, None);

    let (terminal, bytes) = apply_weave_with_rom_checks(
        &temp,
        "game.nes",
        "update.bps",
        json!({ "checksums": { "crc32": "00000000" }, "size": rom.len() + 1 }),
        "override.nes",
        &["--ignore-checksum-validation"],
        0,
    );
    assert_eq!(terminal["status"], "succeeded", "override: {terminal}");
    assert_eq!(bytes, Some(with_nes_header(&modified)));

    // A `rom.member` is checked as the member file it resolves to.
    let archive = temp.child("roms.tar.gz");
    write_tar_gz_fixture(
        &[
            (temp.child("game.nes").path(), "game.nes"),
            (temp.child("body.nes").path(), "other.nes"),
        ],
        archive.path(),
    );
    let weave = temp.child("member-weave.json");
    for (crc32, output_name, expected_code) in [
        (crc32_hex(&rom), "member.nes", 0),
        ("00000000".to_string(), "member-wrong.nes", 1),
    ] {
        fs::write(
            weave.path(),
            json!({
                "version": 1,
                "rom": {
                    "path": "roms.tar.gz",
                    "member": "game.nes",
                    "checks": { "checksums": { "crc32": crc32 }, "size": rom.len() },
                },
                "patches": [{ "path": "update.bps" }],
            })
            .to_string(),
        )
        .expect("weave fixture");
        let output = temp.child(output_name);
        let events = run_json_events(
            &[
                "patch-apply",
                "--input",
                weave.path().to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--no-compress",
                "--jsonl",
            ],
            expected_code,
        );
        let terminal = events.last().expect("terminal");
        if expected_code == 0 {
            assert_eq!(
                fs::read(output.path()).ok(),
                Some(with_nes_header(&modified))
            );
        } else {
            assert!(
                terminal["label"]
                    .as_str()
                    .expect("label")
                    .contains("input checksum mismatch for crc32"),
                "wrong member ROM: {terminal}"
            );
            assert!(!output.path().exists());
        }
    }
}

#[test]
fn weave_rom_checks_leave_the_snes_header_decision_to_the_patch() {
    let temp = setup_temp_dir();
    // 512-byte copier header + 32 KiB payload (len % 1024 == 512). The IPS
    // record at offset 0 lands inside the copier header on the raw basis,
    // which proves the patch was made for the headerless bytes.
    let body = vec![0xA5_u8; 32768];
    let mut modified = body.clone();
    modified[0] = b'Z';
    fs::write(temp.child("body.sfc").path(), &body).expect("body fixture");
    fs::write(temp.child("modified.sfc").path(), &modified).expect("modified fixture");
    create_patch_file(
        temp.child("body.sfc").path(),
        temp.child("modified.sfc").path(),
        "ips",
        temp.child("update.ips").path(),
    );
    let rom = with_header(&body);
    fs::write(temp.child("game.smc").path(), &rom).expect("rom fixture");

    // A CRC-only `rom.checks` of the headered file MUST NOT pin the header.
    let (terminal, bytes) = apply_weave_with_rom_checks(
        &temp,
        "game.smc",
        "update.ips",
        json!({ "checksums": { "crc32": crc32_hex(&rom) } }),
        "out.sfc",
        &["--output-header", "strip"],
        0,
    );
    assert_eq!(terminal["status"], "succeeded", "matching ROM: {terminal}");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("input header stripped (512 bytes"),
        "header decision: {terminal}"
    );
    assert_eq!(bytes, Some(modified));
}

#[test]
fn weave_rom_checks_accept_another_dump_of_the_recorded_rom() {
    let temp = setup_temp_dir();
    // Recorded from a headerless NES ROM; the user supplies a headered dump.
    let body: Vec<u8> = (0..64_u8).collect();
    let mut modified = body.clone();
    modified[0x20] = 0xAA;
    fs::write(temp.child("body.nes").path(), &body).expect("body fixture");
    fs::write(temp.child("modified.nes").path(), &modified).expect("modified fixture");
    create_patch_file(
        temp.child("body.nes").path(),
        temp.child("modified.nes").path(),
        "bps",
        temp.child("update.bps").path(),
    );
    fs::write(temp.child("game.nes").path(), with_nes_header(&body)).expect("rom fixture");
    let (terminal, bytes) = apply_weave_with_rom_checks(
        &temp,
        "game.nes",
        "update.bps",
        json!({ "checksums": { "crc32": crc32_hex(&body) }, "size": body.len() }),
        "out.nes",
        &[],
        0,
    );
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains(&format!(
                "input checks verified against the ROM's headerless form (crc32={}, size={})",
                crc32_hex(&body),
                body.len()
            )),
        "headered dump: {terminal}"
    );
    assert_eq!(bytes, Some(with_nes_header(&modified)));

    // Recorded from a big-endian `.z64`; the user supplies a byte-swapped `.v64`.
    let mut z64 = vec![0x80, 0x37, 0x12, 0x40];
    z64.extend((0..4092_u32).map(|index| (index % 251) as u8));
    let mut z64_modified = z64.clone();
    z64_modified[0x40] ^= 0xFF;
    fs::write(temp.child("body.z64").path(), &z64).expect("z64 fixture");
    fs::write(temp.child("modified.z64").path(), &z64_modified).expect("modified z64 fixture");
    create_patch_file(
        temp.child("body.z64").path(),
        temp.child("modified.z64").path(),
        "bps",
        temp.child("update-n64.bps").path(),
    );
    let swap_pairs = |bytes: &[u8]| -> Vec<u8> {
        bytes
            .chunks_exact(2)
            .flat_map(|pair| [pair[1], pair[0]])
            .collect()
    };
    fs::write(temp.child("game.v64").path(), swap_pairs(&z64)).expect("v64 fixture");
    let (terminal, bytes) = apply_weave_with_rom_checks(
        &temp,
        "game.v64",
        "update-n64.bps",
        json!({ "checksums": { "crc32": crc32_hex(&z64) }, "size": z64.len() }),
        "out.v64",
        &[],
        0,
    );
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains(&format!(
                "input checks verified against the ROM's n64-big-endian form (crc32={}, size={})",
                crc32_hex(&z64),
                z64.len()
            )),
        "byte-swapped dump: {terminal}"
    );
    assert_eq!(bytes, Some(swap_pairs(&z64_modified)));
}

#[test]
fn weave_rom_check_failure_keeps_the_rom_name_warning() {
    let temp = setup_temp_dir();
    fs::write(temp.child("game.nes").path(), with_nes_header(&[0_u8; 64])).expect("rom fixture");
    let patch = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        json!({
            "version": 1,
            "rom": { "name": "expected.nes", "checks": { "checksums": { "crc32": "00000000" } } },
            "patches": [{ "path": patch.file_name().expect("name").to_str().expect("utf8") }],
        })
        .to_string(),
    )
    .expect("weave fixture");
    let output = temp.child("out.nes");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("input checksum mismatch for crc32"),
        "wrong ROM: {terminal}"
    );
    assert!(
        terminal
            .to_string()
            .contains("weave ROM name mismatch: expected `expected.nes`, found `game.nes`"),
        "name warning: {terminal}"
    );
    assert!(!output.path().exists());
}

#[test]
fn weave_rom_checks_run_after_the_output_path_checks() {
    let temp = setup_temp_dir();
    fs::write(temp.child("game.nes").path(), with_nes_header(&[0_u8; 64])).expect("rom fixture");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(temp.child("taken.nes").path(), b"keep").expect("existing output");
    // A wrong ROM and a taken output: the cheap output check reports first.
    let (terminal, bytes) = apply_weave_with_rom_checks(
        &temp,
        "game.nes",
        "main.ips",
        json!({ "checksums": { "crc32": "00000000" } }),
        "taken.nes",
        &[],
        1,
    );
    let label = terminal["label"].as_str().expect("label");
    assert!(
        label.contains("refusing to overwrite existing output"),
        "output check first: {terminal}"
    );
    assert_eq!(bytes, Some(b"keep".to_vec()));
}

#[test]
fn weave_rom_checks_repeated_by_the_first_patch_report_one_label() {
    let temp = setup_temp_dir();
    let rom: Vec<u8> = (0..64_u8).collect();
    fs::write(temp.child("game.bin").path(), &rom).expect("rom fixture");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let checks = json!({ "checksums": { "crc32": crc32_hex(&rom), "md5": md5_hex(&rom) }, "size": rom.len() });
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        json!({
            "version": 1,
            "rom": { "path": "game.bin", "checks": checks },
            "patches": [{ "path": "main.ips", "inputChecks": checks }],
        })
        .to_string(),
    )
    .expect("weave fixture");
    let output = temp.child("out.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal");
    let label = terminal["label"].as_str().expect("label");
    assert_eq!(
        (
            label.matches("input size verified").count(),
            label.matches("input checksum(s) verified").count()
        ),
        (1, 1),
        "one label per verification: {terminal}"
    );
}

#[test]
fn weave_rom_check_size_mismatch_skips_hashing_without_another_form() {
    let temp = setup_temp_dir();
    // No copier header and no N64 byte order, so no other form can match.
    let rom: Vec<u8> = (0..64_u8).collect();
    fs::write(temp.child("game.bin").path(), &rom).expect("rom fixture");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        json!({
            "version": 1,
            "rom": {
                "path": "game.bin",
                "checks": { "checksums": { "crc32": crc32_hex(&rom) }, "size": rom.len() + 1 },
            },
            "patches": [{ "path": "main.ips" }],
        })
        .to_string(),
    )
    .expect("weave fixture");
    let output = temp.child("out.bin");
    let result = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "--log-level",
            "trace",
            "patch",
            "apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
        ])
        .assert()
        .code(1)
        .get_output()
        .clone();
    let stderr = String::from_utf8(result.stderr).expect("utf8 stderr");
    assert!(
        stderr.contains("input size mismatch")
            && !stderr.contains("computing base checksums for verification plan"),
        "size mismatch without hashing: {stderr}"
    );
    assert!(!output.path().exists());
}

/// Writes `rom` as `rom_name` and an IPS from `body` to `modified`, applies
/// a weave whose `rom.checks` describe `body` with `patch_entry` extended by
/// the patch path, and returns the terminal event and the output bytes.
fn apply_weave_recorded_from_body(
    temp: &TempDir,
    rom_name: &str,
    rom: &[u8],
    body: &[u8],
    modified: &[u8],
    patch_entry: serde_json::Value,
) -> (serde_json::Value, Vec<u8>) {
    fs::write(temp.child("body.bin").path(), body).expect("body fixture");
    fs::write(temp.child("modified.bin").path(), modified).expect("modified fixture");
    create_patch_file(
        temp.child("body.bin").path(),
        temp.child("modified.bin").path(),
        "ips",
        temp.child("update.ips").path(),
    );
    fs::write(temp.child(rom_name).path(), rom).expect("rom fixture");
    let mut patch_entry = patch_entry;
    patch_entry["path"] = json!("update.ips");
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        json!({
            "version": 1,
            "rom": {
                "path": rom_name,
                "checks": { "checksums": { "crc32": crc32_hex(body) }, "size": body.len() },
            },
            "patches": [patch_entry],
        })
        .to_string(),
    )
    .expect("weave fixture");
    let output = temp.child(format!("out-{rom_name}"));
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--force",
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal").clone();
    // A header policy can adjust the output extension, so read the emitted file.
    let emitted = terminal["details"]["emitted_files"][0]["path"]
        .as_str()
        .expect("emitted output path")
        .to_owned();
    (terminal, fs::read(emitted).expect("output"))
}

#[test]
fn weave_rom_checks_on_the_headerless_form_strip_the_header_for_a_patch_without_evidence() {
    let body: Vec<u8> = (0..64_u8).collect();
    let mut modified = body.clone();
    modified[0x20] = 0xAA;
    for patch_entry in [json!({}), json!({ "basis": "base" })] {
        let temp = setup_temp_dir();
        let (terminal, bytes) = apply_weave_recorded_from_body(
            &temp,
            "game.nes",
            &with_nes_header(&body),
            &body,
            &modified,
            patch_entry.clone(),
        );
        assert_eq!(
            bytes,
            with_nes_header(&modified),
            "nes output bytes from rom.checks {patch_entry}"
        );
        assert!(
            terminal["label"]
                .as_str()
                .expect("label")
                .contains("patch header basis taken as headerless"),
            "header basis from rom.checks {patch_entry}: {terminal}"
        );
    }
}

#[test]
fn weave_rom_checks_on_the_headerless_form_strip_a_snes_copier_header() {
    // 512-byte copier header + 32 KiB payload, with the record well past the
    // header so the record geometry cannot settle the basis.
    let body = vec![0xA5_u8; 32768];
    let mut modified = body.clone();
    modified[0x4000] = b'Z';
    let temp = setup_temp_dir();
    let (terminal, bytes) = apply_weave_recorded_from_body(
        &temp,
        "game.smc",
        &with_header(&body),
        &body,
        &modified,
        json!({}),
    );
    // Copier headers are not restored on output.
    assert_eq!(bytes, modified, "snes output bytes from rom.checks");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("patch header basis taken as headerless"),
        "header basis from rom.checks snes: {terminal}"
    );
}

#[test]
fn weave_rom_checks_on_the_headerless_form_yield_to_decisive_ips_header_geometry() {
    // The IPS appends 16 bytes at the headered end of file, which starts past
    // the end of the headerless bytes, so its geometry says raw. The matched
    // headerless form MUST NOT override that.
    let body: Vec<u8> = (0..64_u8).collect();
    let rom = with_nes_header(&body);
    let mut modified = rom.clone();
    modified.extend(0xC0..0xD0_u8);
    let temp = setup_temp_dir();
    fs::write(temp.child("game.nes").path(), &rom).expect("rom fixture");
    fs::write(temp.child("modified.nes").path(), &modified).expect("modified fixture");
    create_patch_file(
        temp.child("game.nes").path(),
        temp.child("modified.nes").path(),
        "ips",
        temp.child("update.ips").path(),
    );
    let (terminal, bytes) = apply_weave_with_rom_checks(
        &temp,
        "game.nes",
        "update.ips",
        json!({ "checksums": { "crc32": crc32_hex(&body) }, "size": body.len() }),
        "out.nes",
        &[],
        0,
    );
    assert_eq!(
        bytes,
        Some(modified),
        "ips geometry outranks rom.checks: {terminal}"
    );
}

#[test]
fn weave_rom_checks_on_the_headerless_form_agree_with_decisive_ips_header_geometry() {
    // The IPS record at offset 0 lands inside the copier header on the raw
    // basis, so the record geometry alone also says headerless.
    let body = vec![0xA5_u8; 32768];
    let mut modified = body.clone();
    modified[0] = b'Z';
    let temp = setup_temp_dir();
    let (_, bytes) = apply_weave_recorded_from_body(
        &temp,
        "game.smc",
        &with_header(&body),
        &body,
        &modified,
        json!({}),
    );
    // Copier headers are not restored on output.
    assert_eq!(bytes, modified, "snes geometry and rom.checks agree");
}

#[test]
fn weave_rom_checks_on_another_n64_order_yield_to_decisive_record_structure() {
    // The IPS was made for the byte-swapped order and its records alone
    // decide that; the weave was recorded from the big-endian dump, so the
    // matched form MUST NOT override the record structure.
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    let mut z64 = vec![0x80, 0x37, 0x12, 0x40];
    z64.extend((0..8188).map(|_| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 24) as u8
    }));
    let swap_pairs = |bytes: &[u8]| -> Vec<u8> {
        bytes
            .chunks_exact(2)
            .flat_map(|pair| [pair[1], pair[0]])
            .collect()
    };
    let reverse_words = |bytes: &[u8]| -> Vec<u8> {
        bytes
            .chunks_exact(4)
            .flat_map(|word| [word[3], word[2], word[1], word[0]])
            .collect()
    };
    let v64 = swap_pairs(&z64);
    // Each record writes the byte that sits at its offset in the big-endian
    // (even records) or little-endian (odd records) order, so at either wrong
    // order the record edge matches the bytes underneath and is ruled out.
    let mut v64_modified = v64.clone();
    for (index, offset) in [
        0x200,
        0x401,
        0x602,
        0x803,
        0xA00,
        0xC01,
        0xE02,
        0x1003_usize,
    ]
    .into_iter()
    .enumerate()
    {
        let word = offset & !3;
        let source = if index % 2 == 0 {
            offset ^ 1
        } else {
            word + (offset - word + 2) % 4
        };
        assert_ne!(
            v64[source], v64[offset],
            "fixture record {offset:#x} changes a byte"
        );
        v64_modified[offset] = v64[source];
    }
    let z64_modified = swap_pairs(&v64_modified);
    let temp = setup_temp_dir();
    fs::write(temp.child("made-for.v64").path(), &v64).expect("v64 fixture");
    fs::write(temp.child("modified.v64").path(), &v64_modified).expect("modified fixture");
    create_patch_file(
        temp.child("made-for.v64").path(),
        temp.child("modified.v64").path(),
        "ips",
        temp.child("update.ips").path(),
    );
    for (rom_name, rom, expected) in [
        ("game.v64", v64.clone(), v64_modified.clone()),
        (
            "game.n64",
            reverse_words(&z64),
            reverse_words(&z64_modified),
        ),
        ("game.z64", z64.clone(), z64_modified.clone()),
    ] {
        fs::write(temp.child(rom_name).path(), &rom).expect("rom fixture");
        // Precondition: the record structure decides on its own.
        let plain = temp.child(format!("plain-{rom_name}"));
        run_json_events(
            &[
                "patch-apply",
                "--input",
                temp.child(rom_name).path().to_str().expect("path"),
                "--patch",
                temp.child("update.ips").path().to_str().expect("path"),
                "--output",
                plain.path().to_str().expect("path"),
                "--no-compress",
                "--jsonl",
            ],
            0,
        );
        assert_eq!(
            fs::read(plain.path()).expect("plain output"),
            expected,
            "record structure alone ({rom_name})"
        );
        let (terminal, bytes) = apply_weave_with_rom_checks(
            &temp,
            rom_name,
            "update.ips",
            json!({ "checksums": { "crc32": crc32_hex(&z64) }, "size": z64.len() }),
            &format!("out-{rom_name}"),
            &[],
            0,
        );
        assert_eq!(
            bytes,
            Some(expected),
            "record structure outranks rom.checks ({rom_name}): {terminal}"
        );
    }
}

#[test]
fn weave_rom_checks_on_another_n64_order_convert_for_a_patch_without_evidence() {
    let mut z64 = vec![0x80, 0x37, 0x12, 0x40];
    z64.extend((0..4092_u32).map(|index| (index % 251) as u8));
    let mut z64_modified = z64.clone();
    z64_modified[0x41] ^= 0xFF;
    let swap_pairs = |bytes: &[u8]| -> Vec<u8> {
        bytes
            .chunks_exact(2)
            .flat_map(|pair| [pair[1], pair[0]])
            .collect()
    };
    let reverse_words = |bytes: &[u8]| -> Vec<u8> {
        bytes
            .chunks_exact(4)
            .flat_map(|word| [word[3], word[2], word[1], word[0]])
            .collect()
    };
    for (rom_name, convert) in [
        ("game.v64", &swap_pairs as &dyn Fn(&[u8]) -> Vec<u8>),
        ("game.n64", &reverse_words),
    ] {
        let temp = setup_temp_dir();
        let (terminal, bytes) = apply_weave_recorded_from_body(
            &temp,
            rom_name,
            &convert(&z64),
            &z64,
            &z64_modified,
            json!({}),
        );
        assert_eq!(
            bytes,
            convert(&z64_modified),
            "n64 output bytes from rom.checks {rom_name}"
        );
        assert!(
            terminal["label"]
                .as_str()
                .expect("label")
                .contains("patch N64 byte order taken as big-endian"),
            "n64 order from rom.checks {rom_name}: {terminal}"
        );
    }
}

#[test]
fn weave_rom_checks_on_the_headerless_form_leave_patch_evidence_in_charge() {
    // The BPS proves it was made for the headered bytes, so the header stays
    // even though rom.checks describe the headerless body.
    let temp = setup_temp_dir();
    let body: Vec<u8> = (0..64_u8).collect();
    let rom = with_nes_header(&body);
    let mut modified = rom.clone();
    modified[0x20] = 0xAA;
    fs::write(temp.child("game.nes").path(), &rom).expect("rom fixture");
    fs::write(temp.child("modified.nes").path(), &modified).expect("modified fixture");
    create_patch_file(
        temp.child("game.nes").path(),
        temp.child("modified.nes").path(),
        "bps",
        temp.child("update.bps").path(),
    );
    let (terminal, bytes) = apply_weave_with_rom_checks(
        &temp,
        "game.nes",
        "update.bps",
        json!({ "checksums": { "crc32": crc32_hex(&body) }, "size": body.len() }),
        "out.nes",
        &[],
        0,
    );
    assert!(
        !terminal["label"]
            .as_str()
            .expect("label")
            .contains("taken as headerless"),
        "patch evidence decides: {terminal}"
    );
    assert_eq!(bytes, Some(modified));
}

/// Applies a `format` patch made from the supplied dump `rom` to `modified`
/// through a weave whose `rom.checks` describe another dump, `recorded`,
/// with `input_checks` on the patch entry. Returns the report label and the
/// output bytes.
fn apply_patch_for_the_supplied_dump(
    rom_name: &str,
    rom: &[u8],
    recorded: &[u8],
    modified: &[u8],
    format: &str,
    input_checks: Option<serde_json::Value>,
) -> (String, Vec<u8>) {
    let temp = setup_temp_dir();
    fs::write(temp.child(rom_name).path(), rom).expect("rom fixture");
    fs::write(temp.child("modified.bin").path(), modified).expect("modified fixture");
    let patch_name = format!("update.{format}");
    create_patch_file(
        temp.child(rom_name).path(),
        temp.child("modified.bin").path(),
        format,
        temp.child(&patch_name).path(),
    );
    let mut patch_entry = json!({ "path": patch_name });
    if let Some(input_checks) = input_checks {
        patch_entry["inputChecks"] = input_checks;
    }
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        json!({
            "version": 1,
            "rom": {
                "path": rom_name,
                "checks": { "checksums": { "crc32": crc32_hex(recorded) }, "size": recorded.len() },
            },
            "patches": [patch_entry],
        })
        .to_string(),
    )
    .expect("weave fixture");
    let output = temp.child(format!("out-{rom_name}"));
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    let terminal = events.last().expect("terminal");
    let emitted = terminal["details"]["emitted_files"][0]["path"]
        .as_str()
        .expect("emitted output path");
    (
        terminal["label"].as_str().expect("label").to_owned(),
        fs::read(emitted).expect("output"),
    )
}

/// Each patch was made for the supplied dump itself and says so, through
/// its declared inputChecks (IPS) or the RUP source MD5, so the form that
/// rom.checks matched MUST NOT change the layout. Runs the `only_format` cases.
fn assert_patch_evidence_keeps_the_layout(only_format: &str) {
    let body: Vec<u8> = (0..64_u8).collect();
    let nes = with_nes_header(&body);
    let mut nes_modified = nes.clone();
    nes_modified[0x20] = 0xAA;
    let mut z64 = vec![0x80, 0x37, 0x12, 0x40];
    z64.extend((0..4092_u32).map(|index| (index % 251) as u8));
    let v64: Vec<u8> = z64
        .chunks_exact(2)
        .flat_map(|pair| [pair[1], pair[0]])
        .collect();
    let mut v64_modified = v64.clone();
    v64_modified[0x41] ^= 0xFF;
    let md5_checks =
        |bytes: &[u8]| json!({ "checksums": { "md5": md5_hex(bytes) }, "size": bytes.len() });
    for (case, rom_name, rom, recorded, modified, format, input_checks) in [
        (
            "nes inputChecks",
            "game.nes",
            &nes,
            &body,
            &nes_modified,
            "ips",
            Some(md5_checks(&nes)),
        ),
        (
            "nes rup",
            "game.nes",
            &nes,
            &body,
            &nes_modified,
            "rup",
            None,
        ),
        (
            "n64 inputChecks",
            "game.v64",
            &v64,
            &z64,
            &v64_modified,
            "ips",
            Some(md5_checks(&v64)),
        ),
        (
            "n64 rup",
            "game.v64",
            &v64,
            &z64,
            &v64_modified,
            "rup",
            None,
        ),
    ] {
        if format != only_format {
            continue;
        }
        let (label, bytes) = apply_patch_for_the_supplied_dump(
            rom_name,
            rom,
            recorded,
            modified,
            format,
            input_checks,
        );
        assert_eq!(
            &bytes, modified,
            "patch evidence keeps the layout ({case}): {label}"
        );
        assert!(
            !label.contains("taken as headerless") && !label.contains("taken as big-endian"),
            "patch evidence keeps the layout ({case}): {label}"
        );
    }
}

#[test]
fn weave_rom_checks_on_another_form_yield_to_the_patch_input_checks() {
    assert_patch_evidence_keeps_the_layout("ips");
}

#[test]
fn weave_rom_checks_on_another_form_yield_to_an_embedded_source_md5() {
    assert_patch_evidence_keeps_the_layout("rup");
}

fn assert_weave_n64_own_checks(format: &str, checksums: Option<serde_json::Value>, succeeds: bool) {
    let temp = setup_temp_dir();
    let home = temp.child("home");
    fs::create_dir(home.path()).expect("isolated home");
    let home = home.path().to_str().expect("home path");
    let envs = [
        ("HOME", home),
        ("XDG_CONFIG_HOME", home),
        ("XDG_CACHE_HOME", home),
        ("XDG_STATE_HOME", home),
    ];
    let mut z64 = vec![0x80, 0x37, 0x12, 0x40];
    z64.extend((0..4092_u32).map(|index| (index % 251) as u8));
    let swap = |bytes: &[u8]| {
        bytes
            .chunks_exact(2)
            .flat_map(|pair| [pair[1], pair[0]])
            .collect::<Vec<_>>()
    };
    let mut modified = z64.clone();
    modified[0x40] ^= 0xFF;
    fs::write(temp.child("base.z64").path(), &z64).expect("base");
    fs::write(temp.child("modified.z64").path(), &modified).expect("modified");
    fs::write(temp.child("source.v64").path(), swap(&z64)).expect("input");
    let patch_name = format!("update.{format}");
    command_stdout_with_env(
        &[
            "patch",
            "create",
            "--original",
            temp.child("base.z64").path().to_str().expect("path"),
            "--modified",
            temp.child("modified.z64").path().to_str().expect("path"),
            "--format",
            format,
            "--output",
            temp.child(&patch_name).path().to_str().expect("path"),
        ],
        &envs,
        0,
    );
    let mut patch = json!({ "path": patch_name });
    if let Some(checksums) = checksums {
        patch["inputChecks"] = json!({ "checksums": checksums });
    }
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(weave.path(), json!({
        "version": 1,
        "rom": { "path": "source.v64", "checks": { "checksums": { "crc32": crc32_hex(&z64) }, "size": z64.len() } },
        "patches": [patch]
    }).to_string()).expect("weave");
    let output = temp.child("out.v64");
    let events = run_json_events_with_env(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        &envs,
        if succeeds { 0 } else { 1 },
    );
    let terminal = events.last().expect("terminal");
    if succeeds {
        assert_eq!(
            fs::read(output.path()).expect("output"),
            swap(&modified),
            "own N64 checksum selects authored bytes: {terminal}"
        );
    } else {
        assert_eq!(
            terminal["status"], "failed",
            "conflicting checks MUST fail: {terminal}"
        );
        assert!(
            !output.path().exists(),
            "failed checks MUST NOT publish output"
        );
    }
}

#[test]
fn weave_n64_embedded_md5_selects_authored_order() {
    for format in ["rup", "solid"] {
        assert_weave_n64_own_checks(format, None, true);
    }
}

#[test]
fn weave_n64_declared_checks_select_authored_order() {
    for checks in [
        json!({ "md5": "b1e201554177068604830c335c3a0568" }),
        json!({ "sha1": "ace0c16a44d8fe6493ad43c724d7d2f05559a1c6" }),
        json!({ "md5": "b1e201554177068604830c335c3a0568", "sha1": "ace0c16a44d8fe6493ad43c724d7d2f05559a1c6" }),
    ] {
        assert_weave_n64_own_checks("ips", Some(checks), true);
    }
}

#[test]
fn weave_n64_conflicting_or_unmatched_checks_reject_input() {
    for checks in [
        json!({ "md5": "00000000000000000000000000000000" }),
        json!({ "sha1": "0000000000000000000000000000000000000000" }),
        json!({ "md5": "b1e201554177068604830c335c3a0568", "sha1": "0000000000000000000000000000000000000000" }),
        json!({ "md5": "00000000000000000000000000000000", "sha1": "ace0c16a44d8fe6493ad43c724d7d2f05559a1c6" }),
        json!({ "md5": "b1e201554177068604830c335c3a0568", "sha1": "e8e83dec7c9fb3d584cb433f1951895bcf3b7901" }),
        json!({ "md5": "b449b8806ba1157996362c697ee2df5a", "sha1": "ace0c16a44d8fe6493ad43c724d7d2f05559a1c6" }),
    ] {
        assert_weave_n64_own_checks("ips", Some(checks), false);
    }
}

#[test]
fn weave_apply_rejects_disabled_named_patch_input_producer() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "a.ips", 0, 0xAA);
    write_offset_ips(&temp, "c.ips", 2, 0xCC);
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        r#"{ "version": 2, "patchBasis": "previous", "patches": [
            { "id": "a", "path": "a.ips", "optional": true, "input": { "rom": true } },
            { "id": "c", "path": "c.ips", "input": { "patch": "a" } }
        ] }"#,
    )
    .expect("weave fixture");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    assert!(
        events.last().expect("terminal")["label"]
            .as_str()
            .expect("label")
            .contains("bundle.patch.input.patch.unavailable")
    );
}

#[test]
fn weave_create_keeps_implicit_chain_inputs_implicit_across_optional_steps() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let a = write_offset_ips(&temp, "a.ips", 0, 0xAA);
    let b = write_offset_ips(&temp, "b.ips", 1, 0xBB);
    let c = write_offset_ips(&temp, "c.ips", 2, 0xCC);
    let weave = temp.child("rom-weaver-weave.json");
    run_json_events(
        &[
            "weave",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--patch",
            a.to_str().expect("path"),
            "--patch-id",
            "a",
            "--patch",
            b.to_str().expect("path"),
            "--patch-id",
            "b",
            "--patch-optional",
            "true",
            "--patch",
            c.to_str().expect("path"),
            "--patch-id",
            "c",
            "--output",
            weave.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let parsed = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            weave.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let recipe = &parsed.last().expect("terminal")["details"]["weave"]["weave"];
    assert!(
        recipe["patches"]
            .as_array()
            .expect("patches")
            .iter()
            .all(|patch| patch.get("input").is_none())
    );
    let output = temp.child("out.bin");
    run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(
        fs::read(output.path()).expect("output"),
        patched_rom_bytes(&[(0, 0xAA), (2, 0xCC)])
    );
}

#[test]
fn weave_input_checks_block_conflicting_embedded_base_inference() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let mid = temp.child("mid.bin");
    let mut mid_bytes = WEAVE_ROM_BYTES.to_vec();
    mid_bytes[0] = 0xAA;
    fs::write(mid.path(), &mid_bytes).expect("mid fixture");
    let target = temp.child("target.bin");
    let mut target_bytes = WEAVE_ROM_BYTES.to_vec();
    target_bytes[1] = 0xBB;
    fs::write(target.path(), target_bytes).expect("target fixture");
    let first_patch = temp.child("first.bps");
    let second_patch = temp.child("second.bps");
    for (modified, patch) in [(&mid, &first_patch), (&target, &second_patch)] {
        command_stdout(
            &[
                "patch",
                "create",
                "--original",
                rom.to_str().expect("path"),
                "--modified",
                modified.path().to_str().expect("path"),
                "--format",
                "bps",
                "--output",
                patch.path().to_str().expect("path"),
                "--json",
            ],
            0,
        );
    }

    fs::write(
        temp.child("rom-weaver-weave.json").path(),
        format!(
            r#"{{
                "version": 1,
                "rom": {{ "path": "game.bin" }},
                "patches": [
                    {{ "path": "first.bps" }},
                    {{ "path": "second.bps", "inputChecks": {{ "checksums": {{ "crc32": "{}" }} }} }}
                ],
                "output": {{ "name": "out.bin" }}
            }}"#,
            crc32_hex(&mid_bytes)
        ),
    )
    .expect("weave fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("Input checksum invalid"),
        "unexpected failure: {terminal}"
    );

    // When the unbased declaration agrees with the embedded base endpoint,
    // Base inference is valid but must not stand down the declaration's
    // intermediate-state gate.
    fs::write(
        temp.child("rom-weaver-weave.json").path(),
        format!(
            r#"{{
                "version": 1,
                "rom": {{ "path": "game.bin" }},
                "patches": [
                    {{ "path": "first.bps" }},
                    {{ "path": "second.bps", "inputChecks": {{ "checksums": {{ "crc32": "{}" }} }} }}
                ],
                "output": {{ "name": "out.bin" }}
            }}"#,
            crc32_hex(WEAVE_ROM_BYTES)
        ),
    )
    .expect("weave fixture");
    let inferred_base = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            temp.child("inferred-base-out.bin")
                .path()
                .to_str()
                .expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    let terminal = inferred_base.last().expect("terminal event");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("patch.chain.input_mismatch"),
        "unexpected inferred-base failure: {terminal}"
    );
}

#[test]
fn weave_apply_base_basis_verifies_declared_checks_against_the_rom() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    let rom_crc = crc32_hex(WEAVE_ROM_BYTES);
    let out = temp.child("out.bin");

    // The second entry's declared input state IS the base ROM. Left to the
    // default previous basis, that check runs against the intermediate and
    // fails; declared as base it verifies against the ROM once and the chain
    // succeeds with the step's state checks stood down.
    let write_weave = |basis_field: &str, input_crc: &str| {
        fs::write(
            temp.child("rom-weaver-weave.json").path(),
            format!(
                r#"{{
                    "version": 1,
                    "rom": {{ "path": "game.bin" }},
                    "patches": [
                        {{ "path": "main.ips" }},
                        {{ "path": "extra.ips"{basis_field}, "inputChecks": {{ "checksums": {{ "crc32": "{input_crc}" }} }} }}
                    ],
                    "output": {{ "name": "out.bin" }}
                }}"#
            ),
        )
        .expect("weave fixture");
    };

    write_weave("", &rom_crc);
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            out.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    assert!(
        events.last().expect("terminal")["label"]
            .as_str()
            .expect("label")
            .contains("patch.chain.input_mismatch")
    );

    write_weave(r#", "basis": "base""#, &rom_crc);
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            out.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(out.path()).expect("output"),
        patched_rom_bytes(&[(0, 0xAA), (1, 0xBB)])
    );

    // A declared base check remains mandatory even when it is the only
    // whole-file evidence for this checksumless patch.
    write_weave(r#", "basis": "base""#, "00000000");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            out.path().to_str().expect("path"),
            // The successful run above wrote this output; patch apply now
            // refuses to overwrite without --force.
            "--force",
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    assert!(
        events.last().expect("terminal")["label"]
            .as_str()
            .expect("label")
            .contains("patch.base.input_mismatch")
    );
}

#[test]
fn weave_first_patch_declared_base_checksum_and_size_match_a_headered_rom() {
    let temp = setup_temp_dir();
    let body: Vec<u8> = (0..64_u8).collect();
    let rom = with_nes_header(&body);
    fs::write(temp.child("game.nes").path(), &rom).expect("rom fixture");
    write_offset_ips(&temp, "main.ips", 0x20, 0xAA);
    let weave = temp.child("rom-weaver-weave.json");

    // The first patch's checks MUST verify against a hashed base variant;
    // a size alone matches one variant while the other variant's size
    // conflicts, so the checksum is what decides the verdict.
    let apply = |input_checks: serde_json::Value, output: &str, expected_code: i32| {
        let entry = json!({ "path": "main.ips", "basis": "base", "inputChecks": input_checks });
        fs::write(
            weave.path(),
            json!({
                "version": 1,
                "rom": { "path": "game.nes" },
                "patches": [entry],
                "output": { "name": "out.nes" }
            })
            .to_string(),
        )
        .expect("weave fixture");
        let output = temp.child(output);
        let events = run_json_events(
            &[
                "patch-apply",
                "--input",
                weave.path().to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--no-compress",
                "--jsonl",
            ],
            expected_code,
        );
        let terminal = events.last().expect("terminal").clone();
        (terminal, fs::read(output.path()).ok())
    };

    let mut headered_expected = rom.clone();
    headered_expected[0x20] = 0xAA;
    let (headered, headered_bytes) = apply(
        json!({ "checksums": { "crc32": crc32_hex(&rom) }, "size": rom.len() }),
        "headered.nes",
        0,
    );
    assert_eq!(headered["status"], "succeeded", "headered: {headered}");
    assert_eq!(headered_bytes, Some(headered_expected));

    // Headerless checks select the stripped base, so the patch offset lands
    // inside the body and the header is kept on output.
    let mut patched_body = body.clone();
    patched_body[0x20] = 0xAA;
    let (headerless, headerless_bytes) = apply(
        json!({ "checksums": { "crc32": crc32_hex(&body) }, "size": body.len() }),
        "headerless.nes",
        0,
    );
    assert_eq!(
        headerless["status"], "succeeded",
        "headerless: {headerless}"
    );
    assert_eq!(headerless_bytes, Some(with_nes_header(&patched_body)));

    let (mismatch, mismatch_bytes) = apply(
        json!({ "checksums": { "crc32": "00000000" }, "size": rom.len() }),
        "mismatch.nes",
        1,
    );
    assert!(
        mismatch["label"]
            .as_str()
            .expect("label")
            .contains("input checksum mismatch for crc32"),
        "mismatch: {mismatch}"
    );
    assert_eq!(mismatch_bytes, None);
}

#[test]
fn weave_declared_base_conflict_is_rejected_and_cli_auto_clears_the_declaration() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let mid = temp.child("mid.bin");
    let mut mid_bytes = WEAVE_ROM_BYTES.to_vec();
    mid_bytes[4] = 0xAA;
    fs::write(mid.path(), &mid_bytes).expect("mid fixture");
    let target = temp.child("target.bin");
    let mut target_bytes = mid_bytes.clone();
    target_bytes[12] = 0xBB;
    fs::write(target.path(), &target_bytes).expect("target fixture");
    let first_patch = temp.child("first.bps");
    let second_patch = temp.child("second.bps");
    create_patch_file(rom.as_path(), mid.path(), "bps", first_patch.path());
    create_patch_file(mid.path(), target.path(), "bps", second_patch.path());
    let weave = temp.child("rom-weaver-weave.json");

    // A weave declaration may add evidence, but it cannot turn a patch whose
    // embedded source is the intermediate into a Base-authored patch.
    fs::write(
        weave.path(),
        format!(
            r#"{{
                "version": 1,
                "rom": {{ "path": "game.bin" }},
                "patches": [
                    {{ "path": "first.bps" }},
                    {{
                        "path": "second.bps",
                        "basis": "base",
                        "inputChecks": {{ "checksums": {{ "crc32": "{}" }} }}
                    }}
                ],
                "output": {{ "name": "out.bin" }}
            }}"#,
            crc32_hex(WEAVE_ROM_BYTES)
        ),
    )
    .expect("weave fixture");
    let conflict = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            temp.child("conflict.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    let terminal = conflict.last().expect("terminal");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("patch.base.input_mismatch"),
        "unexpected conflict: {terminal}"
    );

    // With only the stale basis declaration left, an explicit Auto clears the
    // weave pin and lets the embedded endpoints recover the real chain.
    fs::write(
        weave.path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [
                { "path": "first.bps" },
                { "path": "second.bps", "basis": "base" }
            ],
            "output": { "name": "out.bin" }
        }"#,
    )
    .expect("weave fixture");
    let stale = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            temp.child("stale.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    assert!(
        stale.last().expect("terminal")["label"]
            .as_str()
            .expect("label")
            .contains("patch.base.input_mismatch")
    );

    let output = temp.child("auto.bin");
    let automatic = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--default-patch-basis",
            "auto",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(automatic.last().expect("terminal")["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), target_bytes);
}

#[test]
fn weave_v2_patch_basis_precedence_is_patch_cli_shared_entry_then_weave() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let mid = temp.child("mid.bin");
    let mut mid_bytes = WEAVE_ROM_BYTES.to_vec();
    mid_bytes[4] = 0xAA;
    fs::write(mid.path(), &mid_bytes).expect("mid fixture");
    let target = temp.child("target.bin");
    let mut target_bytes = mid_bytes.clone();
    target_bytes[12] = 0xBB;
    fs::write(target.path(), &target_bytes).expect("target fixture");
    let first_patch = temp.child("first.bps");
    let second_patch = temp.child("second.bps");
    create_patch_file(rom.as_path(), mid.path(), "bps", first_patch.path());
    create_patch_file(mid.path(), target.path(), "bps", second_patch.path());
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        r#"{
            "version": 2,
            "patchBasis": "base",
            "rom": { "path": "game.bin" },
            "patches": [
                { "path": "first.bps" },
                { "path": "second.bps", "basis": "previous" }
            ]
        }"#,
    )
    .expect("weave fixture");

    let entry_override = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            temp.child("entry.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(
        entry_override.last().expect("terminal")["status"],
        "succeeded"
    );

    let shared_override = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--default-patch-basis",
            "base",
            "--output",
            temp.child("shared.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    assert!(
        shared_override.last().expect("terminal")["label"]
            .as_str()
            .expect("label")
            .contains("patch.base.input_mismatch")
    );

    let patch_override = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--default-patch-basis",
            "base",
            "--patch-basis",
            "base",
            "--patch-basis",
            "auto",
            "--output",
            temp.child("patch.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(
        patch_override.last().expect("terminal")["status"],
        "succeeded"
    );
    assert_eq!(
        fs::read(temp.child("patch.bin").path()).expect("output"),
        target_bytes
    );
}

#[test]
fn patch_apply_emit_weave_preserves_per_patch_basis_overrides() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let mid = temp.child("mid.bin");
    let mut mid_bytes = WEAVE_ROM_BYTES.to_vec();
    mid_bytes[4] = 0xAA;
    fs::write(mid.path(), &mid_bytes).expect("mid fixture");
    let target = temp.child("target.bin");
    let mut target_bytes = mid_bytes.clone();
    target_bytes[12] = 0xBB;
    fs::write(target.path(), &target_bytes).expect("target fixture");
    let first_patch = temp.child("first.bps");
    let second_patch = temp.child("second.bps");
    create_patch_file(rom.as_path(), mid.path(), "bps", first_patch.path());
    create_patch_file(mid.path(), target.path(), "bps", second_patch.path());
    let source_weave = temp.child("source-weave.json");
    fs::write(
        source_weave.path(),
        r#"{
            "version": 2,
            "patchBasis": "base",
            "rom": { "path": "game.bin" },
            "patches": [
                { "path": "first.bps" },
                { "path": "second.bps", "basis": "previous" }
            ]
        }"#,
    )
    .expect("weave fixture");

    let emitted = temp.child("emitted-weave.json");
    let output = temp.child("output.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            source_weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--emit-weave",
            emitted.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    let terminal = events
        .iter()
        .find(|event| event["command"] == "patch-apply" && event["status"] != "running")
        .expect("patch-apply terminal");
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), target_bytes);

    let emitted_json: Value = serde_json::from_slice(&fs::read(emitted.path()).expect("weave"))
        .expect("valid emitted weave");
    assert_eq!(emitted_json["patchBasis"], "base");
    assert_eq!(emitted_json["patches"][1]["basis"], "previous");

    let replay_output = temp.child("replay.bin");
    let replay = run_json_events(
        &[
            "patch-apply",
            "--input",
            emitted.path().to_str().expect("path"),
            "--output",
            replay_output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(replay.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(replay_output.path()).expect("replay"),
        target_bytes
    );
}

#[test]
fn patch_apply_emit_weave_records_inferred_bases_with_cheat_codes() {
    let temp = setup_temp_dir();
    let base = with_nes_header(&vec![0_u8; 0x8000]);
    let rom = temp.child("game.nes");
    fs::write(rom.path(), &base).expect("rom fixture");
    let mut mid_bytes = base.clone();
    mid_bytes[0x100] = 0xAA;
    let mid = temp.child("mid.nes");
    fs::write(mid.path(), &mid_bytes).expect("mid fixture");
    let mut target_bytes = mid_bytes.clone();
    target_bytes[0x200] = 0xBB;
    let target = temp.child("target.nes");
    fs::write(target.path(), &target_bytes).expect("target fixture");
    let first_patch = temp.child("first.bps");
    let second_patch = temp.child("second.bps");
    create_patch_file(rom.path(), mid.path(), "bps", first_patch.path());
    create_patch_file(mid.path(), target.path(), "bps", second_patch.path());

    let emitted = temp.child("emitted-weave.json");
    let output = temp.child("output.nes");
    run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.path().to_str().expect("path"),
            "--patch",
            first_patch.path().to_str().expect("path"),
            "--patch",
            second_patch.path().to_str().expect("path"),
            "--code",
            "AKE-LVS",
            "--output",
            output.path().to_str().expect("path"),
            "--emit-weave",
            emitted.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );

    let emitted_json: Value = serde_json::from_slice(&fs::read(emitted.path()).expect("weave"))
        .expect("valid emitted weave");
    assert_eq!(emitted_json["patches"][0]["basis"], "base");
    assert_eq!(emitted_json["patches"][1]["basis"], "previous");
}

#[test]
fn weave_ignore_mode_does_not_use_stale_output_checks_to_select_rup_direction() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "first.ips", 4, 0xAA);
    let mid = temp.child("mid.bin");
    let mid_bytes = patched_rom_bytes(&[(4, 0xAA)]);
    fs::write(mid.path(), &mid_bytes).expect("mid fixture");
    let target = temp.child("target.bin");
    let mut target_bytes = mid_bytes[..12].to_vec();
    target_bytes[8] = 0xBB;
    fs::write(target.path(), &target_bytes).expect("target fixture");
    let second_patch = temp.child("second.rup");
    create_patch_file(mid.path(), target.path(), "rup", second_patch.path());
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        format!(
            r#"{{
                "version": 1,
                "rom": {{ "path": "game.bin" }},
                "patches": [
                    {{
                        "path": "first.ips",
                        "outputChecks": {{
                            "checksums": {{ "md5": "{}" }},
                            "size": {}
                        }}
                    }},
                    {{ "path": "second.rup" }}
                ],
                "output": {{ "name": "out.bin" }}
            }}"#,
            md5_hex(&target_bytes),
            target_bytes.len()
        ),
    )
    .expect("weave fixture");

    let output = temp.child("out.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--ignore-checksum-validation",
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), target_bytes);
}

/// `--patch-input-check`/`--patch-output-check` are the canonical spellings on
/// `weave create`; the old `--patch-expect-in`/`--patch-expect-out` keep working
/// as hidden aliases and produce the same weave.
#[test]
fn weave_create_legacy_patch_expect_spellings_match_the_canonical_flags() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let mut weaves = Vec::new();
    for (name, input_flag, output_flag) in [
        ("canonical", "--patch-input-check", "--patch-output-check"),
        ("legacy", "--patch-expect-in", "--patch-expect-out"),
    ] {
        let weave_out = temp.child(format!("{name}.json"));
        run_json_events(
            &[
                "weave",
                "create",
                "--patch",
                main.to_str().expect("path"),
                input_flag,
                "crc32=00000000",
                output_flag,
                "crc32=11111111",
                "--output",
                weave_out.path().to_str().expect("path"),
                "--jsonl",
            ],
            0,
        );
        weaves.push(fs::read_to_string(weave_out.path()).expect("weave"));
    }
    assert_eq!(weaves[0], weaves[1]);
    assert!(weaves[0].contains("11111111"), "{}", weaves[0]);

    let help = String::from_utf8(command_stdout(&["weave", "create", "--help"], 0)).expect("utf8");
    assert!(help.contains("--patch-input-check"), "{help}");
    assert!(help.contains("--patch-output-check"), "{help}");
    assert!(!help.contains("patch-expect"), "{help}");
}

#[test]
fn weave_create_dedups_endpoint_checks_and_apply_validates_output() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let extra = write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    let weave_out = temp.child("rom-weaver-weave.json");
    let rom_crc = crc32_hex(WEAVE_ROM_BYTES);
    let mid_crc = crc32_hex(&patched_rom_bytes(&[(0, 0xAA)]));
    let final_crc = crc32_hex(&patched_rom_bytes(&[(0, 0xAA), (1, 0xBB)]));

    run_json_events(
        &[
            "weave",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--patch",
            main.to_str().expect("path"),
            "--patch-input-check",
            &format!("crc32={rom_crc}"),
            "--patch-output-check",
            &format!("crc32={mid_crc}"),
            "--patch",
            extra.to_str().expect("path"),
            "--patch-input-check",
            &format!("crc32={mid_crc}"),
            "--patch-output-check",
            &format!("crc32={final_crc}"),
            "--default-patch-basis",
            "previous",
            "--expect-out",
            &format!("crc32={final_crc}"),
            "--output",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let parsed = &events.last().expect("terminal")["details"]["weave"]["weave"];
    // Endpoint checks live on rom/output; only mid-chain states stay on the
    // patches (first input == rom.checks, last output == output.checks, so
    // output.checksRef names the last patch's output state).
    assert_eq!(parsed["output"]["checksRef"], "patch:1:output");
    assert_eq!(
        weave_check_state(parsed, "patch:1:output")["checks"]["checksums"]["crc32"],
        final_crc
    );
    let first = &parsed["patches"][0];
    assert!(
        first.get("inputChecks").is_none(),
        "first patch relies on rom.checks: {first}"
    );
    assert_eq!(first["outputChecksRef"], "patch:0:output");
    assert_eq!(
        weave_check_state(parsed, "patch:0:output")["checks"]["checksums"]["crc32"],
        mid_crc
    );
    let second = &parsed["patches"][1];
    assert_eq!(second["inputChecksRef"], "patch:1:input");
    assert!(
        second.get("outputChecks").is_none(),
        "last patch's output is output.checks: {second}"
    );
    assert_eq!(second["outputChecksRef"], "patch:1:output");

    // Applying the full chain validates the final output against
    // output.checks and succeeds.
    let output = temp.child("patched.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA), (1, 0xBB)])
    );

    // A partial selection validates against ITS last patch's outputChecks...
    let partial_weave = fs::read_to_string(weave_out.path())
        .expect("weave readable")
        .replace(
            &format!("\"crc32\": \"{mid_crc}\""),
            "\"crc32\": \"00000000\"",
        );
    // ...so corrupting the first patch's recorded outputChecks fails a
    // main-only apply with the recorded (wrong) expectation.
    fs::write(temp.child("rom-weaver-weave.json").path(), partial_weave).expect("weave rewrite");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--without",
            "extra*",
            "--output",
            temp.child("partial.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("label");
    assert!(
        label.contains("00000000"),
        "expected output checksum mismatch in label: {label}"
    );
}

#[test]
fn weave_apply_partial_chain_skips_full_chain_output_checks() {
    // output.checks records the FULL chain's result. A partial selection that
    // happens to end on the final entry (earlier patches skipped) produces a
    // different, legitimate output and must not be gated by it.
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    fs::write(
        temp.child("rom-weaver-weave.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [
                { "name": "main", "path": "main.ips" },
                { "name": "extra", "optional": true, "path": "extra.ips" }
            ],
            "output": { "checks": { "checksums": { "crc32": "00000000" } } }
        }"#,
    )
    .expect("weave fixture");
    let output = temp.child("partial.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--with",
            "extra",
            "--without",
            "main",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(1, 0xBB)])
    );
}

#[test]
fn weave_apply_non_prefix_selection_skips_entry_output_checks() {
    // A patch entry's outputChecks describe the state after applying the chain
    // UP TO it. A selection that skips an earlier optional but still ends on
    // that entry produces a different, legitimate result - the recorded hash
    // must not gate it. The same hash MUST gate the true prefix selection.
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    write_offset_ips(&temp, "final.ips", 2, 0xCC);
    fs::write(
        temp.child("rom-weaver-weave.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [
                { "name": "main", "path": "main.ips" },
                { "name": "extra", "optional": true, "path": "extra.ips" },
                {
                    "name": "final",
                    "path": "final.ips",
                    "outputChecks": { "checksums": { "crc32": "00000000" } }
                }
            ]
        }"#,
    )
    .expect("weave fixture");

    // Skipping the middle optional: {main, final} is not the chain prefix
    // ending at `final`, so its (deliberately wrong) outputChecks stand down.
    let output = temp.child("skip-middle.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA), (2, 0xCC)])
    );

    // The full chain IS the prefix ending at `final`: the recorded (wrong)
    // outputChecks now gate the run and fail it.
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--with",
            "extra",
            "--output",
            temp.child("full-chain.bin").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("label");
    assert!(
        label.contains("00000000"),
        "expected output checksum mismatch in label: {label}"
    );
}

#[test]
fn weave_create_source_url_emits_url_entry() {
    let temp = setup_temp_dir();
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let weave_out = temp.child("rom-weaver-weave.json");

    run_json_events(
        &[
            "weave",
            "create",
            "--patch",
            main.to_str().expect("path"),
            "--patch-source-url",
            "https://example.test/patches/main.ips",
            "--output",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            weave_out.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let entry = &events.last().expect("terminal")["details"]["weave"]["weave"]["patches"][0];
    assert_eq!(entry["url"], "https://example.test/patches/main.ips");
    assert!(entry["path"].is_null());
}

#[test]
fn weave_target_chains_follow_optional_selection_after_create() {
    let temp = setup_temp_dir();
    let first = write_weave_rom(&temp, "first.bin");
    let second = temp.child("second.bin");
    let second_bytes = vec![0x77; WEAVE_ROM_BYTES.len()];
    fs::write(second.path(), &second_bytes).expect("second source");
    let archive = temp.child("roms.tar.gz");
    write_tar_gz_fixture(
        &[(&first, "first.bin"), (second.path(), "second.bin")],
        archive.path(),
    );
    for (name, offset, value) in [
        ("a.ips", 0, 0xAA),
        ("b.ips", 1, 0xBB),
        ("c.ips", 2, 0xCC),
        ("d.ips", 3, 0xDD),
    ] {
        write_offset_ips(&temp, name, offset, value);
    }
    let spec = temp.child("spec.json");
    fs::write(spec.path(), r#"{
        "version": 2, "patchBasis": "auto",
        "rom": { "path": "roms.tar.gz", "member": "first.bin" },
        "patches": [
            { "id": "a", "path": "a.ips", "target": { "rom": true, "member": "first.bin" } },
            { "id": "b", "path": "b.ips", "optional": true, "target": { "rom": true, "member": "first.bin" } },
            { "id": "d", "path": "d.ips", "target": { "rom": true, "member": "second.bin" } },
            { "id": "c", "path": "c.ips", "target": { "rom": true, "member": "first.bin" } }
        ]
    }"#).expect("spec");
    let weave = temp.child("rom-weaver-weave.json");
    command_stdout(
        &[
            "weave",
            "create",
            "--from",
            spec.path().to_str().expect("path"),
            "--output",
            weave.path().to_str().expect("path"),
        ],
        0,
    );
    let created: serde_json::Value =
        serde_json::from_slice(&fs::read(weave.path()).expect("weave")).expect("JSON");
    assert_eq!(created["patches"][3]["target"]["member"], "first.bin");
    assert!(created["patches"][3].get("input").is_none());
    for (option, edits) in [
        ("--with", vec![(0, 0xAA), (1, 0xBB), (2, 0xCC)]),
        ("--without", vec![(0, 0xAA), (2, 0xCC)]),
    ] {
        let output = temp.child(format!("{option}.bin"));
        run_json_events(
            &[
                "patch",
                "apply",
                "--input",
                archive.path().to_str().expect("path"),
                "--weave",
                weave.path().to_str().expect("path"),
                option,
                "b.ips",
                "--output",
                output.path().to_str().expect("path"),
                "--no-compress",
                "--jsonl",
            ],
            0,
        );
        assert_eq!(
            fs::read(output.path()).expect("output"),
            patched_rom_bytes(&edits),
            "{option} must select the cumulative first-member chain"
        );
    }
}

#[test]
fn weave_patch_target_member_accepts_the_bare_member_file() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "romA.bin");
    let archive = temp.child("romA_archive.tar.gz");
    write_tar_gz_fixture(&[(&rom, "romA.bin")], archive.path());
    write_offset_ips(&temp, "a.ips", 0, 0xAA);
    let weave = temp.child("weave.json");
    fs::write(
        weave.path(),
        r#"{"version":2,"patchBasis":"auto","patches":[
            {"id":"a","path":"a.ips","target":{"rom":true,"member":"romA.bin"}}]}"#,
    )
    .expect("weave");
    let apply = |input: &Path, name: &str, expected_code: i32| {
        let output = temp.child(name);
        let events = run_json_events(
            &[
                "patch",
                "apply",
                "--input",
                input.to_str().expect("path"),
                "--weave",
                weave.path().to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--no-compress",
                "--jsonl",
            ],
            expected_code,
        );
        (output, events)
    };
    let (from_archive, _) = apply(archive.path(), "from-archive.bin", 0);
    let (from_bare, _) = apply(rom.as_path(), "from-bare.bin", 0);
    assert_eq!(
        fs::read(from_bare.path()).expect("bare output"),
        fs::read(from_archive.path()).expect("archive output"),
        "the bare member file must produce the archive path's bytes"
    );
    assert_eq!(
        fs::read(from_bare.path()).expect("bare output"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
    // A bare file whose name and checks both differ still fails clearly.
    let other = temp.child("other.bin");
    fs::write(other.path(), WEAVE_ROM_BYTES).expect("other");
    let (_, events) = apply(other.path(), "from-other.bin", 1);
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal
            .to_string()
            .contains("neither its file name nor its checks match"),
        "unexpected failure: {terminal}"
    );
}

/// Applies `weave_json` to the bare `input` file and returns the terminal event.
fn apply_weave_to_bare_input(
    temp: &TempDir,
    input: &Path,
    weave_json: &str,
    expected_code: i32,
) -> (PathBuf, serde_json::Value) {
    let weave = temp.child("bare-weave.json");
    fs::write(weave.path(), weave_json).expect("weave");
    let output = temp.child("bare-out.bin");
    let events = run_json_events(
        &[
            "patch",
            "apply",
            "--input",
            input.to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        expected_code,
    );
    (
        output.path().to_path_buf(),
        events.last().expect("terminal").clone(),
    )
}

#[test]
fn weave_bare_file_with_a_zero_first_block_is_not_read_as_an_empty_tar() {
    let temp = setup_temp_dir();
    // An all-zero first 512 bytes reads as an empty tar archive to libarchive,
    // but the file has no tar-family extension, so it is a bare member.
    let rom = temp.child("track02.bin");
    let mut bytes = vec![0_u8; 1024];
    bytes.extend_from_slice(b"payload bytes");
    fs::write(rom.path(), &bytes).expect("rom");
    write_offset_ips(&temp, "a.ips", 0, 0xAA);
    let weave = r#"{"version":2,"patchBasis":"auto","patches":[
        {"id":"a","path":"a.ips","target":{"rom":true,"member":"disc/track02.bin"}}]}"#;
    let (output, _) = apply_weave_to_bare_input(&temp, rom.path(), weave, 0);
    let mut expected = bytes;
    expected[0] = 0xAA;
    assert_eq!(fs::read(output).expect("output"), expected);
}

#[test]
fn weave_member_is_extracted_from_a_tar_with_a_non_tar_name() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "romA.bin");
    // A `rom.url` with no usable name downloads to `weave-download.bin`, so a
    // plain tar can arrive under a name no tar handler claims.
    let archive = temp.child("archive.dat");
    let mut builder = tar::Builder::new(File::create(archive.path()).expect("create tar"));
    builder
        .append_path_with_name(&rom, "romA.bin")
        .expect("append entry");
    builder.finish().expect("finish tar");
    drop(builder);
    write_offset_ips(&temp, "a.ips", 0, 0xAA);
    let weave = r#"{"version":2,"patchBasis":"auto","patches":[
        {"id":"a","path":"a.ips","target":{"rom":true,"member":"romA.bin"}}]}"#;
    let (output, _) = apply_weave_to_bare_input(&temp, archive.path(), weave, 0);
    assert_eq!(
        fs::read(output).expect("output"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn weave_rom_checks_do_not_bind_the_bare_file_to_another_member() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "romA.bin");
    write_offset_ips(&temp, "a.ips", 0, 0xAA);
    write_offset_ips(&temp, "b.ips", 1, 0xBB);
    let crc = crc32_hex(WEAVE_ROM_BYTES);
    // `rom.checks` describes `rom.member` (romA.bin); it must not make the same
    // bare file stand in for the other member romB.bin.
    let weave = format!(
        r#"{{"version":2,"patchBasis":"auto",
            "rom":{{"member":"romA.bin","checks":{{"checksums":{{"crc32":"{crc}"}},"size":16}}}},
            "patches":[
              {{"id":"a","path":"a.ips","target":{{"rom":true,"member":"romA.bin"}}}},
              {{"id":"b","path":"b.ips","target":{{"rom":true,"member":"romB.bin"}}}}]}}"#
    );
    let (_, terminal) = apply_weave_to_bare_input(&temp, &rom, &weave, 1);
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal.to_string().contains("romB.bin"),
        "unexpected failure: {terminal}"
    );
}

#[test]
fn weave_bare_file_refuses_to_stand_in_for_several_members() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "track.bin");
    write_offset_ips(&temp, "a.ips", 0, 0xAA);
    write_offset_ips(&temp, "b.ips", 1, 0xBB);
    let weave = r#"{"version":2,"patchBasis":"auto","patches":[
        {"id":"a","path":"a.ips","target":{"rom":true,"member":"disc-a/track.bin"}},
        {"id":"b","path":"b.ips","target":{"rom":true,"member":"disc-b/track.bin"}}]}"#;
    let (_, terminal) = apply_weave_to_bare_input(&temp, &rom, weave, 1);
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal
            .to_string()
            .contains("matches several weave ROM members"),
        "unexpected failure: {terminal}"
    );
}

#[test]
fn weave_bare_file_bound_to_the_root_member_refuses_a_second_member() {
    let crc = crc32_hex(WEAVE_ROM_BYTES);
    // `rom.member` already claims the bare file; with or without ROM checks a
    // second same-named member must not bind to it as well.
    for rom_checks in [
        String::new(),
        format!(r#","checks":{{"checksums":{{"crc32":"{crc}"}},"size":16}}"#),
    ] {
        let temp = setup_temp_dir();
        let rom = write_weave_rom(&temp, "track.bin");
        write_offset_ips(&temp, "a.ips", 0, 0xAA);
        write_offset_ips(&temp, "b.ips", 1, 0xBB);
        let weave = format!(
            r#"{{"version":2,"patchBasis":"auto",
                "rom":{{"member":"disc-a/track.bin"{rom_checks}}},
                "patches":[
                  {{"id":"a","path":"a.ips","target":{{"rom":true,"member":"disc-a/track.bin"}}}},
                  {{"id":"b","path":"b.ips","target":{{"rom":true,"member":"disc-b/track.bin"}}}}]}}"#
        );
        let (_, terminal) = apply_weave_to_bare_input(&temp, &rom, &weave, 1);
        assert_eq!(terminal["status"], "failed");
        assert!(
            terminal
                .to_string()
                .contains("matches several weave ROM members"),
            "unexpected failure: {terminal}"
        );
    }
}

#[test]
fn weave_bare_file_read_implicitly_as_the_root_refuses_a_second_member() {
    // Patch `a` reads the root lane without naming `rom.member`; the bare file
    // already stands in for it, so patch `b`'s same-named member must not bind too.
    for a_target in ["", r#","target":{"rom":true}"#] {
        let temp = setup_temp_dir();
        let rom = write_weave_rom(&temp, "track.bin");
        write_offset_ips(&temp, "a.ips", 0, 0xAA);
        write_offset_ips(&temp, "b.ips", 1, 0xBB);
        let weave = format!(
            r#"{{"version":2,"patchBasis":"auto",
                "rom":{{"member":"disc-a/track.bin"}},
                "patches":[
                  {{"id":"a","path":"a.ips"{a_target}}},
                  {{"id":"b","path":"b.ips","target":{{"rom":true,"member":"disc-b/track.bin"}}}}]}}"#
        );
        let (_, terminal) = apply_weave_to_bare_input(&temp, &rom, &weave, 1);
        assert_eq!(terminal["status"], "failed");
        assert!(
            terminal
                .to_string()
                .contains("matches several weave ROM members"),
            "unexpected failure: {terminal}"
        );
    }
}

#[test]
fn weave_bare_file_matches_a_member_named_only_by_a_patch_input() {
    let temp = setup_temp_dir();
    let rom = write_weave_rom(&temp, "renamed.bin");
    write_offset_ips(&temp, "a.ips", 0, 0xAA);
    let crc = crc32_hex(WEAVE_ROM_BYTES);
    let weave = format!(
        r#"{{"version":2,"patchBasis":"auto","patches":[
            {{"id":"a","path":"a.ips","input":{{"rom":true,"member":"romA.bin"}},
              "inputChecks":{{"checksums":{{"crc32":"{crc}"}},"size":16}}}}]}}"#
    );
    let (output, _) = apply_weave_to_bare_input(&temp, &rom, &weave, 0);
    assert_eq!(
        fs::read(output).expect("output"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn weave_bare_file_binds_rom_member_plus_matching_members_only_once() {
    let crc = crc32_hex(WEAVE_ROM_BYTES);
    let checks = format!(r#""checks":{{"checksums":{{"crc32":"{crc}"}},"size":16}}"#);
    /// The output's patched `(offset, byte)` edits, or the expected failure text.
    type Expected = std::result::Result<Vec<(usize, u8)>, String>;
    let several = |a: &str, b: &str| -> Expected {
        Err(format!("matches several weave ROM members (`{a}`, `{b}`)"))
    };
    // (case, input file, archive input, `rom` object, patches, expected result)
    let cases: Vec<(&str, &str, bool, String, &str, Expected)> = vec![
        (
            "untargeted root step plus a same-named member",
            "track.bin",
            false,
            r#"{"member":"disc-a/track.bin"}"#.to_owned(),
            r#"{"id":"a","path":"a.ips"},
               {"id":"b","path":"b.ips","target":{"rom":true,"member":"disc-b/track.bin"}}"#,
            several("disc-a/track.bin", "disc-b/track.bin"),
        ),
        (
            "rom.checks verify rom.member while no step reads the root lane",
            "track.bin",
            false,
            format!(r#"{{"member":"disc-a/track.bin",{checks}}}"#),
            r#"{"id":"b","path":"b.ips","target":{"rom":true,"member":"disc-b/track.bin"}}"#,
            several("disc-a/track.bin", "disc-b/track.bin"),
        ),
        (
            "unselected optional root step",
            "track.bin",
            false,
            format!(r#"{{"member":"disc-a/track.bin",{checks}}}"#),
            r#"{"id":"a","path":"a.ips","optional":true},
               {"id":"b","path":"b.ips","target":{"rom":true,"member":"disc-b/track.bin"}}"#,
            several("disc-a/track.bin", "disc-b/track.bin"),
        ),
        (
            "two members bound through rom.checks",
            "game.bin",
            false,
            format!("{{{checks}}}"),
            r#"{"id":"a","path":"a.ips","target":{"rom":true,"member":"first.bin"}},
               {"id":"b","path":"b.ips","target":{"rom":true,"member":"second.bin"}}"#,
            several("first.bin", "second.bin"),
        ),
        (
            "renamed file for a target naming rom.member, with checks",
            "mygame.bin",
            false,
            format!(r#"{{"member":"disc-a/game.bin",{checks}}}"#),
            r#"{"id":"a","path":"a.ips","target":{"rom":true,"member":"disc-a/game.bin"}}"#,
            Ok(vec![(0, 0xAA)]),
        ),
        (
            "renamed file for a target naming rom.member, without checks",
            "mygame.bin",
            false,
            r#"{"member":"disc-a/game.bin"}"#.to_owned(),
            r#"{"id":"a","path":"a.ips","target":{"rom":true,"member":"disc-a/game.bin"}}"#,
            Ok(vec![(0, 0xAA)]),
        ),
        (
            "single member matched by name",
            "game.bin",
            false,
            "{}".to_owned(),
            r#"{"id":"a","path":"a.ips","target":{"rom":true,"member":"disc-a/game.bin"}}"#,
            Ok(vec![(0, 0xAA)]),
        ),
        (
            "single member matched by rom.checks",
            "game.bin",
            false,
            format!("{{{checks}}}"),
            r#"{"id":"a","path":"a.ips","target":{"rom":true,"member":"first.bin"}}"#,
            Ok(vec![(0, 0xAA)]),
        ),
        (
            "archive input holding both members",
            "discs.tar.gz",
            true,
            format!(r#"{{"member":"disc-a/track.bin",{checks}}}"#),
            r#"{"id":"b","path":"b.ips","target":{"rom":true,"member":"disc-b/track.bin"}}"#,
            Ok(vec![(1, 0xBB)]),
        ),
    ];
    let mut failures = Vec::new();
    for (case, input_name, archive, rom, patches, expected) in cases {
        let temp = setup_temp_dir();
        write_offset_ips(&temp, "a.ips", 0, 0xAA);
        write_offset_ips(&temp, "b.ips", 1, 0xBB);
        let input = if archive {
            let track = write_weave_rom(&temp, "track.bin");
            let input = temp.child(input_name);
            write_tar_gz_fixture(
                &[(&track, "disc-a/track.bin"), (&track, "disc-b/track.bin")],
                input.path(),
            );
            input.path().to_path_buf()
        } else {
            write_weave_rom(&temp, input_name)
        };
        let weave = temp.child("weave.json");
        fs::write(
            weave.path(),
            format!(r#"{{"version":2,"patchBasis":"auto","rom":{rom},"patches":[{patches}]}}"#),
        )
        .expect("weave");
        let output = temp.child("out.bin");
        let run = Command::cargo_bin("rom-weaver")
            .expect("binary")
            .args(["patch", "apply", "--no-compress", "--jsonl", "--input"])
            .arg(&input)
            .arg("--weave")
            .arg(weave.path())
            .arg("--output")
            .arg(output.path())
            .output()
            .expect("run rom-weaver");
        let stdout = String::from_utf8_lossy(&run.stdout);
        let outcome = match expected {
            Ok(edits) if run.status.success() => {
                let bytes = fs::read(output.path()).expect("output");
                if bytes == patched_rom_bytes(&edits) {
                    Ok(())
                } else {
                    Err(format!("wrong output bytes; expected edits {edits:?}"))
                }
            }
            Ok(_) => Err(format!("expected success, got: {stdout}")),
            Err(message) if !run.status.success() && stdout.contains(&message) => Ok(()),
            Err(message) => Err(format!(
                "expected failure containing {message:?}, got: {stdout}"
            )),
        };
        if let Err(problem) = outcome {
            failures.push(format!("{case}: {problem}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn weave_generated_output_members_support_fixed_and_cumulative_inputs() {
    let temp = setup_temp_dir();
    write_weave_rom(&temp, "game.bin");
    let member = temp.child("member.bin");
    let member_bytes = patched_rom_bytes(&[(4, 0x44)]);
    fs::write(member.path(), &member_bytes).expect("member");
    let archive = temp.child("generated.tar.gz");
    write_tar_gz_fixture(&[(member.path(), "nested/member.bin")], archive.path());
    let archive_bytes = fs::read(archive.path()).expect("archive");
    fs::write(
        temp.child("producer.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: archive_bytes.clone(),
            }],
            Some(archive_bytes.len() as u32),
        ),
    )
    .expect("producer patch");
    write_offset_ips(&temp, "b.ips", 0, 0xAA);
    write_offset_ips(&temp, "c.ips", 1, 0xBB);
    for field in ["input", "target"] {
        let weave = temp.child(format!("{field}.json"));
        let reference = serde_json::json!({"patch": "producer", "member": "nested/member.bin"});
        let mut b = serde_json::json!({"id":"b", "path":"b.ips"});
        let mut c = serde_json::json!({"id":"c", "path":"c.ips"});
        b[field] = reference.clone();
        c[field] = reference;
        let recipe = serde_json::json!({
            "version":2, "patchBasis":"auto", "rom":{"path":"game.bin"},
            "patches":[{"id":"producer","path":"producer.ips"},b,c]
        });
        fs::write(
            weave.path(),
            serde_json::to_vec(&recipe).expect("recipe JSON"),
        )
        .expect("weave");
        let output = temp.child(format!("out-{field}.bin"));
        run_json_events(
            &[
                "patch",
                "apply",
                "--input",
                weave.path().to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--no-compress",
                "--jsonl",
            ],
            0,
        );
        let mut expected = member_bytes.clone();
        if field == "target" {
            expected[0] = 0xAA;
        }
        expected[1] = 0xBB;
        assert_eq!(
            fs::read(output.path()).expect("output"),
            expected,
            "{field} must preserve its declared relationship to the generated member"
        );
    }
}

/// Install one packaged per-track disc record under a temp data directory.
/// The record names the disc's real first track; `track02_crc32` lets a test
/// describe a second track the disc does or does not have.
fn install_two_track_pack(
    data_dir: &TempDir,
    track01: &[u8],
    track02_crc32: &str,
    track02_size: u64,
) -> (String, u64) {
    use rom_weaver_checksum::identify_catalog::IdentifySource;
    use rom_weaver_checksum::identify_pack_types::{
        PackComponent, PackComponentRole, PackGame, UpstreamSource,
    };
    let track = |ordinal: u32, role, filename: &str, size: u64, crc32: &str| PackComponent {
        role,
        ordinal,
        hash_scope: "track_file".to_string(),
        filename: Some(filename.to_string()),
        size,
        crc32: Some(crc32.to_string()),
        md5: None,
        sha1: None,
        sha256: None,
        required: true,
        discriminating: true,
        track: Some(ordinal + 1),
        session: None,
    };
    let track01_crc32 = crc32_hex(track01);
    let game = PackGame {
        name: "Two Track Quest (USA)".to_string(),
        alternate_names: Vec::new(),
        platform: "Test Disc System".to_string(),
        source: IdentifySource::Redump,
        upstream_source: UpstreamSource::Redump,
        provenance: Vec::new(),
        legacy_variant: false,
        dump_tags: Vec::new(),
        game_id: None,
        region: Some("USA".to_string()),
        language: None,
        disc_number: None,
        revision: None,
        parent: None,
        components: vec![
            track(
                0,
                PackComponentRole::DataTrack,
                "Two Track Quest (USA) (Track 1).bin",
                track01.len() as u64,
                &track01_crc32,
            ),
            track(
                1,
                PackComponentRole::AudioTrack,
                "Two Track Quest (USA) (Track 2).bin",
                track02_size,
                track02_crc32,
            ),
        ],
    };
    let pack = rom_weaver_checksum::identify_pack_v1::encode(
        "Test Disc System",
        IdentifySource::Redump,
        "redump-cd-track-v1",
        &serde_json::json!([]),
        vec![game],
    )
    .expect("RWFP1 pack");
    let mut compressed = Vec::new();
    {
        let mut encoder = brotli::CompressorWriter::new(&mut compressed, 4096, 5, 22);
        std::io::Write::write_all(&mut encoder, &pack).expect("brotli pack");
    }
    let root = data_dir.path().join("identify/full-v1");
    let packs = root.join("packs");
    fs::create_dir_all(&packs).expect("packs dir");
    fs::write(packs.join("test-disc-system.pack.br"), &compressed).expect("pack fixture");
    // The member lane fill loads only the packs the catalog marks per-track.
    fs::write(
        root.join("catalog.json"),
        serde_json::json!({
            "format": "rom-weaver-identify-catalog-v1",
            "platforms": [{
                "canonicalPlatform": "Test Disc System",
                "aliases": ["tds"],
                "source": "redump",
                "mediaProfiles": ["redump-cd-track-v1"],
                "packSlug": "test-disc-system",
                "packFormat": "RWFP1",
                "canonicalizationVersion": 1,
            }]
        })
        .to_string(),
    )
    .expect("catalog fixture");
    // The packaged reader verifies every pack against `index.json`.
    let sha256 = |bytes: &[u8]| {
        let mut checksum = rom_weaver_checksum::StreamingChecksum::new(&["sha256".to_string()])
            .expect("sha256 setup")
            .expect("sha256 support");
        checksum.update(bytes).expect("sha256 update");
        checksum
            .finalize()
            .expect("sha256 finalize")
            .remove("sha256")
            .expect("sha256 result")
    };
    fs::write(
        root.join("index.json"),
        serde_json::json!({
            "systems": [{
                "slug": "test-disc-system",
                "file": "packs/test-disc-system.pack",
                "rawBytes": pack.len(),
                "sha256": sha256(&pack),
                "brotliFile": "packs/test-disc-system.pack.br",
                "brotliBytes": compressed.len(),
                "brotliSha256": sha256(&compressed),
            }]
        })
        .to_string(),
    )
    .expect("index fixture");
    (track01_crc32, track01.len() as u64)
}

/// The weave names the first track; the database record then supplies the
/// second track's checks to the lane that patches it.
fn two_track_weave(temp: &TempDir, track01_crc32: &str, track01_size: u64) -> PathBuf {
    write_offset_ips(temp, "first.ips", 100, 0xAA);
    write_offset_ips(temp, "second.ips", 100, 0xBB);
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        format!(
            r#"{{
        "version":2,"patchBasis":"auto",
        "rom":{{"member":"track01.bin","checks":{{"checksums":{{"crc32":"{track01_crc32}"}},"size":{track01_size}}}}},
        "patches":[
            {{"id":"first","path":"first.ips","target":{{"rom":true,"member":"track01.bin"}}}},
            {{"id":"second","path":"second.ips","target":{{"rom":true,"member":"track02.bin"}}}}
        ]
    }}"#
        ),
    )
    .expect("weave");
    weave.path().to_path_buf()
}

#[test]
fn weave_member_lane_checks_filled_from_identify_data_pass_on_the_real_track() {
    let source = setup_temp_dir();
    let (mut expected_first, mut expected_second) = super::patch_disc::write_two_track_cd(&source);
    let data_dir = setup_temp_dir();
    let (track01_crc32, track01_size) = install_two_track_pack(
        &data_dir,
        &expected_first,
        &crc32_hex(&expected_second),
        expected_second.len() as u64,
    );
    let temp = setup_temp_dir();
    let weave = two_track_weave(&temp, &track01_crc32, track01_size);
    let output = temp.child("raw/disc.cue");
    let run = command_output_with_env(
        &[
            "patch",
            "apply",
            "--input",
            source.child("disc.cue").path().to_str().expect("path"),
            "--weave",
            weave.to_str().expect("path"),
            "--target",
            "track01.bin",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
            "--log-level",
            "debug",
        ],
        &[(
            "ROM_WEAVER_DATA_DIR",
            data_dir.path().to_str().expect("path"),
        )],
        0,
    );
    let events = parse_json_lines(&run.stdout);
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        stderr.contains("filled the ROM member lane's input checks")
            && stderr.contains("track02.bin"),
        "expected the second lane to take its checks from the database: {stderr}"
    );
    expected_first[100] = 0xAA;
    expected_second[100] = 0xBB;
    assert_eq!(
        fs::read(temp.child("raw/track01.bin").path()).expect("first track"),
        expected_first
    );
    assert_eq!(
        fs::read(temp.child("raw/track02.bin").path()).expect("second track"),
        expected_second
    );
}

#[test]
fn weave_member_lane_checks_filled_from_identify_data_name_the_expected_title() {
    let source = setup_temp_dir();
    let (expected_first, expected_second) = super::patch_disc::write_two_track_cd(&source);
    let data_dir = setup_temp_dir();
    // The record's second track is not the one on this disc.
    let (track01_crc32, track01_size) = install_two_track_pack(
        &data_dir,
        &expected_first,
        "deadbeef",
        expected_second.len() as u64,
    );
    let temp = setup_temp_dir();
    let weave = two_track_weave(&temp, &track01_crc32, track01_size);
    let events = run_json_events_with_env(
        &[
            "patch",
            "apply",
            "--input",
            source.child("disc.cue").path().to_str().expect("path"),
            "--weave",
            weave.to_str().expect("path"),
            "--target",
            "track01.bin",
            "--output",
            temp.child("raw/disc.cue").path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        &[(
            "ROM_WEAVER_DATA_DIR",
            data_dir.path().to_str().expect("path"),
        )],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("label");
    assert!(
        label.contains("patch.chain.input_mismatch") && label.contains("second.ips"),
        "expected the second lane's input gate to fail: {label}"
    );
    assert!(
        label.contains("Two Track Quest (USA)") && label.contains("Test Disc System"),
        "expected the database title behind the declared checks: {label}"
    );

    // Without a database the lane has no filled check, so the same run passes.
    let empty_data_dir = setup_temp_dir();
    let events = run_json_events_with_env(
        &[
            "patch",
            "apply",
            "--input",
            source.child("disc.cue").path().to_str().expect("path"),
            "--weave",
            weave.to_str().expect("path"),
            "--target",
            "track01.bin",
            "--output",
            temp.child("raw-no-db/disc.cue")
                .path()
                .to_str()
                .expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        &[(
            "ROM_WEAVER_DATA_DIR",
            empty_data_dir.path().to_str().expect("path"),
        )],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
}

/// An authored check on a member lane's first step describes the lane's
/// chain prefix, so deselecting an optional earlier entry must not verify a
/// post-patch state against the untouched track.
#[test]
fn weave_member_lane_authored_checks_skip_when_an_earlier_optional_entry_is_off() {
    let source = setup_temp_dir();
    let (_expected_first, mut expected_second) = super::patch_disc::write_two_track_cd(&source);
    let temp = setup_temp_dir();
    write_offset_ips(&temp, "first.ips", 100, 0xAA);
    write_offset_ips(&temp, "second.ips", 200, 0xBB);
    let mut after_first = expected_second.clone();
    after_first[100] = 0xAA;
    let after_first_crc32 = crc32_hex(&after_first);
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        format!(
            r#"{{
        "version":2,"patchBasis":"auto",
        "rom":{{"member":"track01.bin"}},
        "patches":[
            {{"id":"first","path":"first.ips","optional":true,"target":{{"rom":true,"member":"track02.bin"}}}},
            {{"id":"second","path":"second.ips","target":{{"rom":true,"member":"track02.bin"}},
             "inputChecks":{{"checksums":{{"crc32":"{after_first_crc32}"}}}}}}
        ]
    }}"#
        ),
    )
    .expect("weave");
    let disc = source.child("disc.cue");
    let common = [
        "patch",
        "apply",
        "--input",
        disc.path().to_str().expect("path"),
        "--weave",
        weave.path().to_str().expect("path"),
        "--target",
        "track01.bin",
        "--no-compress",
        "--json",
    ];
    // With the optional entry on, the declared state is the real intermediate.
    let mut args = common.to_vec();
    let output = temp.child("full/disc.cue");
    args.extend([
        "--with",
        "first.ips",
        "--output",
        output.path().to_str().expect("path"),
    ]);
    let events = run_json_events(&args, 0);
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    expected_second[100] = 0xAA;
    expected_second[200] = 0xBB;
    assert_eq!(
        fs::read(temp.child("full/track02.bin").path()).expect("second track"),
        expected_second
    );
    // Off (its default), the declaration no longer describes what the step reads.
    let mut args = common.to_vec();
    let output = temp.child("partial/disc.cue");
    args.extend(["--output", output.path().to_str().expect("path")]);
    let events = run_json_events(&args, 0);
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    // Byte 100 of the fixture track is 100 % 173, untouched with the entry off.
    expected_second[100] = 100;
    assert_eq!(
        fs::read(temp.child("partial/track02.bin").path()).expect("second track"),
        expected_second
    );
}

#[test]
fn weave_disc_targets_preserve_all_tracks_and_chd_parity() {
    let source = setup_temp_dir();
    let (mut expected_first, mut expected_second) = super::patch_disc::write_two_track_cd(&source);
    let temp = setup_temp_dir();
    write_offset_ips(&temp, "first.ips", 100, 0xAA);
    write_offset_ips(&temp, "second.ips", 100, 0xBB);
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        r#"{
        "version":2,"patchBasis":"auto",
        "rom":{"member":"track01.bin"},
        "patches":[
            {"id":"first","path":"first.ips","target":{"rom":true,"member":"track01.bin"}},
            {"id":"second","path":"second.ips","target":{"rom":true,"member":"track02.bin"}}
        ]
    }"#,
    )
    .expect("weave");
    let output = temp.child("raw/disc.cue");
    run_json_events(
        &[
            "patch",
            "apply",
            "--input",
            source.child("disc.cue").path().to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--target",
            "track01.bin",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    expected_first[100] = 0xAA;
    expected_second[100] = 0xBB;
    assert_eq!(
        fs::read(temp.child("raw/track01.bin").path()).expect("first track"),
        expected_first
    );
    assert_eq!(
        fs::read(temp.child("raw/track02.bin").path()).expect("second track"),
        expected_second
    );
    let compressed = temp.child("patched.chd");
    run_json_events(
        &[
            "patch",
            "apply",
            "--input",
            source.child("disc.cue").path().to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--target",
            "track01.bin",
            "--output",
            compressed.path().to_str().expect("path"),
            "--compress-format",
            "chd",
            "--compress-codec",
            "zstd",
            "--threads",
            "1",
            "--jsonl",
        ],
        0,
    );
    let expected_chd = temp.child("expected.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            output.path().to_str().expect("path"),
            "--output",
            expected_chd.path().to_str().expect("path"),
            "--format",
            "chd",
            "--codec",
            "zstd",
            "--threads",
            "1",
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read(compressed.path()).expect("compressed"),
        fs::read(expected_chd.path()).expect("expected compressed"),
        "all patched tracks must reach the CHD encoder"
    );
}

#[test]
fn weave_target_lane_verifies_bps_base_and_previous_states() {
    let temp = setup_temp_dir();
    let first = write_weave_rom(&temp, "first.bin");
    let second = temp.child("second.bin");
    let second_bytes = vec![0x31; WEAVE_ROM_BYTES.len()];
    fs::write(second.path(), &second_bytes).expect("second source");
    let archive = temp.child("roms.tar.gz");
    write_tar_gz_fixture(
        &[
            (first.as_path(), "first.bin"),
            (second.path(), "second.bin"),
        ],
        archive.path(),
    );
    let mid = temp.child("mid.bin");
    let mut mid_bytes = second_bytes.clone();
    mid_bytes[3] = 0xAA;
    fs::write(mid.path(), &mid_bytes).expect("mid source");
    let final_state = temp.child("final.bin");
    let mut final_bytes = mid_bytes.clone();
    final_bytes[9] = 0xBB;
    fs::write(final_state.path(), &final_bytes).expect("final source");
    create_patch_file(
        second.path(),
        mid.path(),
        "bps",
        temp.child("first.bps").path(),
    );
    create_patch_file(
        mid.path(),
        final_state.path(),
        "bps",
        temp.child("second.bps").path(),
    );
    let weave = temp.child("rom-weaver-weave.json");
    fs::write(
        weave.path(),
        format!(
            r#"{{
                "version": 2,
                "patchBasis": "auto",
                "rom": {{ "path": "roms.tar.gz", "member": "first.bin" }},
                "patches": [
                    {{
                        "path": "first.bps",
                        "target": {{ "rom": true, "member": "second.bin" }},
                        "basis": "base",
                        "inputChecks": {{ "checksums": {{ "crc32": "{}" }} }}
                    }},
                    {{
                        "path": "second.bps",
                        "target": {{ "rom": true, "member": "second.bin" }},
                        "basis": "previous",
                        "inputChecks": {{ "checksums": {{ "crc32": "{}" }} }}
                    }}
                ]
            }}"#,
            crc32_hex(&second_bytes),
            crc32_hex(&mid_bytes),
        ),
    )
    .expect("weave");
    let output = temp.child("out.bin");
    run_json_events(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(fs::read(output.path()).expect("output"), final_bytes);
}

#[test]
fn weave_target_lane_endpoint_checks_run_before_a_later_lane() {
    let temp = setup_temp_dir();
    let first = write_weave_rom(&temp, "first.bin");
    let second = temp.child("second.bin");
    let second_bytes = vec![0x55; WEAVE_ROM_BYTES.len()];
    fs::write(second.path(), &second_bytes).expect("second source");
    let archive = temp.child("roms.tar.gz");
    write_tar_gz_fixture(
        &[
            (first.as_path(), "first.bin"),
            (second.path(), "second.bin"),
        ],
        archive.path(),
    );
    write_offset_ips(&temp, "first.ips", 0, 0xAA);
    write_offset_ips(&temp, "second.ips", 1, 0xDD);
    let weave = temp.child("rom-weaver-weave.json");
    let write_weave =
        |first_output_crc: &str, second_output_crc: &str, weave_output_crc: Option<&str>| {
            let output_section = weave_output_crc.map_or_else(String::new, |crc| {
            format!(
                ", \"output\": {{ \"checks\": {{ \"checksums\": {{ \"crc32\": \"{crc}\" }} }} }}"
            )
        });
            fs::write(
                weave.path(),
                format!(
                    r#"{{
                    "version": 2,
                    "patchBasis": "auto",
                    "rom": {{ "path": "roms.tar.gz", "member": "first.bin" }},
                    "patches": [
                        {{
                            "path": "first.ips",
                            "target": {{ "rom": true, "member": "first.bin" }},
                            "outputChecks": {{ "checksums": {{ "crc32": "{first_output_crc}" }} }}
                        }},
                        {{
                            "path": "second.ips",
                            "target": {{ "rom": true, "member": "second.bin" }},
                            "outputChecks": {{ "checksums": {{ "crc32": "{second_output_crc}" }} }}
                        }}
                    ]{output_section}
                }}"#,
                ),
            )
            .expect("weave");
        };
    let mut expected = second_bytes.clone();
    expected[1] = 0xDD;
    write_weave("00000000", &crc32_hex(&expected), None);
    let output = temp.child("out.bin");
    let failed = run_json_events(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    assert!(
        failed.last().expect("terminal")["label"]
            .as_str()
            .expect("label")
            .contains("patch.chain.output_mismatch")
    );

    write_weave(
        &crc32_hex(&patched_rom_bytes(&[(0, 0xAA)])),
        &crc32_hex(&expected),
        None,
    );
    run_json_events(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--force",
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(fs::read(output.path()).expect("output"), expected);

    write_weave(
        &crc32_hex(&patched_rom_bytes(&[(0, 0xAA)])),
        &crc32_hex(&expected),
        Some("00000000"),
    );
    let root_failed = run_json_events(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--weave",
            weave.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--force",
            "--no-compress",
            "--jsonl",
        ],
        1,
    );
    assert!(
        root_failed.last().expect("terminal")["label"]
            .as_str()
            .expect("label")
            .contains("output checksum mismatch")
    );
}

#[test]
fn weave_metadata_help_describes_native_binding() {
    let help =
        String::from_utf8(command_stdout(&["weave", "create", "--help"], 0)).expect("UTF-8 help");
    assert!(
        help.contains("Before the first --patch, it describes that first patch"),
        "{help}"
    );
    assert!(
        help.contains("You may leave metadata out for any patch"),
        "{help}"
    );
    assert!(!help.contains("a partial list is an error"), "{help}");
}

#[test]
fn weave_archive_prefers_canonical_over_legacy_in_either_order() {
    let temp = setup_temp_dir();
    let canonical = temp.child("canonical.json");
    let legacy = temp.child("legacy.json");
    fs::write(
        canonical.path(),
        r#"{"version":1,"patches":[{"url":"https://example.test/new.ips"}]}"#,
    )
    .expect("canonical fixture");
    fs::write(
        legacy.path(),
        r#"{"version":1,"patches":[{"url":"https://example.test/old.ips"}]}"#,
    )
    .expect("legacy fixture");
    for (reverse, identical) in [(false, false), (true, false), (false, true), (true, true)] {
        let archive = temp.child(format!("archive-{reverse}-{identical}.tar.gz"));
        let mut entries = vec![
            (
                if identical {
                    canonical.path()
                } else {
                    legacy.path()
                },
                "ROM-WEAVER-BUNDLE.JSON",
            ),
            (canonical.path(), "ROM-WEAVER-WEAVE.JSON"),
        ];
        if reverse {
            entries.reverse();
        }
        write_tar_gz_fixture(&entries, archive.path());
        let events = run_json_events(
            &[
                "bundle",
                "parse",
                "--input",
                archive.path().to_str().expect("path"),
                "--jsonl",
            ],
            0,
        );
        let terminal = events.last().expect("terminal");
        assert_eq!(
            terminal["details"]["weave"]["archive_member"],
            "ROM-WEAVER-WEAVE.JSON"
        );
        assert_eq!(terminal["details"]["bundle"]["bundle"]["version"], 1);
        assert_eq!(terminal["command"], "bundle-parse");
        let restored: rom_weaver_app::BundleParseResult =
            serde_json::from_value(terminal["details"]["bundle"].clone())
                .expect("old typed parse reader");
        assert_eq!(restored.bundle.version, 1);
        assert_eq!(restored.warnings.len(), usize::from(!identical));
    }
}

#[test]
fn oversized_legacy_member_does_not_reject_valid_canonical_recipe() {
    let temp = setup_temp_dir();
    let canonical = temp.child("canonical.json");
    let oversized = temp.child("oversized.json");
    let archive = temp.child("oversized-alias.tar.gz");
    fs::write(
        canonical.path(),
        r#"{"version":1,"patches":[{"url":"https://example.test/new.ips"}]}"#,
    )
    .expect("canonical");
    fs::write(oversized.path(), vec![b' '; 4 * 1024 * 1024 + 1]).expect("oversized alias");
    write_tar_gz_fixture(
        &[
            (oversized.path(), "rom-weaver-bundle.json"),
            (canonical.path(), "rom-weaver-weave.json"),
        ],
        archive.path(),
    );
    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            archive.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let result = &events.last().expect("terminal")["details"]["bundle"];
    assert_eq!(result["bundle"]["version"], 1);
    assert_eq!(result["archive_member"], "rom-weaver-weave.json");
    assert_eq!(result["warnings"].as_array().expect("warnings").len(), 1);
}

fn weave_output_fixture(temp: &TempDir, members: &[&str]) -> PathBuf {
    let patch = write_min_ips(temp, "fixture.ips");
    let manifest = temp.child("manifest.json");
    let patches: Vec<_> = members.iter().map(|path| json!({ "path": path })).collect();
    fs::write(
        manifest.path(),
        json!({ "version": 1, "patches": patches }).to_string(),
    )
    .expect("write manifest");
    let archive = temp.child("input.tar.gz");
    let mut entries = vec![(manifest.path(), "rom-weaver-weave.json")];
    entries.extend(members.iter().map(|name| (patch.as_path(), *name)));
    write_tar_gz_fixture(&entries, archive.path());
    archive.path().to_owned()
}

fn parse_weave_output(archive: &Path, output: &Path, code: i32) {
    run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            archive.to_str().expect("archive path"),
            "--output",
            output.to_str().expect("output path"),
            "--jsonl",
        ],
        code,
    );
}

#[test]
fn weave_parse_preserves_existing_output_and_preflights_later_conflicts() {
    let temp = setup_temp_dir();
    let archive = weave_output_fixture(&temp, &["first.ips", "second.ips"]);
    let output = temp.child("output");
    fs::create_dir(output.path()).expect("output directory");
    fs::write(output.path().join("second.ips"), b"keep me").expect("existing output");
    parse_weave_output(&archive, output.path(), 1);
    assert_eq!(
        fs::read(output.path().join("second.ips")).expect("sentinel"),
        b"keep me"
    );
    assert!(!output.path().join("first.ips").exists());
}

#[test]
fn weave_parse_preserves_source_archive_when_member_aliases_input() {
    let temp = setup_temp_dir();
    let archive = weave_output_fixture(&temp, &["input.tar.gz"]);
    let original = fs::read(&archive).expect("original archive");
    parse_weave_output(&archive, temp.path(), 1);
    assert_eq!(fs::read(&archive).expect("preserved archive"), original);
}

#[test]
fn weave_parse_rejects_file_directory_output_conflicts_without_writing() {
    let temp = setup_temp_dir();
    let archive = weave_output_fixture(&temp, &["patch", "patch/next.ips"]);
    let output = temp.child("output");
    parse_weave_output(&archive, output.path(), 1);
    assert!(!output.path().exists());
}

#[test]
fn weave_parse_repeated_member_reuses_one_output() {
    let temp = setup_temp_dir();
    let patch = write_min_ips(&temp, "fixture.ips");
    let manifest = temp.child("manifest.json");
    fs::write(
        manifest.path(),
        r#"{"version":1,"patches":[{"path":"main.ips"},{"path":"main.ips"}]}"#,
    )
    .expect("manifest");
    let archive = temp.child("repeat.tar.gz");
    write_tar_gz_fixture(
        &[
            (manifest.path(), "rom-weaver-weave.json"),
            (&patch, "main.ips"),
        ],
        archive.path(),
    );
    let output = temp.child("output");
    parse_weave_output(archive.path(), output.path(), 0);
    assert_eq!(
        fs::read(output.path().join("main.ips")).expect("output"),
        fs::read(patch).expect("patch")
    );
}

#[cfg(unix)]
#[test]
fn weave_parse_rejects_file_and_dangling_symlinks() {
    use std::os::unix::fs::symlink;
    let temp = setup_temp_dir();
    let archive = weave_output_fixture(&temp, &["main.ips"]);
    let outside = temp.child("outside.ips");
    fs::write(outside.path(), b"outside sentinel").expect("outside file");
    for (name, destination) in [
        ("existing", outside.path().to_owned()),
        ("dangling", temp.path().join("missing.ips")),
    ] {
        let output = temp.child(name);
        fs::create_dir(output.path()).expect("output directory");
        symlink(&destination, output.path().join("main.ips")).expect("symlink");
        parse_weave_output(&archive, output.path(), 1);
        assert!(
            fs::symlink_metadata(output.path().join("main.ips"))
                .expect("symlink preserved")
                .file_type()
                .is_symlink()
        );
    }
    assert_eq!(
        fs::read(outside.path()).expect("outside sentinel"),
        b"outside sentinel"
    );
    assert!(!temp.path().join("missing.ips").exists());
}

#[cfg(unix)]
#[test]
fn weave_parse_rejects_symlinked_directories_and_output_root() {
    use std::os::unix::fs::symlink;
    let temp = setup_temp_dir();
    let archive = weave_output_fixture(&temp, &["patches/main.ips"]);
    let outside = temp.child("outside");
    fs::create_dir(outside.path()).expect("outside directory");
    let output = temp.child("output");
    fs::create_dir(output.path()).expect("output directory");
    symlink(outside.path(), output.path().join("patches")).expect("directory symlink");
    parse_weave_output(&archive, output.path(), 1);
    let root_link = temp.child("root-link");
    symlink(outside.path(), root_link.path()).expect("root symlink");
    parse_weave_output(&archive, root_link.path(), 1);
    assert_eq!(
        fs::read_dir(outside.path())
            .expect("outside directory")
            .count(),
        0
    );
}

#[cfg(unix)]
fn assert_weave_parse_rejects_suffixed_symlink_root(suffix: &str) {
    use std::os::unix::fs::symlink;
    let temp = setup_temp_dir();
    let archive = weave_output_fixture(&temp, &["main.ips"]);
    let outside = temp.child("outside");
    fs::create_dir(outside.path()).expect("outside directory");
    let root_link = temp.child("root-link");
    symlink(outside.path(), root_link.path()).expect("root symlink");
    let mut output = root_link.path().as_os_str().to_owned();
    output.push(suffix);
    parse_weave_output(&archive, Path::new(&output), 1);
    assert_eq!(
        fs::read_dir(outside.path())
            .expect("outside directory")
            .count(),
        0
    );
    assert!(
        fs::symlink_metadata(root_link.path())
            .expect("root link preserved")
            .file_type()
            .is_symlink()
    );
}

#[cfg(unix)]
#[test]
fn weave_parse_rejects_symlink_root_with_trailing_separator() {
    assert_weave_parse_rejects_suffixed_symlink_root("/");
}

#[cfg(unix)]
#[test]
fn weave_parse_rejects_symlink_root_with_trailing_dot() {
    assert_weave_parse_rejects_suffixed_symlink_root("/.");
}

#[cfg(unix)]
#[test]
fn weave_parse_preserves_parent_traversal_through_symlink_ancestor() {
    use std::os::unix::fs::symlink;
    let temp = setup_temp_dir();
    let archive = weave_output_fixture(&temp, &["main.ips"]);
    let outside = temp.child("outside");
    fs::create_dir_all(outside.path().join("nested")).expect("outside directory");
    let ancestor = temp.child("ancestor-link");
    symlink(outside.path().join("nested"), ancestor.path()).expect("ancestor symlink");
    parse_weave_output(&archive, &ancestor.path().join("../output/."), 0);
    assert_eq!(
        fs::read(outside.path().join("output/main.ips")).expect("resolved output"),
        fs::read(temp.child("fixture.ips").path()).expect("patch fixture"),
    );
    assert!(!temp.child("output").path().exists());
}

#[test]
fn weave_parse_preserves_hard_link_to_source_archive() {
    let temp = setup_temp_dir();
    let archive = weave_output_fixture(&temp, &["main.ips"]);
    let original = fs::read(&archive).expect("archive");
    let output = temp.child("output");
    fs::create_dir(output.path()).expect("output directory");
    fs::hard_link(&archive, output.path().join("main.ips")).expect("hard link");
    parse_weave_output(&archive, output.path(), 1);
    assert_eq!(fs::read(&archive).expect("archive preserved"), original);
}

#[test]
fn weave_apply_repeated_archive_member_uses_private_outputs() {
    let temp = setup_temp_dir();
    let archive = weave_output_fixture(&temp, &["main.ips", "main.ips"]);
    let rom = write_weave_rom(&temp, "game.bin");
    let output = temp.child("patched.bin");
    run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("rom"),
            "--weave",
            archive.to_str().expect("archive"),
            "--output",
            output.path().to_str().expect("output"),
            "--no-compress",
            "--jsonl",
        ],
        0,
    );
    let mut expected = fs::read(rom).expect("original ROM");
    expected[0] = 0xAA;
    assert_eq!(fs::read(output.path()).expect("patched ROM"), expected);
}

#[test]
fn weave_parse_corrupt_later_member_leaves_no_extracted_files() {
    let temp = setup_temp_dir();
    let first = write_min_ips(&temp, "first.ips");
    let second = write_min_ips(&temp, "second.ips");
    let manifest = temp.child("rom-weaver-weave.json");
    fs::write(
        manifest.path(),
        r#"{"version":1,"patches":[{"path":"first.ips"},{"path":"second.ips"}]}"#,
    )
    .expect("manifest");
    let archive = temp.child("corrupt.zip");
    run_json_events(
        &[
            "compress",
            "--input",
            manifest.path().to_str().expect("manifest path"),
            "--input",
            first.to_str().expect("first patch"),
            "--input",
            second.to_str().expect("second patch"),
            "--output",
            archive.path().to_str().expect("archive path"),
            "--jsonl",
        ],
        0,
    );
    let mut bytes = fs::read(archive.path()).expect("archive");
    let header = bytes
        .windows(30 + "second.ips".len())
        .position(|window| window.starts_with(b"PK\x03\x04") && &window[30..] == b"second.ips")
        .expect("second local ZIP header");
    let extra_len = u16::from_le_bytes([bytes[header + 28], bytes[header + 29]]) as usize;
    bytes[header + 30 + "second.ips".len() + extra_len] ^= 0xff;
    fs::write(archive.path(), &bytes).expect("corrupt member payload");
    // The manifest and entry listing remain readable; only member extraction fails.
    run_json_events(
        &[
            "weave",
            "parse",
            "--input",
            archive.path().to_str().expect("archive path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );
    let output = temp.child("output");
    parse_weave_output(archive.path(), output.path(), 1);
    assert!(
        !output.path().join("first.ips").exists(),
        "earlier member must not survive a later read failure"
    );
    assert!(
        !output.path().join("second.ips").exists(),
        "failed member must not leave partial bytes"
    );
    assert_eq!(fs::read(archive.path()).expect("source preserved"), bytes);
}
