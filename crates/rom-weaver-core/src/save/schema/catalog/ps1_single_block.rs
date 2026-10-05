use super::playstation_card::{self, BLOCK_SIZE};
use super::*;

// Fields and linked writes MUST follow these pinned game layouts.
// https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/tekken/saveEditor
// https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/rayman/saveEditor
// https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/castlevania-symphony-of-the-night/saveEditor
// https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/grandia/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for block in 1..=15 {
        let base = block * BLOCK_SIZE;
        for (region, product) in [
            ("europe", "SCES-00005"),
            ("usa", "SLUS-00006"),
            ("japan", "SLPS-00040"),
        ] {
            let mut fields = vec![
                FieldDefinition::new(
                    "difficulty".into(),
                    "Difficulty".into(),
                    base + 0x203,
                    Storage::U8,
                )
                .min(0)
                .max(4),
            ];
            for (index, name) in [
                "Kazuya",
                "Paul",
                "Law",
                "Jack",
                "Nina",
                "King",
                "Yoshimitsu",
                "Michelle",
                "Wang",
                "Heihachi",
                "Lee",
                "Prototype Jack",
                "Armor King",
                "Anna",
                "Ganryu",
                "Kuma",
                "Kunimitsu",
            ]
            .into_iter()
            .enumerate()
            {
                fields.push(
                    FieldDefinition::new(
                        format!("character_{index}.unlocked"),
                        format!("{name} unlocked"),
                        base + 0x20c + index / 8,
                        Storage::Bit,
                    )
                    .bit((index % 8) as u8),
                );
            }
            games.push(playstation_card::definition(
                "tekken", "Tekken", region, product, block, fields,
            ));
        }
        for (region, product) in [
            ("europe", "SLES-00049"),
            ("usa", "SLUS-00005"),
            ("japan", "SLPS-00026"),
        ] {
            let fields = [("lives", "Lives", 0x400), ("tings", "Tings", 0x406)]
                .into_iter()
                .map(|(id, label, offset)| {
                    FieldDefinition::new(id.into(), label.into(), base + offset, Storage::U8)
                        .min(0)
                        .max(99)
                })
                .collect();
            games.push(playstation_card::definition(
                "rayman", "Rayman", region, product, block, fields,
            ));
        }
        for (region, product, shift) in [
            ("europe", "SLES-00524", 0),
            ("usa", "SLUS-00067", 0x100),
            ("japan", "SLPM-86023", 0x100),
            ("asia", "SCPS-45196", 0x100),
        ] {
            let fields = vec![
                FieldDefinition::new(
                    "gold".into(),
                    "Gold".into(),
                    base + shift + 0x3c4,
                    Storage::U32Le,
                )
                .min(0)
                .max(999999)
                .copies(vec![base + shift + 0x110]),
                FieldDefinition::new(
                    "experience".into(),
                    "Experience".into(),
                    base + shift + 0x3c0,
                    Storage::U32Le,
                )
                .min(0)
                .max(999999),
            ];
            games.push(playstation_card::definition(
                "castlevania-symphony-of-the-night",
                "Castlevania: Symphony of the Night",
                region,
                product,
                block,
                fields,
            ));
        }
        for (region, product, shift) in [
            ("europe", "SLES-02397", 0),
            ("usa", "SCUSP94457", 0x180),
            ("japan", "SLPSP02124", 0x180),
            ("france", "SLES-02398", 0),
            ("germany", "SLES-02399", 0),
        ] {
            let fields = vec![
                FieldDefinition::new(
                    "gold".into(),
                    "Gold pieces".into(),
                    base + shift + 0x1b0,
                    Storage::U32Le,
                )
                .min(0)
                .max(9999999),
            ];
            games.push(playstation_card::definition(
                "grandia", "Grandia", region, product, block, fields,
            ));
        }
    }
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handler(id: &str) -> SchemaSaveHandler {
        schemas()
            .into_iter()
            .find(|handler| handler.definitions()[0].identity.id == id)
            .unwrap()
    }

    #[test]
    fn scalar_edits_preserve_the_card_and_noops() {
        for (id, product, field, offset, value) in [
            ("tekken-usa-block-3", "SLUS-00006", "difficulty", 0x203, 4),
            ("rayman-usa-block-3", "SLUS-00005", "lives", 0x400, 99),
            (
                "castlevania-symphony-of-the-night-usa-block-3",
                "SLUS-00067",
                "experience",
                0x4c0,
                999999,
            ),
            ("grandia-usa-block-3", "SCUSP94457", "gold", 0x330, 9999999),
        ] {
            let handler = handler(id);
            let identity = handler.definitions()[0].identity.clone();
            let input = SaveDetectionInput {
                bytes: playstation_card::fixture(product, 3),
                selected_game: Some(id.into()),
                rom_sha1: None,
            };
            let edit = SaveEdit {
                field: field.into(),
                value: SaveValue::U32(value),
            };
            let output = handler
                .apply(&input, &identity, std::slice::from_ref(&edit), false)
                .unwrap()
                .bytes
                .unwrap();
            let width = if matches!(field, "experience" | "gold") {
                4
            } else {
                1
            };
            let start = 3 * BLOCK_SIZE + offset;
            for (index, (before, after)) in input.bytes.iter().zip(&output).enumerate() {
                if !(start..start + width).contains(&index) {
                    assert_eq!(before, after, "{id}: {index:x}");
                }
            }
            assert_eq!(&output[start..start + width], &value.to_le_bytes()[..width]);
            let edited = SaveDetectionInput {
                bytes: output.clone(),
                ..input.clone()
            };
            assert_eq!(
                handler
                    .apply(&edited, &identity, &[edit], false)
                    .unwrap()
                    .bytes
                    .unwrap_or_else(|| edited.bytes.clone()),
                output
            );
            assert_eq!(
                handler
                    .apply(&input, &identity, &[], false)
                    .unwrap()
                    .bytes
                    .unwrap_or_else(|| input.bytes.clone()),
                input.bytes
            );
            assert!(
                handler
                    .apply(
                        &input,
                        &identity,
                        &[SaveEdit {
                            field: field.into(),
                            value: SaveValue::U32(100_000_000)
                        }],
                        false
                    )
                    .is_err()
            );
        }
    }

    #[test]
    fn gold_updates_only_the_value_and_preview_in_each_region() {
        for (region, product, shift) in [
            ("europe", "SLES-00524", 0),
            ("usa", "SLUS-00067", 0x100),
            ("japan", "SLPM-86023", 0x100),
            ("asia", "SCPS-45196", 0x100),
        ] {
            let id = format!("castlevania-symphony-of-the-night-{region}-block-15");
            let handler = handler(&id);
            let identity = handler.definitions()[0].identity.clone();
            let input = SaveDetectionInput {
                bytes: playstation_card::fixture(product, 15),
                selected_game: Some(id),
                rom_sha1: None,
            };
            let output = handler
                .apply(
                    &input,
                    &identity,
                    &[SaveEdit {
                        field: "gold".into(),
                        value: SaveValue::U32(123456),
                    }],
                    false,
                )
                .unwrap()
                .bytes
                .unwrap();
            let base = 15 * BLOCK_SIZE + shift;
            for offset in [0x110, 0x3c4] {
                assert_eq!(
                    &output[base + offset..base + offset + 4],
                    &123456u32.to_le_bytes()
                );
            }
            for (index, (&after, &before)) in output.iter().zip(&input.bytes).enumerate() {
                if !(base + 0x110..base + 0x114).contains(&index)
                    && !(base + 0x3c4..base + 0x3c8).contains(&index)
                {
                    assert_eq!(after, before);
                }
            }
        }
    }

    #[test]
    fn card_checks_reject_damaged_metadata_and_unsupported_layouts() {
        let handler = handler("tekken-usa-block-1");
        let identity = handler.definitions()[0].identity.clone();
        let original = playstation_card::fixture("SLUS-00006", 1);
        for offset in [
            0, 0x7f, 0x80, 0x84, 0x88, 0x8c, 0xff, 0x2000, 0x2002, 0x2003,
        ] {
            let mut bytes = original.clone();
            bytes[offset] ^= 1;
            let input = SaveDetectionInput {
                bytes,
                selected_game: Some(identity.id.clone()),
                rom_sha1: None,
            };
            assert!(
                handler.apply(&input, &identity, &[], false).is_err(),
                "accepted damage at {offset:x}"
            );
        }
        for size in [0, 0x2000, 0x1ffff, 0x20001] {
            let input = SaveDetectionInput {
                bytes: vec![0; size],
                selected_game: Some(identity.id.clone()),
                rom_sha1: None,
            };
            assert!(handler.apply(&input, &identity, &[], false).is_err());
        }
        let mut bytes = original;
        bytes[0x2200..0x4000].fill(0);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        assert!(handler.apply(&input, &identity, &[], false).is_err());
        let mut bytes = playstation_card::fixture("SLUS-00006", 1);
        bytes[0x100] = 0x52;
        bytes[0x108..0x10a].fill(0);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        assert!(handler.apply(&input, &identity, &[], false).is_err());
    }
}
