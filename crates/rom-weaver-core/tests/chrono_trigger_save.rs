use rom_weaver_core::{
    SaveDetectionInput, SaveEdit, SaveGameIdentity, SaveGameRegistry, SaveValue,
};

const SLOT_SIZE: usize = 0xa00;

fn identity(registry: &SaveGameRegistry, id: &str) -> SaveGameIdentity {
    registry
        .definitions()
        .into_iter()
        .find(|definition| definition.identity.id == id)
        .expect("Chrono Trigger profile")
        .identity
}

/// Builds 8 KiB SRAM with one marked slot holding `words` and the given stored checksum.
fn sram(
    slot: usize,
    words: &[(usize, u16)],
    stored_checksum: u16,
    game: &str,
) -> SaveDetectionInput {
    let mut bytes = vec![0; 8192];
    for &(offset, word) in words {
        let offset = slot * SLOT_SIZE + offset;
        bytes[offset..offset + 2].copy_from_slice(&word.to_le_bytes());
    }
    bytes[0x1ff8 + slot * 2..0x1ffa + slot * 2].copy_from_slice(&[0x1b, 0xe4]);
    bytes[0x1ff0 + slot * 2..0x1ff2 + slot * 2].copy_from_slice(&stored_checksum.to_le_bytes());
    SaveDetectionInput {
        bytes,
        selected_game: Some(game.into()),
        rom_sha1: None,
    }
}

// Checksums come from an instruction-level port of the game's ADC loop, so the last add's
// carry is dropped and earlier carries enter the next add.
#[test]
fn edit_accepts_and_writes_the_games_checksum_after_a_carry() {
    let registry = SaveGameRegistry::default();
    let game = identity(&registry, "chrono-trigger-slot-1");
    let input = sram(0, &[(0, 0x0001), (2, 0xfffe)], 0xffff, &game.id);
    let output = registry
        .apply(
            &input,
            &game,
            &[SaveEdit {
                field: "gold".into(),
                value: SaveValue::U32(1),
            }],
            false,
        )
        .expect("a save with the game's own checksum must be editable")
        .bytes
        .expect("edited bytes");
    assert_eq!(output[0x5e0..0x5e3], [0x01, 0x00, 0x00]);
    assert_eq!(
        output[0x1ff0..0x1ff2],
        [0x00, 0x00],
        "edit must store the game's checksum"
    );
}

#[test]
fn first_item_reads_the_first_inventory_byte() {
    let registry = SaveGameRegistry::default();
    let game = identity(&registry, "chrono-trigger-slot-2");
    let input = sram(1, &[(0, 0x00c4), (0x2c4, 0x7700)], 0x77c4, &game.id);
    let document = registry.parse(&input, &game).expect("valid slot 2");
    let first_item = document
        .fields
        .iter()
        .find(|field| field.id == "inventory.first_item")
        .expect("first item field");
    assert_eq!(
        first_item.value,
        SaveValue::U32(0xc4),
        "first item must come from slot offset 0x0"
    );
}
