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
fn manifest_parse_plain_json_resolves_refs_verbatim() {
    let temp = setup_temp_dir();
    let manifest = temp.child("rw.json");
    fs::write(
        manifest.path(),
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
    .expect("manifest fixture");

    let events = run_json_events(
        &[
            "manifest",
            "parse",
            manifest.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["manifest"];
    assert_eq!(result["source_kind"], "json");
    assert_eq!(result["manifest"]["version"], 1);
    assert!(
        result["manifest"].get("name").is_none(),
        "manifests carry no display name"
    );
    assert!(
        result["manifest"]["patches"][0].get("optional").is_none(),
        "non-optional patches omit the flag"
    );
    assert_eq!(result["manifest"]["patches"][1]["optional"], true);
    assert_eq!(result["manifest"]["patches"][0]["label"], "stable");
    assert!(result["manifest"]["output"].get("compress").is_none());
    assert_eq!(
        result["rom_source"]["url"], "https://example.test/roms/game.sfc",
        "url refs pass through verbatim"
    );
    assert_eq!(
        result["patch_sources"][0]["source"]["path"], "main.ips",
        "path refs stay manifest-relative for a plain manifest"
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
fn manifest_parse_reads_gzipped_manifest() {
    let temp = setup_temp_dir();
    let manifest = temp.child("rw.json.gz");
    let json = r#"{ "version": 1, "patches": [ { "path": "main.ips" } ] }"#;
    let file = File::create(manifest.path()).expect("create rw.json.gz");
    let mut encoder = GzEncoder::new(file, DeflateCompression::default());
    encoder.write_all(json.as_bytes()).expect("gzip manifest");
    encoder.finish().expect("finish gzip manifest");

    let events = run_json_events(
        &[
            "manifest",
            "parse",
            manifest.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["manifest"];
    assert_eq!(result["source_kind"], "compressed-json");
    assert_eq!(result["manifest"]["patches"][0]["path"], "main.ips");
}

#[test]
fn manifest_parse_archive_extracts_referenced_members() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"0123456789abcdef").expect("rom fixture");
    let patch_path = write_min_ips(&temp, "main.ips");
    let manifest = temp.child("rw.json");
    fs::write(
        manifest.path(),
        r#"{
            "version": 1,
            "rom": { "path": "roms/game.bin" },
            "patches": [ { "path": "patches/main.ips", "description": "main hack" } ]
        }"#,
    )
    .expect("manifest fixture");
    let bundle = temp.child("bundle.tar.gz");
    write_tar_gz_fixture(
        &[
            (manifest.path(), "rw.json"),
            (rom.path(), "roms/game.bin"),
            (&patch_path, "patches/main.ips"),
        ],
        bundle.path(),
    );
    let extract_dir = temp.child("manifest-out");

    let events = run_json_events(
        &[
            "manifest",
            "parse",
            bundle.path().to_str().expect("path"),
            "--extract-dir",
            extract_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["manifest"];
    assert_eq!(result["source_kind"], "archive");
    assert_eq!(result["archive_member"], "rw.json");

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
fn manifest_parse_archive_without_manifest_fails() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"0123456789abcdef").expect("rom fixture");
    let bundle = temp.child("bundle.tar.gz");
    write_tar_gz_fixture(&[(rom.path(), "roms/game.bin")], bundle.path());

    let events = run_json_events(
        &[
            "manifest",
            "parse",
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("failure label");
    assert!(
        label.contains("manifest.missing"),
        "expected manifest.missing code in label: {label}"
    );
}

const MANIFEST_ROM_BYTES: &[u8] = b"0123456789abcdef";

fn write_manifest_rom(temp: &TempDir, name: &str) -> PathBuf {
    let rom = temp.child(name);
    fs::write(rom.path(), MANIFEST_ROM_BYTES).expect("rom fixture");
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

fn patched_rom_bytes(edits: &[(usize, u8)]) -> Vec<u8> {
    let mut bytes = MANIFEST_ROM_BYTES.to_vec();
    for (offset, value) in edits {
        bytes[*offset] = *value;
    }
    bytes
}

#[test]
fn manifest_apply_plain_manifest_input_uses_output_name() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "name": "out.bin" }
        }"#,
    )
    .expect("manifest fixture");

    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.current_dir(temp.path());
    command.args([
        "patch",
        "apply",
        "--input",
        "rw.json",
        "--no-compress",
        "--json",
    ]);
    let stdout = command.assert().code(0).get_output().stdout.clone();
    let terminal = parse_json_lines(&stdout).last().expect("terminal").clone();
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("out.bin").path()).expect("manifest-named output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn manifest_apply_gzipped_manifest_with_cli_output() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let manifest = temp.child("rw.json.gz");
    let json = r#"{ "version": 1,
                    "rom": { "path": "game.bin" },
                    "patches": [ { "path": "main.ips" } ],
                    "output": {} }"#;
    let file = File::create(manifest.path()).expect("create rw.json.gz");
    let mut encoder = GzEncoder::new(file, DeflateCompression::default());
    encoder.write_all(json.as_bytes()).expect("gzip manifest");
    encoder.finish().expect("finish gzip manifest");
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            manifest.path().to_str().expect("path"),
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

fn write_everything_archive(temp: &TempDir, manifest_json: &str) -> PathBuf {
    let rom = write_manifest_rom(temp, "game.bin");
    let main = write_offset_ips(temp, "main.ips", 0, 0xAA);
    let extra = write_offset_ips(temp, "extra.ips", 1, 0xBB);
    let manifest = temp.child("rw.json");
    fs::write(manifest.path(), manifest_json).expect("manifest fixture");
    let bundle = temp.child("bundle.tar.gz");
    write_tar_gz_fixture(
        &[
            (manifest.path(), "rw.json"),
            (&rom, "roms/game.bin"),
            (&main, "patches/main.ips"),
            (&extra, "patches/extra.ips"),
        ],
        bundle.path(),
    );
    bundle.path().to_path_buf()
}

const EVERYTHING_MANIFEST: &str = r#"{
    "version": 1,
    "rom": { "path": "roms/game.bin" },
    "patches": [
        { "path": "patches/main.ips",  "name": "Main hack" },
        { "path": "patches/extra.ips", "name": "Extra",     "optional": true }
    ],
    "output": {}
}"#;

#[test]
fn manifest_apply_everything_archive_skips_optional() {
    let temp = setup_temp_dir();
    let bundle = write_everything_archive(&temp, EVERYTHING_MANIFEST);
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
fn manifest_apply_with_flag_includes_optional() {
    let temp = setup_temp_dir();
    let bundle = write_everything_archive(&temp, EVERYTHING_MANIFEST);
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
fn manifest_apply_without_can_disable_default_patch() {
    let temp = setup_temp_dir();
    let bundle = write_everything_archive(&temp, EVERYTHING_MANIFEST);

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
fn manifest_apply_rom_checks_mismatch_fails() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin", "checks": { "checksums": { "crc32": "00000000" } } },
            "patches": [ { "path": "main.ips" } ],
            "output": {}
        }"#,
    )
    .expect("manifest fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rw.json").path().to_str().expect("path"),
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
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
fn manifest_apply_explicit_manifest_flag_keeps_input_rom() {
    let temp = setup_temp_dir();
    let rom = write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    // The manifest's rom entry points at a nonexistent URL host on purpose:
    // with --manifest the positional input supplies the ROM, so the rom
    // source must be ignored (its checks are not — none set here).
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "url": "https://example.test/never-fetched.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": {}
        }"#,
    )
    .expect("manifest fixture");
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("path"),
            "--manifest",
            temp.child("rw.json").path().to_str().expect("path"),
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
fn manifest_apply_cli_output_overrides_manifest_name() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "name": "manifest-named.bin" }
        }"#,
    )
    .expect("manifest fixture");
    let output = temp.child("cli-named.bin");

    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.current_dir(temp.path());
    command.args([
        "patch",
        "apply",
        "--input",
        "rw.json",
        "--output",
        "cli-named.bin",
        "--no-compress",
        "--json",
    ]);
    command.assert().code(0);
    assert!(output.path().is_file(), "explicit --output path must win");
    assert!(
        !temp.child("manifest-named.bin").path().exists(),
        "manifest output.name must not be written when --output is given"
    );
}

#[test]
fn manifest_apply_missing_output_fails_with_code() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": {}
        }"#,
    )
    .expect("manifest fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rw.json").path().to_str().expect("path"),
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
            .contains("manifest.output.missing"),
        "unexpected label: {}",
        terminal["label"]
    );
}

#[test]
fn manifest_parse_rejects_output_compression() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "name": "out.zip", "compress": { "format": "zip", "level": "min" } }
        }"#,
    )
    .expect("manifest fixture");

    let events = run_json_events(
        &[
            "manifest",
            "parse",
            temp.child("rw.json").path().to_str().expect("path"),
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

#[test]
fn manifest_apply_url_patch_downloads_and_applies() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    let patch_bytes = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: vec![0xAA],
        }],
        None,
    );
    let base_url = serve_files(vec![("/main.ips", patch_bytes)], 1);
    fs::write(
        temp.child("rw.json").path(),
        format!(
            r#"{{
                "version": 1,
                "rom": {{ "path": "game.bin" }},
                "patches": [ {{ "url": "{base_url}/main.ips" }} ],
                "output": {{}}
            }}"#
        ),
    )
    .expect("manifest fixture");
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rw.json").path().to_str().expect("path"),
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
fn manifest_apply_url_manifest_resolves_relative_entries() {
    let temp = setup_temp_dir();
    let rom = write_manifest_rom(&temp, "game.bin");
    let patch_bytes = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: vec![0xAA],
        }],
        None,
    );
    let manifest_json = br#"{
        "version": 1,
        "patches": [ { "url": "patches/main.ips" } ],
        "output": {}
    }"#
    .to_vec();
    let base_url = serve_files(
        vec![
            ("/rw.json", manifest_json),
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
            "--manifest",
            &format!("{base_url}/packs/rw.json"),
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
fn manifest_create_computes_checks_and_aligns_metadata() {
    let temp = setup_temp_dir();
    let rom = write_manifest_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let extra = write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    let manifest_out = temp.child("rw.json");

    let events = run_json_events(
        &[
            "manifest",
            "create",
            "--rom",
            rom.to_str().expect("path"),
            "--patch",
            main.to_str().expect("path"),
            "--patch-name",
            "Main hack",
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
            manifest_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "succeeded");
    let created = &terminal["details"]["manifest_create"];
    assert!(
        created["manifest_path"]
            .as_str()
            .expect("manifest path")
            .ends_with("rw.json")
    );

    // Round-trip through manifest parse and verify computed values.
    let events = run_json_events(
        &[
            "manifest",
            "parse",
            manifest_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let parsed = &events.last().expect("terminal")["details"]["manifest"]["manifest"];
    assert!(parsed.get("name").is_none(), "manifests carry no name");
    assert_eq!(parsed["rom"]["path"], "game.bin");
    assert_eq!(
        parsed["rom"]["checks"]["checksums"]["crc32"],
        crc32_hex(MANIFEST_ROM_BYTES).as_str()
    );
    assert_eq!(
        parsed["rom"]["checks"]["size"],
        MANIFEST_ROM_BYTES.len() as u64
    );
    let first = &parsed["patches"][0];
    assert_eq!(first["name"], "Main hack");
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
    assert_eq!(second["description"], "extra maps");
    assert!(second["name"].is_null());
    assert_eq!(parsed["output"]["name"], "patched.bin");
    assert!(parsed["output"].get("compress").is_none());
}

#[test]
fn manifest_create_gzip_output_parses_back() {
    let temp = setup_temp_dir();
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let manifest_out = temp.child("rw.json.gz");

    run_json_events(
        &[
            "manifest",
            "create",
            "--patch",
            main.to_str().expect("path"),
            "--output",
            manifest_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "manifest",
            "parse",
            manifest_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let result = &events.last().expect("terminal")["details"]["manifest"];
    assert_eq!(result["source_kind"], "compressed-json");
    assert_eq!(result["manifest"]["patches"][0]["path"], "main.ips");
}

#[test]
fn manifest_create_bundle_roundtrips_through_apply() {
    let temp = setup_temp_dir();
    let rom = write_manifest_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let manifest_out = temp.child("rw.json");
    let bundle = temp.child("bundle.zip");

    let events = run_json_events(
        &[
            "manifest",
            "create",
            "--rom",
            rom.to_str().expect("path"),
            "--patch",
            main.to_str().expect("path"),
            "--output",
            manifest_out.path().to_str().expect("path"),
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["details"]["manifest_create"]["bundle_path"]
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
fn manifest_create_patch_check_emits_checks_and_apply_enforces() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let manifest_out = temp.child("rw.json");

    run_json_events(
        &[
            "manifest",
            "create",
            "--patch",
            main.to_str().expect("path"),
            "--patch-input-check",
            "crc32=00000000",
            "--output",
            manifest_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "manifest",
            "parse",
            manifest_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let entry = &events.last().expect("terminal")["details"]["manifest"]["manifest"]["patches"][0];
    assert_eq!(entry["inputChecks"]["checksums"]["crc32"], "00000000");

    // The deliberately wrong expected checksum must fail the apply.
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("game.bin").path().to_str().expect("path"),
            "--manifest",
            manifest_out.path().to_str().expect("path"),
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
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
fn manifest_create_no_bundle_rom_emits_checks_only_entry() {
    let temp = setup_temp_dir();
    let rom = write_manifest_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let manifest_out = temp.child("rw.json");
    let bundle = temp.child("bundle.zip");

    run_json_events(
        &[
            "manifest",
            "create",
            "--rom",
            rom.to_str().expect("path"),
            "--no-bundle-rom",
            "--patch",
            main.to_str().expect("path"),
            "--output",
            manifest_out.path().to_str().expect("path"),
            "--bundle",
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "manifest",
            "parse",
            manifest_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let result = &events.last().expect("terminal")["details"]["manifest"];
    let rom_entry = &result["manifest"]["rom"];
    assert!(
        rom_entry["path"].is_null() && rom_entry["url"].is_null(),
        "no-bundle-rom entry must be sourceless: {rom_entry}"
    );
    assert_eq!(
        rom_entry["checks"]["checksums"]["crc32"],
        crc32_hex(MANIFEST_ROM_BYTES).as_str()
    );
    assert!(result["rom_source"].is_null(), "no rom source to resolve");

    // The applying user supplies the ROM; the bundle is patches-only.
    let output = temp.child("patched.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("path"),
            "--manifest",
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
    let expected_crc = crc32_hex(MANIFEST_ROM_BYTES);
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
fn manifest_create_dedups_endpoint_checks_and_apply_validates_output() {
    let temp = setup_temp_dir();
    let rom = write_manifest_rom(&temp, "game.bin");
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let extra = write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    let manifest_out = temp.child("rw.json");
    let rom_crc = crc32_hex(MANIFEST_ROM_BYTES);
    let mid_crc = crc32_hex(&patched_rom_bytes(&[(0, 0xAA)]));
    let final_crc = crc32_hex(&patched_rom_bytes(&[(0, 0xAA), (1, 0xBB)]));

    run_json_events(
        &[
            "manifest",
            "create",
            "--rom",
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
            "--output-check",
            &format!("crc32={final_crc}"),
            "--output",
            manifest_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "manifest",
            "parse",
            manifest_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let parsed = &events.last().expect("terminal")["details"]["manifest"]["manifest"];
    // Endpoint checks live on rom/output; only mid-chain states stay on the
    // patches (first input == rom.checks, last output == output.checks).
    assert_eq!(parsed["output"]["checks"]["checksums"]["crc32"], final_crc);
    let first = &parsed["patches"][0];
    assert!(
        first.get("inputChecks").is_none(),
        "first patch relies on rom.checks: {first}"
    );
    assert_eq!(first["outputChecks"]["checksums"]["crc32"], mid_crc);
    let second = &parsed["patches"][1];
    assert_eq!(second["inputChecks"]["checksums"]["crc32"], mid_crc);
    assert!(
        second.get("outputChecks").is_none(),
        "last patch's output is output.checks: {second}"
    );

    // Applying the full chain validates the final output against
    // output.checks and succeeds.
    let output = temp.child("patched.bin");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rw.json").path().to_str().expect("path"),
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
    let partial_manifest = fs::read_to_string(manifest_out.path())
        .expect("manifest readable")
        .replace(
            &format!("\"crc32\": \"{mid_crc}\""),
            "\"crc32\": \"00000000\"",
        );
    // ...so corrupting the first patch's recorded outputChecks fails a
    // main-only apply with the recorded (wrong) expectation.
    fs::write(temp.child("rw.json").path(), partial_manifest).expect("manifest rewrite");
    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rw.json").path().to_str().expect("path"),
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
fn manifest_apply_partial_chain_skips_full_chain_output_checks() {
    // output.checks records the FULL chain's result. A partial selection that
    // happens to end on the final entry (earlier patches skipped) produces a
    // different, legitimate output and must not be gated by it.
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    write_offset_ips(&temp, "extra.ips", 1, 0xBB);
    fs::write(
        temp.child("rw.json").path(),
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
    .expect("manifest fixture");
    let output = temp.child("partial.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rw.json").path().to_str().expect("path"),
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
fn manifest_create_source_url_emits_url_entry() {
    let temp = setup_temp_dir();
    let main = write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let manifest_out = temp.child("rw.json");

    run_json_events(
        &[
            "manifest",
            "create",
            "--patch",
            main.to_str().expect("path"),
            "--patch-source-url",
            "https://example.test/patches/main.ips",
            "--output",
            manifest_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let events = run_json_events(
        &[
            "manifest",
            "parse",
            manifest_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let entry = &events.last().expect("terminal")["details"]["manifest"]["manifest"]["patches"][0];
    assert_eq!(entry["url"], "https://example.test/patches/main.ips");
    assert!(entry["path"].is_null());
}
