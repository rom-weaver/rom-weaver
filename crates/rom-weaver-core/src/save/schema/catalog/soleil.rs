use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

// Layout, fields, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/soleil/saveEditor

const SLOT_SIZE: usize = 0x800;

fn checksum(bytes: &[u8], base: usize) -> u16 {
    (base..base + 0xaa).step_by(2).fold(0u16, |sum, offset| {
        sum.wrapping_add(u16::from_be_bytes([bytes[offset], bytes[offset + 1]]))
    })
}

fn valid_slot(bytes: &[u8], base: usize) -> bool {
    base + 0xac <= bytes.len()
        && bytes[base + 2..base + 6] == *b"RAGN"
        && u16::from_be_bytes([bytes[base + 0xaa], bytes[base + 0xab]]) == checksum(bytes, base)
}

fn definition(size: usize) -> GameDefinition {
    let logical_size = size / 2;
    let slots = (0..4)
        .filter(|slot| slot * SLOT_SIZE + 0xac <= logical_size)
        .count();
    let check = Check {
        when: None,
        assert: Condition::new(move |bytes| {
            Ok((0..slots).any(|slot| valid_slot(bytes, slot * SLOT_SIZE)))
        }),
        code: "soleil_checksum".into(),
        message: "no Soleil slot has a valid signature and checksum".into(),
        section_id: None,
        warning: None,
    };
    let groups = (0..logical_size)
        .step_by(4096)
        .map(|start| {
            let length = (logical_size - start).min(4096);
            layout::Group {
                id: format!("data_{start:x}"),
                logical_offset: start,
                logical_length: length,
                copies: layout::Copies::Fixed {
                    candidates: vec![layout::Candidate {
                        spans: (start..start + length)
                            .map(|offset| layout::Span {
                                logical_offset: offset,
                                physical_offset: offset * 2 + 1,
                                length: 1,
                            })
                            .collect(),
                        ..Default::default()
                    }],
                },
                selection: layout::Selection::FirstValid,
                write: layout::WritePolicy::Selected,
                empty: vec![0xff],
                empty_if_no_signature: false,
            }
        })
        .collect();
    let mut fields = Vec::new();
    let mut stores = Vec::new();
    for slot in 0..slots {
        let base = slot * SLOT_SIZE;
        let prefix = format!("slot{}", slot + 1);
        let editable = field::FieldBehavior {
            editable_when: Some(Condition::new(move |bytes| {
                Ok(bytes[base + 2..base + 6] == *b"RAGN")
            })),
            ..Default::default()
        };
        fields.extend([
            FieldDefinition::new(
                format!("{prefix}.health.current"),
                format!("Slot {} current health", slot + 1),
                base + 0x60,
                Storage::U16Be,
            )
            .min(0)
            .max(32)
            .behavior(editable.clone()),
            FieldDefinition::new(
                format!("{prefix}.health.maximum"),
                format!("Slot {} maximum health", slot + 1),
                base + 0x62,
                Storage::U16Be,
            )
            .min(1)
            .max(32)
            .behavior(editable.clone()),
            FieldDefinition::new(
                format!("{prefix}.malins"),
                format!("Slot {} Malins", slot + 1),
                base + 0x66,
                Storage::U16Be,
            )
            .min(0)
            .max(9999)
            .behavior(editable.clone()),
            FieldDefinition::new(
                format!("{prefix}.animal_a"),
                format!("Slot {} equipped animal A", slot + 1),
                base + 0x72,
                Storage::U16Be,
            )
            .min(0)
            .max(24)
            .behavior(editable.clone()),
            FieldDefinition::new(
                format!("{prefix}.animal_b"),
                format!("Slot {} equipped animal B", slot + 1),
                base + 0x74,
                Storage::U16Be,
            )
            .min(0)
            .max(24)
            .behavior(editable.clone()),
            FieldDefinition::new(
                format!("{prefix}.location"),
                format!("Slot {} location", slot + 1),
                base + 0x76,
                Storage::U16Be,
            )
            .min(0)
            .max(0x8c)
            .behavior(editable.clone()),
        ]);
        stores.push(Store {
            when: Some(Condition::new(move |bytes| {
                Ok(bytes[base + 2..base + 6] == *b"RAGN")
            })),
            destination: Scalar {
                offset: base + 0xaa,
                storage: Storage::U16Be,
                mask: None,
            },
            value: ReadValue::new(move |bytes| Ok(i64::from(checksum(bytes, base)))),
        });
    }
    GameDefinition { fields, description: "Edits all present Soleil (Crusader of Centy) slots in odd-byte Genesis SRAM dumps and repairs each initialized slot checksum. Requires a game-made template.".into(), runtime: runtime::Runtime { logical_size: Some(logical_size), layout: Some(layout::Layout { groups }), recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid, SaveRecognitionReason::SignatureValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: false }), checks: vec![check], after_edit: stores, ..Default::default() }, ..GameDefinition::new(format!("soleil-{size}"), "Soleil (Crusader of Centy)".into(), "genesis".into(), size) }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(
        [512, 4608, 8704, 12800, 65536]
            .into_iter()
            .map(definition)
            .collect(),
        BTreeMap::new(),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edits_interleaved_slot_and_repairs_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut logical = vec![0xff; 256];
        logical[2..6].copy_from_slice(b"RAGN");
        logical[0x60..0x64].copy_from_slice(&16u16.to_be_bytes().repeat(2));
        let sum = checksum(&logical, 0);
        logical[0xaa..0xac].copy_from_slice(&sum.to_be_bytes());
        let mut bytes = vec![0xff; 512];
        for (offset, value) in logical.iter().enumerate() {
            bytes[offset * 2 + 1] = *value;
        }
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let output = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "slot1.malins".into(),
                    value: SaveValue::U32(9999),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        let decoded: Vec<_> = output[1..].iter().step_by(2).copied().collect();
        assert_eq!(u16::from_be_bytes([decoded[0x66], decoded[0x67]]), 9999);
        assert_eq!(
            u16::from_be_bytes([decoded[0xaa], decoded[0xab]]),
            checksum(&decoded, 0)
        );
        let mut bad = input.clone();
        bad.bytes[1] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input;
        bad.bytes.pop();
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }
}
