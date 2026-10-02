use super::*;

// Layout and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/pokemon-trading-card-game/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = vec![
        FieldDefinition::new(
            "playtime.seconds".into(),
            "Playtime seconds".into(),
            0x580b,
            Storage::U8,
        )
        .max(59),
        FieldDefinition::new(
            "playtime.minutes".into(),
            "Playtime minutes".into(),
            0x580c,
            Storage::U8,
        )
        .max(59),
        FieldDefinition::new(
            "playtime.hours".into(),
            "Playtime hours".into(),
            0x580d,
            Storage::U16Le,
        )
        .max(999),
        FieldDefinition::new("location".into(), "Location".into(), 0x5810, Storage::U8).max(0x21),
        FieldDefinition::new(
            "position_x_raw".into(),
            "Position X (half-tile units)".into(),
            0x5811,
            Storage::U8,
        )
        .max(28),
        FieldDefinition::new(
            "position_y_raw".into(),
            "Position Y (half-tile units)".into(),
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
            .bit(7 - bit as u8),
        );
    }
    build(vec![GameDefinition { fields, description: "Edits playtime, position, and Master Medals. Card collections are omitted because their derived album count needs coordinated updates.".into(), signatures: vec![SignatureDefinition{offset:0,bytes:vec![4,0x21,5]},SignatureDefinition{offset:0x5800,bytes:vec![8]}], checksums: vec![ChecksumDefinition{start:Some(0x5804),length:Some(0xb7),exclude:vec![ChecksumExclusion{offset:0x5804,length:2}],..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le,0x5804)}], ..GameDefinition::new("pokemon-trading-card-game".into(), "Pokémon Trading Card Game".into(), "game-boy-color".into(), 32768)}],BTreeMap::new(),true)
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
        expected[0x580c] = 17;
        repair(&mut expected);
        assert_eq!(out, expected);
        assert!(h.apply(&input, &id, &[], false).unwrap().bytes.is_none());
        let mut bad = input;
        bad.bytes[0x5804] ^= 1;
        assert!(h.apply(&bad, &id, &[], false).is_err());
    }
}
