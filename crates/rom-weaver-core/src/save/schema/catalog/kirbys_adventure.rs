use super::*;

// Source layout: https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/kirby-s-adventure/saveEditor

const SLOT_STRIDE: usize = 0x4c;
const CHECKSUM_BASE: usize = 0x1903;
const SIGNATURE_BASE: usize = 0x18d0;

#[derive(Clone, Copy)]
enum Region {
    EuropeUsaRev1FranceGermany,
    UsaJapan,
    Canada,
}

impl Region {
    fn id(self) -> &'static str {
        match self {
            Self::EuropeUsaRev1FranceGermany => "europe-usa-rev1-france-germany",
            Self::UsaJapan => "usa-japan",
            Self::Canada => "canada",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::EuropeUsaRev1FranceGermany => "Europe/USA Rev 1/France/Germany",
            Self::UsaJapan => "USA/Japan",
            Self::Canada => "Canada",
        }
    }

    fn layout_shift(self) -> usize {
        match self {
            Self::EuropeUsaRev1FranceGermany => 0,
            Self::UsaJapan | Self::Canada => 0x12,
        }
    }

    fn signature_offset(self) -> usize {
        match self {
            Self::Canada => SIGNATURE_BASE + self.layout_shift(),
            Self::EuropeUsaRev1FranceGermany | Self::UsaJapan => SIGNATURE_BASE,
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let regions = [
        Region::EuropeUsaRev1FranceGermany,
        Region::UsaJapan,
        Region::Canada,
    ];
    let games = regions
        .into_iter()
        .flat_map(|region| (0..3).map(move |slot_index| game(region, slot_index)))
        .collect();
    build(games, BTreeMap::new(), true)
}

fn game(region: Region, slot_index: usize) -> GameDefinition {
    let checksum_offset = CHECKSUM_BASE + region.layout_shift() + slot_index * SLOT_STRIDE;
    let data_offset = checksum_offset + 2;
    let slot = slot_index + 1;
    let prefix = format!("slot_{slot}");
    let fields = vec![
        FieldDefinition::new(
            format!("{prefix}.completed_doors"),
            format!("Slot {slot} completed doors"),
            data_offset,
            Storage::U8,
        )
        .description("Raw completed-door count used to calculate completion rate.".into())
        .editable(false),
        FieldDefinition::new(
            format!("{prefix}.completed_levels"),
            format!("Slot {slot} completed levels"),
            data_offset + 1,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            format!("{prefix}.current_level"),
            format!("Slot {slot} current level"),
            data_offset + 0x1c,
            Storage::U24Be,
        )
        .description(
            "The upstream three-byte level ID; its high byte is copied to both animation bytes."
                .into(),
        )
        .choices(level_choices())
        .behavior(field::FieldBehavior {
            on_edit: vec![data_offset + 0x19, data_offset + 0x1a]
                .into_iter()
                .map(|offset| rules::Store {
                    when: None,
                    destination: rules::Scalar {
                        offset,
                        storage: Storage::U8,
                        mask: None,
                    },
                    value: rules::ReadValue::new(move |bytes| {
                        rules::Scalar {
                            offset: data_offset + 0x1c,
                            storage: Storage::U8,
                            mask: None,
                        }
                        .read(bytes)
                    }),
                })
                .collect(),
            ..Default::default()
        }),
    ];
    let mut game = GameDefinition {
        fields,
        description: format!(
            "Edits Kirby's Adventure Slot {slot} current-level bytes for the {} layout and repairs its XOR-high/additive-low checksum. The other slots remain unchanged. Door, switch, completion, and progression edits are omitted because they require derived writes.",
            region.name()
        ),
        signatures: if matches!(region, Region::Canada) {
            Vec::new()
        } else {
            vec![SignatureDefinition {
                offset: region.signature_offset(),
                bytes: vec![0xff],
            }]
        },
        checksums: vec![
            ChecksumDefinition {
                start: Some(data_offset),
                length: Some(0x24),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add8, checksum_offset)
            },
            ChecksumDefinition {
                start: Some(data_offset),
                length: Some(0x24),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Xor8, checksum_offset + 1)
            },
        ],
        ..GameDefinition::new(
            format!("kirbys-adventure-{}-slot-{slot}", region.id()),
            format!("Kirby's Adventure ({}, Slot {slot})", region.name()),
            "nes".into(),
            8192,
        )
    };
    if matches!(region, Region::Canada) {
        let marker = canada_marker_check();
        game.runtime.checks = vec![marker.clone()];
        game.runtime.recognition = Some(runtime::Recognition {
            checks: vec![marker],
            reasons: vec![
                SaveRecognitionReason::ChecksumValid,
                SaveRecognitionReason::SignatureValid,
            ],
            confidence: SaveRecognitionConfidence::High,
            incomplete_confidence: None,
            selected_reason: true,
            empty_top_level_reasons: false,
        });
    }
    game
}

fn canada_marker_check() -> rules::Check {
    rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok((0..3).any(|slot| bytes[SIGNATURE_BASE + 0x12 + slot * SLOT_STRIDE] == 0xff))
        }),
        code: "save_signature".into(),
        message: "the save does not contain a Canadian layout marker".into(),
        section_id: None,
        warning: None,
    }
}

fn level_choices() -> Vec<FieldChoice> {
    choices(&[
        ("Door 1-1", 0x266),
        ("Door 1-2", 0x2f8),
        ("Door 1-3", 0x342),
        ("Door 1-4", 0x385),
        ("Level 2", 0x101b9),
        ("Door 2-1", 0x10374),
        ("Door 2-2", 0x1010b),
        ("Door 2-3", 0x10417),
        ("Door 2-4", 0x10116),
        ("Door 2-5", 0x104f3),
        ("Level 3", 0x202b7),
        ("Door 3-1", 0x20377),
        ("Door 3-2", 0x20380),
        ("Door 3-3", 0x20277),
        ("Door 3-4", 0x20281),
        ("Door 3-5", 0x20185),
        ("Door 3-6", 0x20180),
        ("Level 4", 0x30077),
        ("Door 4-1", 0x30375),
        ("Door 4-2", 0x303a0),
        ("Door 4-3", 0x30147),
        ("Door 4-4", 0x30476),
        ("Door 4-5", 0x30523),
        ("Door 4-6", 0x30266),
        ("Level 5", 0x402b5),
        ("Door 5-1", 0x40038),
        ("Door 5-2", 0x40095),
        ("Door 5-3", 0x400aa),
        ("Door 5-4", 0x40430),
        ("Door 5-5", 0x40514),
        ("Door 5-6", 0x40585),
        ("Level 6", 0x502b9),
        ("Door 6-1", 0x50388),
        ("Door 6-2", 0x503c2),
        ("Door 6-3", 0x50435),
        ("Door 6-4", 0x504a3),
        ("Door 6-5", 0x50541),
        ("Door 6-6", 0x502ab),
        ("Level 7", 0x602d9),
        ("Door 7-1", 0x60252),
        ("Door 7-2", 0x602a4),
        ("Door 7-3", 0x60306),
        ("Door 7-4", 0x60353),
        ("Door 7-5", 0x603a1),
        ("Door 7-6", 0x601da),
        ("Final Boss", 0x600f9),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_checksum(bytes: &[u8], start: usize) -> [u8; 2] {
        let mut xor = 0;
        let mut sum = 0u8;
        for byte in &bytes[start..start + 0x24] {
            xor ^= byte;
            sum = sum.wrapping_add(*byte);
        }
        [sum, xor]
    }

    fn fixture(region: Region, slot_index: usize) -> Vec<u8> {
        let mut bytes = vec![0; 8192];
        let checksum = CHECKSUM_BASE + region.layout_shift() + slot_index * SLOT_STRIDE;
        let data = checksum + 2;
        bytes[region.signature_offset()] = 0xff;
        for (index, byte) in bytes[data..data + 0x24].iter_mut().enumerate() {
            *byte = (index as u8).wrapping_mul(7).wrapping_add(slot_index as u8);
        }
        let checksum_bytes = source_checksum(&bytes, data);
        bytes[checksum..checksum + 2].copy_from_slice(&checksum_bytes);
        bytes
    }

    fn input(bytes: Vec<u8>, id: &str) -> SaveDetectionInput {
        SaveDetectionInput {
            bytes,
            selected_game: Some(id.into()),
            rom_sha1: None,
        }
    }

    #[test]
    fn recognizes_all_region_and_slot_layouts() {
        for (handler, (region, slot_index)) in schemas().into_iter().zip(
            [
                Region::EuropeUsaRev1FranceGermany,
                Region::UsaJapan,
                Region::Canada,
            ]
            .into_iter()
            .flat_map(|region| (0..3).map(move |slot| (region, slot))),
        ) {
            let identity = handler.definitions().remove(0).identity;
            let recognition = handler.recognize(&input(fixture(region, slot_index), &identity.id));
            assert!(matches!(
                recognition.outcome,
                SaveRecognitionOutcome::Recognized { .. }
            ));
        }
    }

    #[test]
    fn edit_repairs_source_checksum_and_preserves_other_slots() {
        let region = Region::Canada;
        let slot_index = 1;
        let handler = schemas().remove(7);
        let identity = handler.definitions().remove(0).identity;
        let original = fixture(region, slot_index);
        let checksum = CHECKSUM_BASE + region.layout_shift() + slot_index * SLOT_STRIDE;
        let data = checksum + 2;
        let result = handler
            .apply(
                &input(original.clone(), &identity.id),
                &identity,
                &[SaveEdit {
                    field: "slot_2.current_level".into(),
                    value: SaveValue::Enum("Door 7-1".into()),
                }],
                false,
            )
            .unwrap();
        let edited = result.bytes.unwrap();
        assert_eq!(
            &edited[checksum..checksum + 2],
            &source_checksum(&edited, data)
        );
        assert_eq!(edited[data + 0x19], 6);
        assert_eq!(edited[data + 0x1a], 6);
        assert_eq!(edited[data + 0x1c], 6);
        assert_eq!(&edited[..checksum], &original[..checksum]);
        assert_eq!(&edited[data + 0x24..], &original[data + 0x24..]);
    }

    #[test]
    fn rejects_an_invalid_source_checksum() {
        let region = Region::UsaJapan;
        let handler = schemas().remove(3);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = fixture(region, 0);
        bytes[CHECKSUM_BASE + region.layout_shift() + 5] ^= 0x80;
        let recognition = handler.recognize(&input(bytes, &identity.id));
        assert!(matches!(
            recognition.outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
        assert!(
            recognition
                .reasons
                .contains(&SaveRecognitionReason::ChecksumMismatch)
        );
    }
}
