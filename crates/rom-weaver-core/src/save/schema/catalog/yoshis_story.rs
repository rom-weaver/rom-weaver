use super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

// Layout and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/yoshi-s-story/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(
        vec![game(Region::Europe), game(Region::Usa), game(Region::Japan)],
        BTreeMap::new(),
        true,
    )
}

#[derive(Clone, Copy)]
enum Region {
    Europe,
    Usa,
    Japan,
}

impl Region {
    fn id(self) -> &'static str {
        match self {
            Self::Europe => "europe",
            Self::Usa => "usa",
            Self::Japan => "japan",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Europe => "Europe",
            Self::Usa => "USA",
            Self::Japan => "Japan",
        }
    }
}

fn game(region: Region) -> GameDefinition {
    let mut fields = Vec::new();
    let (black_offset, black_bit, white_offset, white_bit) = match region {
        Region::Japan => (0x2, 0, 0x1, 7),
        Region::Europe | Region::Usa => (0x0, 4, 0x0, 5),
    };
    fields.push(
        FieldDefinition::new(
            "unlocked.black_yoshi".into(),
            "Black Yoshi unlocked".into(),
            black_offset,
            Storage::Bit,
        )
        .bit(black_bit),
    );
    fields.push(
        FieldDefinition::new(
            "unlocked.white_yoshi".into(),
            "White Yoshi unlocked".into(),
            white_offset,
            Storage::Bit,
        )
        .bit(white_bit),
    );

    if !matches!(region, Region::Japan) {
        fields.push(
            FieldDefinition::new(
                "continue.page".into(),
                "Continue page (zero-based)".into(),
                0x3f9,
                Storage::U8,
            )
            .min(0)
            .max(5),
        );
        for page in 1..=5 {
            fields.push(
                FieldDefinition::new(
                    format!("continue.mood.page_{page}"),
                    format!("Page {page} Yoshi mood"),
                    0x3ea + page * 2,
                    Storage::U16Be,
                )
                .max(9999),
            );
        }
        for (bit, (id, label)) in [
            ("cyan", "Cyan"),
            ("blue", "Blue"),
            ("green", "Green"),
            ("pink", "Pink"),
            ("red", "Red"),
            ("yellow", "Yellow"),
            ("white", "White"),
            ("black", "Black"),
        ]
        .into_iter()
        .enumerate()
        {
            fields.push(
                FieldDefinition::new(
                    format!("continue.yoshi.{id}"),
                    format!("{label} Yoshi available"),
                    0x3f6,
                    Storage::Bit,
                )
                .bit(bit as u8),
            );
        }
    }

    let audio_mask = if matches!(region, Region::Japan) {
        0x03
    } else {
        0xc0
    };
    fields.push(
        FieldDefinition::new("options.audio".into(), "Audio".into(), 0, Storage::U8)
            .mask(audio_mask)
            .choices(choices(&[("Stereo", 0), ("Mono", 1), ("Headphones", 2)])),
    );
    if !matches!(region, Region::Japan) {
        let languages = match region {
            Region::Europe => choices(&[("English", 0), ("French", 2), ("German", 3)]),
            Region::Usa => choices(&[("English", 0), ("Japanese", 1)]),
            Region::Japan => unreachable!(),
        };
        fields.push(
            FieldDefinition::new("options.language".into(), "Language".into(), 0, Storage::U8)
                .mask(0x0c)
                .choices(languages),
        );
    }

    let checksum_check = Check {
        when: None,
        assert: Condition::new(|bytes| {
            Ok(u16::from_be_bytes([bytes[0x3fa], bytes[0x3fb]]) == checksum(bytes))
        }),
        code: "save_checksum_mismatch".into(),
        message: "the Yoshi's Story checksum is invalid".into(),
        section_id: None,
        warning: None,
    };
    let runtime = runtime::Runtime {
        checks: vec![checksum_check.clone()],
        after_edit: vec![Store {
            when: None,
            destination: Scalar {
                offset: 0x3fa,
                storage: Storage::U16Be,
                mask: None,
            },
            value: ReadValue::new(|bytes| Ok(i64::from(checksum(bytes)))),
        }],
        layout: Some(layout::Layout {
            groups: vec![layout::Group {
                id: "save".into(),
                logical_offset: 0,
                logical_length: 2048,
                copies: layout::Copies::Fixed {
                    candidates: vec![layout::Candidate {
                        spans: vec![layout::Span {
                            logical_offset: 0,
                            physical_offset: 0,
                            length: 2048,
                        }],
                        predicates: vec![checksum_check.assert.clone()],
                        ..Default::default()
                    }],
                },
                selection: layout::Selection::FirstValid,
                write: layout::WritePolicy::Selected,
                empty: vec![],
                empty_if_no_signature: false,
            }],
        }),
        recognition: Some(runtime::Recognition {
            checks: vec![checksum_check],
            reasons: vec![SaveRecognitionReason::ChecksumValid],
            confidence: SaveRecognitionConfidence::High,
            incomplete_confidence: None,
            selected_reason: true,
            empty_top_level_reasons: false,
        }),
        ..Default::default()
    };
    GameDefinition {
        fields,
        description: format!(
            "Edits source-proven {} fields in a canonical 2 KiB EEPROM image. Rankings, names, and byte-swapped or container images are omitted. Requires a game-made template.",
            region.name()
        ),
        signatures: vec![SignatureDefinition {
            offset: 0x3fd,
            bytes: b"1u1".to_vec(),
        }],
        runtime,
        ..GameDefinition::new(
            format!("yoshis-story-canonical-eeprom-{}", region.id()),
            format!("Yoshi's Story (canonical EEPROM, {})", region.name()),
            "n64".into(),
            2048,
        )
    }
}

fn checksum(bytes: &[u8]) -> u16 {
    bytes[..0x3fa].iter().fold(0u32, |value, byte| {
        ((value ^ u32::from(*byte)) << 1) % 0xffff
    }) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn independent_checksum(bytes: &[u8]) -> u16 {
        let mut value = 0u32;
        for byte in &bytes[..0x3fa] {
            value ^= u32::from(*byte);
            value <<= 1;
            value %= 65_535;
        }
        value as u16
    }

    fn input(id: &str) -> SaveDetectionInput {
        let mut bytes: Vec<u8> = (0..2048).map(|offset| (offset * 37 + 11) as u8).collect();
        bytes[0x3fd..0x400].copy_from_slice(b"1u1");
        let checksum = independent_checksum(&bytes);
        bytes[0x3fa..0x3fc].copy_from_slice(&checksum.to_be_bytes());
        SaveDetectionInput {
            bytes,
            selected_game: Some(id.into()),
            rom_sha1: None,
        }
    }

    #[test]
    fn profiles_keep_regional_fields_separate() {
        let handlers = schemas();
        let identities: Vec<_> = handlers
            .iter()
            .map(|handler| handler.definitions().remove(0).identity)
            .collect();
        assert_eq!(identities.len(), 3);
        assert_eq!(identities[0].id, "yoshis-story-canonical-eeprom-europe");
        assert_eq!(identities[1].id, "yoshis-story-canonical-eeprom-usa");
        assert_eq!(identities[2].id, "yoshis-story-canonical-eeprom-japan");
        for (index, expected_fields) in [18, 18, 3].into_iter().enumerate() {
            let document = handlers[index]
                .parse(&input(&identities[index].id), &identities[index])
                .unwrap();
            assert_eq!(document.fields.len(), expected_fields);
        }
    }

    #[test]
    fn edits_region_specific_fields_and_repairs_exact_checksum() {
        for (index, field, offset, mask) in [
            (0, "unlocked.black_yoshi", 0, 0x10),
            (1, "unlocked.white_yoshi", 0, 0x20),
            (2, "unlocked.black_yoshi", 2, 0x01),
        ] {
            let handler = schemas().remove(index);
            let identity = handler.definitions().remove(0).identity;
            let original = input(&identity.id);
            let result = handler
                .apply(
                    &original,
                    &identity,
                    &[SaveEdit {
                        field: field.into(),
                        value: SaveValue::Bool(original.bytes[offset] & mask == 0),
                    }],
                    false,
                )
                .unwrap()
                .bytes
                .unwrap();
            assert_eq!(result[offset], original.bytes[offset] ^ mask);
            assert_eq!(
                u16::from_be_bytes([result[0x3fa], result[0x3fb]]),
                independent_checksum(&result)
            );
            assert_eq!(result[0x400..], original.bytes[0x400..]);
        }
    }

    #[test]
    fn packs_regional_audio_and_language_bits_exactly() {
        for (index, edits, expected, edited_mask) in [
            (
                0,
                vec![
                    ("options.audio", "Headphones"),
                    ("options.language", "German"),
                ],
                0x8c,
                0xcc,
            ),
            (
                1,
                vec![("options.audio", "Mono"), ("options.language", "Japanese")],
                0x44,
                0xcc,
            ),
            (2, vec![("options.audio", "Headphones")], 0x02, 0x03),
        ] {
            let handler = schemas().remove(index);
            let identity = handler.definitions().remove(0).identity;
            let mut original = input(&identity.id);
            original.bytes[0] = 0x33;
            let checksum = independent_checksum(&original.bytes);
            original.bytes[0x3fa..0x3fc].copy_from_slice(&checksum.to_be_bytes());
            let edits: Vec<_> = edits
                .into_iter()
                .map(|(field, value)| SaveEdit {
                    field: field.into(),
                    value: SaveValue::Enum(value.into()),
                })
                .collect();
            let result = handler
                .apply(&original, &identity, &edits, false)
                .unwrap()
                .bytes
                .unwrap();
            assert_eq!(result[0] & edited_mask, expected);
            assert_eq!(result[0] & !edited_mask, original.bytes[0] & !edited_mask);
        }
    }

    #[test]
    fn rejects_wrong_size_checksum_and_signature_and_cannot_generate() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let valid = input(&identity.id);
        for bytes in [valid.bytes[..2047].to_vec(), {
            let mut bytes = valid.bytes.clone();
            bytes.push(0);
            bytes
        }] {
            let bad = SaveDetectionInput {
                bytes,
                ..valid.clone()
            };
            assert!(handler.apply(&bad, &identity, &[], false).is_err());
        }
        let mut bad_checksum = valid.clone();
        bad_checksum.bytes[0x100] ^= 1;
        assert!(handler.apply(&bad_checksum, &identity, &[], false).is_err());
        let mut bad_signature = valid.clone();
        bad_signature.bytes[0x3fd] ^= 1;
        assert!(
            handler
                .apply(
                    &bad_signature,
                    &identity,
                    &[SaveEdit {
                        field: "unlocked.black_yoshi".into(),
                        value: SaveValue::Bool(true),
                    }],
                    false,
                )
                .is_err()
        );
        assert!(matches!(
            handler.recognize(&bad_signature).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
        assert!(handler.generate(&identity).is_err());
    }
}
