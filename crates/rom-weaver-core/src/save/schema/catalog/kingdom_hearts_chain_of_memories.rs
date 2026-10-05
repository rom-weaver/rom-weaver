use super::*;

// System bits, physical file shifts, character-dependent checksum lengths, and modulo-65535 word sum: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/kingdom-hearts-chain-of-memories/saveEditor (MIT; LICENSE-GAME-TOOLS-COLLECTION).
const FILES: [(usize, usize); 4] = [
    (0x1ec0, 0x418),
    (0x26f0, 0x418),
    (0x2f20, 0xf14),
    (0x4d48, 0xf14),
];

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut game = GameDefinition::new(
        "kingdom-hearts-chain-of-memories".into(),
        "Kingdom Hearts: Chain of Memories".into(),
        "game-boy-advance".into(),
        0x8000,
    );
    game.description = "Edits only the shared Riku Story/Link unlock and title-screen choice/switch in initialized raw 32 KiB Europe/USA/Japan saves. Validates the system and each initialized Riku/Sora file's modulo-65535 word-sum checksum. Decks, character state, previews, names, wrappers, and fresh generation are omitted.".into();
    game.signatures = vec![SignatureDefinition {
        offset: 0x10,
        bytes: b"KHCOM_BACKUP_VER".to_vec(),
    }];
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok(FILES.iter().any(|(start, _)| bytes[*start] == b'K'))
        }),
        code: "save_empty".into(),
        message: "no Chain of Memories file is initialized".into(),
        section_id: None,
        warning: None,
    });
    for (bit, id, label) in [
        (0, "riku_story_and_link", "Riku Story and Link unlocked"),
        (1, "riku_title_screen", "Riku title screen"),
        (2, "automatic_title_screen", "Automatic title-screen switch"),
    ] {
        game.fields
            .push(FieldDefinition::new(id.into(), label.into(), 0x2c, Storage::Bit).bit(bit));
    }
    integrity(&mut game, 0, 0x50, 0x28, None);
    for (start, length) in FILES {
        integrity(
            &mut game,
            start,
            start + length,
            start + 0x18,
            Some(rules::Condition::new(move |bytes| Ok(bytes[start] == b'K'))),
        );
    }
    build(vec![game], BTreeMap::new(), true)
}

fn word_sum(bytes: &[u8], start: usize, end: usize, checksum: usize) -> u16 {
    let sum = (start..end)
        .step_by(2)
        .filter(|offset| *offset != checksum)
        .fold(0u32, |sum, offset| {
            (sum + u32::from(u16::from_le_bytes(
                bytes[offset..offset + 2].try_into().unwrap(),
            ))) % 0xffff
        });
    (sum as u16) ^ 0xffff
}

fn integrity(
    game: &mut GameDefinition,
    start: usize,
    end: usize,
    checksum: usize,
    when: Option<rules::Condition>,
) {
    game.runtime.checks.push(rules::Check {
        when: when.clone(),
        assert: rules::Condition::new(move |bytes| {
            Ok(
                u16::from_le_bytes(bytes[checksum..checksum + 2].try_into().unwrap())
                    == word_sum(bytes, start, end, checksum),
            )
        }),
        code: "save_checksum".into(),
        message: "a Chain of Memories modulo-65535 checksum is invalid".into(),
        section_id: None,
        warning: None,
    });
    game.runtime.after_edit.push(rules::Store {
        when,
        destination: rules::Scalar {
            offset: checksum,
            storage: Storage::U16Le,
            mask: None,
        },
        value: rules::ReadValue::new(move |bytes| {
            Ok(i64::from(word_sum(bytes, start, end, checksum)))
        }),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8], start: usize, length: usize, checksum: usize) {
        bytes[checksum..checksum + 2].fill(0);
        let sum: u64 = bytes[start..start + length]
            .chunks_exact(2)
            .map(|word| u64::from(u16::from_le_bytes(word.try_into().unwrap())))
            .sum();
        bytes[checksum..checksum + 2]
            .copy_from_slice(&((sum % 65535) as u16 ^ 65535).to_le_bytes());
    }

    #[test]
    fn independent_system_edit_preserves_all_four_physical_files() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0; 0x8000];
        bytes[0x10..0x20].copy_from_slice(b"KHCOM_BACKUP_VER");
        for (start, length) in FILES {
            bytes[start..start + length].fill(0xff);
            bytes[start] = b'K';
            repair(&mut bytes, start, length, start + 0x18);
        }
        repair(&mut bytes, 0, 0x50, 0x28);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edits = [SaveEdit {
            field: "riku_story_and_link".into(),
            value: SaveValue::Bool(true),
        }];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        expected[0x2c] |= 1;
        repair(&mut expected, 0, 0x50, 0x28);
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
        for position in [0x10, 0x28, 0x1ed8, 0x2708, 0x2f38, 0x4d60] {
            let mut bad = input.clone();
            bad.bytes[position] ^= 1;
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
        for size in [0, 0x7fff, 0x8001] {
            let bad = SaveDetectionInput {
                bytes: vec![0; size],
                ..input.clone()
            };
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
        let mut empty = input;
        for (start, _) in FILES {
            empty.bytes[start] = 0;
        }
        assert!(handler.apply(&empty, &identity, &edits, false).is_err());
    }
}
