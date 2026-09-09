use super::shared::*;

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
fn bundle_parse_plain_json_resolves_refs_verbatim() {
    let temp = setup_temp_dir();
    let bundle = temp.child("rom-weaver-bundle.json");
    fs::write(
        bundle.path(),
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
    .expect("bundle fixture");

    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["bundle"];
    assert_eq!(result["source_kind"], "json");
    assert_eq!(result["bundle"]["version"], 1);
    assert!(
        result["bundle"].get("name").is_none(),
        "bundles carry no display name"
    );
    assert!(
        result["bundle"]["patches"][0].get("optional").is_none(),
        "non-optional patches omit the flag"
    );
    assert_eq!(result["bundle"]["patches"][1]["optional"], true);
    assert_eq!(result["bundle"]["patches"][0]["label"], "stable");
    assert!(result["bundle"]["output"].get("compress").is_none());
    assert_eq!(
        result["rom_source"]["url"], "https://example.test/roms/game.sfc",
        "url refs pass through verbatim"
    );
    assert_eq!(
        result["patch_sources"][0]["source"]["path"], "main.ips",
        "path refs stay bundle-relative for a plain bundle"
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
fn bundle_parse_reads_gzipped_bundle() {
    let temp = setup_temp_dir();
    let bundle = temp.child("rom-weaver-bundle.json.gz");
    let json = r#"{ "version": 1, "patches": [ { "path": "main.ips" } ] }"#;
    let file = File::create(bundle.path()).expect("create rom-weaver-bundle.json.gz");
    let mut encoder = GzEncoder::new(file, DeflateCompression::default());
    encoder.write_all(json.as_bytes()).expect("gzip bundle");
    encoder.finish().expect("finish gzip bundle");

    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["bundle"];
    assert_eq!(result["source_kind"], "compressed-json");
    assert_eq!(result["bundle"]["patches"][0]["path"], "main.ips");
}

#[test]
fn bundle_parse_archive_extracts_referenced_members() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"0123456789abcdef").expect("rom fixture");
    let patch_path = write_min_ips(&temp, "main.ips");
    let bundle_json = temp.child("rom-weaver-bundle.json");
    fs::write(
        bundle_json.path(),
        r#"{
            "version": 1,
            "rom": { "path": "roms/game.bin" },
            "patches": [ { "path": "patches/main.ips", "description": "main hack" } ]
        }"#,
    )
    .expect("bundle fixture");
    let archive = temp.child("bundle.tar.gz");
    write_tar_gz_fixture(
        &[
            (bundle_json.path(), "rom-weaver-bundle.json"),
            (rom.path(), "roms/game.bin"),
            (&patch_path, "patches/main.ips"),
        ],
        archive.path(),
    );
    let extract_dir = temp.child("bundle-out");

    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            extract_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["bundle"];
    assert_eq!(result["source_kind"], "archive");
    assert_eq!(result["archive_member"], "rom-weaver-bundle.json");

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
fn bundle_parse_archive_content_probes_noncanonical_member() {
    // A pre-rename archive whose index is named `rw.json`, not the canonical
    // `rom-weaver-bundle.json`, must still be found by content probing. A decoy
    // `config.json` that is not a bundle sits alongside to prove the probe is
    // gated on a successful parse, not on the `.json` extension.
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"0123456789abcdef").expect("rom fixture");
    let patch_path = write_min_ips(&temp, "main.ips");
    let decoy = temp.child("config.json");
    fs::write(decoy.path(), r#"{ "unrelated": true }"#).expect("decoy fixture");
    let bundle_json = temp.child("rw.json");
    fs::write(
        bundle_json.path(),
        r#"{
            "version": 1,
            "rom": { "path": "roms/game.bin" },
            "patches": [ { "path": "patches/main.ips" } ]
        }"#,
    )
    .expect("bundle fixture");
    let archive = temp.child("legacy-bundle.tar.gz");
    write_tar_gz_fixture(
        &[
            (decoy.path(), "config.json"),
            (bundle_json.path(), "rw.json"),
            (rom.path(), "roms/game.bin"),
            (&patch_path, "patches/main.ips"),
        ],
        archive.path(),
    );
    let extract_dir = temp.child("legacy-out");

    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            extract_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["bundle"];
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
fn bundle_parse_archive_without_bundle_fails() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"0123456789abcdef").expect("rom fixture");
    let bundle = temp.child("bundle.tar.gz");
    write_tar_gz_fixture(&[(rom.path(), "roms/game.bin")], bundle.path());

    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("failure label");
    assert!(
        label.contains("bundle.missing"),
        "expected bundle.missing code in label: {label}"
    );
}

const BUNDLE_ROM_BYTES: &[u8] = b"0123456789abcdef";

fn write_bundle_rom(temp: &TempDir, name: &str) -> PathBuf {
    let rom = temp.child(name);
    fs::write(rom.path(), BUNDLE_ROM_BYTES).expect("rom fixture");
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
    let mut bytes = BUNDLE_ROM_BYTES.to_vec();
    for (offset, value) in edits {
        bytes[*offset] = *value;
    }
    bytes
}

fn bundle_check_state<'a>(bundle: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
    bundle["checkStates"]
        .as_array()
        .expect("check states")
        .iter()
        .find(|state| state["id"] == id)
        .expect("named check state")
}

#[test]
fn bundle_apply_plain_bundle_input_uses_output_name() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rom-weaver-bundle.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "name": "out.bin" }
        }"#,
    )
    .expect("bundle fixture");

    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.current_dir(temp.path());
    command.args([
        "patch",
        "apply",
        "--input",
        "rom-weaver-bundle.json",
        "--no-compress",
        "--json",
    ]);
    let stdout = command.assert().code(0).get_output().stdout.clone();
    let terminal = parse_json_lines(&stdout).last().expect("terminal").clone();
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("out.bin").path()).expect("bundle-named output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn bundle_apply_gzipped_bundle_with_cli_output() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let bundle = temp.child("rom-weaver-bundle.json.gz");
    let json = r#"{ "version": 1,
                    "rom": { "path": "game.bin" },
                    "patches": [ { "path": "main.ips" } ],
                    "output": {} }"#;
    let file = File::create(bundle.path()).expect("create rom-weaver-bundle.json.gz");
    let mut encoder = GzEncoder::new(file, DeflateCompression::default());
    encoder.write_all(json.as_bytes()).expect("gzip bundle");
    encoder.finish().expect("finish gzip bundle");
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

fn write_everything_archive(temp: &TempDir, bundle_json: &str) -> PathBuf {
    let rom = write_bundle_rom(temp, "game.bin");
    let main = write_offset_ips(temp, "main.ips", 0, 0xAA);
    let extra = write_offset_ips(temp, "extra.ips", 1, 0xBB);
    let bundle_file = temp.child("rom-weaver-bundle.json");
    fs::write(bundle_file.path(), bundle_json).expect("bundle fixture");
    let archive = temp.child("bundle.tar.gz");
    write_tar_gz_fixture(
        &[
            (bundle_file.path(), "rom-weaver-bundle.json"),
            (&rom, "roms/game.bin"),
            (&main, "patches/main.ips"),
            (&extra, "patches/extra.ips"),
        ],
        archive.path(),
    );
    archive.path().to_path_buf()
}

const EVERYTHING_BUNDLE: &str = r#"{
    "version": 1,
    "rom": { "path": "roms/game.bin" },
    "patches": [
        { "path": "patches/main.ips",  "name": "Main hack" },
        { "path": "patches/extra.ips", "name": "Extra",     "optional": true }
    ],
    "output": {}
}"#;

#[test]
fn bundle_apply_everything_archive_skips_optional() {
    let temp = setup_temp_dir();
    let bundle = write_everything_archive(&temp, EVERYTHING_BUNDLE);
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_apply_with_flag_includes_optional() {
    let temp = setup_temp_dir();
    let bundle = write_everything_archive(&temp, EVERYTHING_BUNDLE);
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.to_str().expect("path"),
            "--with",
            "Extra",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_apply_without_can_disable_default_patch() {
    let temp = setup_temp_dir();
    let bundle = write_everything_archive(&temp, EVERYTHING_BUNDLE);

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.to_str().expect("path"),
            "--without",
            "Main*",
            "--with",
            "Extra",
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_apply_rom_checks_mismatch_fails() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rom-weaver-bundle.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin", "checks": { "checksums": { "crc32": "00000000" } } },
            "patches": [ { "path": "main.ips" } ],
            "output": {}
        }"#,
    )
    .expect("bundle fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_apply_explicit_bundle_flag_keeps_input_rom() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    // The bundle's rom entry points at a nonexistent URL host on purpose:
    // with --bundle the positional input supplies the ROM, so the rom
    // source must be ignored (its checks are not - none set here).
    fs::write(
        temp.child("rom-weaver-bundle.json").path(),
        r#"{
            "version": 1,
            "rom": { "url": "https://example.test/never-fetched.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": {}
        }"#,
    )
    .expect("bundle fixture");
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("path"),
            "--bundle",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_apply_cli_output_overrides_bundle_name() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rom-weaver-bundle.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "name": "bundle-named.bin" }
        }"#,
    )
    .expect("bundle fixture");
    let output = temp.child("cli-named.bin");

    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.current_dir(temp.path());
    command.args([
        "patch",
        "apply",
        "--input",
        "rom-weaver-bundle.json",
        "--output",
        "cli-named.bin",
        "--no-compress",
        "--json",
    ]);
    command.assert().code(0);
    assert!(output.path().is_file(), "explicit --output path must win");
    assert!(
        !temp.child("bundle-named.bin").path().exists(),
        "bundle output.name must not be written when --output is given"
    );
}

#[test]
fn bundle_apply_missing_output_fails_with_code() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rom-weaver-bundle.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": {}
        }"#,
    )
    .expect("bundle fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--json",
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
fn bundle_parse_rejects_output_compression() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rom-weaver-bundle.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "name": "out.zip", "compress": { "format": "zip", "level": "min" } }
        }"#,
    )
    .expect("bundle fixture");

    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--json",
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
fn bundle_apply_url_patch_downloads_and_applies() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    let patch_bytes = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: vec![0xAA],
        }],
        None,
    );
    let base_url = serve_files(vec![("/main.ips", patch_bytes)], 1);
    fs::write(
        temp.child("rom-weaver-bundle.json").path(),
        format!(
            r#"{{
                "version": 1,
                "rom": {{ "path": "game.bin" }},
                "patches": [ {{ "url": "{base_url}/main.ips" }} ],
                "output": {{}}
            }}"#
        ),
    )
    .expect("bundle fixture");
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_apply_url_bundle_resolves_relative_entries() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let patch_bytes = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: vec![0xAA],
        }],
        None,
    );
    let bundle_json = br#"{
        "version": 1,
        "patches": [ { "url": "patches/main.ips" } ],
        "output": {}
    }"#
    .to_vec();
    let base_url = serve_files(
        vec![
            ("/rom-weaver-bundle.json", bundle_json),
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
            "--bundle",
            &format!("{base_url}/packs/rom-weaver-bundle.json"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_create_computes_checks_and_aligns_metadata() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let extra = write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    let bundle_out = temp.child("rom-weaver-bundle.json");

    let events = run_json_events(
        &[
            "bundle",
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
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "succeeded");
    let created = &terminal["details"]["bundle_create"];
    assert!(
        created["bundle_path"]
            .as_str()
            .expect("bundle path")
            .ends_with("rom-weaver-bundle.json")
    );

    // Round-trip through bundle parse and verify computed values.
    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let parsed = &events.last().expect("terminal")["details"]["bundle"]["bundle"];
    assert_eq!(parsed["version"], 2);
    assert_eq!(parsed["patchBasis"], "auto");
    assert!(parsed.get("name").is_none(), "bundles carry no name");
    assert_eq!(parsed["rom"]["path"], "game.bin");
    assert_eq!(parsed["rom"]["checksRef"], "rom");
    assert_eq!(
        bundle_check_state(parsed, "rom")["checks"]["checksums"]["crc32"],
        crc32_hex(BUNDLE_ROM_BYTES).as_str()
    );
    assert_eq!(
        bundle_check_state(parsed, "rom")["checks"]["size"],
        BUNDLE_ROM_BYTES.len() as u64
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
fn bundle_create_upgrades_v1_with_auto_basis_and_omits_redundant_entry_basis() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let patch = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let spec = temp.child("v1.json");
    let output = temp.child("rom-weaver-bundle.json");
    fs::write(
        spec.path(),
        format!(
            r#"{{
              "$schema": "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-bundle-v1.schema.json",
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
            "bundle",
            "create",
            "--from",
            spec.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let bundle = &events.last().expect("terminal")["details"]["bundle_create"]["bundle"];
    assert_eq!(bundle["version"], 2);
    assert_eq!(bundle["patchBasis"], "auto");
    assert_eq!(
        bundle["$schema"],
        "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/rom-weaver-bundle-v2.schema.json"
    );
    assert_eq!(bundle["patches"][0]["basis"], "base");

    let base_output = temp.child("base.json");
    let events = run_json_events(
        &[
            "bundle",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--patch",
            patch.to_str().expect("path"),
            "--patch-basis",
            "base",
            "--output",
            base_output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let bundle = &events.last().expect("terminal")["details"]["bundle_create"]["bundle"];
    assert_eq!(bundle["patchBasis"], "auto");
    assert_eq!(bundle["patches"][0]["basis"], "base");
}

#[test]
fn bundle_create_uses_cached_rom_checks_and_size() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let patch = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let bundle_out = temp.child("rom-weaver-bundle.json");
    let cached_crc = "deadbeef";
    let cached_md5 = "00112233445566778899aabbccddeeff";
    let cached_sha1 = "00112233445566778899aabbccddeeff00112233";

    run_json_events(
        &[
            "bundle",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--assume-in",
            &format!("crc32={cached_crc},md5={cached_md5},sha1={cached_sha1},size=999"),
            "--patch",
            patch.to_str().expect("path"),
            "--output",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let parsed = &events.last().expect("terminal")["details"]["bundle"]["bundle"];
    let rom_checks = &bundle_check_state(parsed, "rom")["checks"];
    assert_eq!(rom_checks["checksums"]["crc32"], cached_crc);
    assert_eq!(rom_checks["checksums"]["md5"], cached_md5);
    assert_eq!(rom_checks["checksums"]["sha1"], cached_sha1);
    assert_eq!(rom_checks["size"], 999);
}

#[test]
fn bundle_create_gzip_output_parses_back() {
    let temp = setup_temp_dir();
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let bundle_out = temp.child("rom-weaver-bundle.json.gz");

    run_json_events(
        &[
            "bundle",
            "create",
            "--patch",
            main.to_str().expect("path"),
            "--output",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let result = &events.last().expect("terminal")["details"]["bundle"];
    assert_eq!(result["source_kind"], "compressed-json");
    assert_eq!(result["bundle"]["patches"][0]["path"], "main.ips");
}

#[test]
fn bundle_create_bundle_roundtrips_through_apply() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let bundle_out = temp.child("rom-weaver-bundle.json");
    let bundle = temp.child("bundle.zip");

    let events = run_json_events(
        &[
            "bundle",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--patch",
            main.to_str().expect("path"),
            "--output",
            bundle_out.path().to_str().expect("path"),
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["details"]["bundle_create"]["archive_path"]
            .as_str()
            .expect("bundle path")
            .ends_with("bundle.zip")
    );

    let output = temp.child("patched.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_create_reuses_equal_payloads_and_disambiguates_same_basename() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
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
    let bundle_json = temp.child("rom-weaver-bundle.json");
    let archive = temp.child("bundle.zip");
    let events = run_json_events(
        &[
            "bundle",
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
            bundle_json.path().to_str().expect("path"),
            "--bundle",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let bundle = &events.last().expect("terminal")["details"]["bundle_create"]["bundle"];
    let paths: Vec<&str> = bundle["patches"]
        .as_array()
        .expect("patches")
        .iter()
        .map(|patch| patch["path"].as_str().expect("bundle path"))
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
fn bundle_create_from_preserves_shared_size_only_check_state() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
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
    ).expect("source bundle");
    let output = temp.child("rom-weaver-bundle.json");
    let events = run_json_events(
        &[
            "bundle",
            "create",
            "--from",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let bundle = &events.last().expect("terminal")["details"]["bundle_create"]["bundle"];
    assert_eq!(bundle["rom"]["checksRef"], "rom");
    assert_eq!(bundle["patches"][0]["inputChecksRef"], "rom");
    assert_eq!(bundle_check_state(bundle, "rom")["checks"]["size"], 16);
}

#[test]
fn bundle_create_from_preserves_an_explicit_shared_input_state_without_basis_inference() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
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
    .expect("source bundle");
    let output = temp.child("rom-weaver-bundle.json");
    let events = run_json_events(
        &[
            "bundle",
            "create",
            "--from",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let bundle = &events.last().expect("terminal")["details"]["bundle_create"]["bundle"];
    assert_eq!(bundle["patches"][0]["inputChecksRef"], "shared-size");
    assert_eq!(bundle["patches"][1]["inputChecksRef"], "shared-size");
    assert_eq!(
        bundle_check_state(bundle, "shared-size")["checks"]["size"],
        16
    );
}

#[test]
fn bundle_create_keeps_equal_checks_for_a_different_rom_member() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
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
    ).expect("source bundle");
    let output = temp.child("rom-weaver-bundle.json");
    let events = run_json_events(
        &[
            "bundle",
            "create",
            "--from",
            source.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let bundle = &events.last().expect("terminal")["details"]["bundle_create"]["bundle"];
    assert_eq!(bundle["patches"][0]["inputChecksRef"], "patch:main:input");
    assert_eq!(
        bundle_check_state(bundle, "patch:main:input")["checks"]["size"],
        16
    );
}

#[test]
fn bundle_create_patch_check_emits_checks_and_apply_enforces() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let bundle_out = temp.child("rom-weaver-bundle.json");

    run_json_events(
        &[
            "bundle",
            "create",
            "--patch",
            main.to_str().expect("path"),
            "--patch-expect-in",
            "crc32=00000000",
            "--output",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let entry = &events.last().expect("terminal")["details"]["bundle"]["bundle"]["patches"][0];
    assert_eq!(entry["inputChecksRef"], "patch:0:input");
    let parsed = &events.last().expect("terminal")["details"]["bundle"]["bundle"];
    assert_eq!(
        bundle_check_state(parsed, "patch:0:input")["checks"]["checksums"]["crc32"],
        "00000000"
    );

    // The deliberately wrong expected checksum must fail the apply.
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("game.bin").path().to_str().expect("path"),
            "--bundle",
            bundle_out.path().to_str().expect("path"),
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_create_no_bundle_rom_emits_checks_only_entry() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let bundle_out = temp.child("rom-weaver-bundle.json");
    let bundle = temp.child("bundle.zip");

    run_json_events(
        &[
            "bundle",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--no-bundle-rom",
            "--patch",
            main.to_str().expect("path"),
            "--output",
            bundle_out.path().to_str().expect("path"),
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let result = &events.last().expect("terminal")["details"]["bundle"];
    let rom_entry = &result["bundle"]["rom"];
    assert!(
        rom_entry["path"].is_null() && rom_entry["url"].is_null(),
        "no-bundle-rom entry must be sourceless: {rom_entry}"
    );
    assert_eq!(rom_entry["checksRef"], "rom");
    assert_eq!(
        bundle_check_state(&result["bundle"], "rom")["checks"]["checksums"]["crc32"],
        crc32_hex(BUNDLE_ROM_BYTES).as_str()
    );
    assert_eq!(rom_entry["name"], "game.bin");
    assert!(result["rom_source"].is_null(), "no rom source to resolve");

    // The applying user supplies the ROM; the bundle is patches-only.
    let output = temp.child("patched.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("path"),
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );

    // Using the patches-only bundle as the apply input has no ROM to patch.
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.path().to_str().expect("path"),
            "--output",
            temp.child("nope.bin").path().to_str().expect("path"),
            "--json",
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
    let expected_crc = crc32_hex(BUNDLE_ROM_BYTES);
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
fn bundle_apply_warns_but_succeeds_when_rom_name_differs() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let bundle = temp.child("rom-weaver-bundle.json");

    run_json_events(
        &[
            "bundle",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--no-bundle-rom",
            "--rom-name",
            "expected.bin",
            "--patch",
            main.to_str().expect("path"),
            "--output",
            bundle.path().to_str().expect("path"),
            "--json",
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
            "--bundle",
            bundle.path().to_str().expect("path"),
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
        stderr.contains("bundle ROM name mismatch")
            && stderr.contains("expected.bin")
            && stderr.contains("game.bin"),
        "expected advisory name warning, got: {stderr}"
    );

    run_json_events(
        &[
            "bundle",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--no-bundle-rom",
            "--rom-name",
            "GAME.BIN",
            "--patch",
            main.to_str().expect("path"),
            // Rewriting the bundle from the first half of this test now needs
            // --force: `bundle create` refuses to clobber an existing output.
            "--force",
            "--output",
            bundle.path().to_str().expect("path"),
            "--json",
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
            "--bundle",
            bundle.path().to_str().expect("path"),
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
        !stderr.contains("bundle ROM name mismatch"),
        "case-only difference must match: {stderr}"
    );
}

#[test]
fn bundle_create_empty_rom_name_suppresses_the_default() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let patch = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let bundle = temp.child("rom-weaver-bundle.json");

    run_json_events(
        &[
            "bundle",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--no-bundle-rom",
            "--rom-name",
            "",
            "--patch",
            patch.to_str().expect("path"),
            "--output",
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let parsed: serde_json::Value =
        serde_json::from_slice(&fs::read(bundle.path()).expect("bundle bytes"))
            .expect("bundle json");
    assert!(
        parsed["rom"].get("name").is_none(),
        "an explicitly cleared name must stay absent: {}",
        parsed["rom"]
    );
}

#[test]
fn bundle_apply_enforces_mid_chain_declared_input_checks() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    let bundle = temp.child("rom-weaver-bundle.json");
    // The second entry declares an impossible mid-chain input state: strict
    // apply must verify it against the real intermediate and stop the chain.
    fs::write(
        bundle.path(),
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
    .expect("bundle fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.path().to_str().expect("path"),
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_apply_named_patch_input_uses_producer_bytes_not_current_chain_bytes() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "a.ips", 0, 0xAA);
    write_offset_ips(&temp, "b.ips", 1, 0xBB);
    write_offset_ips(&temp, "c.ips", 2, 0xCC);
    let bundle = temp.child("rom-weaver-bundle.json");
    fs::write(
        bundle.path(),
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
    .expect("bundle fixture");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.path().to_str().expect("path"),
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_apply_rom_member_selects_the_exact_archive_entry() {
    let temp = setup_temp_dir();
    let unwanted = temp.child("unwanted.bin");
    fs::write(unwanted.path(), BUNDLE_ROM_BYTES).expect("unwanted ROM fixture");
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
    let bundle = temp.child("rom-weaver-bundle.json");
    fs::write(
        bundle.path(),
        r#"{
            "version": 2,
            "patchBasis": "base",
            "rom": { "member": "roms/wanted.bin" },
            "patches": [{ "id": "main", "path": "main.ips", "input": { "rom": true } }]
        }"#,
    )
    .expect("bundle fixture");
    let output = temp.child("out.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_apply_verifies_checks_for_the_explicit_rom_member() {
    let temp = setup_temp_dir();
    let root = temp.child("root.bin");
    fs::write(root.path(), BUNDLE_ROM_BYTES).expect("root ROM fixture");
    let selected = temp.child("selected.bin");
    let selected_bytes = patched_rom_bytes(&[(1, 0x11)]);
    fs::write(selected.path(), &selected_bytes).expect("selected ROM fixture");
    let archive = temp.child("roms.tar.gz");
    write_tar_gz_fixture(
        &[(root.path(), "root.bin"), (selected.path(), "selected.bin")],
        archive.path(),
    );
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let bundle = temp.child("rom-weaver-bundle.json");
    fs::write(
        bundle.path(),
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
    ).expect("bundle fixture");
    let output = temp.child("out.bin");
    run_json_events(
        &[
            "patch-apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read(output.path()).expect("output"),
        patched_rom_bytes(&[(0, 0xAA), (1, 0x11)])
    );
}

#[test]
fn bundle_apply_rejects_disabled_named_patch_input_producer() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "a.ips", 0, 0xAA);
    write_offset_ips(&temp, "c.ips", 2, 0xCC);
    let bundle = temp.child("rom-weaver-bundle.json");
    fs::write(
        bundle.path(),
        r#"{ "version": 2, "patchBasis": "previous", "patches": [
            { "id": "a", "path": "a.ips", "optional": true, "input": { "rom": true } },
            { "id": "c", "path": "c.ips", "input": { "patch": "a" } }
        ] }"#,
    )
    .expect("bundle fixture");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("path"),
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_create_keeps_implicit_chain_inputs_implicit_across_optional_steps() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let a = write_offset_ips(&temp, "a.ips", 0, 0xAA);
    let b = write_offset_ips(&temp, "b.ips", 1, 0xBB);
    let c = write_offset_ips(&temp, "c.ips", 2, 0xCC);
    let bundle = temp.child("rom-weaver-bundle.json");
    run_json_events(
        &[
            "bundle",
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
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let parsed = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let recipe = &parsed.last().expect("terminal")["details"]["bundle"]["bundle"];
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
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read(output.path()).expect("output"),
        patched_rom_bytes(&[(0, 0xAA), (2, 0xCC)])
    );
}

#[test]
fn bundle_input_checks_block_conflicting_embedded_base_inference() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let mid = temp.child("mid.bin");
    let mut mid_bytes = BUNDLE_ROM_BYTES.to_vec();
    mid_bytes[0] = 0xAA;
    fs::write(mid.path(), &mid_bytes).expect("mid fixture");
    let target = temp.child("target.bin");
    let mut target_bytes = BUNDLE_ROM_BYTES.to_vec();
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
        temp.child("rom-weaver-bundle.json").path(),
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
    .expect("bundle fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
        temp.child("rom-weaver-bundle.json").path(),
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
            crc32_hex(BUNDLE_ROM_BYTES)
        ),
    )
    .expect("bundle fixture");
    let inferred_base = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            temp.child("inferred-base-out.bin")
                .path()
                .to_str()
                .expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_apply_base_basis_verifies_declared_checks_against_the_rom() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    let rom_crc = crc32_hex(BUNDLE_ROM_BYTES);
    let out = temp.child("out.bin");

    // The second entry's declared input state IS the base ROM. Left to the
    // default previous basis, that check runs against the intermediate and
    // fails; declared as base it verifies against the ROM once and the chain
    // succeeds with the step's state checks stood down.
    let write_bundle = |basis_field: &str, input_crc: &str| {
        fs::write(
            temp.child("rom-weaver-bundle.json").path(),
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
        .expect("bundle fixture");
    };

    write_bundle("", &rom_crc);
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            out.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );
    assert!(
        events.last().expect("terminal")["label"]
            .as_str()
            .expect("label")
            .contains("patch.chain.input_mismatch")
    );

    write_bundle(r#", "basis": "base""#, &rom_crc);
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            out.path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
    write_bundle(r#", "basis": "base""#, "00000000");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            out.path().to_str().expect("path"),
            // The successful run above wrote this output; patch apply now
            // refuses to overwrite without --force.
            "--force",
            "--no-compress",
            "--json",
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
fn bundle_declared_base_conflict_is_rejected_and_cli_auto_clears_the_declaration() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let mid = temp.child("mid.bin");
    let mut mid_bytes = BUNDLE_ROM_BYTES.to_vec();
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
    let bundle = temp.child("rom-weaver-bundle.json");

    // A bundle declaration may add evidence, but it cannot turn a patch whose
    // embedded source is the intermediate into a Base-authored patch.
    fs::write(
        bundle.path(),
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
            crc32_hex(BUNDLE_ROM_BYTES)
        ),
    )
    .expect("bundle fixture");
    let conflict = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.path().to_str().expect("path"),
            "--output",
            temp.child("conflict.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
    // bundle pin and lets the embedded endpoints recover the real chain.
    fs::write(
        bundle.path(),
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
    .expect("bundle fixture");
    let stale = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.path().to_str().expect("path"),
            "--output",
            temp.child("stale.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
            bundle.path().to_str().expect("path"),
            "--default-patch-basis",
            "auto",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    assert_eq!(automatic.last().expect("terminal")["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), target_bytes);
}

#[test]
fn bundle_v2_patch_basis_precedence_is_patch_cli_shared_entry_then_bundle() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let mid = temp.child("mid.bin");
    let mut mid_bytes = BUNDLE_ROM_BYTES.to_vec();
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
    let bundle = temp.child("rom-weaver-bundle.json");
    fs::write(
        bundle.path(),
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
    .expect("bundle fixture");

    let entry_override = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.path().to_str().expect("path"),
            "--output",
            temp.child("entry.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
            bundle.path().to_str().expect("path"),
            "--default-patch-basis",
            "base",
            "--output",
            temp.child("shared.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
            bundle.path().to_str().expect("path"),
            "--default-patch-basis",
            "base",
            "--patch-basis",
            "base",
            "--patch-basis",
            "auto",
            "--output",
            temp.child("patch.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn patch_apply_emit_bundle_preserves_per_patch_basis_overrides() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let mid = temp.child("mid.bin");
    let mut mid_bytes = BUNDLE_ROM_BYTES.to_vec();
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
    let source_bundle = temp.child("source-bundle.json");
    fs::write(
        source_bundle.path(),
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
    .expect("bundle fixture");

    let emitted = temp.child("emitted-bundle.json");
    let output = temp.child("output.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            source_bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--emit-bundle",
            emitted.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let terminal = events
        .iter()
        .find(|event| event["command"] == "patch-apply" && event["status"] != "running")
        .expect("patch-apply terminal");
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), target_bytes);

    let emitted_json: Value = serde_json::from_slice(&fs::read(emitted.path()).expect("bundle"))
        .expect("valid emitted bundle");
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
            "--json",
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
fn bundle_ignore_mode_does_not_use_stale_output_checks_to_select_rup_direction() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
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
    let bundle = temp.child("rom-weaver-bundle.json");
    fs::write(
        bundle.path(),
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
    .expect("bundle fixture");

    let output = temp.child("out.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--ignore-checksum-validation",
            "--no-compress",
            "--json",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), target_bytes);
}

#[test]
fn bundle_create_dedups_endpoint_checks_and_apply_validates_output() {
    let temp = setup_temp_dir();
    let rom = write_bundle_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let extra = write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    let bundle_out = temp.child("rom-weaver-bundle.json");
    let rom_crc = crc32_hex(BUNDLE_ROM_BYTES);
    let mid_crc = crc32_hex(&patched_rom_bytes(&[(0, 0xAA)]));
    let final_crc = crc32_hex(&patched_rom_bytes(&[(0, 0xAA), (1, 0xBB)]));

    run_json_events(
        &[
            "bundle",
            "create",
            "--input",
            rom.to_str().expect("path"),
            "--patch",
            main.to_str().expect("path"),
            "--patch-expect-in",
            &format!("crc32={rom_crc}"),
            "--patch-expect-out",
            &format!("crc32={mid_crc}"),
            "--patch",
            extra.to_str().expect("path"),
            "--patch-expect-in",
            &format!("crc32={mid_crc}"),
            "--patch-expect-out",
            &format!("crc32={final_crc}"),
            "--default-patch-basis",
            "previous",
            "--expect-out",
            &format!("crc32={final_crc}"),
            "--output",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let parsed = &events.last().expect("terminal")["details"]["bundle"]["bundle"];
    // Endpoint checks live on rom/output; only mid-chain states stay on the
    // patches (first input == rom.checks, last output == output.checks, so
    // output.checksRef names the last patch's output state).
    assert_eq!(parsed["output"]["checksRef"], "patch:1:output");
    assert_eq!(
        bundle_check_state(parsed, "patch:1:output")["checks"]["checksums"]["crc32"],
        final_crc
    );
    let first = &parsed["patches"][0];
    assert!(
        first.get("inputChecks").is_none(),
        "first patch relies on rom.checks: {first}"
    );
    assert_eq!(first["outputChecksRef"], "patch:0:output");
    assert_eq!(
        bundle_check_state(parsed, "patch:0:output")["checks"]["checksums"]["crc32"],
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
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA), (1, 0xBB)])
    );

    // A partial selection validates against ITS last patch's outputChecks...
    let partial_bundle = fs::read_to_string(bundle_out.path())
        .expect("bundle readable")
        .replace(
            &format!("\"crc32\": \"{mid_crc}\""),
            "\"crc32\": \"00000000\"",
        );
    // ...so corrupting the first patch's recorded outputChecks fails a
    // main-only apply with the recorded (wrong) expectation.
    fs::write(temp.child("rom-weaver-bundle.json").path(), partial_bundle).expect("bundle rewrite");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--without",
            "extra*",
            "--output",
            temp.child("partial.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_apply_partial_chain_skips_full_chain_output_checks() {
    // output.checks records the FULL chain's result. A partial selection that
    // happens to end on the final entry (earlier patches skipped) produces a
    // different, legitimate output and must not be gated by it.
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    fs::write(
        temp.child("rom-weaver-bundle.json").path(),
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
    .expect("bundle fixture");
    let output = temp.child("partial.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-bundle.json")
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
            "--json",
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
fn bundle_apply_non_prefix_selection_skips_entry_output_checks() {
    // A patch entry's outputChecks describe the state after applying the chain
    // UP TO it. A selection that skips an earlier optional but still ends on
    // that entry produces a different, legitimate result - the recorded hash
    // must not gate it. The same hash MUST gate the true prefix selection.
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    write_offset_ips(&temp, "final.ips", 2, 0xCC);
    fs::write(
        temp.child("rom-weaver-bundle.json").path(),
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
    .expect("bundle fixture");

    // Skipping the middle optional: {main, final} is not the chain prefix
    // ending at `final`, so its (deliberately wrong) outputChecks stand down.
    let output = temp.child("skip-middle.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
            temp.child("rom-weaver-bundle.json")
                .path()
                .to_str()
                .expect("path"),
            "--with",
            "extra",
            "--output",
            temp.child("full-chain.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
fn bundle_create_source_url_emits_url_entry() {
    let temp = setup_temp_dir();
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let bundle_out = temp.child("rom-weaver-bundle.json");

    run_json_events(
        &[
            "bundle",
            "create",
            "--patch",
            main.to_str().expect("path"),
            "--patch-source-url",
            "https://example.test/patches/main.ips",
            "--output",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "bundle",
            "parse",
            "--input",
            bundle_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let entry = &events.last().expect("terminal")["details"]["bundle"]["bundle"]["patches"][0];
    assert_eq!(entry["url"], "https://example.test/patches/main.ips");
    assert!(entry["path"].is_null());
}

#[test]
fn bundle_target_chains_follow_optional_selection_after_create() {
    let temp = setup_temp_dir();
    let first = write_bundle_rom(&temp, "first.bin");
    let second = temp.child("second.bin");
    let second_bytes = vec![0x77; BUNDLE_ROM_BYTES.len()];
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
    let bundle = temp.child("rom-weaver-bundle.json");
    command_stdout(
        &[
            "bundle",
            "create",
            "--from",
            spec.path().to_str().expect("path"),
            "--output",
            bundle.path().to_str().expect("path"),
        ],
        0,
    );
    let created: serde_json::Value =
        serde_json::from_slice(&fs::read(bundle.path()).expect("bundle")).expect("JSON");
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
                "--bundle",
                bundle.path().to_str().expect("path"),
                option,
                "b.ips",
                "--output",
                output.path().to_str().expect("path"),
                "--no-compress",
                "--json",
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
fn bundle_generated_output_members_support_fixed_and_cumulative_inputs() {
    let temp = setup_temp_dir();
    write_bundle_rom(&temp, "game.bin");
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
        let bundle = temp.child(format!("{field}.json"));
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
            bundle.path(),
            serde_json::to_vec(&recipe).expect("recipe JSON"),
        )
        .expect("bundle");
        let output = temp.child(format!("out-{field}.bin"));
        run_json_events(
            &[
                "patch",
                "apply",
                "--input",
                bundle.path().to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--no-compress",
                "--json",
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

/// The bundle names the first track; the database record then supplies the
/// second track's checks to the lane that patches it.
fn two_track_bundle(temp: &TempDir, track01_crc32: &str, track01_size: u64) -> PathBuf {
    write_offset_ips(temp, "first.ips", 100, 0xAA);
    write_offset_ips(temp, "second.ips", 100, 0xBB);
    let bundle = temp.child("rom-weaver-bundle.json");
    fs::write(
        bundle.path(),
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
    .expect("bundle");
    bundle.path().to_path_buf()
}

#[test]
fn bundle_member_lane_checks_filled_from_identify_data_pass_on_the_real_track() {
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
    let bundle = two_track_bundle(&temp, &track01_crc32, track01_size);
    let output = temp.child("raw/disc.cue");
    let events = run_json_events_with_env(
        &[
            "patch",
            "apply",
            "--input",
            source.child("disc.cue").path().to_str().expect("path"),
            "--bundle",
            bundle.to_str().expect("path"),
            "--target",
            "track01.bin",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        &[(
            "ROM_WEAVER_DATA_DIR",
            data_dir.path().to_str().expect("path"),
        )],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
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
fn bundle_member_lane_checks_filled_from_identify_data_name_the_expected_title() {
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
    let bundle = two_track_bundle(&temp, &track01_crc32, track01_size);
    let events = run_json_events_with_env(
        &[
            "patch",
            "apply",
            "--input",
            source.child("disc.cue").path().to_str().expect("path"),
            "--bundle",
            bundle.to_str().expect("path"),
            "--target",
            "track01.bin",
            "--output",
            temp.child("raw/disc.cue").path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
            "--bundle",
            bundle.to_str().expect("path"),
            "--target",
            "track01.bin",
            "--output",
            temp.child("raw-no-db/disc.cue")
                .path()
                .to_str()
                .expect("path"),
            "--no-compress",
            "--json",
        ],
        &[(
            "ROM_WEAVER_DATA_DIR",
            empty_data_dir.path().to_str().expect("path"),
        )],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
}

#[test]
fn bundle_disc_targets_preserve_all_tracks_and_chd_parity() {
    let source = setup_temp_dir();
    let (mut expected_first, mut expected_second) = super::patch_disc::write_two_track_cd(&source);
    let temp = setup_temp_dir();
    write_offset_ips(&temp, "first.ips", 100, 0xAA);
    write_offset_ips(&temp, "second.ips", 100, 0xBB);
    let bundle = temp.child("rom-weaver-bundle.json");
    fs::write(
        bundle.path(),
        r#"{
        "version":2,"patchBasis":"auto",
        "rom":{"member":"track01.bin"},
        "patches":[
            {"id":"first","path":"first.ips","target":{"rom":true,"member":"track01.bin"}},
            {"id":"second","path":"second.ips","target":{"rom":true,"member":"track02.bin"}}
        ]
    }"#,
    )
    .expect("bundle");
    let output = temp.child("raw/disc.cue");
    run_json_events(
        &[
            "patch",
            "apply",
            "--input",
            source.child("disc.cue").path().to_str().expect("path"),
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--target",
            "track01.bin",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
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
            "--bundle",
            bundle.path().to_str().expect("path"),
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
            "--json",
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
fn bundle_target_lane_verifies_bps_base_and_previous_states() {
    let temp = setup_temp_dir();
    let first = write_bundle_rom(&temp, "first.bin");
    let second = temp.child("second.bin");
    let second_bytes = vec![0x31; BUNDLE_ROM_BYTES.len()];
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
    let bundle = temp.child("rom-weaver-bundle.json");
    fs::write(
        bundle.path(),
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
    .expect("bundle");
    let output = temp.child("out.bin");
    run_json_events(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    assert_eq!(fs::read(output.path()).expect("output"), final_bytes);
}

#[test]
fn bundle_target_lane_endpoint_checks_run_before_a_later_lane() {
    let temp = setup_temp_dir();
    let first = write_bundle_rom(&temp, "first.bin");
    let second = temp.child("second.bin");
    let second_bytes = vec![0x55; BUNDLE_ROM_BYTES.len()];
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
    let bundle = temp.child("rom-weaver-bundle.json");
    let write_bundle =
        |first_output_crc: &str, second_output_crc: &str, bundle_output_crc: Option<&str>| {
            let output_section = bundle_output_crc.map_or_else(String::new, |crc| {
            format!(
                ", \"output\": {{ \"checks\": {{ \"checksums\": {{ \"crc32\": \"{crc}\" }} }} }}"
            )
        });
            fs::write(
                bundle.path(),
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
            .expect("bundle");
        };
    let mut expected = second_bytes.clone();
    expected[1] = 0xDD;
    write_bundle("00000000", &crc32_hex(&expected), None);
    let output = temp.child("out.bin");
    let failed = run_json_events(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );
    assert!(
        failed.last().expect("terminal")["label"]
            .as_str()
            .expect("label")
            .contains("patch.chain.output_mismatch")
    );

    write_bundle(
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
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--force",
            "--no-compress",
            "--json",
        ],
        0,
    );
    assert_eq!(fs::read(output.path()).expect("output"), expected);

    write_bundle(
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
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--force",
            "--no-compress",
            "--json",
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
