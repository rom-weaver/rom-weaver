use super::shared::*;
use rom_weaver_app::gdrom::{
    GD_HIGH_DENSITY_START_LBA, IsoFile, IsoTimestamp, USER_DATA_SIZE, build_iso,
    encode_mode1_sector,
};

fn write_patch(path: &Path) -> Vec<u8> {
    let patch = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 100,
            data: vec![0x42],
        }],
        None,
    );
    fs::write(path, &patch).expect("patch fixture");
    patch
}

fn apply_compressed(
    input: &Path,
    patch: &Path,
    output: &Path,
    format: &str,
    expected: i32,
) -> Vec<u8> {
    let report = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.to_str().unwrap(),
            "--patch",
            patch.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
            "--compress-format",
            format,
            "--force",
            "--threads",
            "1",
            "--json",
        ],
        expected,
    );
    if expected == 1 {
        assert!(
            String::from_utf8_lossy(&report).contains("resolve to the same file"),
            "unexpected failure: {}",
            String::from_utf8_lossy(&report)
        );
    }
    report
}

#[test]
fn compressed_apply_preserves_rom_alias_after_extension_is_appended() {
    let temp = setup_temp_dir();
    let input = temp.child("rom.bin");
    let patch = temp.child("update.ips");
    let original = (0..128).collect::<Vec<u8>>();
    fs::write(input.path(), &original).expect("ROM fixture");
    write_patch(patch.path());
    fs::hard_link(input.path(), temp.child("output.zip").path()).expect("ROM alias");
    apply_compressed(
        input.path(),
        patch.path(),
        temp.child("output").path(),
        "zip",
        1,
    );
    assert_eq!(
        fs::read(input.path()).unwrap(),
        original,
        "compressed apply must preserve its source ROM"
    );
}

#[test]
fn compressed_apply_preserves_patch_alias_after_extension_is_appended() {
    let temp = setup_temp_dir();
    let input = temp.child("rom.bin");
    let patch = temp.child("update.ips");
    fs::write(input.path(), vec![0; 128]).expect("ROM fixture");
    let original = write_patch(patch.path());
    fs::hard_link(patch.path(), temp.child("output.zip").path()).expect("patch alias");
    apply_compressed(
        input.path(),
        patch.path(),
        temp.child("output").path(),
        "zip",
        1,
    );
    assert_eq!(
        fs::read(patch.path()).unwrap(),
        original,
        "compressed apply must preserve its patch"
    );
}

#[test]
fn compressed_disc_apply_preserves_every_source_track() {
    for (track, append_extension) in [("track01.bin", false), ("track02.bin", true)] {
        let temp = setup_temp_dir();
        let (track01, track02) = super::patch_disc::write_two_track_cd(&temp);
        let patch = temp.child("update.ips");
        write_patch(patch.path());
        fs::hard_link(temp.child(track).path(), temp.child("output.chd").path())
            .expect("track alias");
        let output = temp.child(if append_extension {
            "output"
        } else {
            "output.chd"
        });
        let report = command_stdout(
            &[
                "patch",
                "apply",
                "--input",
                temp.child("disc.cue").path().to_str().unwrap(),
                "--patch",
                patch.path().to_str().unwrap(),
                "--target",
                "*track02*",
                "--output",
                output.path().to_str().unwrap(),
                "--compress-format",
                "chd",
                "--force",
                "--threads",
                "1",
                "--json",
            ],
            1,
        );
        assert!(
            String::from_utf8_lossy(&report).contains("resolve to the same file"),
            "unexpected failure: {}",
            String::from_utf8_lossy(&report)
        );
        assert_eq!(
            fs::read(temp.child("track01.bin").path()).unwrap(),
            track01,
            "untouched source track must survive"
        );
        assert_eq!(
            fs::read(temp.child("track02.bin").path()).unwrap(),
            track02,
            "patched source track must survive"
        );
    }
}

#[test]
fn compressed_dcp_apply_preserves_source_track() {
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
                sector.try_into().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    fs::write(temp.child("track03.bin").path(), &raw).expect("source track");
    fs::write(temp.child("track01.bin").path(), vec![0; 2352 * 8]).expect("low density data");
    fs::write(temp.child("track02.bin").path(), vec![0; 2352 * 8]).expect("audio track");
    temp.child("disc.gdi")
        .write_str(
            "3\n1 0 4 2352 track01.bin 0\n2 8 0 2352 track02.bin 0\n3 45000 4 2352 track03.bin 0\n",
        )
        .expect("source GDI");
    temp.child("NEW.DAT")
        .write_str("added file")
        .expect("patch payload");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("NEW.DAT").path().to_str().unwrap(),
            "--format",
            "zip",
            "--output",
            temp.child("update.dcp").path().to_str().unwrap(),
            "--json",
        ],
        0,
    );
    fs::hard_link(
        temp.child("track03.bin").path(),
        temp.child("output.chd").path(),
    )
    .expect("track alias");
    let report = apply_compressed(
        temp.child("disc.gdi").path(),
        temp.child("update.dcp").path(),
        temp.child("output").path(),
        "chd",
        1,
    );
    assert!(
        String::from_utf8_lossy(&report).contains("resolve to the same file"),
        "unexpected failure: {}",
        String::from_utf8_lossy(&report)
    );
    assert_eq!(
        fs::read(temp.child("track03.bin").path()).unwrap(),
        raw,
        "DCP compression must preserve its source track"
    );
}

#[test]
fn compressed_apply_force_still_replaces_unrelated_output() {
    let temp = setup_temp_dir();
    let input = temp.child("rom.bin");
    let patch = temp.child("update.ips");
    let original = (0..128).collect::<Vec<u8>>();
    fs::write(input.path(), &original).expect("ROM fixture");
    let original_patch = write_patch(patch.path());
    fs::write(temp.child("output.zip").path(), b"replace this output").expect("existing output");
    apply_compressed(
        input.path(),
        patch.path(),
        temp.child("output").path(),
        "zip",
        0,
    );
    assert!(
        fs::read(temp.child("output.zip").path())
            .unwrap()
            .starts_with(b"PK")
    );
    assert_eq!(fs::read(input.path()).unwrap(), original);
    assert_eq!(fs::read(patch.path()).unwrap(), original_patch);
}

#[test]
fn compressed_apply_preserves_original_archive_after_extension_is_appended() {
    let temp = setup_temp_dir();
    let input = temp.child("rom.bin");
    let patch = temp.child("update.ips");
    let archive = temp.child("source.zip");
    fs::write(input.path(), vec![0; 128]).expect("ROM fixture");
    write_patch(patch.path());
    command_stdout(
        &[
            "compress",
            "--input",
            input.path().to_str().unwrap(),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().unwrap(),
            "--json",
        ],
        0,
    );
    let original = fs::read(archive.path()).unwrap();
    apply_compressed(
        archive.path(),
        patch.path(),
        temp.child("source").path(),
        "zip",
        1,
    );
    assert_eq!(
        fs::read(archive.path()).unwrap(),
        original,
        "compressed apply must preserve its original archive"
    );
}
