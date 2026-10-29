use super::shared::*;
use std::{
    io::Read,
    os::{fd::FromRawFd, unix::process::CommandExt},
    process::{Command as ProcessCommand, ExitStatus, Stdio},
    time::{Duration, Instant},
};

fn isolated_command(temp: &TempDir) -> ProcessCommand {
    let mut command = ProcessCommand::new(assert_cmd::cargo::cargo_bin!("rom-weaver"));
    command.current_dir(temp.path()).env("HOME", temp.path());
    for key in [
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
    ] {
        command.env(key, temp.child(key).path());
    }
    command.env("NO_COLOR", "1");
    command.env(
        "ROM_WEAVER_CHEAT_DATABASE",
        temp.child("no-database").path(),
    );
    command
}

fn fixture() -> TempDir {
    let temp = setup_temp_dir();
    let mut rom = vec![0; 16 + 32_768];
    rom[..6].copy_from_slice(b"NES\x1a\x02\x00");
    fs::write(temp.child("game.nes").path(), rom).expect("ROM fixture");
    fs::write(
        temp.child("main.ips").path(),
        b"PATCH\x00\x00\x14\x00\x01\xaaEOF",
    )
    .expect("patch fixture");
    temp
}

fn run_tui(temp: &TempDir, extra: &[&str]) -> (ExitStatus, String) {
    run_tui_to(temp, "out.nes", extra)
}

fn run_tui_to(temp: &TempDir, output: &str, extra: &[&str]) -> (ExitStatus, String) {
    run_tui_paths(temp, "game.nes", "main.ips", Some(output), true, extra)
}

fn run_tui_paths(
    temp: &TempDir,
    input: &str,
    patch: &str,
    output: Option<&str>,
    no_compress: bool,
    extra: &[&str],
) -> (ExitStatus, String) {
    let mut master = -1;
    let mut slave = -1;
    // SAFETY: openpty initializes both descriptors; optional terminal settings are null.
    let result = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    assert_eq!(result, 0, "openpty: {}", std::io::Error::last_os_error());
    // SAFETY: successful openpty returned two distinct, owned descriptors.
    let (mut terminal, slave) = unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) };
    let mut command = isolated_command(temp);
    command
        .args([
            "patch", "apply", "--input", input, "--patch", patch, "--tui",
        ])
        .args(extra)
        .stdin(slave.try_clone().expect("terminal stdin"))
        .stdout(slave.try_clone().expect("terminal stdout"))
        .stderr(slave);
    if let Some(output) = output {
        command.args(["--output", output]);
    }
    if no_compress {
        command.arg("--no-compress");
    }
    // SAFETY: setsid and ioctl are async-signal-safe; fd 0 is the child terminal.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().expect("TUI child");
    drop(command);
    let patch_count = 1 + extra
        .iter()
        .filter(|argument| **argument == "--patch")
        .count();
    let prompts = (0..patch_count)
        .flat_map(|_| {
            [
                "  name",
                "  version",
                "  author",
                "optional (starts deselected)?",
            ]
        })
        .chain(std::iter::once("Output file name"))
        .collect::<Vec<_>>();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut transcript = String::new();
    let mut prompt = 0;
    loop {
        if Instant::now() >= deadline {
            child.kill().expect("stop timed-out TUI");
            child.wait().expect("reap timed-out TUI");
            panic!("TUI timed out: {transcript}");
        }
        let mut poll = libc::pollfd {
            fd: master,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll receives one valid pollfd and a bounded timeout.
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        assert!(ready >= 0, "poll: {}", std::io::Error::last_os_error());
        if ready == 0 {
            continue;
        }
        let mut buffer = [0; 4096];
        match terminal.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => transcript.push_str(&String::from_utf8_lossy(&buffer[..count])),
            Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
            Err(error) => panic!("read TUI: {error}: {transcript}"),
        }
        if let Some(expected) = prompts.get(prompt)
            && transcript.contains(expected)
        {
            terminal.write_all(b"\n").expect("accept prompt default");
            prompt += 1;
        }
    }
    (child.wait().expect("TUI exit"), transcript)
}

fn assert_replay(temp: &TempDir) -> Vec<u8> {
    let replay = isolated_command(temp)
        .args([
            "patch",
            "apply",
            "--input",
            "rom-weaver-weave.json",
            "--output",
            "replay.nes",
            "--no-compress",
            "--json",
        ])
        .stdin(Stdio::null())
        .output()
        .expect("replay CLI");
    assert!(replay.status.success(), "{replay:?}");
    let original = fs::read(temp.child("out.nes").path()).expect("TUI output");
    let replay = fs::read(temp.child("replay.nes").path()).expect("replay output");
    assert_eq!(original.len(), replay.len(), "TUI replay length differs");
    assert!(original == replay, "TUI replay bytes differ");
    original
}

#[test]
fn tui_recipe_replays_output_header_strip() {
    for patch_mode in [None, Some("keep"), Some("strip")] {
        for (mode, length) in [("strip", 32_768), ("keep", 32_784), ("auto", 32_784)] {
            let temp = fixture();
            let mut flags = vec!["--output-header", mode];
            if let Some(patch_mode) = patch_mode {
                flags.extend(["--patch-header", patch_mode]);
            }
            let (status, transcript) = run_tui(&temp, &flags);
            assert!(status.success(), "{transcript}");
            assert_eq!(assert_replay(&temp).len(), length);
        }
    }
}

#[test]
fn tui_rejects_cheats_before_writing_outputs() {
    for extra in [
        vec!["--code", "AKE-LVS", "--code-kind", "game-genie"],
        vec!["--cheat", "some-cheat"],
    ] {
        for occupied in [false, true] {
            let temp = fixture();
            let output = temp.child("out.nes");
            let recipe = temp.child("rom-weaver-weave.json");
            if occupied {
                fs::write(output.path(), b"existing output").expect("output sentinel");
                fs::write(recipe.path(), b"existing recipe").expect("recipe sentinel");
            }
            let mut flags = extra.clone();
            flags.push("--force");
            let (status, transcript) = run_tui(&temp, &flags);
            assert_eq!(status.code(), Some(2), "{transcript}");
            assert!(
                transcript.contains("--tui cannot record cheat settings"),
                "{transcript}"
            );
            assert!(transcript.contains("rerun without --tui"), "{transcript}");
            assert!(
                !transcript.contains("Authoring rom-weaver-weave.json"),
                "{transcript}"
            );
            if occupied {
                assert_eq!(fs::read(output.path()).expect("output"), b"existing output");
                assert_eq!(fs::read(recipe.path()).expect("recipe"), b"existing recipe");
            } else {
                assert!(!output.path().exists());
                assert!(!recipe.path().exists());
            }
        }
    }
}
#[test]
fn tui_rejects_unrecordable_apply_flags_before_writing_outputs() {
    for (flag, extra) in [
        ("--repair-checksum", vec!["--repair-checksum"]),
        ("--n64-byte-order", vec!["--n64-byte-order", "keep"]),
    ] {
        let temp = fixture();
        let (status, transcript) = run_tui(&temp, &extra);
        assert_eq!(status.code(), Some(2), "{flag}: {transcript}");
        assert!(
            transcript.contains(&format!("--tui cannot record {flag}")),
            "{flag}: {transcript}"
        );
        assert!(transcript.contains("rerun without --tui"), "{transcript}");
        assert!(
            !transcript.contains("Authoring rom-weaver-weave.json"),
            "{transcript}"
        );
        assert!(!temp.child("out.nes").path().exists());
        assert!(!temp.child("rom-weaver-weave.json").path().exists());
    }
}

#[test]
fn tui_bounds_exponential_dangling_symlink_chain() {
    use std::os::unix::fs::symlink;
    let temp = fixture();
    let dir = temp.path();
    symlink("L1/../L1/../m0", dir.join("rom-weaver-weave.json")).expect("recipe link");
    for i in 1..30 {
        symlink(
            format!("L{n}/../L{n}/../m{i}", n = i + 1),
            dir.join(format!("L{i}")),
        )
        .expect("chain link");
    }
    symlink("missing", dir.join("L30")).expect("tail link");
    let started = Instant::now();
    let (status, transcript) = run_tui(&temp, &[]);
    assert!(started.elapsed() < Duration::from_secs(10), "{transcript}");
    assert_eq!(status.code(), Some(2), "{transcript}");
    assert!(
        transcript.contains("cannot be resolved safely"),
        "{transcript}"
    );
    assert!(!temp.child("out.nes").path().exists());
}

#[test]
fn tui_force_replaces_rom_and_recipe_on_repeat() {
    let temp = fixture();
    for run in 0..2 {
        let (status, transcript) = run_tui(&temp, &["--force"]);
        assert!(status.success(), "repeated forced TUI failed: {transcript}");
        let recipe = temp.child("rom-weaver-weave.json");
        let document: Value =
            serde_json::from_slice(&fs::read(recipe.path()).expect("recipe")).expect("recipe JSON");
        assert_eq!(document["patches"][0]["name"], "main");
        if run == 0 {
            fs::write(recipe.path(), b"stale recipe").expect("stale recipe");
            fs::write(temp.child("out.nes").path(), b"stale ROM").expect("stale ROM");
        }
    }
    assert_replay(&temp);
}

#[test]
fn tui_recipe_failure_discloses_kept_output_without_force() {
    let temp = fixture();
    let recipe = temp.child("rom-weaver-weave.json");
    fs::write(recipe.path(), b"existing recipe").expect("recipe sentinel");
    let (status, transcript) = run_tui(&temp, &[]);
    assert_eq!(status.code(), Some(1), "{transcript}");
    assert!(
        transcript.contains(
            "patch apply succeeded, but TUI recipe creation failed; the patched output was kept"
        ),
        "{transcript}"
    );
    assert!(
        transcript.contains("pass --force to overwrite it"),
        "{transcript}"
    );
    assert_eq!(fs::read(recipe.path()).expect("recipe"), b"existing recipe");
    let output = fs::read(temp.child("out.nes").path()).expect("kept output");
    assert_eq!(output.len(), 32_784);
    assert_eq!(output[20], 0xaa);
    let (status, transcript) = run_tui(&temp, &[]);
    assert_eq!(status.code(), Some(1), "{transcript}");
    assert!(
        !transcript.contains("the patched output was kept"),
        "{transcript}"
    );
    assert_eq!(fs::read(recipe.path()).expect("recipe"), b"existing recipe");
    assert_eq!(
        fs::read(temp.child("out.nes").path()).expect("output"),
        output
    );
}

#[test]
fn tui_rejects_recipe_aliases_before_writing() {
    use std::os::unix::fs::symlink;

    for case in [
        "output",
        "relative",
        "absolute",
        "missing-parent",
        "symlink-parent",
        "dangling-recipe",
        "symlink-input",
        "hardlink-input",
        "symlink-patch",
        "hardlink-patch",
        "symlink-output",
        "hardlink-output",
    ] {
        let temp = fixture();
        let recipe = temp.child("rom-weaver-weave.json");
        let input = temp.child("game.nes");
        let patch = temp.child("main.ips");
        let input_before = fs::read(input.path()).expect("input");
        let patch_before = fs::read(patch.path()).expect("patch");
        let output = match case {
            "output" => "rom-weaver-weave.json".to_owned(),
            "relative" => "./rom-weaver-weave.json".to_owned(),
            "absolute" => recipe.path().to_str().expect("absolute output").to_owned(),
            "missing-parent" => "missing/../rom-weaver-weave.json".to_owned(),
            "symlink-parent" => {
                symlink(".", temp.child("alias").path()).expect("parent symlink");
                "alias/rom-weaver-weave.json".to_owned()
            }
            "dangling-recipe" => {
                symlink("out.nes", recipe.path()).expect("dangling recipe");
                "out.nes".to_owned()
            }
            "symlink-input" | "symlink-patch" => {
                let source = if case == "symlink-input" {
                    "game.nes"
                } else {
                    "main.ips"
                };
                symlink(source, recipe.path()).expect("source symlink");
                "out.nes".to_owned()
            }
            "hardlink-input" | "hardlink-patch" => {
                let source = if case == "hardlink-input" {
                    input.path()
                } else {
                    patch.path()
                };
                fs::hard_link(source, recipe.path()).expect("source hardlink");
                "out.nes".to_owned()
            }
            "symlink-output" | "hardlink-output" => {
                let output = temp.child("out.nes");
                fs::write(output.path(), b"existing output").expect("output sentinel");
                if case == "symlink-output" {
                    symlink("out.nes", recipe.path()).expect("output symlink");
                } else {
                    fs::hard_link(output.path(), recipe.path()).expect("output hardlink");
                }
                "out.nes".to_owned()
            }
            _ => unreachable!(),
        };
        let output_path = temp.child(&output);
        let output_before = fs::read(output_path.path()).ok();
        let recipe_before = fs::read(recipe.path()).ok();
        let (status, transcript) = run_tui_to(&temp, &output, &["--force"]);
        assert_eq!(status.code(), Some(2), "{case}: {transcript}");
        assert!(transcript.contains("--tui recipe"), "{case}: {transcript}");
        assert!(
            !transcript.contains("Authoring rom-weaver-weave.json"),
            "{case}: {transcript}"
        );
        assert_eq!(
            fs::read(input.path()).expect("preserved input"),
            input_before,
            "{case}"
        );
        assert_eq!(
            fs::read(patch.path()).expect("preserved patch"),
            patch_before,
            "{case}"
        );
        assert_eq!(fs::read(output_path.path()).ok(), output_before, "{case}");
        assert_eq!(fs::read(recipe.path()).ok(), recipe_before, "{case}");
    }
}

#[test]
fn tui_allows_distinct_recipe_basename_in_another_directory() {
    let temp = fixture();
    let (status, transcript) = run_tui_to(&temp, "nested/rom-weaver-weave.json", &["--force"]);
    assert!(status.success(), "{transcript}");
    let rom = fs::read(temp.child("nested/rom-weaver-weave.json").path()).expect("output ROM");
    assert_eq!(rom.len(), 32_784);
    assert_eq!(rom[20], 0xaa);
    let recipe: Value = serde_json::from_slice(
        &fs::read(temp.child("rom-weaver-weave.json").path()).expect("recipe"),
    )
    .expect("recipe JSON");
    assert_eq!(recipe["patches"][0]["name"], "main");
}

#[test]
fn tui_rejects_inherited_weave_settings_before_writing() {
    let temp = fixture();
    let weave = serde_json::json!({
        "version": 1,
        "rom": {"path": "game.nes"},
        "patches": [],
        "cheats": [{"id": "snapshot", "code": "AKE-LVS", "codeKind": "game-genie"}],
        "output": {"header": "strip"}
    });
    fs::write(
        temp.child("source.json").path(),
        serde_json::to_vec(&weave).expect("weave JSON"),
    )
    .expect("weave fixture");
    let input_before = fs::read(temp.child("game.nes").path()).expect("input");
    let (status, transcript) = run_tui(&temp, &["--weave", "source.json", "--force"]);
    assert_eq!(status.code(), Some(2), "{transcript}");
    assert!(
        transcript.contains("--tui cannot re-open a weave"),
        "{transcript}"
    );
    assert_eq!(
        fs::read(temp.child("game.nes").path()).expect("input"),
        input_before
    );
    assert!(!temp.child("out.nes").path().exists());
    assert!(!temp.child("rom-weaver-weave.json").path().exists());
}

#[test]
fn tui_rejects_unresolvable_recipe_before_writing() {
    use std::os::unix::fs::symlink;

    for case in ["self", "pair", "chain41"] {
        let temp = fixture();
        let recipe = temp.child("rom-weaver-weave.json");
        let output = temp.child("out.nes");
        fs::write(output.path(), b"existing output").expect("output sentinel");
        match case {
            "self" => symlink("rom-weaver-weave.json", recipe.path()).expect("self link"),
            "pair" => {
                symlink("other-link", recipe.path()).expect("first link");
                symlink("rom-weaver-weave.json", temp.child("other-link").path())
                    .expect("second link");
            }
            "chain41" => {
                for index in 0..41 {
                    let link = if index == 0 {
                        recipe.path().to_path_buf()
                    } else {
                        temp.child(format!("link-{index}")).path().to_path_buf()
                    };
                    let target = if index == 40 {
                        "out.nes".to_owned()
                    } else {
                        format!("link-{}", index + 1)
                    };
                    symlink(target, link).expect("chain link");
                }
            }
            _ => unreachable!(),
        }
        let input = temp.child("game.nes");
        let input_before = fs::read(input.path()).expect("input");
        let (status, transcript) = run_tui(&temp, &["--force"]);
        assert_eq!(status.code(), Some(2), "{case}: {transcript}");
        assert!(
            transcript.contains("cannot be resolved safely"),
            "{case}: {transcript}"
        );
        assert!(
            !transcript.contains("Authoring rom-weaver-weave.json"),
            "{case}: {transcript}"
        );
        assert_eq!(
            fs::read(output.path()).expect("output"),
            b"existing output",
            "{case}"
        );
        assert_eq!(
            fs::read(input.path()).expect("input"),
            input_before,
            "{case}"
        );
    }
}

#[test]
fn tui_rejects_resolved_recipe_output_aliases() {
    use std::os::unix::fs::symlink;

    for compressed in [false, true] {
        let temp = fixture();
        let target = if compressed {
            "out.zip"
        } else {
            "game-patched.nes"
        };
        symlink(target, temp.child("rom-weaver-weave.json").path()).expect("recipe symlink");
        let input = fs::read(temp.child("game.nes").path()).expect("input");
        let (output, flags): (Option<&str>, &[&str]) = if compressed {
            (Some("out"), &["--force", "--compress-format", "zip"])
        } else {
            (None, &["--force"])
        };
        let (status, transcript) =
            run_tui_paths(&temp, "game.nes", "main.ips", output, !compressed, flags);
        assert_eq!(status.code(), Some(1), "{transcript}");
        assert!(
            transcript.contains("the TUI recipe would overwrite"),
            "{transcript}"
        );
        assert!(
            transcript.contains("the patched output was kept"),
            "{transcript}"
        );
        let actual = fs::read(temp.child(target).path()).expect("kept output");
        if compressed {
            assert!(actual.starts_with(b"PK\x03\x04"), "ZIP output preserved");
        } else {
            let mut expected = input.clone();
            expected[20] = 0xaa;
            assert_eq!(actual, expected);
        }
        assert_eq!(
            fs::read(temp.child("game.nes").path()).expect("input"),
            input
        );
    }
}

#[test]
fn tui_guards_native_output_paths_with_literal_backslashes() {
    use std::os::unix::fs::symlink;

    let temp = fixture();
    fs::create_dir(temp.child("odd\\name").path()).expect("output directory");
    symlink(
        "odd\\name/out.zip",
        temp.child("rom-weaver-weave.json").path(),
    )
    .expect("recipe symlink");
    let (status, transcript) = run_tui_paths(
        &temp,
        "game.nes",
        "main.ips",
        Some("odd\\name/out"),
        false,
        &["--force", "--compress-format", "zip"],
    );
    assert_eq!(status.code(), Some(1), "{transcript}");
    assert!(
        transcript.contains("the TUI recipe would overwrite"),
        "{transcript}"
    );
    let bytes = fs::read(temp.child("odd\\name/out.zip").path()).expect("kept ZIP");
    assert!(bytes.starts_with(b"PK\x03\x04"));
}

#[test]
fn tui_rejects_canonical_weave_inputs_before_writing() {
    for name in [
        "rom-weaver-weave.json",
        "ROM-WEAVER-WEAVE.JSON",
        "rom-weaver-bundle.json",
        "rom-weaver-weave.json.gz",
    ] {
        let temp = fixture();
        fs::create_dir(temp.child("recipes").path()).expect("recipe directory");
        let rom = fs::read(temp.child("game.nes").path()).expect("ROM");
        fs::write(temp.child("recipes/game.nes").path(), &rom).expect("nested ROM");
        let document = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "rom": {"path": "game.nes"},
            "patches": [],
            "cheats": [{"id": "snapshot", "code": "AKE-LVS", "codeKind": "game-genie"}],
            "output": {"header": "strip"}
        }))
        .expect("weave JSON");
        let bytes = if name.ends_with(".gz") {
            let mut encoder = GzEncoder::new(Vec::new(), DeflateCompression::default());
            encoder.write_all(&document).expect("gzip weave");
            encoder.finish().expect("compressed weave")
        } else {
            document
        };
        let input = format!("recipes/{name}");
        fs::write(temp.child(&input).path(), &bytes).expect("nested weave");
        let (status, transcript) = run_tui_paths(
            &temp,
            &input,
            "main.ips",
            Some("out.nes"),
            true,
            &["--force"],
        );
        assert_eq!(status.code(), Some(2), "{name}: {transcript}");
        assert!(
            transcript.contains("--tui cannot re-open a weave"),
            "{name}: {transcript}"
        );
        assert!(
            !transcript.contains("Authoring rom-weaver-weave.json"),
            "{transcript}"
        );
        assert!(!temp.child("out.nes").path().exists());
        assert!(!temp.child("rom-weaver-weave.json").path().exists());
        assert_eq!(fs::read(temp.child(&input).path()).expect("weave"), bytes);
        assert_eq!(
            fs::read(temp.child("recipes/game.nes").path()).expect("ROM"),
            rom
        );
    }
}

#[test]
fn tui_preserves_disc_sources_and_companion_outputs() {
    use rom_weaver_app::gdrom::{
        GD_HIGH_DENSITY_START_LBA, IsoFile, IsoTimestamp, USER_DATA_SIZE, build_iso,
        encode_mode1_sector,
    };
    use std::os::unix::fs::symlink;

    for (recipe_target, compressed) in [
        ("track03.bin", true),
        ("out/track03.bin", false),
        ("out/disc.zip", true),
    ] {
        let temp = setup_temp_dir();
        let cooked = build_iso(
            &[IsoFile {
                path: "KEEP.DAT".to_string(),
                data: b"source file".to_vec(),
            }],
            GD_HIGH_DENSITY_START_LBA,
            IsoTimestamp::default(),
        )
        .expect("source ISO");
        let raw = cooked
            .chunks_exact(USER_DATA_SIZE)
            .enumerate()
            .flat_map(|(index, sector)| {
                encode_mode1_sector(
                    GD_HIGH_DENSITY_START_LBA + index as u32,
                    sector.try_into().expect("sector"),
                )
            })
            .collect::<Vec<_>>();
        fs::write(temp.child("track03.bin").path(), &raw).expect("source track");
        fs::write(
            temp.child("disc.gdi").path(),
            b"1\n3 45000 4 2352 track03.bin 0\n",
        )
        .expect("source sheet");
        fs::write(temp.child("NEW.DAT").path(), b"added by DCP").expect("DCP payload");
        let create = isolated_command(&temp)
            .args([
                "compress",
                "--input",
                "NEW.DAT",
                "--format",
                "zip",
                "--output",
                "update.dcp",
                "--json",
            ])
            .output()
            .expect("create DCP");
        assert!(create.status.success(), "{create:?}");
        fs::create_dir(temp.child("out").path()).expect("output directory");
        symlink(recipe_target, temp.child("rom-weaver-weave.json").path()).expect("recipe symlink");
        let flags: &[&str] = if compressed {
            &["--force", "--compress-format", "zip"]
        } else {
            &["--force"]
        };
        let output = if compressed {
            "out/disc"
        } else {
            "out/disc.gdi"
        };
        let (status, transcript) = run_tui_paths(
            &temp,
            "disc.gdi",
            "update.dcp",
            Some(output),
            !compressed,
            flags,
        );
        assert_eq!(status.code(), Some(1), "{recipe_target}: {transcript}");
        assert!(
            transcript.contains("the TUI recipe would overwrite"),
            "{transcript}"
        );
        assert!(
            transcript.contains("the patched output was kept"),
            "{transcript}"
        );
        assert_eq!(
            fs::read(temp.child("track03.bin").path()).expect("source track"),
            raw
        );
        let kept = fs::read(
            temp.child(if compressed {
                "out/disc.zip"
            } else {
                "out/track03.bin"
            })
            .path(),
        )
        .expect("kept output");
        if compressed {
            assert!(kept.starts_with(b"PK\x03\x04"));
        } else {
            assert!(kept.len() >= 2352);
            assert!(!kept.starts_with(b"{"));
        }
    }
}

#[test]
fn tui_recipe_replays_aligned_per_patch_header_modes() {
    for second_mode in [None, Some("keep"), Some("strip")] {
        let temp = fixture();
        fs::write(
            temp.child("second.ips").path(),
            b"PATCH\x00\x00\x15\x00\x01\xbbEOF",
        )
        .expect("second patch");
        let mut flags = vec!["--patch-header", "strip", "--patch", "second.ips"];
        if let Some(mode) = second_mode {
            flags.extend(["--patch-header", mode]);
        }
        flags.extend(["--output-header", "strip"]);
        let (status, transcript) = run_tui(&temp, &flags);
        assert!(status.success(), "{transcript}");
        assert_replay(&temp);
        let recipe: Value = serde_json::from_slice(
            &fs::read(temp.child("rom-weaver-weave.json").path()).expect("recipe"),
        )
        .expect("recipe JSON");
        assert_eq!(recipe["patches"][0]["header"], "strip");
        assert_eq!(
            recipe["patches"][1]["header"],
            second_mode.unwrap_or("strip")
        );
    }
}
