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
            "patch",
            "apply",
            "--input",
            "game.nes",
            "--patch",
            "main.ips",
            "--output",
            "out.nes",
            "--no-compress",
            "--tui",
        ])
        .args(extra)
        .stdin(slave.try_clone().expect("terminal stdin"))
        .stdout(slave.try_clone().expect("terminal stdout"))
        .stderr(slave);
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
    let prompts = [
        "  name",
        "  version",
        "  author",
        "optional (starts deselected)?",
        "Output file name",
    ];
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
    for (mode, length) in [("strip", 32_768), ("keep", 32_784), ("auto", 32_784)] {
        let temp = fixture();
        let (status, transcript) = run_tui(&temp, &["--output-header", mode]);
        assert!(status.success(), "{transcript}");
        assert_eq!(assert_replay(&temp).len(), length);
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
