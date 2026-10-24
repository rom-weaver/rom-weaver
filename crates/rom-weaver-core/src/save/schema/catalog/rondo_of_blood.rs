use super::super::rules::{Check, Condition};
use super::*;

// Layout and write rules: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/akumajou-dracula-x-chi-no-rondo/saveEditor
// The 2 KiB BRAM format follows https://github.com/libretro/beetle-pce-libretro/blob/b96c11e095b6a40a412d2da02766ae1c3f4fd539/mednafen/pce/huc.cpp
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    for slot in 0..3 {
        let base = slot * 0x30;
        let active = field::FieldBehavior {
            editable_when: Some(Condition::new(move |bytes| Ok(bytes[base + 0x21] != 0))),
            ..Default::default()
        };
        for (id, label, offset, length, max) in [
            ("deaths", "death count", 0x3d, 2, 9999),
            ("money", "money", 0x3f, 3, 999_999),
        ] {
            fields.push(
                FieldDefinition {
                    length: Some(length),
                    ..FieldDefinition::new(
                        format!("slot_{}.{id}", slot + 1),
                        format!("Slot {} {label}", slot + 1),
                        base + offset,
                        Storage::BcdLe,
                    )
                }
                .min(0)
                .max(max)
                .behavior(active.clone()),
            );
        }
    }
    build(
        vec![GameDefinition {
            description: "Japanese Rondo of Blood in a 2 KiB PC Engine BRAM image with DRACULA X as the first record. Edits money and death count in occupied slots; preserves other BRAM records. Requires an existing game save.".into(),
            fields,
            signatures: vec![
                SignatureDefinition { offset: 0, bytes: b"HUBM".to_vec() },
                SignatureDefinition { offset: 0x16, bytes: b"DRACULA X".to_vec() },
            ],
            checksums: vec![ChecksumDefinition {
                start: Some(0x14),
                length: Some(0x9c),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 0x12)
            }],
            runtime: runtime::Runtime {
                checks: vec![Check {
                    when: None,
                    assert: Condition::new(|bytes| Ok((0..3).any(|slot| bytes[slot * 0x30 + 0x21] != 0))),
                    code: "rondo_empty_save".into(),
                    message: "the Rondo of Blood record has no occupied slots".into(),
                    section_id: None,
                    warning: None,
                }],
                ..Default::default()
            },
            ..GameDefinition::new("rondo-of-blood-japan".into(), "Castlevania: Rondo of Blood (Japan)".into(), "pc-engine-cd".into(), 2048)
        }],
        BTreeMap::new(),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> SaveDetectionInput {
        let mut bytes = vec![0x67; 2048];
        bytes[..0xb0].fill(0);
        bytes[..4].copy_from_slice(b"HUBM");
        bytes[0x16..0x1f].copy_from_slice(b"DRACULA X");
        bytes[0x21] = 4;
        bytes[0x81] = 4;
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("rondo-of-blood-japan".into()),
            rom_sha1: None,
        }
    }

    fn repair(bytes: &mut [u8]) {
        let sum: u16 = bytes[0x14..0xb0].iter().map(|byte| u16::from(*byte)).sum();
        bytes[0x12..0x14].copy_from_slice(&0u16.wrapping_sub(sum).to_le_bytes());
    }

    #[test]
    fn bcd_edits_preserve_other_slots_and_bram_records() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let source = fixture();
        let mut expected = source.bytes.clone();
        expected[0x9f..0xa2].copy_from_slice(&[0x56, 0x34, 0x12]);
        repair(&mut expected);
        let edits = [SaveEdit {
            field: "slot_3.money".into(),
            value: SaveValue::U32(123_456),
        }];
        let output = handler.apply(&source, &identity, &edits, false).unwrap();
        assert_eq!(output.bytes.unwrap(), expected);
        assert!(
            handler
                .apply(&source, &identity, &edits, true)
                .unwrap()
                .bytes
                .is_none()
        );
        assert!(
            handler
                .apply(&source, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        assert!(
            handler
                .apply(
                    &source,
                    &identity,
                    &[SaveEdit {
                        field: "slot_2.money".into(),
                        value: SaveValue::U32(1)
                    }],
                    false
                )
                .is_err()
        );
    }

    #[test]
    fn invalid_inputs_and_out_of_range_values_cannot_be_written() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let source = fixture();
        let edits = [SaveEdit {
            field: "slot_1.money".into(),
            value: SaveValue::U32(1),
        }];
        for offset in [0, 0x12, 0x16, 0x21] {
            let mut corrupt = source.clone();
            corrupt.bytes[offset] ^= 1;
            assert!(handler.apply(&corrupt, &identity, &edits, false).is_err());
        }
        let mut empty = source.clone();
        empty.bytes[0x21] = 0;
        empty.bytes[0x81] = 0;
        repair(&mut empty.bytes);
        assert!(handler.apply(&empty, &identity, &edits, false).is_err());
        let mut short = source.clone();
        short.bytes.pop();
        assert!(handler.apply(&short, &identity, &edits, false).is_err());
        assert!(
            handler
                .apply(
                    &source,
                    &identity,
                    &[SaveEdit {
                        field: "slot_1.money".into(),
                        value: SaveValue::U32(1_000_000)
                    }],
                    false
                )
                .is_err()
        );
        assert!(handler.generate(&identity).is_err());
    }
}
