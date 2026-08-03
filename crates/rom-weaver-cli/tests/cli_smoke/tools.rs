use super::shared::*;

/// Build a minimal PPF3 patch (no blockcheck, no file_id trailer) with one
/// record per `(offset, data, undo)` tuple. `data` and `undo` must be the same
/// length. Mirrors the on-disk layout `rom_weaver_patches::ppf` parses:
/// `"PPF30"` + method byte + 50-byte description + imagetype/blockcheck/undo/
/// reserved flag bytes, then `offset:u64 LE, len:u8, data[len], undo[len]` per
/// record.
fn build_ppf3_undo_patch(records: &[(u64, Vec<u8>, Vec<u8>)]) -> Vec<u8> {
    build_ppf3_patch(records, true)
}

/// Same layout as [`build_ppf3_undo_patch`], but with the undo flag cleared and
/// no undo bytes written per record - the shape `undo_ppf` rejects.
fn build_ppf3_patch_without_undo(records: &[(u64, Vec<u8>)]) -> Vec<u8> {
    let with_empty_undo: Vec<(u64, Vec<u8>, Vec<u8>)> = records
        .iter()
        .map(|(offset, data)| (*offset, data.clone(), Vec::new()))
        .collect();
    build_ppf3_patch(&with_empty_undo, false)
}

fn build_ppf3_patch(records: &[(u64, Vec<u8>, Vec<u8>)], undo_enabled: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"PPF30");
    bytes.push(2); // encoding method: PPF3
    let mut description = [0u8; 50];
    let text = b"cli-smoke ppf-undo fixture";
    description[..text.len()].copy_from_slice(text);
    bytes.extend_from_slice(&description);
    bytes.push(0); // imagetype
    bytes.push(0); // blockcheck disabled
    bytes.push(u8::from(undo_enabled));
    bytes.push(0); // reserved
    for (offset, data, undo) in records {
        bytes.extend_from_slice(&offset.to_le_bytes());
        bytes.push(data.len() as u8);
        bytes.extend_from_slice(data);
        if undo_enabled {
            assert_eq!(data.len(), undo.len(), "undo data must match record length");
            bytes.extend_from_slice(undo);
        }
    }
    bytes
}

#[test]
fn tools_ppf_undo_restores_the_original_rom() {
    let temp = setup_temp_dir();
    let original = b"AAAAAAAAAAAAAAAA".to_vec();
    let mut patched = original.clone();
    patched[4] = b'X';
    patched[5] = b'Y';
    patched[6] = b'Z';

    let patch_bytes = build_ppf3_undo_patch(&[(
        4,
        vec![b'X', b'Y', b'Z'],
        vec![original[4], original[5], original[6]],
    )]);

    let rom_path = temp.child("patched.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("restored.bin");
    fs::write(rom_path.path(), &patched).expect("patched fixture");
    fs::write(patch_path.path(), &patch_bytes).expect("patch fixture");

    let json = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "-i",
            rom_path.path().to_str().expect("rom path"),
            "--patch",
            patch_path.path().to_str().expect("patch path"),
            "-o",
            output_path.path().to_str().expect("output path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "tools-ppf-undo");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "PPF");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("restored ROM written to")
    );

    assert_eq!(
        fs::read(output_path.path()).expect("restored output"),
        original
    );
}

#[test]
fn tools_ppf_undo_rejects_a_patch_without_undo_data() {
    let temp = setup_temp_dir();
    let rom_path = temp.child("patched.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("restored.bin");
    fs::write(rom_path.path(), b"AAAAAAAAAAAAAAAA").expect("rom fixture");
    fs::write(
        patch_path.path(),
        build_ppf3_patch_without_undo(&[(4, vec![b'X', b'Y', b'Z'])]),
    )
    .expect("patch fixture");

    let json = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "-i",
            rom_path.path().to_str().expect("rom path"),
            "--patch",
            patch_path.path().to_str().expect("patch path"),
            "-o",
            output_path.path().to_str().expect("output path"),
            "--json",
        ],
        1,
    );
    assert_eq!(json["command"], "tools-ppf-undo");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "PPF");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("does not contain complete undo data")
    );
    assert!(
        !output_path.path().exists(),
        "a failed undo must not leave a restored output behind"
    );
}

#[test]
fn tools_ppf_undo_reports_a_missing_rom_as_a_validation_failure() {
    let temp = setup_temp_dir();
    let missing_rom = temp.child("missing.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("restored.bin");
    fs::write(
        patch_path.path(),
        build_ppf3_undo_patch(&[(0, vec![b'X'], vec![b'A'])]),
    )
    .expect("patch fixture");

    let json = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "-i",
            missing_rom.path().to_str().expect("rom path"),
            "--patch",
            patch_path.path().to_str().expect("patch path"),
            "-o",
            output_path.path().to_str().expect("output path"),
            "--json",
        ],
        1,
    );
    assert_eq!(json["command"], "tools-ppf-undo");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("input path does not exist")
    );
}
