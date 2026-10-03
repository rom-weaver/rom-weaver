use super::*;

// Source layout: https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/legend-of-zelda-the-link-s-awakening/saveEditor

#[derive(Clone, Copy)]
enum Layout {
    GameBoy,
    GameBoyColor,
}

impl Layout {
    fn id(self) -> &'static str {
        match self {
            Self::GameBoy => "gb",
            Self::GameBoyColor => "gbc",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::GameBoy => "Game Boy",
            Self::GameBoyColor => "Game Boy Color",
        }
    }

    fn platform(self) -> &'static str {
        match self {
            Self::GameBoy => "game-boy",
            Self::GameBoyColor => "game-boy-color",
        }
    }

    fn save_size(self) -> usize {
        match self {
            Self::GameBoy => 8192,
            Self::GameBoyColor => 32768,
        }
    }

    fn stride(self) -> usize {
        match self {
            Self::GameBoy => 0x385,
            Self::GameBoyColor => 0x3ad,
        }
    }
}

#[derive(Clone, Copy)]
enum Region {
    EuropeUsaFranceCanadaGermany,
    JapanAlternate,
}

impl Region {
    fn id(self) -> &'static str {
        match self {
            Self::EuropeUsaFranceCanadaGermany => "international",
            Self::JapanAlternate => "japan-alternate",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::EuropeUsaFranceCanadaGermany => "Europe/USA/France/Canada/Germany",
            Self::JapanAlternate => "Japan (alternate marker)",
        }
    }

    fn signature(self) -> Vec<u8> {
        match self {
            Self::EuropeUsaFranceCanadaGermany => vec![1, 3, 5, 7, 9],
            Self::JapanAlternate => vec![1, 2, 3, 4, 5],
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let layouts = [Layout::GameBoy, Layout::GameBoyColor];
    let regions = [Region::EuropeUsaFranceCanadaGermany, Region::JapanAlternate];
    let games = layouts
        .into_iter()
        .flat_map(|layout| regions.into_iter().map(move |region| game(layout, region)))
        .collect();
    build(games, BTreeMap::new(), true)
}

fn game(layout: Layout, region: Region) -> GameDefinition {
    let mut fields = Vec::new();
    for slot_index in 0..3 {
        fields.extend(slot_fields(slot_index, layout.stride()));
    }
    let expected_color = matches!(layout, Layout::GameBoyColor);
    let layout_check = rules::Check {
        when: None,
        assert: rules::Condition::new(move |bytes| {
            let color_marker = bytes.get(0x4ad..0x4b2) == Some([1, 3, 5, 7, 9].as_slice());
            Ok(color_marker == expected_color)
        }),
        code: "save_layout".into(),
        message: format!("the save does not use the {} slot layout", layout.name()),
        section_id: None,
        warning: None,
    };
    let mut game = GameDefinition {
        fields,
        description: format!(
            "Edits three {} save slots for the {} release marker. Names, location, and dungeon state are omitted. Current quantities cannot exceed their stored capacities. This layout has no checksum.",
            layout.name(),
            region.name()
        ),
        signatures: vec![SignatureDefinition {
            offset: 0x100,
            bytes: region.signature(),
        }],
        ..GameDefinition::new(
            format!("zelda-links-awakening-{}-{}", layout.id(), region.id()),
            format!(
                "The Legend of Zelda: Link's Awakening ({}, {})",
                layout.name(),
                region.name()
            ),
            layout.platform().into(),
            layout.save_size(),
        )
    };
    game.runtime.checks = vec![layout_check.clone()];
    game.runtime.recognition = Some(runtime::Recognition {
        checks: vec![layout_check],
        reasons: vec![SaveRecognitionReason::SignatureValid],
        confidence: SaveRecognitionConfidence::High,
        incomplete_confidence: None,
        selected_reason: true,
        empty_top_level_reasons: false,
    });
    game.runtime.edit_checks = (0..3)
        .map(|slot| {
            let shift = slot * layout.stride();
            rules::Check {
                when: Some(rules::Condition::new(move |bytes| {
                    Ok(bytes[shift + 0x45f] != 0)
                })),
                assert: rules::Condition::new(move |bytes| {
                    let resources_valid = [(0x451, 0x47b), (0x452, 0x47c), (0x44a, 0x47d)]
                        .into_iter()
                        .all(|(current, capacity)| {
                            let current = bytes[shift + current];
                            let capacity = bytes[shift + capacity];
                            current & 15 <= 9
                                && current >> 4 <= 9
                                && capacity & 15 <= 9
                                && capacity >> 4 <= 9
                                && current <= capacity
                        });
                    Ok(resources_valid
                        && u16::from(bytes[shift + 0x45f]) <= u16::from(bytes[shift + 0x460]) * 8)
                }),
                code: "save_resource_capacity".into(),
                message: format!(
                    "slot {} health or resources exceed their stored capacities",
                    slot + 1
                ),
                section_id: None,
                warning: None,
            }
        })
        .collect();
    game
}

fn slot_fields(slot_index: usize, stride: usize) -> Vec<FieldDefinition> {
    let slot = slot_index + 1;
    let shift = slot_index * stride;
    let prefix = format!("slot_{slot}");
    let field = |id: &str, label: &str, offset, storage| {
        FieldDefinition::new(
            format!("{prefix}.{id}"),
            format!("Slot {slot} {label}"),
            offset + shift,
            storage,
        )
    };
    let mut fields = vec![
        field("death_count_bcd", "death count", 0x45c, Storage::BcdLe)
            .length(2)
            .max(999),
        field("theft_count", "theft count", 0x473, Storage::U8),
        field(
            "health_eighths",
            "current health (eighths)",
            0x45f,
            Storage::U8,
        )
        .min(2)
        .max(112),
        field("heart_capacity", "heart capacity", 0x460, Storage::U8)
            .min(1)
            .max(14),
        field("heart_pieces", "heart pieces", 0x461, Storage::U8).max(3),
        field("rupees", "rupees", 0x462, Storage::BcdBe)
            .length(2)
            .max(999),
        field(
            "secret_seashells",
            "secret seashells",
            0x414,
            Storage::BcdBe,
        )
        .length(1)
        .max(26),
        field(
            "resources.magic_powder",
            "magic powder",
            0x451,
            Storage::BcdBe,
        )
        .length(1),
        field("resources.bombs", "bombs", 0x452, Storage::BcdBe).length(1),
        field("resources.arrows", "arrows", 0x44a, Storage::BcdBe).length(1),
        field("key_items.flippers", "Flippers", 0x411, Storage::Bit).bit(0),
        field(
            "key_items.secret_medicine",
            "Secret Medicine",
            0x412,
            Storage::Bit,
        )
        .bit(0),
        field("key_items.tail_key", "Tail Key", 0x415, Storage::Bit).bit(0),
        field("key_items.angler_key", "Angler Key", 0x416, Storage::Bit).bit(0),
        field("key_items.face_key", "Face Key", 0x417, Storage::Bit).bit(0),
        field("key_items.bird_key", "Bird Key", 0x418, Storage::Bit).bit(0),
    ];
    for (index, label) in [
        "Full Moon Cello",
        "Conch Horn",
        "Sea Lily's Bell",
        "Surf Harp",
        "Wind Marimba",
        "Coral Triangle",
        "Organ of Evening Calm",
        "Thunder Drum",
    ]
    .into_iter()
    .enumerate()
    {
        fields.push(field(
            &format!("instruments.{}", index + 1),
            label,
            0x46a + index,
            Storage::Bool,
        ));
    }
    let health_offset = 0x45f + shift;
    for field in &mut fields {
        field.behavior.editable_when = Some(rules::Condition::new(move |bytes| {
            Ok(bytes[health_offset] != 0)
        }));
        field.behavior.present_when = Some(rules::Condition::new(move |bytes| {
            Ok(bytes[health_offset] != 0)
        }));
    }
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(identity: &SaveGameIdentity, color: bool) -> SaveDetectionInput {
        let mut bytes = vec![0xa5; if color { 32768 } else { 8192 }];
        bytes[0x100..0x105].copy_from_slice(&[1, 3, 5, 7, 9]);
        if color {
            bytes[0x4ad..0x4b2].copy_from_slice(&[1, 3, 5, 7, 9]);
        }
        let stride = if color { 0x3ad } else { 0x385 };
        for slot in 0..3 {
            for offset in [0x414, 0x44a, 0x451, 0x452, 0x45c, 0x45d, 0x462, 0x463] {
                bytes[offset + slot * stride] = 0;
            }
            bytes[0x45f + slot * stride] = 8;
            bytes[0x460 + slot * stride] = 3;
            for offset in [0x47b, 0x47c, 0x47d] {
                bytes[offset + slot * stride] = 0x60;
            }
        }
        SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        }
    }

    #[test]
    fn color_slot_edit_uses_color_stride_and_preserves_other_bytes() {
        let handler = schemas().remove(2);
        let identity = handler.definitions().remove(0).identity;
        let input = input(&identity, true);
        let mut expected = input.bytes.clone();
        expected[0x451 + 2 * 0x3ad] = 0x42;
        let result = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "slot_3.resources.magic_powder".into(),
                    value: SaveValue::U32(42),
                }],
                false,
            )
            .unwrap();
        assert_eq!(result.bytes.unwrap(), expected);
    }

    #[test]
    fn rejects_quantities_above_capacity_and_edits_to_empty_slots() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input(&identity, false);
        for (id, value) in [
            ("resources.bombs", 99),
            ("resources.arrows", 99),
            ("resources.magic_powder", 99),
            ("health_eighths", 32),
        ] {
            let edits = [SaveEdit {
                field: format!("slot_1.{id}"),
                value: SaveValue::U32(value),
            }];
            for dry_run in [true, false] {
                assert!(
                    handler
                        .apply(&original, &identity, &edits, dry_run)
                        .is_err(),
                    "{id}"
                );
            }
        }
        let mut empty = original;
        empty.bytes[0x45f] = 0;
        assert!(
            handler
                .apply(
                    &empty,
                    &identity,
                    &[SaveEdit {
                        field: "slot_1.rupees".into(),
                        value: SaveValue::U32(50),
                    }],
                    false
                )
                .is_err()
        );
    }

    #[test]
    fn rejects_wrong_layout_signature_and_length() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        assert!(
            handler
                .apply(&input(&identity, true), &identity, &[], false)
                .is_err()
        );
        let mut bad = input(&identity, false);
        bad.bytes.pop();
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input(&identity, false);
        bad.bytes[0x100] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }
}
