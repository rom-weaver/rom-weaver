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
            .contains("only NES is supported")
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
