use super::shared::*;

const SIGNATURE: u32 = 0x0801_2025;

fn checksum(data: &[u8]) -> u16 {
    let sum = data.chunks_exact(4).fold(0u32, |sum, chunk| {
        sum.wrapping_add(u32::from_le_bytes(chunk.try_into().unwrap()))
    });
    (sum as u16).wrapping_add((sum >> 16) as u16)
}

fn section_offset(slot: usize, id: usize) -> usize {
    slot * 0xE000 + ((id + 1) % 14) * 0x1000
}

fn emerald_fixture() -> Vec<u8> {
    let mut bytes = vec![0u8; 0x20_000];
    for (slot, counter) in [(0usize, 8u32), (1, 7)] {
        for id in 0..14usize {
            let offset = section_offset(slot, id);
            bytes[offset + 0xFF4..offset + 0xFF6].copy_from_slice(&(id as u16).to_le_bytes());
            bytes[offset + 0xFF8..offset + 0xFFC].copy_from_slice(&SIGNATURE.to_le_bytes());
            bytes[offset + 0xFFC..offset + 0x1000].copy_from_slice(&counter.to_le_bytes());
        }
        let small = section_offset(slot, 0);
        bytes[small..small + 7].copy_from_slice(&[0xCC, 0xBF, 0xBE, 0xFF, 0xFF, 0xFF, 0xFF]);
        bytes[small + 8] = 0;
        bytes[small + 10..small + 14].copy_from_slice(&[0x39, 0x30, 0x31, 0xD4]);
        bytes[small + 14..small + 19].copy_from_slice(&[32, 0, 14, 22, 3]);
        bytes[small + 0xAC..small + 0xB0].copy_from_slice(&0x1234_5678u32.to_le_bytes());
        let large = section_offset(slot, 1) + 0x490;
        bytes[large..large + 4].copy_from_slice(&(5_000u32 ^ 0x1234_5678).to_le_bytes());
        bytes[section_offset(slot, 4) + 0xEF0] = 0x42;
        for id in 0..14usize {
            let offset = section_offset(slot, id);
            let size = match id {
                0 => 0xF2C,
                1..=3 | 5..=12 => 0xF80,
                4 => 0xF08,
                13 => 0x7D0,
                _ => unreachable!(),
            };
            let sum = checksum(&bytes[offset..offset + size]);
            bytes[offset + 0xFF6..offset + 0xFF8].copy_from_slice(&sum.to_le_bytes());
        }
    }
    bytes
}

fn write_fixture(temp: &TempDir) -> PathBuf {
    let path = temp.child("emerald.sav");
    fs::write(path.path(), emerald_fixture()).expect("save fixture");
    path.path().to_path_buf()
}

fn alttp_fixture() -> Vec<u8> {
    const FILE_SIZE: usize = 0x500;
    let mut bytes = vec![0; 0x2000];
    for slot in 0..3usize {
        let offset = slot * FILE_SIZE;
        let file = &mut bytes[offset..offset + FILE_SIZE];
        file[0x3E5..0x3E7].copy_from_slice(&0x55AAu16.to_le_bytes());
        file[0x360..0x362].copy_from_slice(&123u16.to_le_bytes());
        file[0x362..0x364].copy_from_slice(&123u16.to_le_bytes());
        file[0x36C] = 24;
        file[0x36D] = 24;
        let sum = file[..0x4FE].chunks_exact(2).fold(0x5A5Au16, |sum, word| {
            sum.wrapping_sub(u16::from_le_bytes([word[0], word[1]]))
        });
        file[0x4FE..0x500].copy_from_slice(&sum.to_le_bytes());
        let backup = 0xF00 + offset;
        bytes.copy_within(offset..offset + FILE_SIZE, backup);
    }
    bytes
}

#[test]
fn save_identify_rejects_oversized_input_before_reading_it() {
    let temp = setup_temp_dir();
    let save = temp.child("oversized.sav");
    fs::File::create(save.path())
        .and_then(|file| file.set_len(128 * 1024 * 1024 + 1))
        .expect("create sparse oversized save");
    let json = run_single_json_event(&["save", "identify", save.to_str().unwrap(), "--json"], 1);
    assert_eq!(
        json["details"]["save_editor"]["error"]["code"],
        "save_size_limit"
    );
}

#[test]
fn save_identify_supports_stable_json_and_human_output() {
    let temp = setup_temp_dir();
    let save = write_fixture(&temp);
    let json = run_single_json_event(&["save", "identify", save.to_str().unwrap(), "--json"], 0);
    assert_eq!(json["command"], "save-identify");
    assert_eq!(json["family"], "save");
    assert_eq!(json["status"], "succeeded");
    let details = &json["details"]["save_editor"];
    assert_eq!(details["save_size"], 131_072);
    assert_eq!(details["document"]["identity"]["id"], "pokemon-emerald");
    assert_eq!(details["document"]["integrity"]["state"], "valid");
    assert_eq!(details["document"]["active_slot"], 0);

    let human = String::from_utf8(command_stdout(
        &["save", "identify", save.to_str().unwrap()],
        0,
    ))
    .unwrap();
    assert!(human.contains("Pokémon Emerald"));
    assert!(human.contains("Active save slot"));
}

#[test]
fn save_inspect_get_and_export_schema_share_generic_fields() {
    let temp = setup_temp_dir();
    let save = write_fixture(&temp);
    let inspect = run_single_json_event(&["save", "inspect", save.to_str().unwrap(), "--json"], 0);
    let fields = inspect["details"]["save_editor"]["document"]["fields"]
        .as_array()
        .unwrap();
    assert!(
        fields
            .iter()
            .any(|field| { field["id"] == "trainer.money" && field["kind"] == "unsigned_integer" })
    );

    let get = run_single_json_event(
        &[
            "save",
            "get",
            save.to_str().unwrap(),
            "trainer.money",
            "--json",
        ],
        0,
    );
    assert_eq!(get["label"], "5000");
    assert_eq!(
        get["details"]["save_editor"]["field"]["id"],
        "trainer.money"
    );

    let schema = run_single_json_event(
        &["save", "export-schema", save.to_str().unwrap(), "--json"],
        0,
    );
    assert_eq!(
        schema["details"]["save_editor"]["schema"]["game"]["id"],
        "pokemon-emerald"
    );
    assert!(schema["details"]["save_editor"]["schema"]["fields"].is_array());

    let inspect_human = String::from_utf8(command_stdout(
        &["save", "inspect", save.to_str().unwrap()],
        0,
    ))
    .unwrap();
    assert!(inspect_human.contains("Trainer"));
    assert!(inspect_human.contains("Money"));
    let get_human = String::from_utf8(command_stdout(
        &["save", "get", save.to_str().unwrap(), "trainer.money"],
        0,
    ))
    .unwrap();
    assert!(get_human.contains("5000"));
    let schema_human = String::from_utf8(command_stdout(
        &["save", "export-schema", save.to_str().unwrap()],
        0,
    ))
    .unwrap();
    assert!(schema_human.contains("trainer.money"));
}

#[test]
fn save_set_dry_run_and_write_are_atomic_and_reparseable() {
    let temp = setup_temp_dir();
    let save = write_fixture(&temp);
    let output = temp.child("edited.sav");
    let preview = run_single_json_event(
        &[
            "save",
            "set",
            save.to_str().unwrap(),
            "trainer.money=999999",
            "trainer.name=ASH",
            "--dry-run",
            "--json",
        ],
        0,
    );
    assert_eq!(preview["stage"], "preview");
    assert_eq!(
        preview["details"]["save_editor"]["result"]["preview"]["output_valid"],
        true
    );
    assert_eq!(
        preview["details"]["save_editor"]["result"]["preview"]["integrity_recalculated"],
        true
    );
    assert_eq!(
        preview["details"]["save_editor"]["result"]["preview"]["touched_sections"],
        serde_json::json!([0, 1])
    );
    assert!(!output.path().exists());

    let preview_human = String::from_utf8(command_stdout(
        &[
            "save",
            "set",
            save.to_str().unwrap(),
            "trainer.money=999999",
            "--dry-run",
        ],
        0,
    ))
    .unwrap();
    assert!(preview_human.contains("5000 -> 999999"));

    let set = run_single_json_event(
        &[
            "save",
            "set",
            save.to_str().unwrap(),
            "trainer.money=999999",
            "trainer.name=ASH",
            "-o",
            output.path().to_str().unwrap(),
            "--json",
        ],
        0,
    );
    assert_eq!(set["status"], "succeeded");
    assert_emitted_file(&set, output.path(), Some("game-save"));
    assert_eq!(fs::read(&save).unwrap(), emerald_fixture());

    let get = run_single_json_event(
        &[
            "save",
            "get",
            output.path().to_str().unwrap(),
            "trainer.money",
            "--json",
        ],
        0,
    );
    assert_eq!(get["label"], "999999");
}

#[test]
fn save_commands_route_an_alttp_sram_through_the_shared_handler() {
    let temp = setup_temp_dir();
    let save = temp.child("zelda.srm");
    let output = temp.child("zelda-edited.srm");
    let original = alttp_fixture();
    fs::write(save.path(), &original).unwrap();

    let identify = run_single_json_event(
        &["save", "identify", save.path().to_str().unwrap(), "--json"],
        0,
    );
    assert_eq!(
        identify["details"]["save_editor"]["document"]["identity"]["id"],
        "zelda-a-link-to-the-past"
    );

    let preview = run_single_json_event(
        &[
            "save",
            "set",
            save.path().to_str().unwrap(),
            "slot_2.resources.rupees=999",
            "--dry-run",
            "--json",
        ],
        0,
    );
    assert_eq!(
        preview["details"]["save_editor"]["result"]["preview"]["output_valid"],
        true
    );

    run_single_json_event(
        &[
            "save",
            "set",
            save.path().to_str().unwrap(),
            "slot_2.resources.rupees=999",
            "-o",
            output.path().to_str().unwrap(),
            "--json",
        ],
        0,
    );
    let get = run_single_json_event(
        &[
            "save",
            "get",
            output.path().to_str().unwrap(),
            "slot_2.resources.rupees",
            "--json",
        ],
        0,
    );
    assert_eq!(get["label"], "999");
    assert_eq!(fs::read(save.path()).unwrap(), original);
}

#[test]
fn save_set_rejects_bad_values_and_source_collisions() {
    let temp = setup_temp_dir();
    let save = write_fixture(&temp);
    let invalid = run_single_json_event(
        &[
            "save",
            "set",
            save.to_str().unwrap(),
            "trainer.money=1000000",
            "--json",
        ],
        1,
    );
    assert_eq!(invalid["status"], "failed");
    assert!(
        invalid["label"]
            .as_str()
            .unwrap()
            .contains("save_value_range")
    );

    let collision = run_single_json_event(
        &[
            "save",
            "set",
            save.to_str().unwrap(),
            "trainer.money=1",
            "-o",
            save.to_str().unwrap(),
            "--force",
            "--json",
        ],
        1,
    );
    assert_eq!(collision["status"], "failed");
    assert_eq!(fs::read(&save).unwrap(), emerald_fixture());

    let output = temp.child("existing.sav");
    fs::write(output.path(), b"keep me").unwrap();
    let output_collision = run_single_json_event(
        &[
            "save",
            "set",
            save.to_str().unwrap(),
            "trainer.money=1",
            "-o",
            output.path().to_str().unwrap(),
            "--json",
        ],
        1,
    );
    assert_eq!(output_collision["status"], "failed");
    assert_eq!(fs::read(output.path()).unwrap(), b"keep me");

    let replaced = run_single_json_event(
        &[
            "save",
            "set",
            save.to_str().unwrap(),
            "trainer.money=1",
            "-o",
            output.path().to_str().unwrap(),
            "--force",
            "--json",
        ],
        0,
    );
    assert_eq!(replaced["status"], "succeeded");
    assert_ne!(fs::read(output.path()).unwrap(), b"keep me");
}

#[test]
fn unsupported_save_stays_untouched() {
    let temp = setup_temp_dir();
    let save = temp.child("unknown.sav");
    fs::write(save.path(), vec![0xA5; 65_536]).unwrap();
    let json = run_single_json_event(
        &["save", "identify", save.path().to_str().unwrap(), "--json"],
        2,
    );
    assert_eq!(json["status"], "unsupported");
    assert_eq!(
        json["details"]["save_editor"]["potential_format"],
        "Flash 64 KiB (Game Boy Advance); Battery SRAM 64 KiB (Super Nintendo); \
         Nintendo DS save 64 KiB (Nintendo DS); \
         Cartridge SRAM 64 KiB (Sega Genesis and Mega Drive)"
    );
    assert!(json["details"]["save_editor"]["container"].is_null());
    assert_eq!(fs::read(save.path()).unwrap(), vec![0xA5; 65_536]);

    let ds_save = temp.child("unknown-ds.sav");
    fs::write(ds_save.path(), vec![0xA5; 524_288]).unwrap();
    let json = run_single_json_event(
        &[
            "save",
            "identify",
            ds_save.path().to_str().unwrap(),
            "--json",
        ],
        2,
    );
    assert_eq!(json["status"], "unsupported");
    assert_eq!(
        json["details"]["save_editor"]["potential_format"],
        "Nintendo DS save 512 KiB (Nintendo DS)"
    );
    assert_eq!(fs::read(ds_save.path()).unwrap(), vec![0xA5; 524_288]);
}

fn desmume_wrap(save: &[u8]) -> Vec<u8> {
    let mut bytes = save.to_vec();
    bytes.extend_from_slice(
        b"|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:",
    );
    for value in [save.len() as u32, save.len() as u32, 3, 2, 18, 0] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(b"|-DESMUME SAVE-|");
    bytes
}

#[test]
fn save_identify_names_the_container_and_signature_formats() {
    let temp = setup_temp_dir();
    let dsv = temp.child("unknown.dsv");
    fs::write(dsv.path(), desmume_wrap(&vec![0xA5; 65_536])).unwrap();
    let json = run_single_json_event(
        &["save", "identify", dsv.path().to_str().unwrap(), "--json"],
        2,
    );
    let details = &json["details"]["save_editor"];
    assert_eq!(json["status"], "unsupported");
    assert_eq!(details["container"]["kind"], "desmume_dsv");
    assert_eq!(details["container"]["name"], "DeSmuME save (.dsv)");
    assert_eq!(details["save_size"], 65_536);
    assert_eq!(details["file_size"], 65_536 + 122);
    // An unsupported report prints its label on stderr.
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["save", "identify", dsv.path().to_str().unwrap()])
        .assert()
        .code(2)
        .get_output()
        .clone();
    let human = String::from_utf8(output.stderr).unwrap();
    assert!(human.contains("Container: DeSmuME save (.dsv)"), "{human}");
    assert!(human.contains("Potential format: Flash 64 KiB"), "{human}");

    let gme = temp.child("card.gme");
    let mut wrapped = vec![0u8; 0xF40];
    wrapped[..11].copy_from_slice(b"123-456-STD");
    let mut card = vec![0u8; 131_072];
    card[..2].copy_from_slice(b"MC");
    wrapped.extend_from_slice(&card);
    fs::write(gme.path(), &wrapped).unwrap();
    let json = run_single_json_event(
        &["save", "identify", gme.path().to_str().unwrap(), "--json"],
        2,
    );
    let details = &json["details"]["save_editor"];
    assert_eq!(details["container"]["kind"], "dexdrive_gme");
    assert_eq!(
        details["potential_formats"][0]["id"],
        "psx_memory_card_128k"
    );
    assert_eq!(details["potential_formats"][0]["signature_checked"], true);
    assert!(
        details["potential_format"]
            .as_str()
            .unwrap()
            .starts_with("Memory card 128 KiB (Sony PlayStation); ")
    );
    assert_eq!(fs::read(gme.path()).unwrap(), wrapped);
}

fn shark_port_wrap(save: &[u8]) -> Vec<u8> {
    fn shark_port_checksum(payload: &[u8]) -> u32 {
        let mut crc: u32 = 0;
        for &byte in payload {
            let value = byte as i8 as i32 as u32;
            crc = crc.wrapping_add(value.wrapping_shl(crc % 0x18));
        }
        crc
    }
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&13u32.to_le_bytes());
    bytes.extend_from_slice(b"SharkPortSave");
    bytes.extend_from_slice(&0x000f_0000u32.to_le_bytes());
    for text in ["POKEMON EMER", "2026-08-27", "notes"] {
        bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
        bytes.extend_from_slice(text.as_bytes());
    }
    let mut payload = vec![0u8; 0x1c];
    payload[..12].copy_from_slice(b"POKEMON EMER");
    payload[0x14] = 1;
    payload.extend_from_slice(save);
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    let crc = shark_port_checksum(&payload);
    bytes.extend_from_slice(&payload);
    bytes.extend_from_slice(&crc.to_le_bytes());
    bytes
}

#[test]
fn save_set_round_trips_a_shark_port_wrapper() {
    let temp = setup_temp_dir();
    let path = temp.child("emerald.sps");
    let wrapped = shark_port_wrap(&emerald_fixture());
    fs::write(path.path(), &wrapped).expect("sps fixture");

    let identify =
        run_single_json_event(&["save", "identify", path.to_str().unwrap(), "--json"], 0);
    let details = &identify["details"]["save_editor"];
    assert_eq!(details["save_size"], 131_072);
    assert_eq!(details["file_size"], wrapped.len());
    assert_eq!(details["container"]["kind"], "shark_port_save");
    assert_eq!(
        details["potential_format"],
        "Flash 128 KiB (Game Boy Advance)"
    );
    assert_eq!(details["potential_formats"][0]["id"], "gba_flash_128k");
    assert_eq!(details["document"]["identity"]["id"], "pokemon-emerald");
    assert!(
        details["document"]["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning.as_str().unwrap().contains("SharkPortSave"))
    );

    let output = temp.child("edited.sps");
    let set = run_single_json_event(
        &[
            "save",
            "set",
            path.to_str().unwrap(),
            "trainer.money=777",
            "--output",
            output.to_str().unwrap(),
            "--json",
        ],
        0,
    );
    assert_eq!(set["status"], "succeeded");
    let edited = fs::read(output.path()).expect("edited sps");
    assert_eq!(edited.len(), wrapped.len());
    let payload_start = wrapped.len() - 4 - 0x20_000 - 0x1c;
    // The wrapper header (magic, strings, game info) survives verbatim.
    assert_eq!(
        edited[..payload_start + 0x1c],
        wrapped[..payload_start + 0x1c]
    );
    let get = run_single_json_event(
        &[
            "save",
            "get",
            output.to_str().unwrap(),
            "trainer.money",
            "--json",
        ],
        0,
    );
    assert_eq!(get["label"], "777");
}
