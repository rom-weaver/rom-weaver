//! Native emulator smoke-test command coverage.

use std::os::unix::fs::PermissionsExt;

use assert_fs::fixture::PathCreateDir;
use sha2::{Digest, Sha256};

use super::shared::*;

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn runtime(temp: &TempDir, body: &str) -> PathBuf {
    let root = temp.child("runtime");
    let bin = root.child("bin");
    let cores = root.child("cores");
    bin.create_dir_all().expect("runtime bin");
    cores.create_dir_all().expect("runtime cores");
    let script = format!("#!/bin/sh\nset -eu\n{body}\n");
    let retroarch = bin.child("retroarch");
    fs::write(retroarch.path(), script.as_bytes()).expect("fake RetroArch");
    fs::set_permissions(retroarch.path(), fs::Permissions::from_mode(0o755))
        .expect("executable fake RetroArch");
    let core = cores.child("fceumm_libretro.so");
    fs::write(core.path(), b"fake core").expect("fake core");
    let manifest = serde_json::json!({
        "schemaVersion": 1, "platform": "linux-x64-gnu",
        "retroarch": {"path": "bin/retroarch", "revision": "1".repeat(40),
            "sha256": sha256(script.as_bytes())},
        "cores": [{"id": "fceumm", "platform": "nes",
            "path": "cores/fceumm_libretro.so", "revision": "2".repeat(40),
            "sha256": sha256(b"fake core")}],
    });
    fs::write(
        root.child("manifest.json").path(),
        serde_json::to_vec(&manifest).expect("manifest JSON"),
    )
    .expect("manifest");
    root.path().to_path_buf()
}

fn nes(temp: &TempDir) -> PathBuf {
    let path = temp.child("game with spaces.nes");
    let mut bytes = b"NES\x1a".to_vec();
    bytes.extend([0_u8; 12]);
    fs::write(path.path(), bytes).expect("NES fixture");
    path.path().to_path_buf()
}

fn run(temp: &TempDir, runtime: &Path, rom: &Path, extra: &[&str], code: i32) -> Value {
    let cache = temp.child("cache");
    cache.create_dir_all().expect("cache");
    let mut args = vec![
        "--json",
        "test",
        rom.to_str().expect("ROM path"),
        "--runtime-dir",
        runtime.to_str().expect("runtime path"),
    ];
    args.extend_from_slice(extra);
    run_json_events_with_env(
        &args,
        &[("XDG_CACHE_HOME", cache.path().to_str().expect("cache path"))],
        code,
    )
    .pop()
    .expect("terminal event")
}

#[test]
fn test_runs_fake_runtime_and_publishes_screenshot() {
    let temp = TempDir::new().expect("temp");
    let runtime = runtime(
        &temp,
        r#"shot=''
for arg in "$@"; do
  case "$arg" in --max-frames-ss-path=*) shot=${arg#*=};; esac
done
printf '\211PNG\015\012\032\0120000IHDR00000000000000000000IEND' > "$shot"
printf 'ran fake runtime\n'"#,
    );
    let rom = nes(&temp);
    let screenshot = temp.child("published frame.png");
    let event = run(
        &temp,
        &runtime,
        &rom,
        &[
            "--frames",
            "7",
            "--screenshot",
            screenshot.path().to_str().unwrap(),
        ],
        0,
    );
    assert_eq!(event["status"], "succeeded");
    assert_eq!(event["details"]["requested_frames"], 7);
    assert_eq!(event["details"]["status"], "smoke-tested");
    assert_eq!(event["details"]["core"], "fceumm");
    assert_eq!(
        event["details"]["screenshot"],
        screenshot.path().to_str().unwrap()
    );
    assert_eq!(
        event["details"]["screenshot_sha256"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert!(screenshot.path().is_file());
}

#[test]
fn test_rejects_non_nes_content_before_spawn() {
    let temp = TempDir::new().expect("temp");
    let marker = temp.child("spawned");
    let runtime = runtime(&temp, &format!("touch '{}'", marker.path().display()));
    let rom = temp.child("not-nes.nes");
    fs::write(rom.path(), b"not an NES ROM!!!").expect("invalid ROM");
    let event = run(&temp, &runtime, rom.path(), &[], 1);
    assert!(
        event["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not an iNES")
    );
    assert!(!marker.path().exists());
}

#[test]
fn test_reports_nonzero_exit_and_missing_png() {
    let temp = TempDir::new().expect("temp");
    let rom = nes(&temp);
    let failed = runtime(&temp, "printf 'runtime failed' >&2\nexit 9");
    let event = run(&temp, &failed, &rom, &[], 1);
    assert!(
        event["error"]["message"]
            .as_str()
            .unwrap()
            .contains("runtime failed")
    );

    fs::remove_dir_all(&failed).expect("replace runtime");
    let missing = runtime(&temp, "exit 0");
    let event = run(&temp, &missing, &rom, &[], 1);
    assert!(
        event["error"]["message"]
            .as_str()
            .unwrap()
            .contains("captured.png")
    );
}

#[test]
fn test_times_out_and_never_clobbers_output() {
    let temp = TempDir::new().expect("temp");
    let runtime = runtime(&temp, "sleep 5");
    let rom = nes(&temp);
    let started = std::time::Instant::now();
    let event = run(&temp, &runtime, &rom, &["--timeout", "1"], 1);
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert!(
        event["error"]["message"]
            .as_str()
            .unwrap()
            .contains("timed out after 1 seconds")
    );

    let output = temp.child("existing.png");
    fs::write(output.path(), b"keep me").expect("existing output");
    let event = run(
        &temp,
        &runtime,
        &rom,
        &["--screenshot", output.path().to_str().expect("output path")],
        1,
    );
    assert!(
        event["error"]["message"]
            .as_str()
            .unwrap()
            .contains("refusing to overwrite")
    );
    assert_eq!(fs::read(output.path()).unwrap(), b"keep me");
}

#[test]
fn test_dry_run_does_not_require_runtime_or_write() {
    let temp = TempDir::new().expect("temp");
    let output = temp.child("frame.png");
    let missing_rom = temp.child("missing.nes");
    let missing_runtime = temp.child("missing runtime");
    let event = run(
        &temp,
        missing_runtime.path(),
        missing_rom.path(),
        &["--dry-run", "--screenshot", output.path().to_str().unwrap()],
        0,
    );
    assert_eq!(event["details"]["dry_run"], true);
    assert_eq!(event["details"]["status"], "planned");
    assert!(!output.path().exists());
}

fn add_core(runtime: &Path, id: &str, extensions: &[&str], firmware: &[&str]) {
    let file = format!("cores/{id}_libretro.so");
    fs::write(runtime.join(&file), b"another core").unwrap();
    let path = runtime.join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["schemaVersion"] = serde_json::json!(2);
    manifest["cores"][0]["extensions"] = serde_json::json!(["nes"]);
    manifest["cores"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id": id, "platform": id, "path": file, "revision": "3".repeat(40),
            "sha256": sha256(b"another core"), "extensions": extensions, "firmware": firmware,
            "options": {"software_renderer": "enabled"}
        }));
    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
}

const CAPTURE: &str = r#"
for arg in "$@"; do
  case "$arg" in --max-frames-ss-path=*) shot=${arg#*=};; esac
done
printf '\211PNG\015\012\032\0120000IHDR00000000000000000000IEND' > "$shot"
"#;

#[test]
fn multiple_cores_select_by_extension_or_explicit_id() {
    let temp = TempDir::new().unwrap();
    let runtime = runtime(&temp, CAPTURE);
    add_core(&runtime, "gambatte", &["gb"], &[]);
    let rom = temp.child("game.gb");
    fs::write(rom.path(), b"a fake game boy ROM").unwrap();
    assert_eq!(
        run(&temp, &runtime, rom.path(), &[], 0)["details"]["core"],
        "gambatte"
    );
    add_core(&runtime, "mgba", &["gb", "gba"], &[]);
    let event = run(&temp, &runtime, rom.path(), &[], 1);
    assert!(
        event["error"]["message"]
            .as_str()
            .unwrap()
            .contains("pass --core")
    );
    assert_eq!(
        run(&temp, &runtime, rom.path(), &["--core", "mgba"], 0)["details"]["core"],
        "mgba"
    );
    let event = run(&temp, &runtime, rom.path(), &["--core", "missing"], 1);
    assert!(
        event["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not installed")
    );
}

#[test]
fn firmware_is_required_and_isolated_from_user_files() {
    let temp = TempDir::new().unwrap();
    let runtime = runtime(
        &temp,
        &format!("test -f system/boot.bin\nprintf modified > system/boot.bin\n{CAPTURE}"),
    );
    add_core(&runtime, "handy", &["lnx"], &["boot.bin"]);
    let rom = temp.child("game.lnx");
    fs::write(rom.path(), b"a fake lynx ROM").unwrap();
    let event = run(&temp, &runtime, rom.path(), &[], 1);
    assert!(
        event["error"]["message"]
            .as_str()
            .unwrap()
            .contains("requires firmware")
    );
    let system = temp.child("bios");
    system.create_dir_all().unwrap();
    fs::write(system.child("boot.bin").path(), b"original").unwrap();
    run(
        &temp,
        &runtime,
        rom.path(),
        &["--system-dir", system.path().to_str().unwrap()],
        0,
    );
    assert_eq!(
        fs::read(system.child("boot.bin").path()).unwrap(),
        b"original"
    );
}

#[test]
fn disc_sheets_keep_their_tracks_and_reject_escaping_references() {
    let temp = TempDir::new().unwrap();
    let runtime = runtime(
        &temp,
        &format!("test -f 'content/tracks/track 1.bin'\n{CAPTURE}"),
    );
    add_core(&runtime, "pcsx_rearmed", &["cue", "chd", "iso"], &[]);
    let tracks = temp.child("tracks");
    tracks.create_dir_all().unwrap();
    fs::write(tracks.child("track 1.bin").path(), b"track data").unwrap();
    let cue = temp.child("game.cue");
    fs::write(
        cue.path(),
        "FILE \"tracks/track 1.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
    )
    .unwrap();
    run(&temp, &runtime, cue.path(), &[], 0);
    fs::write(
        cue.path(),
        "FILE \"../outside.bin\" BINARY\n  TRACK 01 MODE1/2352\n",
    )
    .unwrap();
    let event = run(&temp, &runtime, cue.path(), &[], 1);
    assert!(
        event["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unsafe disc reference")
    );
}

#[test]
fn archive_disc_selection_keeps_tracks_and_does_not_extract_the_disc() {
    let temp = TempDir::new().unwrap();
    let runtime = runtime(
        &temp,
        &format!("test -f content/game.cue\ntest -f content/track.bin\n{CAPTURE}"),
    );
    add_core(&runtime, "pcsx_rearmed", &["cue", "chd", "iso", "m3u"], &[]);
    let archive = temp.child("disc.tar");
    let mut builder = tar::Builder::new(File::create(archive.path()).unwrap());
    for (name, contents) in [
        (
            "game.cue",
            b"FILE \"track.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n".as_slice(),
        ),
        ("track.bin", b"disc track content".as_slice()),
        ("playlist.m3u", b"# playlist\ngame.cue\n".as_slice()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o644);
        header.set_size(contents.len() as u64);
        header.set_cksum();
        builder.append_data(&mut header, name, contents).unwrap();
    }
    builder.finish().unwrap();
    run(
        &temp,
        &runtime,
        archive.path(),
        &["--select", "game.cue"],
        0,
    );
    run(
        &temp,
        &runtime,
        archive.path(),
        &["--select", "playlist.m3u"],
        0,
    );
}

#[test]
fn system_directory_symlinks_are_rejected() {
    let temp = TempDir::new().unwrap();
    let runtime = runtime(&temp, CAPTURE);
    let system = temp.child("bios");
    system.create_dir_all().unwrap();
    std::os::unix::fs::symlink(temp.path(), system.child("link").path()).unwrap();
    let rom = nes(&temp);
    let event = run(
        &temp,
        &runtime,
        &rom,
        &["--system-dir", system.path().to_str().unwrap()],
        1,
    );
    assert!(
        event["error"]["message"]
            .as_str()
            .unwrap()
            .contains("symlink")
    );
}
