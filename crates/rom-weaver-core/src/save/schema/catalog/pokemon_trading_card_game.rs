use super::super::rules::{ReadValue, Scalar, Store};
use super::*;

fn location_preview(bytes: &[u8]) -> Result<i64> {
    Ok(match bytes[0x5810] {
        0..=2 => 1,
        3 => 2,
        location => i64::from((location + 5) / 3),
    })
}

const ALBUM_COUNT_OFFSET: usize = 0x58fe;
const CARD_OFFSET: usize = 0x4100;
const MAIL_OFFSET: usize = 0x582d;

// Card (prefix, name) in game index order; card N lives at `CARD_OFFSET + N` with N starting at 1.
const CARDS: [(&str, &str); 228] = [
    ("E01", "Grass Energy"),
    ("E02", "Fire Energy"),
    ("E03", "Water Energy"),
    ("E04", "Lightning Energy"),
    ("E05", "Fighting Energy"),
    ("E06", "Psychic Energy"),
    ("E07", "Double Colorless Energy"),
    ("B01", "Bulbasaur Lv13"),
    ("B02", "Ivysaur Lv20"),
    ("PXX", "Venusaur Lv64"),
    ("B03", "Venusaur Lv67"),
    ("B04", "Caterpie Lv13"),
    ("B05", "Metapod Lv21"),
    ("B06", "Butterfree Lv28"),
    ("B07", "Weedle Lv12"),
    ("B08", "Kakuna Lv23"),
    ("B09", "Beedrill Lv32"),
    ("D01", "Ekans Lv10"),
    ("D02", "Arbok Lv27"),
    ("C01", "Nidoran♀ Lv13"),
    ("C02", "Nidorina Lv24"),
    ("C03", "Nidoqueen Lv43"),
    ("A01", "Nidoran♂ Lv20"),
    ("A02", "Nidorino Lv25"),
    ("B10", "Nidoking Lv48"),
    ("D03", "Zubat Lv10"),
    ("D04", "Golbat Lv29"),
    ("C04", "Oddish Lv8"),
    ("C05", "Gloom Lv22"),
    ("C06", "Vileplume Lv35"),
    ("C07", "Paras Lv8"),
    ("C08", "Parasect Lv28"),
    ("D05", "Venonat Lv12"),
    ("D06", "Venomoth Lv28"),
    ("B11", "Bellsprout Lv11"),
    ("B12", "Weepinbell Lv28"),
    ("B13", "Victreebel Lv42"),
    ("D07", "Grimer Lv17"),
    ("D08", "Muk Lv34"),
    ("C09", "Exeggcute Lv14"),
    ("C10", "Exeggutor Lv35"),
    ("D09", "Koffing Lv13"),
    ("D10", "Weezing Lv27"),
    ("D11", "Tangela Lv8"),
    ("A03", "Tangela Lv12"),
    ("A04", "Scyther Lv25"),
    ("A05", "Pinsir Lv24"),
    ("A06", "Charmander Lv10"),
    ("A07", "Charmeleon Lv32"),
    ("B14", "Charizard Lv76"),
    ("C11", "Vulpix Lv11"),
    ("C12", "Ninetails Lv32"),
    ("D12", "Ninetails Lv35"),
    ("A08", "Growlithe Lv18"),
    ("P01", "Arcanine Lv34"),
    ("A09", "Arcanine Lv45"),
    ("A10", "Ponyta Lv10"),
    ("B15", "Rapidash Lv33"),
    ("A11", "Magmar Lv24"),
    ("D13", "Magmar Lv31"),
    ("C13", "Flareon Lv22"),
    ("B16", "Flareon Lv28"),
    ("C14", "Moltres Lv35"),
    ("P02", "Moltres Lv37"),
    ("B17", "Squirtle Lv8"),
    ("B18", "Wartortle Lv22"),
    ("B19", "Blastoise Lv52"),
    ("D14", "Psyduck Lv15"),
    ("D15", "Golduck Lv27"),
    ("D16", "Poliwag Lv13"),
    ("D17", "Poliwhirl Lv28"),
    ("D18", "Poliwrath Lv48"),
    ("D19", "Tentacool Lv10"),
    ("D20", "Tentacruel Lv21"),
    ("A12", "Seel Lv12"),
    ("A13", "Dewgong Lv42"),
    ("C15", "Shellder Lv8"),
    ("C16", "Cloyster Lv25"),
    ("B20", "Krabby Lv20"),
    ("B21", "Kingler Lv27"),
    ("D21", "Horsea Lv19"),
    ("D22", "Seadra Lv23"),
    ("A14", "Goldeen Lv12"),
    ("A15", "Seaking Lv28"),
    ("A16", "Staryu Lv15"),
    ("B22", "Starmie Lv28"),
    ("A17", "Magikarp Lv8"),
    ("A18", "Gyarados Lv41"),
    ("C17", "Lapras Lv31"),
    ("C18", "Vaporeon Lv29"),
    ("B23", "Vaporeon Lv42"),
    ("C19", "Omanyte Lv19"),
    ("C20", "Omastar Lv32"),
    ("C21", "Articuno Lv35"),
    ("P03", "Articuno Lv37"),
    ("A19", "Pikachu Lv12"),
    ("C22", "Pikachu Lv14"),
    ("P04", "Pikachu Lv16"),
    ("P05", "Pikachu Lv16"),
    ("P06", "Flying Pikachu Lv12"),
    ("P07", "Surfing Pikachu Lv13"),
    ("P08", "Surfing Pikachu Lv13"),
    ("A20", "Raichu Lv40"),
    ("C23", "Raichu Lv45"),
    ("A21", "Magnemite Lv13"),
    ("D23", "Magnemite Lv15"),
    ("A22", "Magneton Lv28"),
    ("D24", "Magneton Lv35"),
    ("C24", "Voltorb Lv10"),
    ("D25", "Electrode Lv35"),
    ("C25", "Electrode Lv42"),
    ("P09", "Electabuzz Lv20"),
    ("A23", "Electabuzz Lv35"),
    ("C26", "Jolteon Lv24"),
    ("B24", "Jolteon Lv29"),
    ("C27", "Zapdos Lv40"),
    ("A24", "Zapdos Lv64"),
    ("P10", "Zapdos Lv68"),
    ("B25", "Sandshrew Lv12"),
    ("B26", "Sandslash Lv33"),
    ("A25", "Diglett Lv8"),
    ("A26", "Dugtrio Lv36"),
    ("C28", "Mankey Lv7"),
    ("C29", "Primeape Lv35"),
    ("A27", "Machop Lv20"),
    ("B27", "Machoke Lv40"),
    ("B28", "Machamp Lv67"),
    ("B29", "Geodude Lv16"),
    ("B30", "Graveler Lv29"),
    ("B31", "Golem Lv36"),
    ("D26", "Onix Lv12"),
    ("B32", "Cubone Lv13"),
    ("D27", "Marowak Lv26"),
    ("B33", "Marowak Lv32"),
    ("D28", "Hitmonlee Lv30"),
    ("A28", "Hitmonchan Lv33"),
    ("C30", "Rhyhorn Lv18"),
    ("C31", "Rhydon Lv48"),
    ("C32", "Kabuto Lv9"),
    ("C33", "Kabutops Lv30"),
    ("C34", "Aerodactyl Lv28"),
    ("A29", "Abra Lv10"),
    ("A30", "Kadabra Lv38"),
    ("C35", "Alakazam Lv42"),
    ("P11", "Slowpoke Lv9"),
    ("D29", "Slowpoke Lv18"),
    ("D30", "Slowbro Lv26"),
    ("B34", "Gastly Lv8"),
    ("D31", "Gastly Lv17"),
    ("D32", "Haunter Lv17"),
    ("B35", "Haunter Lv22"),
    ("B36", "Gengar Lv38"),
    ("C36", "Drowzee Lv12"),
    ("D33", "Hypno Lv36"),
    ("D34", "Mr. Mime Lv28"),
    ("B37", "Jynx Lv23"),
    ("D35", "Mewtwo Lv53"),
    ("P12", "Mewtwo Lv60"),
    ("P13", "Mewtwo Lv60"),
    ("P14", "Mew Lv8"),
    ("PXX", "Mew Lv15"),
    ("C37", "Mew Lv23"),
    ("B38", "Pidgey Lv8"),
    ("B39", "Pidgeotto Lv36"),
    ("D36", "Pidgeot Lv38"),
    ("B40", "Pidgeot Lv40"),
    ("A31", "Rattata Lv9"),
    ("A32", "Raticate Lv41"),
    ("D37", "Spearow Lv13"),
    ("D38", "Fearow Lv27"),
    ("C38", "Clefairy Lv14"),
    ("D39", "Clefable Lv34"),
    ("P15", "Jigglypuff Lv12"),
    ("B41", "Jigglypuff Lv13"),
    ("A33", "Jigglypuff Lv14"),
    ("A34", "Wigglytuff Lv36"),
    ("A35", "Meowth Lv14"),
    ("C39", "Meowth Lv15"),
    ("C40", "Persian Lv25"),
    ("C41", "Farfetch'd Lv20"),
    ("D40", "Doduo Lv10"),
    ("D41", "Dodrio Lv28"),
    ("C42", "Lickitung Lv26"),
    ("A36", "Chansey Lv55"),
    ("A37", "Kangaskhan Lv40"),
    ("C43", "Tauros Lv32"),
    ("D42", "Ditto Lv19"),
    ("B42", "Eevee Lv12"),
    ("D43", "Porygon Lv12"),
    ("A38", "Snorlax Lv20"),
    ("C44", "Dratini Lv10"),
    ("C45", "Dragonair Lv33"),
    ("P16", "Dragonite Lv41"),
    ("C46", "Dragonite Lv45"),
    ("A39", "Professor Oak"),
    ("D44", "Imposter Professor Oak"),
    ("A40", "Bill"),
    ("C47", "Mr.Fuji"),
    ("D45", "Lass"),
    ("P17", "Imakuni?"),
    ("B43", "Pokémon Trader"),
    ("B44", "Pokémon Breeder"),
    ("B45", "Clefairy Doll"),
    ("C48", "Mysterious Fossil"),
    ("B46", "Energy Retrieval"),
    ("P18", "Super Energy Retrieval"),
    ("B47", "Energy Search"),
    ("C49", "Energy Removal"),
    ("D46", "Super Energy Removal"),
    ("A41", "Switch"),
    ("C50", "Pokémon Center"),
    ("A42", "Poké Ball"),
    ("A43", "Scoop Up"),
    ("A44", "Computer Search"),
    ("D47", "Pokédex"),
    ("A45", "Pluspower"),
    ("A46", "Defender"),
    ("A47", "Item Finder"),
    ("B48", "Gust of Wind"),
    ("D48", "Devolution Spray"),
    ("A48", "Potion"),
    ("B49", "Super Potion"),
    ("A49", "Full Heal"),
    ("A50", "Revive"),
    ("D49", "Maintenance"),
    ("B50", "Pokémon Flute"),
    ("D50", "Gambler"),
    ("D51", "Recycle"),
];

fn byte_store(
    offset: usize,
    mask: Option<u32>,
    value: impl Fn(&[u8]) -> i64 + Send + Sync + 'static,
) -> Store {
    Store {
        when: None,
        destination: Scalar {
            offset,
            storage: Storage::U8,
            mask,
        },
        value: ReadValue::new(move |bytes| Ok(value(bytes))),
    }
}

// The save preview's album count follows the number of cards in the collection (bit 7 clear).
fn album_store(offset: usize, delta: impl Fn(u8) -> i64 + Send + Sync + 'static) -> Store {
    byte_store(ALBUM_COUNT_OFFSET, None, move |bytes| {
        let count = i64::from(bytes[ALBUM_COUNT_OFFSET]) + delta(bytes[offset]);
        trace!(offset, count, "updated Pokemon TCG album count");
        count
    })
}

fn card_fields() -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (index, (prefix, name)) in CARDS.iter().enumerate() {
        let offset = CARD_OFFSET + index + 1;
        let id = format!("card.{:03}", index + 1);
        // Setting a count also marks the card as collected, as the upstream editor does.
        let mut count = catalog_field(
            &format!("{id}.count"),
            &format!("{prefix} {name} copies"),
            offset,
            Storage::U8,
        )
        .mask(0x7f)
        .max(99);
        count.behavior.on_edit = vec![
            album_store(offset, |byte| i64::from(byte >> 7)),
            byte_store(offset, Some(0x80), |_| 0),
        ];
        fields.push(count);
        let mut collected = catalog_field(
            &format!("{id}.collected"),
            &format!("{prefix} {name} in collection"),
            offset,
            Storage::Bit,
        )
        .bit(7)
        .inverted(true);
        collected.behavior.on_edit =
            vec![album_store(
                offset,
                |byte| {
                    if byte & 0x80 == 0 { 1 } else { -1 }
                },
            )];
        fields.push(collected);
    }
    fields
}

fn config_fields() -> Vec<FieldDefinition> {
    let mut fields = vec![
        catalog_field("config.message_speed", "Message speed", 0x6, Storage::U8).choices(choices(
            &[
                ("speed-5", 0),
                ("speed-4", 1),
                ("speed-3", 2),
                ("speed-2", 4),
                ("speed-1", 6),
            ],
        )),
        // The animation setting spans two bytes: the high bit at 0x7 and the low bit at 0x9.
        catalog_field("config.duel_animation", "Duel animation", 0x7, Storage::U8)
            .choices(choices(&[("show-all", 0), ("skip-some", 1), ("none", 3)]))
            .behavior(field::FieldBehavior {
                read: Some(ReadValue::new(|bytes| {
                    Ok(i64::from(bytes[0x7]) << 1 | i64::from(bytes[0x9]))
                })),
                on_edit: vec![
                    byte_store(0x9, None, |bytes| i64::from(bytes[0x7] & 1)),
                    byte_store(0x7, None, |bytes| i64::from(bytes[0x7] >> 1)),
                ],
                ..Default::default()
            }),
        catalog_field("config.print_quality", "Print quality", 0x3, Storage::U8)
            .min(1)
            .max(5)
            .behavior(field::FieldBehavior {
                read: Some(ReadValue::new(|bytes| Ok(i64::from(bytes[0x3]) + 1))),
                on_edit: vec![byte_store(0x3, None, |bytes| i64::from(bytes[0x3]) - 1)],
                ..Default::default()
            }),
        catalog_field(
            "challenge_machine.unlocked",
            "Challenge Machine unlocked",
            0x5881,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "challenge_machine.defeated_five_count",
            "Challenge Machine defeated 5 opponents count",
            0x1a45,
            Storage::U16Le,
        )
        .max(999),
        catalog_field(
            "challenge_machine.max_consecutive_wins",
            "Challenge Machine maximum consecutive wins",
            0x1a56,
            Storage::U16Le,
        )
        .max(999),
    ];
    for slot in 0..15 {
        fields.push(
            catalog_field(
                &format!("mail.slot_{}", slot + 1),
                &format!("Mail slot {} (0: empty)", slot + 1),
                MAIL_OFFSET + slot,
                Storage::U8,
            )
            .mask(0x7f)
            .max(15),
        );
        fields.push(
            catalog_field(
                &format!("mail.slot_{}_unread", slot + 1),
                &format!("Mail slot {} unread", slot + 1),
                MAIL_OFFSET + slot,
                Storage::Bit,
            )
            .bit(7),
        );
    }
    fields
}

// Layout and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/pokemon-trading-card-game/saveEditor
// Deepened against: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/pokemon-trading-card-game/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = vec![
        catalog_field("playtime.seconds", "Playtime seconds", 0x580b, Storage::U8).max(59),
        catalog_field("playtime.minutes", "Playtime minutes", 0x580c, Storage::U8).max(59),
        catalog_field("playtime.hours", "Playtime hours", 0x580d, Storage::U16Le).max(999),
        catalog_field("location", "Location", 0x5810, Storage::U8)
            .max(0x21)
            .behavior(field::FieldBehavior {
                on_edit: [0x5809, 0x580f]
                    .into_iter()
                    .map(|offset| Store {
                        when: None,
                        destination: Scalar {
                            offset,
                            storage: Storage::U8,
                            mask: None,
                        },
                        value: ReadValue::new(location_preview),
                    })
                    .collect(),
                ..Default::default()
            }),
        catalog_field(
            "position_x_raw",
            "Position X (half-tile units)",
            0x5811,
            Storage::U8,
        )
        .max(28),
        catalog_field(
            "position_y_raw",
            "Position Y (half-tile units)",
            0x5812,
            Storage::U8,
        )
        .max(28),
    ];
    for (bit, name) in [
        "Grass",
        "Science",
        "Fire",
        "Water",
        "Lightning",
        "Psychic",
        "Rock",
        "Fighting",
    ]
    .into_iter()
    .enumerate()
    {
        fields.push(
            FieldDefinition::new(
                format!("medal.{}", name.to_lowercase()),
                format!("{name} Medal"),
                0x587b,
                Storage::Bit,
            )
            .bit(7 - bit as u8)
            .behavior(field::FieldBehavior {
                on_edit: vec![Store {
                    when: None,
                    destination: Scalar {
                        offset: 0x5808,
                        storage: Storage::U8,
                        mask: None,
                    },
                    value: ReadValue::new(|bytes| Ok(i64::from(bytes[0x587b].count_ones()))),
                }],
                ..Default::default()
            }),
        );
    }
    fields.extend(config_fields());
    fields.extend(card_fields());
    build(vec![GameDefinition { fields, description: "Edits playtime, position, Master Medals, config, Challenge Machine records, mail, and the card album (copies and collection flags, with the save-preview album count). Names and decks are omitted because they need region-specific text tables.".into(), signatures: vec![SignatureDefinition{offset:0,bytes:vec![4,0x21,5]},SignatureDefinition{offset:0x5800,bytes:vec![8]}], checksums: vec![ChecksumDefinition{start:Some(0x5804),length:Some(0xb7),exclude:vec![ChecksumExclusion{offset:0x5804,length:2}],..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le,0x5804)}], ..GameDefinition::new("pokemon-trading-card-game".into(), "Pokémon Trading Card Game".into(), "game-boy-color".into(), 32768)}],BTreeMap::new(),true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repair(b: &mut [u8]) {
        let sum = b[0x5806..0x58bb]
            .iter()
            .fold(0u16, |s, v| s.wrapping_add(u16::from(*v)));
        b[0x5804..0x5806].copy_from_slice(&sum.to_le_bytes());
    }
    #[test]
    fn medal_edit_preserves_other_bits_and_repairs_checksum() {
        let h = schemas().remove(0);
        let id = h.definitions().remove(0).identity;
        let mut bytes = vec![0x44; 32768];
        bytes[..3].copy_from_slice(&[4, 0x21, 5]);
        bytes[0x5800] = 8;
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(id.id.clone()),
            rom_sha1: None,
        };
        let out = h
            .apply(
                &input,
                &id,
                &[
                    SaveEdit {
                        field: "medal.grass".into(),
                        value: SaveValue::Bool(true),
                    },
                    SaveEdit {
                        field: "playtime.minutes".into(),
                        value: SaveValue::U32(17),
                    },
                ],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        expected[0x587b] |= 0x80;
        expected[0x5808] = 3;
        expected[0x580c] = 17;
        repair(&mut expected);
        assert_eq!(out, expected);
        assert!(h.apply(&input, &id, &[], false).unwrap().bytes.is_none());
        let mut bad = input;
        bad.bytes[0x5804] ^= 1;
        assert!(h.apply(&bad, &id, &[], false).is_err());
    }

    #[test]
    fn location_edits_update_both_preview_copies() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        for (locations, preview) in [
            (0..=2, 1),
            (3..=3, 2),
            (4..=6, 3),
            (7..=9, 4),
            (10..=12, 5),
            (13..=15, 6),
            (16..=18, 7),
            (19..=21, 8),
            (22..=24, 9),
            (25..=27, 10),
            (28..=30, 11),
            (31..=33, 12),
        ] {
            for location in locations {
                let mut bytes = vec![0x44; 32768];
                bytes[..3].copy_from_slice(&[4, 0x21, 5]);
                bytes[0x5800] = 8;
                repair(&mut bytes);
                let input = SaveDetectionInput {
                    bytes,
                    selected_game: Some(identity.id.clone()),
                    rom_sha1: None,
                };
                let mut expected = input.bytes.clone();
                expected[0x5810] = location;
                expected[0x5809] = preview;
                expected[0x580f] = preview;
                repair(&mut expected);
                let output = handler
                    .apply(
                        &input,
                        &identity,
                        &[SaveEdit {
                            field: "location".into(),
                            value: SaveValue::U32(u32::from(location)),
                        }],
                        false,
                    )
                    .unwrap()
                    .bytes
                    .unwrap();
                assert_eq!(output, expected);
            }
        }
    }

    fn fixture() -> (SchemaSaveHandler, SaveGameIdentity, SaveDetectionInput) {
        let h = schemas().remove(0);
        let id = h.definitions().remove(0).identity;
        let mut bytes = vec![0x44; 32768];
        bytes[..3].copy_from_slice(&[4, 0x21, 5]);
        bytes[0x5800] = 8;
        bytes[0x4100..0x4200].fill(0);
        bytes[ALBUM_COUNT_OFFSET] = 10;
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(id.id.clone()),
            rom_sha1: None,
        };
        (h, id, input)
    }

    fn run(
        fixture: &(SchemaSaveHandler, SaveGameIdentity, SaveDetectionInput),
        edits: &[(&str, SaveValue)],
    ) -> Result<Vec<u8>> {
        let (h, id, input) = fixture;
        let edits: Vec<_> = edits
            .iter()
            .map(|(field, value)| SaveEdit {
                field: (*field).into(),
                value: value.clone(),
            })
            .collect();
        Ok(h.apply(input, id, &edits, false)?
            .bytes
            .expect("edit changes the save"))
    }

    #[test]
    fn config_challenge_machine_and_mail_edits_repair_the_checksum() {
        let fixture = fixture();
        let out = run(
            &fixture,
            &[
                ("config.message_speed", SaveValue::Enum("speed-1".into())),
                ("config.duel_animation", SaveValue::Enum("none".into())),
                ("config.print_quality", SaveValue::U32(5)),
                ("challenge_machine.unlocked", SaveValue::Bool(true)),
                ("challenge_machine.defeated_five_count", SaveValue::U32(999)),
                (
                    "challenge_machine.max_consecutive_wins",
                    SaveValue::U32(258),
                ),
                ("mail.slot_3", SaveValue::U32(15)),
                ("mail.slot_3_unread", SaveValue::Bool(true)),
                ("mail.slot_15", SaveValue::U32(1)),
            ],
        )
        .unwrap();
        let mut expected = fixture.2.bytes.clone();
        expected[0x6] = 6;
        expected[0x7] = 1;
        expected[0x9] = 1;
        expected[0x3] = 4;
        expected[0x5881] |= 2;
        expected[0x1a45..0x1a47].copy_from_slice(&[0xe7, 0x03]);
        expected[0x1a56..0x1a58].copy_from_slice(&[0x02, 0x01]);
        expected[0x582f] = 0x8f;
        expected[0x583b] = 1;
        repair(&mut expected);
        assert_eq!(out, expected);
        for (value, high, low) in [("skip-some", 0, 1), ("show-all", 0, 0)] {
            let mut input = fixture.2.clone();
            input.bytes[0x7] = 1;
            input.bytes[0x9] = 1;
            repair(&mut input.bytes);
            let out = run(
                &(fixture.0.clone(), fixture.1.clone(), input.clone()),
                &[("config.duel_animation", SaveValue::Enum(value.into()))],
            )
            .unwrap();
            let mut expected = input.bytes.clone();
            expected[0x7] = high;
            expected[0x9] = low;
            repair(&mut expected);
            assert_eq!(out, expected, "{value}");
        }
        assert!(run(&fixture, &[("config.print_quality", SaveValue::U32(0))]).is_err());
        assert!(run(&fixture, &[("mail.slot_1", SaveValue::U32(16))]).is_err());
    }

    #[test]
    fn card_edits_keep_the_album_count_in_step_with_collection_flags() {
        let mut fixture = fixture();
        // Card 1 is not collected (bit 7 set); card 2 is collected with five copies.
        fixture.2.bytes[0x4101] = 0x80;
        fixture.2.bytes[0x4102] = 0x05;
        fixture.2.bytes[0x4103] = 0x83;
        repair(&mut fixture.2.bytes);
        let out = run(
            &fixture,
            &[
                ("card.001.count", SaveValue::U32(7)),
                ("card.002.collected", SaveValue::Bool(false)),
                ("card.003.collected", SaveValue::Bool(true)),
                ("card.228.count", SaveValue::U32(99)),
            ],
        )
        .unwrap();
        let mut expected = fixture.2.bytes.clone();
        expected[0x4101] = 0x07;
        expected[0x4102] = 0x85;
        expected[0x4103] = 0x03;
        expected[0x4100 + 228] = 99;
        // +1 (card 1 newly collected), -1 (card 2), +1 (card 3); card 228 was already collected.
        expected[ALBUM_COUNT_OFFSET] = 11;
        repair(&mut expected);
        assert_eq!(out, expected);
        // Raising the copies of an already collected card leaves the count alone.
        let again = run(
            &(
                fixture.0.clone(),
                fixture.1.clone(),
                SaveDetectionInput {
                    bytes: out,
                    ..fixture.2.clone()
                },
            ),
            &[("card.001.count", SaveValue::U32(0))],
        )
        .unwrap();
        assert_eq!(again[0x4101], 0);
        assert_eq!(again[ALBUM_COUNT_OFFSET], 11);
        assert!(run(&fixture, &[("card.001.count", SaveValue::U32(100))]).is_err());
    }

    #[test]
    fn album_count_underflow_and_overflow_are_rejected() {
        let mut fixture = fixture();
        fixture.2.bytes[ALBUM_COUNT_OFFSET] = 0;
        repair(&mut fixture.2.bytes);
        assert!(run(&fixture, &[("card.010.collected", SaveValue::Bool(false))]).is_err());
        fixture.2.bytes[ALBUM_COUNT_OFFSET] = 255;
        fixture.2.bytes[0x410a] = 0x80;
        repair(&mut fixture.2.bytes);
        assert!(run(&fixture, &[("card.010.collected", SaveValue::Bool(true))]).is_err());
    }
}
