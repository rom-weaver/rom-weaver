use super::*;
use tracing::trace;

// Layout and event-flag locations: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/donkey-kong-country-2-diddy-s-kong-quest/saveEditor
// Original counter layout and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/donkey-kong-country-2-diddy-s-kong-quest/saveEditor

const SLOT_SIZE: usize = 0x2a8;
const PLAYER_SIZE: usize = 0x14e;

/// Event flags that nothing else in the save depends on: id, label, byte in the player block, and bit.
const VISIT_FLAGS: [(&str, &str, usize, u8); 3] = [
    ("visited.klubbas_kiosk", "Visited Klubba's Kiosk", 0xeb, 4),
    (
        "visited.monkey_museum_lost_world",
        "Visited the Lost World Monkey Museum",
        0xeb,
        5,
    ),
    (
        "misc.stronghold_showdown_cutscene_seen",
        "Stronghold Showdown cutscene seen",
        0xec,
        1,
    ),
];

/// World, byte, and the three Swanky's Bonus Bonanza games stored in bits 0-2.
const SWANKY_GAMES: [(&str, usize, [&str; 3]); 6] = [
    (
        "gangplank_galleon",
        0xe0,
        ["Swanky's Swag", "Pirate Puzzler", "Chimp Challenge"],
    ),
    (
        "crocodile_cauldron",
        0xe1,
        ["Cranky Challenge", "Lucky Lava", "Gorilla Game"],
    ),
    (
        "krem_quay",
        0xe2,
        ["Funky's Fun", "Swampy Swag", "Primate Prize"],
    ),
    (
        "krazy_kremland",
        0xe8,
        ["Wrinkly's Winner", "Krazy Kwiz", "Baboon Booty"],
    ),
    (
        "gloomy_gulch",
        0xe4,
        ["Lockjaw's Loot", "Haunted Haul", "Gibbon Game"],
    ),
    (
        "k_rool_s_keep",
        0xe5,
        ["K. Rool's Kwiz", "Castle Challenge", "Big Ape Bounty"],
    ),
];

/// World slug, label, and the byte holding its Funky's Flights "Hire Plane" (bit 0) and "Leave Airport" (bit 1) flags.
const FUNKY_AIRPORTS: [(&str, &str, usize); 7] = [
    ("gangplank_galleon", "Gangplank Galleon", 0xd7),
    ("crocodile_cauldron", "Crocodile Cauldron", 0xd8),
    ("krem_quay", "Krem Quay", 0xd9),
    ("krazy_kremland", "Krazy Kremland", 0xdf),
    ("gloomy_gulch", "Gloomy Gulch", 0xdb),
    ("k_rool_s_keep", "K. Rool's Keep", 0xdc),
    ("the_flying_krock", "The Flying Krock", 0xdd),
];

fn flag_field(prefix: &str, id: &str, label: &str, offset: usize, bit: u8) -> FieldDefinition {
    catalog_field(&format!("{prefix}.{id}"), label, offset, Storage::Bit).bit(bit)
}

fn event_fields(prefix: &str, base: usize) -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (id, label, offset, bit) in VISIT_FLAGS {
        fields.push(flag_field(prefix, id, label, base + offset, bit));
    }
    for (world, offset, games) in SWANKY_GAMES {
        for (bit, game) in games.iter().enumerate() {
            fields.push(flag_field(
                prefix,
                &format!("swankys.{world}.game_{}", bit + 1),
                &format!("Swanky's Bonus Bonanza: {game}"),
                base + offset,
                bit as u8,
            ));
        }
    }
    for (world, name, offset) in FUNKY_AIRPORTS {
        for (bit, id, label) in [
            (0, "hire_plane", "Hire Plane"),
            (1, "leave_airport", "Leave Airport"),
        ] {
            fields.push(flag_field(
                prefix,
                &format!("funkys.{world}.{id}"),
                &format!("Funky's Flights, {name}: {label}"),
                base + offset,
                bit,
            ));
        }
    }
    trace!(
        prefix,
        fields = fields.len(),
        "built Donkey Kong Country 2 event flags"
    );
    fields
}

fn default() -> GameDefinition {
    {
        let fields = vec![
            catalog_field("slot_1.player_1.kremkoins", "Kremkoins", 19, Storage::U8),
            catalog_field(
                "slot_1.player_1.play_time",
                "Play-time ticks",
                14,
                Storage::U32Le,
            ),
            catalog_field(
                "slot_1.player_1.completion",
                "Completion percentage",
                18,
                Storage::U8,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_1.hero_coins",
                "Hero's Coins",
                20,
                Storage::U8,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_1.location",
                "Location code",
                189,
                Storage::U8,
            )
            .editable(false),
            catalog_field("slot_1.player_2.kremkoins", "Kremkoins", 353, Storage::U8),
            catalog_field(
                "slot_1.player_2.play_time",
                "Play-time ticks",
                348,
                Storage::U32Le,
            ),
            catalog_field(
                "slot_1.player_2.completion",
                "Completion percentage",
                352,
                Storage::U8,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_2.hero_coins",
                "Hero's Coins",
                354,
                Storage::U8,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_2.location",
                "Location code",
                523,
                Storage::U8,
            )
            .editable(false),
        ];
        GameDefinition {
            fields,
            description: concat!(
                "Edits independent counters and event flags in Slot 1; preserves other slots. ",
                "Coupled progression, completion, inventory and location updates ",
                "remain unsupported. Numeric values use full storage ranges; ",
                "playable states are not guaranteed. EUR/USA/JPN layouts."
            )
            .into(),
            checksums: vec![
                ChecksumDefinition {
                    start: Some(14),
                    length: Some(674),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 8)
                },
                ChecksumDefinition {
                    start: Some(14),
                    length: Some(674),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 10)
                },
            ],
            ..GameDefinition::new("".into(), "".into(), "snes".into(), 2048)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let mut games = vec![
        game_donkey_kong_country_2_diddy_s_kong_quest_slot_1(),
        game_donkey_kong_country_2_diddy_s_kong_quest_slot_2(),
        game_donkey_kong_country_2_diddy_s_kong_quest_slot_3(),
    ];

    for (slot, game) in games.iter_mut().enumerate() {
        for player in 0..2 {
            game.fields.extend(event_fields(
                &format!("slot_{}.player_{}", slot + 1, player + 1),
                slot * SLOT_SIZE + player * PLAYER_SIZE,
            ));
        }
    }

    build(games, codecs, true)
}

fn game_donkey_kong_country_2_diddy_s_kong_quest_slot_1() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-2-diddy-s-kong-quest-slot-1".into();
    game.name = "Donkey Kong Country 2: Diddy's Kong Quest (Slot 1)".into();
    game
}

fn game_donkey_kong_country_2_diddy_s_kong_quest_slot_2() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-2-diddy-s-kong-quest-slot-2".into();
    game.name = "Donkey Kong Country 2: Diddy's Kong Quest (Slot 2)".into();
    game.description = concat!(
        "Edits independent counters and event flags in Slot 2; preserves other slots. ",
        "Coupled progression, completion, inventory and location updates ",
        "remain unsupported. Numeric values use full storage ranges; ",
        "playable states are not guaranteed. EUR/USA/JPN layouts."
    )
    .into();
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(694),
            length: Some(674),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 688)
        },
        ChecksumDefinition {
            start: Some(694),
            length: Some(674),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 690)
        },
    ];
    let fields = vec![
        catalog_field("slot_2.player_1.kremkoins", "Kremkoins", 699, Storage::U8),
        catalog_field(
            "slot_2.player_1.play_time",
            "Play-time ticks",
            694,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_2.player_1.completion",
            "Completion percentage",
            698,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_1.hero_coins",
            "Hero's Coins",
            700,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_1.location",
            "Location code",
            869,
            Storage::U8,
        )
        .editable(false),
        catalog_field("slot_2.player_2.kremkoins", "Kremkoins", 1033, Storage::U8),
        catalog_field(
            "slot_2.player_2.play_time",
            "Play-time ticks",
            1028,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_2.player_2.completion",
            "Completion percentage",
            1032,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_2.hero_coins",
            "Hero's Coins",
            1034,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_2.location",
            "Location code",
            1203,
            Storage::U8,
        )
        .editable(false),
    ];
    game.fields = fields;
    game
}

fn game_donkey_kong_country_2_diddy_s_kong_quest_slot_3() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-2-diddy-s-kong-quest-slot-3".into();
    game.name = "Donkey Kong Country 2: Diddy's Kong Quest (Slot 3)".into();
    game.description = concat!(
        "Edits independent counters and event flags in Slot 3; preserves other slots. ",
        "Coupled progression, completion, inventory and location updates ",
        "remain unsupported. Numeric values use full storage ranges; ",
        "playable states are not guaranteed. EUR/USA/JPN layouts."
    )
    .into();
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(1374),
            length: Some(674),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1368)
        },
        ChecksumDefinition {
            start: Some(1374),
            length: Some(674),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 1370)
        },
    ];
    let fields = vec![
        catalog_field("slot_3.player_1.kremkoins", "Kremkoins", 1379, Storage::U8),
        catalog_field(
            "slot_3.player_1.play_time",
            "Play-time ticks",
            1374,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_3.player_1.completion",
            "Completion percentage",
            1378,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_1.hero_coins",
            "Hero's Coins",
            1380,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_1.location",
            "Location code",
            1549,
            Storage::U8,
        )
        .editable(false),
        catalog_field("slot_3.player_2.kremkoins", "Kremkoins", 1713, Storage::U8),
        catalog_field(
            "slot_3.player_2.play_time",
            "Play-time ticks",
            1708,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_3.player_2.completion",
            "Completion percentage",
            1712,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_2.hero_coins",
            "Hero's Coins",
            1714,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_2.location",
            "Location code",
            1883,
            Storage::U8,
        )
        .editable(false),
    ];
    game.fields = fields;
    game
}

#[cfg(test)]
mod tests {
    use super::*;

    // Independent transcription of the upstream checksum: word sum in the low half, xor in the high half.
    fn repair(bytes: &mut [u8], slot: usize) {
        let base = slot * SLOT_SIZE;
        let (mut sum, mut xor) = (0u16, 0u16);
        for word in bytes[base + 14..base + 14 + 674].chunks(2) {
            let value = u16::from_le_bytes([word[0], word[1]]);
            sum = sum.wrapping_add(value);
            xor ^= value;
        }
        bytes[base + 8..base + 10].copy_from_slice(&sum.to_le_bytes());
        bytes[base + 10..base + 12].copy_from_slice(&xor.to_le_bytes());
    }

    fn template() -> Vec<u8> {
        let mut bytes = vec![0x11; 2048];
        for slot in 0..3 {
            repair(&mut bytes, slot);
        }
        bytes
    }

    fn edit(field: &str, value: bool) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value: SaveValue::Bool(value),
        }
    }

    fn apply(handler: &SchemaSaveHandler, bytes: Vec<u8>, edits: &[SaveEdit]) -> Result<Vec<u8>> {
        let identity = handler.definitions().remove(0).identity;
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        Ok(handler
            .apply(&input, &identity, edits, false)?
            .bytes
            .expect("edited bytes"))
    }

    #[test]
    fn event_flags_write_their_bits_in_both_players_and_repair_the_slot_checksum() {
        let handler = schemas().remove(2);
        let bytes = template();
        let slot = 2 * 0x2a8;
        let second = slot + 0x14e;
        let edits = [
            edit("slot_3.player_1.visited.klubbas_kiosk", false),
            edit("slot_3.player_1.visited.monkey_museum_lost_world", true),
            edit(
                "slot_3.player_1.misc.stronghold_showdown_cutscene_seen",
                false,
            ),
            edit("slot_3.player_1.swankys.k_rool_s_keep.game_3", true),
            edit("slot_3.player_1.swankys.krazy_kremland.game_1", true),
            edit(
                "slot_3.player_2.funkys.the_flying_krock.leave_airport",
                true,
            ),
            edit("slot_3.player_2.funkys.krazy_kremland.hire_plane", false),
        ];
        let mut expected = bytes.clone();
        expected[slot + 0xeb] = 0x11 & !0x10 | 0x20;
        expected[slot + 0xec] = 0x11 & !0x02;
        expected[slot + 0xe5] = 0x11 | 0x04;
        expected[slot + 0xe8] = 0x11;
        expected[second + 0xdd] = 0x11 | 0x02;
        expected[second + 0xdf] = 0x11 & !0x01;
        repair(&mut expected, 2);
        assert_eq!(apply(&handler, bytes.clone(), &edits).unwrap(), expected);
        assert!(
            apply(
                &handler,
                bytes,
                &[edit("slot_3.player_1.swankys.krem_quay.game_4", true)]
            )
            .is_err()
        );
    }

    #[test]
    fn event_flags_land_at_the_documented_offsets_in_every_slot_and_player() {
        let bytes = template();
        for (slot, handler) in schemas().into_iter().enumerate() {
            for player in 0..2 {
                let id = format!(
                    "slot_{}.player_{}.visited.klubbas_kiosk",
                    slot + 1,
                    player + 1
                );
                let offset = slot * 0x2a8 + player * 0x14e + 0xeb;
                let mut cleared = bytes.clone();
                cleared[offset] = 0x01;
                repair(&mut cleared, slot);
                let mut set = cleared.clone();
                set[offset] = 0x11;
                repair(&mut set, slot);
                assert_eq!(apply(&handler, cleared, &[edit(&id, true)]).unwrap(), set);
            }
        }
    }
}
