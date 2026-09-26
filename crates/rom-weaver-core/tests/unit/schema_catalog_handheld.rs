use super::{SaveDetectionInput, SaveEdit, SaveGameRegistry, SaveValue};

const FINAL_FANTASY_PACK: &[u8] =
    include_bytes!("../../../../data/save-schemas/final-fantasy-nes.json");
const WARIO_LAND_PACK: &[u8] =
    include_bytes!("../../../../data/save-schemas/wario-land-super-mario-land-3.json");

fn input(bytes: Vec<u8>, game: &str) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: Some(game.into()),
        rom_sha1: None,
    }
}
fn identity(registry: &SaveGameRegistry, id: &str) -> crate::save::SaveGameIdentity {
    registry
        .definitions()
        .into_iter()
        .find(|definition| definition.identity.id == id)
        .unwrap()
        .identity
}

#[test]
fn wario_land_repairs_each_slot_checksum_after_edits() {
    let registry = SaveGameRegistry::default()
        .with_schema_pack_json(WARIO_LAND_PACK)
        .unwrap();
    let id = "wario-land-super-mario-land-3";
    let game = identity(&registry, id);
    let mut bytes = vec![0xff; 8192];
    for slot in 0..3 {
        let start = slot * 0x40;
        bytes[start..start + 4].copy_from_slice(&[0x19, 0x64, 0x39, 0x57]);
        bytes[0xc0 + slot] = bytes[start..start + 0x20]
            .iter()
            .fold(0u8, |sum, byte| sum.wrapping_add(*byte));
    }

    let edits = (1..=3)
        .map(|slot| SaveEdit {
            field: format!("slot_{slot}.treasures.a"),
            value: SaveValue::Bool(false),
        })
        .collect::<Vec<_>>();
    let result = registry
        .apply(&input(bytes, id), &game, &edits, false)
        .unwrap();
    let output = result.bytes.unwrap();
    for slot in 0..3 {
        let start = slot * 0x40;
        let expected = output[start..start + 0x20]
            .iter()
            .fold(0u8, |sum, byte| sum.wrapping_add(*byte));
        assert_eq!(output[0xc0 + slot], expected);
    }
}

#[test]
fn final_fantasy_repairs_checksum_with_excluded_output() {
    let registry = SaveGameRegistry::default()
        .with_schema_pack_json(FINAL_FANTASY_PACK)
        .unwrap();
    let id = "final-fantasy-nes";
    let game = identity(&registry, id);
    let mut bytes = vec![0u8; 8192];
    bytes[0x4fd] = 0xff;

    let result = registry
        .apply(
            &input(bytes, id),
            &game,
            &[SaveEdit {
                field: "party.gil".into(),
                value: SaveValue::U32(999_999),
            }],
            false,
        )
        .unwrap();
    let output = result.bytes.unwrap();
    let sum = (0x400..0x800)
        .filter(|offset| *offset != 0x4fd)
        .fold(0u16, |sum, offset| (sum + u16::from(output[offset])) % 255);
    assert_eq!(output[0x4fd], (sum as u8) ^ 0xff);
}
