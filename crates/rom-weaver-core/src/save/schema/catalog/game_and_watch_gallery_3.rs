use super::*;

// Layout and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/game-and-watch-gallery-3/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    for (id, label, bit) in [
        ("flagman", "Flagman", 2),
        ("judge", "Judge", 0),
        ("lion", "Lion", 4),
        ("spitball_sparky", "Spitball Sparky", 1),
        ("donkey_kong_ii", "Donkey Kong II", 3),
    ] {
        fields.push(
            FieldDefinition::new(
                format!("unlocked.{id}"),
                format!("{label} unlocked"),
                0x3d4,
                Storage::Bit,
            )
            .bit(bit),
        );
    }
    for (id, label, offset) in [
        ("egg", "Egg", 0x32d),
        ("greenhouse", "Greenhouse", 0x333),
        ("turtle_bridge", "Turtle Bridge", 0x32f),
        ("mario_bros", "Mario Bros.", 0x335),
        ("donkey_kong_jr", "Donkey Kong Jr.", 0x331),
    ] {
        fields.push(
            FieldDefinition::new(
                format!("very_hard.{id}"),
                format!("{label} Very Hard mode available"),
                offset,
                Storage::Bit,
            )
            .bit(0),
        );
    }
    build(vec![GameDefinition {
        fields,
        description: "Edits game unlocks and Very Hard mode flags. Scores and pending games are omitted. Requires a game-made template.".into(),
        signatures: vec![SignatureDefinition { offset: 0, bytes: vec![0x19, 0x97, 8, 0x19, 2] }],
        checksums: vec![ChecksumDefinition {
            start: Some(0), length: Some(0x600),
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 0x600)
        }],
        ..GameDefinition::new("game-and-watch-gallery-3".into(), "Game & Watch Gallery 3".into(), "game-boy-color".into(), 8192)
    }], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8]) {
        let sum = bytes[..0x600]
            .iter()
            .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)));
        bytes[0x600..0x602].copy_from_slice(&sum.to_le_bytes());
    }

    #[test]
    fn flags_preserve_other_bits_and_repair_additive_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0xa5; 8192];
        bytes[..5].copy_from_slice(&[0x19, 0x97, 8, 0x19, 2]);
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0x3d4] &= !(1 << 2);
        expected[0x32d] &= !1;
        repair(&mut expected);
        let result = handler
            .apply(
                &input,
                &identity,
                &[
                    SaveEdit {
                        field: "unlocked.flagman".into(),
                        value: SaveValue::Bool(false),
                    },
                    SaveEdit {
                        field: "very_hard.egg".into(),
                        value: SaveValue::Bool(false),
                    },
                ],
                false,
            )
            .unwrap();
        assert_eq!(result.bytes.unwrap(), expected);
        let mut bad = input.clone();
        bad.bytes[0x600] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input.clone();
        bad.bytes[0] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        assert!(
            handler
                .apply(&input, &identity, &[], true)
                .unwrap()
                .bytes
                .is_none()
        );
        assert!(handler.generate(&identity).is_err());
    }
}
