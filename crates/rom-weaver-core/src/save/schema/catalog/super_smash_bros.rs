use super::*;

// The layout and weighted checksum MUST follow the pinned MIT-licensed source.
// https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/super-smash-bros/saveEditor
fn weighted(bytes: &[u8]) -> u32 {
    bytes[..0x5e8]
        .iter()
        .enumerate()
        .fold(0, |sum, (index, byte)| {
            sum.wrapping_add(u32::from(*byte) * (index as u32 + 1))
        })
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields: Vec<_> = [
        ("luigi", "Luigi unlocked", 0x459, 4),
        ("captain_falcon", "Captain Falcon unlocked", 0x459, 7),
        ("jigglypuff", "Jigglypuff unlocked", 0x458, 2),
        ("ness", "Ness unlocked", 0x458, 3),
        ("mushroom_kingdom", "Mushroom Kingdom unlocked", 0x457, 4),
        ("sound_test", "Sound Test unlocked", 0x457, 5),
        ("item_switch", "Item Switch unlocked", 0x457, 6),
    ]
    .into_iter()
    .map(|(id, label, offset, bit)| {
        FieldDefinition::new(id.into(), label.into(), offset, Storage::Bit).bit(bit)
    })
    .collect();
    for index in 0..12 {
        for (suffix, label, offset, max) in [
            ("score", "Arcade high score", 0x45c, 99_999_999),
            ("bonus", "Arcade bonus count", 0x464, 999),
        ] {
            fields.push(
                FieldDefinition::new(
                    format!("character_{}.{}", index + 1, suffix),
                    format!("Character {} {label}", index + 1),
                    offset + index * 0x20,
                    Storage::U32Be,
                )
                .max(max),
            );
        }
    }
    let check = rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok(weighted(bytes) != 0
                && weighted(bytes) == u32::from_be_bytes(bytes[0x5e8..0x5ec].try_into().unwrap()))
        }),
        code: "save_checksum_mismatch".into(),
        message: "The Super Smash Bros weighted SRAM checksum is invalid.".into(),
        section_id: None,
        warning: None,
    };
    let game = GameDefinition {
        fields,
        description: "Edits unlocks and arcade score/bonus records in canonical big-endian 32 KiB SRAM. Byte-swapped files and other records are unsupported. Requires a game-made template.".into(),
        runtime: runtime::Runtime {
            checks: vec![check],
            after_edit: vec![rules::Store { when: None,
                destination: rules::Scalar { offset: 0x5e8, storage: Storage::U32Be, mask: None },
                value: rules::ReadValue::new(|bytes| Ok(i64::from(weighted(bytes)))) }],
            save_format: Some("n64_sram_32k".into()), ..Default::default()
        },
        ..GameDefinition::new("super-smash-bros-canonical-sram".into(), "Super Smash Bros (canonical SRAM)".into(), "nintendo-64".into(), 32768)
    };
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0x5a; 32768];
        let sum: u32 = (1..=0x5e8u32).sum::<u32>() * 0x5a;
        bytes[0x5e8..0x5ec].copy_from_slice(&sum.to_be_bytes());
        SaveDetectionInput {
            bytes,
            selected_game: Some("super-smash-bros-canonical-sram".into()),
            rom_sha1: None,
        }
    }
    #[test]
    fn exact_unlock_edit_and_integrity_rejections() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let edit = SaveEdit {
            field: "item_switch".into(),
            value: SaveValue::Bool(false),
        };
        let bytes = handler
            .apply(&original, &identity, &[edit], false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = original.bytes.clone();
        expected[0x457] &= !0x40;
        let sum = (1..=0x5e8u32).sum::<u32>() * 0x5a - 0x40 * 0x458;
        expected[0x5e8..0x5ec].copy_from_slice(&sum.to_be_bytes());
        assert_eq!(bytes, expected);
        assert!(
            handler
                .apply(&original, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        for bytes in [vec![0; 32768], vec![0; 32767], {
            let mut b = original.bytes.clone();
            b[0] ^= 1;
            b
        }] {
            assert!(
                handler
                    .apply(
                        &SaveDetectionInput {
                            bytes,
                            ..original.clone()
                        },
                        &identity,
                        &[],
                        false
                    )
                    .is_err()
            );
        }
    }
}
