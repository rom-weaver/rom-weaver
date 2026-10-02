use super::*;

// Layout: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/wario-land-3/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let fields = vec![
        FieldDefinition::new(
            "coins_bcd".into(),
            "Coins (packed BCD)".into(),
            0x388,
            Storage::BcdBe,
        )
        .length(2)
        .min(0)
        .max(999),
        FieldDefinition::new("language".into(), "Language".into(), 0x3ca, Storage::U8)
            .min(0)
            .max(4),
        FieldDefinition::new(
            "time_of_day".into(),
            "Time of day".into(),
            0x3bf,
            Storage::U8,
        )
        .min(0)
        .max(3),
        FieldDefinition::new(
            "power.ground_pound".into(),
            "Ground Pound acquired".into(),
            0x3c0,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "power.swim".into(),
            "Swim acquired".into(),
            0x3c0,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "power.head_smash".into(),
            "Head Smash acquired".into(),
            0x3c0,
            Storage::Bit,
        )
        .bit(2),
    ];
    build(
        vec![GameDefinition {
            fields,
            description:
                "Edits the World Map save block. Mid-level saves are intentionally rejected.".into(),
            signatures: vec![
                SignatureDefinition {
                    offset: 0,
                    bytes: vec![0; 4],
                },
                SignatureDefinition {
                    offset: 0x380,
                    bytes: b"war3".to_vec(),
                },
            ],
            checksums: vec![ChecksumDefinition {
                start: Some(0x384),
                length: Some(0x6c),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 0x791)
            }],
            ..GameDefinition::new(
                "wario-land-3".into(),
                "Wario Land 3".into(),
                "game-boy-color".into(),
                32768,
            )
        }],
        BTreeMap::new(),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0x5a; 32768];
        bytes[..4].fill(0);
        bytes[0x380..0x384].copy_from_slice(b"war3");
        bytes[0x388..0x38a].copy_from_slice(&[0x01, 0x23]);
        let sum = bytes[0x384..0x3f0]
            .iter()
            .fold(0u16, |s, b| s.wrapping_add(u16::from(*b)));
        bytes[0x791..0x793].copy_from_slice(&sum.to_be_bytes());
        SaveDetectionInput {
            bytes,
            selected_game: Some("wario-land-3".into()),
            rom_sha1: None,
        }
    }
    #[test]
    fn edits_bcd_preserves_bits_and_repairs_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let input = input();
        let out = handler
            .apply(
                &input,
                &identity,
                &[
                    SaveEdit {
                        field: "coins_bcd".into(),
                        value: SaveValue::U32(987),
                    },
                    SaveEdit {
                        field: "power.swim".into(),
                        value: SaveValue::Bool(true),
                    },
                ],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&out[0x388..0x38a], &[0x09, 0x87]);
        assert_eq!(out[0x3c0], input.bytes[0x3c0] | 2);
        assert_eq!(&out[0x793..], &input.bytes[0x793..]);
        let sum = out[0x384..0x3f0]
            .iter()
            .fold(0u16, |s, b| s.wrapping_add(u16::from(*b)));
        assert_eq!(&out[0x791..0x793], &sum.to_be_bytes());
        let mut bad = input.clone();
        bad.bytes[0x791] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
    }
}
