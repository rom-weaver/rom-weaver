use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

// Layout and checksum: https://gitlab.com/jcfields/sonic3-save-editor/-/blob/8b740b670ff8e46f7c35ff8fac98169efccfe3b9/save%20format.md
// Field offsets: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/sonic-3/saveEditor

fn checksum(bytes: &[u8], start: usize, end: usize) -> u16 {
    (start..end).step_by(2).fold(0u16, |value, offset| {
        let value = value ^ u16::from_be_bytes([bytes[offset], bytes[offset + 1]]);
        (value >> 1) ^ if value & 1 != 0 { 0x8810 } else { 0 }
    })
}

fn lane_layout(logical_size: usize) -> layout::Layout {
    layout::Layout {
        groups: (0..logical_size)
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
            .collect(),
    }
}

fn check() -> Check {
    Check {
        when: None,
        assert: Condition::new(|bytes| {
            let competition = bytes.len() >= 0x5c
                && u16::from_be_bytes([bytes[0x5a], bytes[0x5b]]) == checksum(bytes, 0x08, 0x5a);
            let sonic3 = bytes.len() < 0xe8
                || bytes[0xe6..0xe8] == [0xff, 0xff]
                || u16::from_be_bytes([bytes[0xe6], bytes[0xe7]]) == checksum(bytes, 0xb4, 0xe6);
            let knuckles = bytes.len() < 0x194
                || bytes[0x192..0x194] == [0xff, 0xff]
                || u16::from_be_bytes([bytes[0x192], bytes[0x193]])
                    == checksum(bytes, 0x140, 0x192);
            Ok(bytes[0x58..0x5a] == *b"LD" && competition && sonic3 && knuckles)
        }),
        code: "sonic_3_checksum".into(),
        message: "no supported Sonic 3 data block has a valid checksum".into(),
        section_id: None,
        warning: None,
    }
}

fn fields(logical_size: usize) -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    if logical_size >= 0xe8 {
        let editable = field::FieldBehavior {
            editable_when: Some(Condition::new(
                |bytes| Ok(bytes[0xe6..0xe8] != [0xff, 0xff]),
            )),
            ..Default::default()
        };
        for slot in 0..6 {
            let base = 0xb4 + slot * 8;
            fields.extend([
                FieldDefinition::new(
                    format!("sonic3.slot{}.character", slot + 1),
                    format!("Sonic 3 slot {} character", slot + 1),
                    base + 2,
                    Storage::U8,
                )
                .min(0)
                .max(2)
                .behavior(editable.clone()),
                FieldDefinition::new(
                    format!("sonic3.slot{}.zone", slot + 1),
                    format!("Sonic 3 slot {} zone", slot + 1),
                    base + 3,
                    Storage::U8,
                )
                .min(0)
                .max(13)
                .behavior(editable.clone()),
                FieldDefinition::new(
                    format!("sonic3.slot{}.special_stage", slot + 1),
                    format!("Sonic 3 slot {} next special stage", slot + 1),
                    base + 4,
                    Storage::U8,
                )
                .min(0)
                .max(6)
                .behavior(editable.clone()),
                FieldDefinition::new(
                    format!("sonic3.slot{}.emeralds", slot + 1),
                    format!("Sonic 3 slot {} emerald count", slot + 1),
                    base + 5,
                    Storage::U8,
                )
                .min(0)
                .max(7)
                .behavior(editable.clone()),
            ]);
        }
    }
    if logical_size >= 0x194 {
        let editable = field::FieldBehavior {
            editable_when: Some(Condition::new(|bytes| {
                Ok(bytes[0x192..0x194] != [0xff, 0xff])
            })),
            ..Default::default()
        };
        for slot in 0..8 {
            let base = 0x140 + slot * 10;
            fields.extend([
                FieldDefinition::new(
                    format!("knuckles.slot{}.character", slot + 1),
                    format!("Sonic 3 & Knuckles slot {} character", slot + 1),
                    base + 2,
                    Storage::U8,
                )
                .mask(0xf0)
                .behavior(editable.clone()),
                FieldDefinition::new(
                    format!("knuckles.slot{}.zone", slot + 1),
                    format!("Sonic 3 & Knuckles slot {} zone", slot + 1),
                    base + 3,
                    Storage::U8,
                )
                .min(0)
                .max(13)
                .behavior(editable.clone()),
                FieldDefinition::new(
                    format!("knuckles.slot{}.lives", slot + 1),
                    format!("Sonic 3 & Knuckles slot {} lives", slot + 1),
                    base + 8,
                    Storage::U8,
                )
                .min(1)
                .max(99)
                .behavior(editable.clone()),
                FieldDefinition::new(
                    format!("knuckles.slot{}.continues", slot + 1),
                    format!("Sonic 3 & Knuckles slot {} continues", slot + 1),
                    base + 9,
                    Storage::U8,
                )
                .min(0)
                .max(99)
                .behavior(editable.clone()),
            ]);
        }
    }
    fields
}

fn definition(size: usize) -> GameDefinition {
    let logical_size = size / 2;
    let integrity = check();
    let mut stores = vec![Store {
        when: Some(Condition::new(|bytes| {
            Ok(bytes.len() >= 0xe8 && bytes[0xe6..0xe8] != [0xff, 0xff])
        })),
        destination: Scalar {
            offset: 0xe6,
            storage: Storage::U16Be,
            mask: None,
        },
        value: ReadValue::new(|bytes| Ok(i64::from(checksum(bytes, 0xb4, 0xe6)))),
    }];
    if logical_size >= 0x194 {
        stores.push(Store {
            when: Some(Condition::new(|bytes| {
                Ok(bytes[0x192..0x194] != [0xff, 0xff])
            })),
            destination: Scalar {
                offset: 0x192,
                storage: Storage::U16Be,
                mask: None,
            },
            value: ReadValue::new(|bytes| Ok(i64::from(checksum(bytes, 0x140, 0x192)))),
        });
    }
    GameDefinition {
        fields: fields(logical_size),
        description: "Edits Sonic 3 and Sonic 3 & Knuckles data in odd-byte Genesis SRAM dumps and repairs the affected checksums. Requires a game-made template.".into(),
        runtime: runtime::Runtime {
            logical_size: Some(logical_size),
            layout: Some(lane_layout(logical_size)),
            recognition: Some(runtime::Recognition { checks: vec![integrity.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: true }),
            checks: vec![integrity],
            after_edit: stores,
            ..Default::default()
        },
        ..GameDefinition::new(format!("sonic-3-{size}"), "Sonic 3".into(), "genesis".into(), size)
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(
        [604, 980, 65536].into_iter().map(definition).collect(),
        BTreeMap::new(),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_interleaved_sonic3_and_repairs_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut logical = vec![0xff; 302];
        logical[0x58..0x5a].copy_from_slice(b"LD");
        logical[0xb4] = 0;
        logical[0xb6] = 1;
        let competition_sum = checksum(&logical, 0x08, 0x5a);
        logical[0x5a..0x5c].copy_from_slice(&competition_sum.to_be_bytes());
        let sum = checksum(&logical, 0xb4, 0xe6);
        logical[0xe6..0xe8].copy_from_slice(&sum.to_be_bytes());
        let mut bytes = vec![0xff; 604];
        for (offset, value) in logical.iter().enumerate() {
            bytes[offset * 2 + 1] = *value;
        }
        let input = SaveDetectionInput {
            bytes: bytes.clone(),
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let output = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "sonic3.slot1.zone".into(),
                    value: SaveValue::U32(7),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(output[2 * 0xb7 + 1], 7);
        assert_eq!(&output[0..2 * 0xb7 + 1], &bytes[0..2 * 0xb7 + 1]);
        let decoded: Vec<_> = output[1..].iter().step_by(2).copied().collect();
        assert_eq!(
            u16::from_be_bytes([decoded[0xe6], decoded[0xe7]]),
            checksum(&decoded, 0xb4, 0xe6)
        );
        let mut bad = input.clone();
        bad.bytes[2 * 0xb4 + 1] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input;
        bad.bytes.pop();
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }
}
