use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

// Layout, fields, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/shining-force/saveEditor

const SLOT_SIZE: usize = 0x8fc;

fn checksum(bytes: &[u8], base: usize) -> u8 {
    bytes[base + 0x118..base + 0x9ce]
        .iter()
        .fold(0u8, |sum, value| sum.wrapping_add(*value))
}

fn definition(size: usize) -> GameDefinition {
    let logical_size = size / 2;
    let slots = (0..3)
        .filter(|slot| slot * SLOT_SIZE + 0x9cf <= logical_size)
        .count();
    let check = Check {
        when: None,
        assert: Condition::new(move |bytes| {
            Ok(bytes[0x100..0x10e] == *b"YASUHIROHIROKO"
                && (0..slots).all(|slot| {
                    let base = slot * SLOT_SIZE;
                    matches!(bytes[base + 0x118], 0 | 0xff)
                        || bytes[base + 0x9ce] == checksum(bytes, base)
                }))
        }),
        code: "shining_force_checksum".into(),
        message: "no Shining Force slot has a valid signature and checksum".into(),
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
                Ok(!matches!(bytes[base + 0x118], 0 | 0xff))
            })),
            ..Default::default()
        };
        fields.extend([
            FieldDefinition::new(
                format!("{prefix}.chapter"),
                format!("Slot {} chapter", slot + 1),
                base + 0x118,
                Storage::U8,
            )
            .min(1)
            .max(8)
            .behavior(editable.clone()),
            FieldDefinition::new(
                format!("{prefix}.gold"),
                format!("Slot {} gold", slot + 1),
                base + 0x1a6,
                Storage::U32Be,
            )
            .min(0)
            .max(999999)
            .behavior(editable.clone()),
            FieldDefinition::new(
                format!("{prefix}.hero.level"),
                format!("Slot {} hero level", slot + 1),
                base + 0x1b5,
                Storage::U8,
            )
            .min(1)
            .max(99)
            .behavior(editable.clone()),
            FieldDefinition::new(
                format!("{prefix}.hero.experience"),
                format!("Slot {} hero experience", slot + 1),
                base + 0x1bb,
                Storage::U8,
            )
            .min(0)
            .max(99)
            .behavior(editable.clone()),
            FieldDefinition::new(
                format!("{prefix}.hero.max_hp"),
                format!("Slot {} hero maximum HP", slot + 1),
                base + 0x1bc,
                Storage::U16Be,
            )
            .min(1)
            .max(999)
            .behavior(editable.clone()),
            FieldDefinition::new(
                format!("{prefix}.hero.current_hp"),
                format!("Slot {} hero current HP", slot + 1),
                base + 0x1be,
                Storage::U16Be,
            )
            .min(0)
            .max(999)
            .behavior(editable.clone()),
        ]);
        stores.push(Store {
            when: Some(Condition::new(move |bytes| {
                Ok(!matches!(bytes[base + 0x118], 0 | 0xff))
            })),
            destination: Scalar {
                offset: base + 0x9ce,
                storage: Storage::U8,
                mask: None,
            },
            value: ReadValue::new(move |bytes| Ok(i64::from(checksum(bytes, base)))),
        });
    }
    GameDefinition {
        fields,
        description: "Edits all present Shining Force slots in odd-byte Genesis SRAM dumps and repairs each initialized slot checksum. Requires a game-made template.".into(),
        runtime: runtime::Runtime { logical_size: Some(logical_size), layout: Some(layout::Layout { groups }), recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid, SaveRecognitionReason::SignatureValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: false }), checks: vec![check], after_edit: stores, ..Default::default() },
        ..GameDefinition::new(format!("shining-force-{size}"), "Shining Force".into(), "genesis".into(), size)
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(
        [16381, 16382, 65536].into_iter().map(definition).collect(),
        BTreeMap::new(),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edits_interleaved_slot_and_repairs_checksum() {
        let handler = schemas().remove(1);
        let identity = handler.definitions().remove(0).identity;
        let mut logical = vec![0xff; 8191];
        logical[0x100..0x10e].copy_from_slice(b"YASUHIROHIROKO");
        logical[0x118] = 1;
        logical[0x1a6..0x1aa].copy_from_slice(&100u32.to_be_bytes());
        for slot in 0..3 {
            let base = slot * SLOT_SIZE;
            logical[base + 0x9ce] = checksum(&logical, base);
        }
        let mut bytes = vec![0; 16382];
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
                    field: "slot1.gold".into(),
                    value: SaveValue::U32(999999),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        let decoded: Vec<_> = output[1..].iter().step_by(2).copied().collect();
        assert_eq!(
            u32::from_be_bytes(decoded[0x1a6..0x1aa].try_into().unwrap()),
            999999
        );
        assert_eq!(decoded[0x9ce], checksum(&decoded, 0));
        let mut bad = input.clone();
        bad.bytes[2 * 0x1a6 + 1] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input;
        bad.bytes.pop();
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }
}
