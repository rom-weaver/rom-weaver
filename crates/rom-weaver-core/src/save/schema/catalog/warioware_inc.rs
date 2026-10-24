use super::*;

// Layout, score indices, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/warioware-inc-minigame-mania/saveEditor (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut game = GameDefinition::new(
        "warioware-inc-minigame-mania".into(),
        "WarioWare, Inc.: Minigame Mania".into(),
        "game-boy-advance".into(),
        0x2000,
    );
    game.description = "Edits gender and independently stored main-game, mix, and bonus-game high scores in initialized raw 8 KiB Europe/USA/Japan saves. Repairs the zeroed-checksum-word u32 sum. Names, progression, grid records, and wrappers are omitted; requires a game-made template.".into();
    game.signatures = vec![SignatureDefinition {
        offset: 0,
        bytes: b"MIW".to_vec(),
    }];
    game.checksums = vec![ChecksumDefinition {
        start: Some(0),
        length: Some(0x404),
        unit: ChecksumUnit::U32Le,
        exclude: vec![ChecksumExclusion {
            offset: 8,
            length: 4,
        }],
        ..ChecksumDefinition::new(ChecksumAlgorithm::Add32Le, 8)
    }];
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok(bytes[0x10..0x1a]
                .iter()
                .any(|byte| *byte != 0 && *byte != 0xff)
                && bytes[0x1b] > 0)
        }),
        code: "save_empty".into(),
        message: "the WarioWare player name is uninitialized".into(),
        section_id: None,
        warning: None,
    });
    game.fields
        .push(catalog_field("gender", "Gender (0: male, 1: female)", 0x1c, Storage::U8).max(1));
    for (index, id) in [
        (0, "introduction"),
        (1, "jimmy_blue"),
        (3, "dribble"),
        (5, "mona"),
        (2, "nine_volt"),
        (9, "jimmy_yellow"),
        (7, "orbulon"),
        (6, "dr_crygor"),
        (4, "kat"),
        (10, "jimmy_red"),
        (8, "wario"),
        (0x1b, "staff"),
        (0xb, "easy"),
        (0xe, "total_boss"),
        (0xc, "thrilling"),
        (0xd, "hard"),
    ] {
        for rank in 0..3 {
            game.fields.push(
                FieldDefinition::new(
                    format!("scores.{id}.rank_{}", rank + 1),
                    format!("{id} high score {}", rank + 1),
                    0x22 + index * 8 + rank * 2,
                    Storage::U16Le,
                )
                .max(999),
            );
        }
    }
    for (index, id, max) in [
        (0x15, "paper_plane", 999),
        (0x16, "skating_board", 999),
        (0x14, "jump_forever", 999),
        (0x10, "dr_wario", 99999999),
        (0x11, "fly_swatter", 99999999),
        (0xf, "sheriff", 99999999),
        (0x12, "pyoro", 999999),
        (0x13, "pyoro_2", 999999),
    ] {
        game.fields.push(
            FieldDefinition::new(
                format!("scores.{id}"),
                format!("{id} high score"),
                0x22 + index * 8,
                Storage::U32Le,
            )
            .max(max),
        );
    }
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8]) {
        bytes[8..12].fill(0);
        let sum = bytes[..0x404].chunks_exact(4).fold(0u32, |sum, word| {
            sum.wrapping_add(u32::from_le_bytes(word.try_into().unwrap()))
        });
        bytes[8..12].copy_from_slice(&sum.to_le_bytes());
    }

    #[test]
    fn scores_repair_word_sum_and_preserve_every_other_byte() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0x5a; 0x2000];
        bytes[..3].copy_from_slice(b"MIW");
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edits = [SaveEdit {
            field: "scores.pyoro".into(),
            value: SaveValue::U32(123456),
        }];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        expected[0xb2..0xb6].copy_from_slice(&123456u32.to_le_bytes());
        repair(&mut expected);
        assert_eq!(out, expected);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let noop = SaveDetectionInput {
            bytes: out,
            ..input.clone()
        };
        assert!(
            handler
                .apply(&noop, &identity, &edits, false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input.clone();
        bad.bytes[8] ^= 1;
        assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        for size in [0, 0x1fff, 0x2001] {
            let bad = SaveDetectionInput {
                bytes: vec![0; size],
                ..input.clone()
            };
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
        let mut empty = input;
        empty.bytes[0x10..0x1c].fill(0);
        repair(&mut empty.bytes);
        assert!(handler.apply(&empty, &identity, &edits, false).is_err());
    }
}
