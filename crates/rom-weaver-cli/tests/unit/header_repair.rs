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

#[test]
fn repair_checksum_file_keeps_snes_with_partial_gba_logo() {
    let dir = scratch_dir("partial-gba-logo");
    let path = dir.join("rom.sfc");
    let mut expected = vec![0_u8; 32768];
    expected[4..8].copy_from_slice(&GBA_HEADER_MAGIC);
    expected[0xB2] = 0x96;
    expected[0xBD] = 0x50;
    expected[0x1BD] = 0x51;
    expected[0x7FC0..0x7FD5].copy_from_slice(b"ROM WEAVER SNES TEST ");
    expected[0x7FD5] = 0x20;
    expected[0x7FD7] = 5;
    expected[0x7FD9] = 1;
    expected[0x7FFC..0x7FFE].copy_from_slice(&0x8000_u16.to_le_bytes());
    fs::write(&path, &expected).expect("SNES fixture with an incidental GBA magic prefix");
    // Snes9x: https://github.com/snes9xgit/snes9x/blob/master/memmap.cpp
    // The final checksum MUST include the pair's 0x1FE byte contribution.
    let checksum = expected
        .iter()
        .fold(0x1FE_u16, |s, b| s.wrapping_add(u16::from(*b)));
    expected[0x7FDC..0x7FDE].copy_from_slice(&(!checksum).to_le_bytes());
    expected[0x7FDE..0x7FE0].copy_from_slice(&checksum.to_le_bytes());

    let outcome = CliApp::repair_checksum_file_in_place(&path, Some(&path)).expect("repair SNES");
    assert!(
        outcome.repaired_profiles.contains(&"snes"),
        "a partial GBA logo must not suppress SNES checksum repair"
    );
    let actual = fs::read(&path).expect("repaired SNES");
    assert_eq!(
        actual[0xBD], 0x50,
        "SNES data must not receive a GBA repair"
    );
    assert_eq!(actual, expected);
    assert_eq!(
        actual
            .iter()
            .fold(0_u16, |s, b| s.wrapping_add(u16::from(*b))),
        checksum
    );
    CliApp::repair_checksum_file_in_place(&path, Some(&path)).expect("repeat repair");
    assert_eq!(fs::read(&path).expect("repeat SNES"), expected);
    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn repair_checksum_file_recursively_mirrors_snes_tail() {
    for len in [0x70000, 0xB0000] {
        for header in [0x7FC0, 0xFFC0] {
            for copier in [0, 512] {
                let dir = scratch_dir(&format!("mirror-{len}-{header}-{copier}"));
                let path = dir.join("rom.sfc");
                let mut body = vec![0_u8; len];
                body[header..header + 21].copy_from_slice(b"ROM WEAVER SNES TEST ");
                body[header + 0x15] = if header == 0x7FC0 { 0x20 } else { 0x21 };
                body[header + 0x17] = if len == 0x70000 { 9 } else { 10 };
                body[header + 0x19] = 1;
                body[header + 0x3C..header + 0x3E].copy_from_slice(&0x8000_u16.to_le_bytes());
                body[len - 0x10000] = 1;
                if len == 0xB0000 {
                    body[0x80000] = 3;
                }
                // Snes9x checksum_mirror_sum recursively mirrors the final partial bank.
                // https://github.com/snes9xgit/snes9x/blob/master/memmap.cpp
                // Build the mapped bytes explicitly, independently of the repair algorithm.
                let expand = |bytes: &[u8]| {
                    let mut expanded = bytes.to_vec();
                    expanded.extend_from_slice(&bytes[len - 0x10000..]);
                    if len == 0xB0000 {
                        let tail = expanded[0x80000..].to_vec();
                        expanded.extend_from_slice(&tail);
                    }
                    expanded
                };
                let checksum = expand(&body)
                    .iter()
                    .fold(0x1FE_u16, |sum, b| sum.wrapping_add(u16::from(*b)));
                let mut input = vec![0x5A; copier];
                input.extend_from_slice(&body);
                fs::write(&path, input).expect("non-power-of-two SNES fixture");
                body[header + 0x1C..header + 0x1E].copy_from_slice(&(!checksum).to_le_bytes());
                body[header + 0x1E..header + 0x20].copy_from_slice(&checksum.to_le_bytes());
                let mut expected = vec![0x5A; copier];
                expected.extend_from_slice(&body);
                CliApp::repair_checksum_file_in_place(&path, Some(&path)).expect("repair SNES");
                let actual = fs::read(&path).expect("repaired ROM");
                let stored = u16::from_le_bytes([
                    actual[copier + header + 0x1E],
                    actual[copier + header + 0x1F],
                ]);
                assert_eq!(
                    stored, checksum,
                    "size {len:#x}, header {header:#x}, copier {copier}"
                );
                assert_eq!(actual, expected);
                assert_eq!(
                    expand(&actual[copier..])
                        .iter()
                        .fold(0_u16, |sum, b| sum.wrapping_add(u16::from(*b))),
                    checksum
                );
                CliApp::repair_checksum_file_in_place(&path, Some(&path)).expect("repeat repair");
                assert_eq!(fs::read(&path).expect("repeat ROM"), expected);
                fs::remove_dir_all(dir).expect("cleanup");
            }
        }
    }
}
