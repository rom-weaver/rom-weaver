use std::{env, fs};

use super::*;

const SNES_TITLE_OFFSET: usize = 0x7FC0;

/// A 32 KiB SNES-shaped ROM with a readable internal title at the LoROM header
/// offset, so `repair_snes_checksum_file` recognises it.
fn snes_rom() -> Vec<u8> {
    let title = b"ROM WEAVER TEST TITLE";
    let mut rom = vec![0xA5_u8; 32768];
    rom[SNES_TITLE_OFFSET..SNES_TITLE_OFFSET + title.len()].copy_from_slice(title);
    rom
}

fn scratch_dir(label: &str) -> std::path::PathBuf {
    let dir = env::temp_dir().join(format!(
        "rom-weaver-header-repair-{label}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn validate_checksum_file_leaves_the_rom_untouched() {
    // The whole point of the validate wrapper: it reuses the in-place repair
    // routines, so it must prove it never writes through to the caller's ROM.
    // The fixture's checksum is deliberately wrong, which is what makes the
    // repair pass want to write.
    let dir = scratch_dir("untouched");
    let rom_path = dir.join("rom.sfc");
    let scratch = dir.join("scratch.bin");
    let rom = snes_rom();
    fs::write(&rom_path, &rom).expect("fixture");

    let outcome =
        CliApp::validate_checksum_file(&rom_path, Some(&rom_path), &scratch).expect("validate");

    assert_eq!(
        fs::read(&rom_path).expect("rom"),
        rom,
        "validate must not write to the ROM"
    );
    assert!(
        outcome.repaired_profiles.contains(&"snes"),
        "a stale SNES checksum must report as invalid: {outcome:?}"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn validate_checksum_file_accepts_a_read_only_rom() {
    // Preserved dumps are routinely read-only, and `fs::copy` carries the source
    // mode onto the scratch copy the repair pass then opens for writing. Without
    // clearing that bit a validate-only call fails on a perfectly good ROM.
    let dir = scratch_dir("read-only");
    let rom_path = dir.join("rom.sfc");
    let scratch = dir.join("scratch.bin");
    fs::write(&rom_path, snes_rom()).expect("fixture");
    let mut permissions = fs::metadata(&rom_path).expect("metadata").permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&rom_path, permissions).expect("read-only fixture");

    let outcome =
        CliApp::validate_checksum_file(&rom_path, Some(&rom_path), &scratch).expect("validate");

    assert!(
        outcome.repaired_profiles.contains(&"snes"),
        "a read-only ROM must still be inspected: {outcome:?}"
    );
    assert!(
        fs::metadata(&rom_path)
            .expect("metadata")
            .permissions()
            .readonly(),
        "validate must not relax the caller's ROM permissions"
    );
    let _ = fs::remove_dir_all(&dir);
}

// quality-reason: Unix owner write bits MUST be checked even when the group can write.
#[cfg(unix)]
#[test]
fn validate_checksum_file_accepts_owner_read_only_input() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    for existing in [false, true] {
        let dir = scratch_dir(if existing {
            "owner-read-only-existing"
        } else {
            "owner-read-only"
        });
        let rom_path = dir.join("rom.sfc");
        let scratch = dir.join("scratch.bin");
        let rom = snes_rom();
        fs::write(&rom_path, &rom).expect("fixture");
        fs::set_permissions(&rom_path, fs::Permissions::from_mode(0o464)).expect("input mode");
        let before = existing.then(|| {
            fs::write(&scratch, vec![0xff; rom.len() + 32]).expect("existing scratch");
            fs::set_permissions(&scratch, fs::Permissions::from_mode(0o604)).expect("scratch mode");
            fs::metadata(&scratch).expect("scratch metadata")
        });
        let outcome = CliApp::validate_checksum_file(&rom_path, Some(&rom_path), &scratch)
            .expect("validate owner read-only ROM");
        assert!(outcome.repaired_profiles.contains(&"snes"));
        assert_eq!(fs::read(&rom_path).expect("ROM"), rom);
        assert_eq!(
            fs::metadata(&rom_path).expect("ROM metadata").mode() & 0o777,
            0o464
        );
        let after = fs::metadata(&scratch).expect("scratch metadata");
        if let Some(before) = before {
            assert_eq!(after.mode(), before.mode());
            assert_eq!(after.ino(), before.ino());
        } else {
            assert_eq!(after.mode() & 0o777, 0o664);
        }
        assert_eq!(after.len(), rom.len() as u64);
        fs::remove_dir_all(dir).expect("cleanup");
    }
}
