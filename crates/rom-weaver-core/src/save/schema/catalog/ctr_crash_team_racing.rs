use super::playstation_card::{self, BLOCK_SIZE};
use super::*;
use rules::Condition;

// Fields and the checksum MUST follow this pinned game layout.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/ctr-crash-team-racing/saveEditor
const CHECKSUM: usize = 0x177e;
const CHECKED: std::ops::Range<usize> = 0x100..0x1780;
const ADVENTURE_SLOTS: usize = 4;
const SLOT_STRIDE: usize = 0x50;
const SLOT_EMPTY: usize = 0x12f;

/// Remainder of the message polynomial modulo 0x11021. Message bits enter the register from
/// below with no 16 trailing zero bits, unlike CRC-16/XMODEM.
fn remainder(data: impl IntoIterator<Item = u8>) -> u16 {
    let mut register = 0u32;
    for byte in data {
        for bit in (0..8).rev() {
            register <<= 1;
            let overflow = register & 0x10000 != 0;
            register |= u32::from(byte >> bit) & 1;
            if overflow {
                register ^= 0x11021;
            }
        }
    }
    register as u16
}

/// The remainder over the checked range with the stored checksum zeroed; the game stores it
/// byte-swapped.
fn checksum(bytes: &[u8]) -> u16 {
    let stored = CHECKSUM - CHECKED.start;
    let data = bytes[CHECKED].iter().enumerate().map(|(index, byte)| {
        if (stored..stored + 2).contains(&index) {
            0
        } else {
            *byte
        }
    });
    remainder(data).swap_bytes()
}

fn character_choices() -> Vec<FieldChoice> {
    choices(&[
        ("Crash Bandicoot", 0),
        ("Dr. Neo Cortex", 1),
        ("Tiny Tiger", 2),
        ("Coco Bandicoot", 3),
        ("N. Gin", 4),
        ("Dingodile", 5),
        ("Polar", 6),
        ("Pura", 7),
        ("Pinstripe", 8),
        ("Papu Papu", 9),
        ("Ripper Roo", 10),
        ("Komodo Joe", 11),
        ("Dr. N. Tropy", 12),
        ("Penta Penguin", 13),
        ("Fake Crash", 14),
    ])
}

fn slot_fields(base: usize, slot: usize, fields: &mut Vec<FieldDefinition>) {
    let shift = base + slot * SLOT_STRIDE;
    let prefix = format!("adventure_{}", slot + 1);
    let label = format!("Adventure slot {}", slot + 1);
    let mut slot_fields = vec![
        catalog_field(
            &format!("{prefix}.character"),
            &format!("{label} character"),
            shift + 0x12e,
            Storage::U8,
        )
        .choices(character_choices()),
        catalog_field(
            &format!("{prefix}.location"),
            &format!("{label} location"),
            shift + 0x132,
            Storage::U8,
        )
        .choices(choices(&[
            ("Gem Stone Valley", 0x19),
            ("N. Sanity Beach", 0x1a),
            ("The Lost Ruins", 0x1b),
            ("Glacier Park", 0x1c),
            ("Citadel City", 0x1d),
        ])),
    ];
    for (id, name, offset, bit) in [
        ("gem_stone_valley", "Gem Stone Valley", 0x110, 4),
        ("gem_races", "Gem Races", 0x110, 5),
        (
            "glacier_park_from_beach",
            "Glacier Park (from N. Sanity Beach)",
            0x110,
            6,
        ),
        (
            "glacier_park_from_ruins",
            "Glacier Park (from The Lost Ruins)",
            0x110,
            7,
        ),
        ("citadel_city", "Citadel City", 0x111, 0),
    ] {
        slot_fields.push(
            catalog_field(
                &format!("{prefix}.world_door.{id}"),
                &format!("{label} world door: {name}"),
                shift + offset,
                Storage::Bit,
            )
            .bit(bit),
        );
    }
    // A slot whose byte at 0x12f is 0xff is empty and holds no editable data.
    let active = Condition::new(move |bytes| Ok(bytes[shift + SLOT_EMPTY] != 0xff));
    for field in &mut slot_fields {
        field.behavior.present_when = Some(active.clone());
        field.behavior.editable_when = Some(active.clone());
    }
    fields.extend(slot_fields);
}

fn fields(base: usize) -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (id, name, offset, bit) in [
        ("character.dr_n_tropy", "Dr. N. Tropy unlocked", 0x248, 5),
        (
            "character.penta_penguin",
            "Penta Penguin unlocked",
            0x248,
            6,
        ),
        ("character.ripper_roo", "Ripper Roo unlocked", 0x248, 7),
        ("character.papu_papu", "Papu Papu unlocked", 0x249, 0),
        ("character.komodo_joe", "Komodo Joe unlocked", 0x249, 1),
        ("character.pinstripe", "Pinstripe unlocked", 0x249, 2),
        ("character.fake_crash", "Fake Crash unlocked", 0x249, 3),
        ("level.turbo_track", "Turbo Track unlocked", 0x248, 1),
        ("level.parking_lot", "Parking Lot unlocked", 0x248, 2),
        ("level.the_north_bowl", "The North Bowl unlocked", 0x248, 3),
        ("level.lab_basement", "Lab Basement unlocked", 0x248, 4),
        ("menu.scrapbook", "Scrapbook unlocked", 0x24c, 4),
    ] {
        fields.push(catalog_field(id, name, base + offset, Storage::Bit).bit(bit));
    }
    for slot in 0..ADVENTURE_SLOTS {
        slot_fields(base, slot, &mut fields);
    }
    for (id, label, offset) in [
        ("options.fx_volume", "Effects volume", 0x16d8),
        ("options.music_volume", "Music volume", 0x16da),
        ("options.voice_volume", "Voice volume", 0x16dc),
    ] {
        fields.push(catalog_field(id, label, base + offset, Storage::U8));
    }
    fields.push(
        catalog_field(
            "options.sound_mode",
            "Sound mode",
            base + 0x16fc,
            Storage::U8,
        )
        .choices(choices(&[("Mono", 0), ("Stereo", 1)])),
    );
    for controller in 0..4 {
        fields.push(
            catalog_field(
                &format!("options.controller_{}.vibration_off", controller + 1),
                &format!("Controller {} vibration off", controller + 1),
                base + 0x16f9,
                Storage::Bit,
            )
            .bit(controller),
        );
    }
    fields
}

fn integrity(game: &mut GameDefinition, base: usize) {
    playstation_card::integrity(
        game,
        base,
        &playstation_card::Integrity {
            code: "ctr_checksum",
            message: "selected Crash Team Racing block checksum is invalid",
            storage: Storage::U16Le,
            offsets: &[CHECKSUM],
            span: BLOCK_SIZE,
        },
        |_| true,
        |block| u32::from(checksum(block)),
    );
}

fn profile(region: &str, product: &'static str, block: usize) -> GameDefinition {
    let base = block * BLOCK_SIZE;
    let mut game = playstation_card::definition(
        "ctr-crash-team-racing",
        "CTR: Crash Team Racing",
        region,
        product,
        block,
        1,
        fields(base),
    );
    integrity(&mut game, base);
    game
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for block in 1..=15 {
        for (region, product) in [
            ("europe", "SCES-02105"),
            ("usa", "SCUS-94426"),
            ("japan", "SCPS-10118"),
        ] {
            games.push(profile(region, product, block));
        }
    }
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::super::ps1_action_support::*;
    use super::*;

    const BLOCK: usize = 7;
    const BASE: usize = BLOCK * BLOCK_SIZE;

    fn game() -> GameDefinition {
        profile("usa", "SCUS-94426", BLOCK)
    }

    /// Byte-wise restatement of the same remainder: `r' = ((r << 8) | byte) mod G`, folding the
    /// register's top byte through a table of `t * x^16 mod G`.
    fn expected_checksum(bytes: &[u8]) -> [u8; 2] {
        let mut table = [0u32; 256];
        for (top, entry) in table.iter_mut().enumerate() {
            let mut value = (top as u32) << 16;
            for bit in (16..24).rev() {
                if value >> bit & 1 == 1 {
                    value ^= 0x11021 << (bit - 16);
                }
            }
            *entry = value;
        }
        let mut register = 0u32;
        for (index, byte) in bytes[BASE + 0x100..BASE + 0x1780].iter().enumerate() {
            let byte = if index == 0x177e - 0x100 || index == 0x177f - 0x100 {
                0
            } else {
                u32::from(*byte)
            };
            register = ((register & 0xff) << 8 | byte) ^ table[(register >> 8) as usize];
        }
        [(register >> 8) as u8, register as u8]
    }

    fn seal(bytes: &mut [u8]) {
        let [high, low] = expected_checksum(bytes);
        bytes[BASE + 0x177e] = high;
        bytes[BASE + 0x177f] = low;
    }

    fn template() -> Vec<u8> {
        let game = game();
        let mut bytes = playstation_card::fixture("SCUS-94426", BLOCK);
        lcg_fill(&mut bytes[BASE + 0x100..BASE + 0x1780], 0xc7a);
        for field in game.fields.iter().filter(|field| !field.choices.is_empty()) {
            bytes[field.offset] = field.choices[0].value as u8;
        }
        // Slots 1 and 3 are in use, slots 2 and 4 are empty.
        for slot in 0..4 {
            bytes[BASE + 0x12f + slot * 0x50] = if slot % 2 == 0 { 0 } else { 0xff };
        }
        seal(&mut bytes);
        bytes
    }

    #[test]
    fn remainder_matches_polynomial_division_vectors() {
        // Vectors from big-integer polynomial long division by 0x11021.
        for (data, expected) in [
            (&[0x12u8, 0x34][..], 0x1234),
            (&[0xff, 0xff], 0xffff),
            (&[0xff, 0xff, 0x00], 0xe1f0),
            (&[1, 2, 3, 4, 5], 0x6534),
            (&[0xde, 0xad, 0xbe, 0xef, 0x00, 0x01], 0xc456),
            (b"123456789", 0xbeef),
            (&[], 0),
        ] {
            assert_eq!(remainder(data.iter().copied()), expected, "{data:x?}");
        }
    }

    #[test]
    fn checksum_matches_the_bytewise_form_and_ignores_outside_bytes() {
        let mut random = playstation_card::fixture("SCUS-94426", BLOCK);
        lcg_fill(&mut random[BASE + 0x100..BASE + 0x1780], 5);
        let block = |bytes: &[u8]| checksum(&bytes[BASE..BASE + BLOCK_SIZE]).to_le_bytes();
        assert_eq!(block(&random), expected_checksum(&random));
        let sealed = block(&random);
        random[BASE + 0x177e] ^= 0xff;
        random[BASE + 0x177f] ^= 0xff;
        assert_eq!(block(&random), sealed, "the stored checksum is excluded");
        random[BASE + 0x1780] ^= 0xff;
        random[BASE + 0xff] ^= 0xff;
        assert_eq!(
            block(&random),
            sealed,
            "bytes outside the range are ignored"
        );
        random[BASE + 0x100] ^= 1;
        assert_ne!(block(&random), sealed);
        assert_eq!(block(&random), expected_checksum(&random));
        let zeros = vec![0u8; BASE + BLOCK_SIZE];
        assert_eq!(block(&zeros), [0, 0]);
    }

    #[test]
    fn every_field_edits_only_itself_and_the_checksum() {
        let game = game();
        let template = template();
        let original = parse_fields(&game, &template);
        // Twelve global flags, two used slots of seven, and eight option fields.
        assert_eq!(original.len(), 12 + 2 * 7 + 8);
        assert_eq!(game.fields.len(), 12 + 4 * 7 + 8);
        let edits = edit_each_field(&game, &template);
        assert_eq!(edits.len(), original.len());
        for edit in edits {
            assert!(
                edit.stray
                    .iter()
                    .all(|index| *index == BASE + 0x177e || *index == BASE + 0x177f),
                "{}: {:x?}",
                edit.id,
                edit.stray
            );
            assert_only_changed(&edit, &original, &[]);
            assert_eq!(
                edit.after[BASE + 0x177e..BASE + 0x1780],
                expected_checksum(&edit.after),
                "{}",
                edit.id
            );
        }
    }

    #[test]
    fn spot_checks_use_the_documented_offsets_and_skip_empty_slots() {
        let game = game();
        let template = template();
        let edits = edit_each_field(&game, &template);
        let find = |id: &str| edits.iter().find(|edit| edit.id == id).unwrap();
        let bit = |id: &str, offset: usize, mask: u8| {
            assert_eq!(
                find(id).after[BASE + offset] & mask,
                (template[BASE + offset] & mask) ^ mask,
                "{id}"
            );
        };
        bit("character.dr_n_tropy", 0x248, 0x20);
        bit("character.fake_crash", 0x249, 0x08);
        bit("level.lab_basement", 0x248, 0x10);
        bit("menu.scrapbook", 0x24c, 0x10);
        bit(
            "adventure_3.world_door.citadel_city",
            0x111 + 2 * 0x50,
            0x01,
        );
        bit("options.controller_4.vibration_off", 0x16f9, 0x08);
        assert_eq!(find("adventure_1.character").after[BASE + 0x12e], 14);
        assert_eq!(
            find("adventure_3.location").after[BASE + 0x132 + 2 * 0x50],
            0x1d
        );
        assert_eq!(find("options.sound_mode").after[BASE + 0x16fc], 1);
        assert_eq!(find("options.music_volume").after[BASE + 0x16da], 255);
        assert!(edits.iter().all(|edit| !edit.id.starts_with("adventure_2")));
        assert!(edits.iter().all(|edit| !edit.id.starts_with("adventure_4")));
        let handler = handler(&game);
        let identity = handler.definitions().remove(0).identity;
        let rejected = handler.apply(
            &input(template, &identity.id),
            &identity,
            &[SaveEdit {
                field: "adventure_2.character".into(),
                value: SaveValue::Enum("Pura".into()),
            }],
            false,
        );
        assert!(rejected.is_err());
    }

    #[test]
    fn rejects_unlisted_choices_and_damaged_blocks() {
        let game = game();
        let handler = handler(&game);
        let identity = handler.definitions().remove(0).identity;
        let template = template();
        let source = input(template.clone(), &identity.id);
        for (field, value) in [
            ("adventure_1.character", SaveValue::Enum("raw:15".into())),
            ("adventure_1.location", SaveValue::Enum("raw:0".into())),
            ("options.sound_mode", SaveValue::Enum("raw:2".into())),
            ("options.fx_volume", SaveValue::U32(256)),
        ] {
            let edit = SaveEdit {
                field: field.into(),
                value,
            };
            assert!(
                handler.apply(&source, &identity, &[edit], false).is_err(),
                "{field}"
            );
        }
        for offset in [0x100, 0x177d, 0x177e, 0x177f] {
            let mut bytes = template.clone();
            bytes[BASE + offset] ^= 1;
            assert!(
                handler
                    .apply(&input(bytes, &identity.id), &identity, &[], false)
                    .is_err(),
                "accepted damage at {offset:x}"
            );
        }
        let mut bytes = template;
        bytes[BASE + 0x1780] ^= 1;
        assert!(
            handler
                .apply(&input(bytes, &identity.id), &identity, &[], false)
                .is_ok()
        );
    }
}
