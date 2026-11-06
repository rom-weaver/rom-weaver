use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;
use tracing::trace;

const CIRCUITS: [&str; 4] = ["minor", "major", "world", "special"];
const BUTTONS: [(&str, i64); 7] = [
    ("R", 0),
    ("L", 1),
    ("X", 2),
    ("A", 3),
    ("Y", 4),
    ("B", 5),
    ("Auto", 6),
];

fn checksum(bytes: &[u8], base: usize) -> u16 {
    let start = base + 0x104;
    let sum = (start..base + 0x180).fold(0u32, |sum, offset| {
        sum + u32::from(bytes[offset])
            + if offset > start {
                (offset - 4) as u32
            } else {
                0
            }
    });
    trace!(base, sum, "computed Super Punch-Out!! slot checksum");
    (sum as u16) ^ 0xff
}

// Layout, write rules, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/super-punch-out/saveEditor
// Current layout and write rules: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/super-punch-out/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..8).map(|slot| {
        let base = slot * 0x80;
        let checksum_offset = base + 0x101;
        let check = Check { when: None, assert: Condition::new(move |bytes| Ok(u16::from_le_bytes([bytes[checksum_offset], bytes[checksum_offset + 1]]) == checksum(bytes, base))), code: "super_punch_out_checksum".into(), message: "the Super Punch-Out!! slot checksum is invalid".into(), section_id: None, warning: None };
        let mut fields = vec![
            catalog_field("losses", "Losses", base + 0x17f, Storage::U8),
            catalog_field("wins", "Wins", base + 0x17e, Storage::U8).editable(false).description("Read-only because lowering wins can also change the beaten-opponents mask.".into()),
            catalog_field("championship_progression", "Championship progression code", base + 0x104, Storage::U8).editable(false),
        ];
        for (id, label, offset, mask) in [
            ("right_punch", "Right punch", 0x106, 0x0f),
            ("left_punch", "Left punch", 0x106, 0xf0),
            ("knockout_punch", "Knockout punch", 0x107, 0x0f),
            ("power_up", "Power up", 0x107, 0xf0),
        ] {
            fields.push(catalog_field(&format!("buttons.{id}"), &format!("{label} button"), base + offset, Storage::U8).mask(mask).choices(choices(&BUTTONS)));
        }
        // A circuit's loss counter only exists once that circuit is beaten; the beaten-opponents byte stores the count minus one, four opponents per circuit.
        for (index, circuit) in CIRCUITS.iter().enumerate() {
            let opponents = base + 0x105;
            fields.push(
                catalog_field(&format!("circuits.{circuit}.losses"), &format!("{} circuit losses", circuit[..1].to_uppercase() + &circuit[1..]), base + 0x110 + index, Storage::U8)
                    .mask(0x0f)
                    .min(0)
                    .max(3)
                    .behavior(field::FieldBehavior {
                        editable_when: Some(Condition::new(move |bytes| Ok(usize::from(bytes[opponents]) + 1 >= (index + 1) * 4))),
                        ..Default::default()
                    }),
            );
        }
        GameDefinition {
            fields,
            description: format!("Edits the loss counters and button mapping in profile {}. Names, wins, opponent flags, times, scores, and records are omitted because they use coupled or digit-per-byte write rules.", slot + 1),
            signatures: vec![SignatureDefinition { offset: base + 0x100, bytes: vec![1] }],
            runtime: runtime::Runtime { recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: true }), checks: vec![check], after_edit: vec![Store { when: None, destination: Scalar { offset: checksum_offset, storage: Storage::U16Le, mask: None }, value: ReadValue::new(move |bytes| Ok(i64::from(checksum(bytes, base)))) }], ..Default::default() },
            ..GameDefinition::new(format!("super-punch-out-slot-{}", slot + 1), format!("Super Punch-Out!! (Profile {})", slot + 1), "snes".into(), 8192)
        }
    }).collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checksum_matches_reference_vectors_in_first_and_last_slots() {
        let bytes: Vec<u8> = (0..8192).map(|offset| offset as u8).collect();
        assert_eq!(checksum(&bytes, 0), 0xb87b);
        assert_eq!(checksum(&bytes, 7 * 0x80), 0xa5fb);
    }
    #[test]
    fn edit_repairs_position_weighted_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0x22; 8192];
        bytes[0x100] = 1;
        let sum = checksum(&bytes, 0);
        bytes[0x101..0x103].copy_from_slice(&sum.to_le_bytes());
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0x17f] = 9;
        let sum = checksum(&expected, 0);
        expected[0x101..0x103].copy_from_slice(&sum.to_le_bytes());
        let output = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "losses".into(),
                    value: SaveValue::U32(9),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(output, expected);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input.clone();
        bad.bytes[0x110] ^= 1;
        assert!(matches!(
            handler.recognize(&bad).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    fn reference_checksum(bytes: &[u8], base: usize) -> u16 {
        let start = base + 0x104;
        let mut sum: u64 = 0;
        for (offset, byte) in bytes.iter().enumerate().take(base + 0x180).skip(start) {
            sum += u64::from(*byte);
            if offset > start {
                sum += (offset - 4) as u64;
            }
        }
        ((sum & 0xffff) as u16) ^ 0xff
    }

    fn repair(bytes: &mut [u8], base: usize) {
        let sum = reference_checksum(bytes, base);
        bytes[base + 0x101..base + 0x103].copy_from_slice(&sum.to_le_bytes());
    }

    fn edit(field: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value,
        }
    }

    fn apply(handler: &SchemaSaveHandler, bytes: Vec<u8>, edits: &[SaveEdit]) -> Result<Vec<u8>> {
        let identity = handler.definitions().remove(0).identity;
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        Ok(handler
            .apply(&input, &identity, edits, false)?
            .bytes
            .expect("edited bytes"))
    }

    #[test]
    fn button_and_circuit_loss_edits_repair_the_slot_checksum_only() {
        for slot in [2usize, 7] {
            let handler = schemas().remove(slot);
            let base = slot * 0x80;
            let mut bytes = vec![0x22; 8192];
            for other in 0..8 {
                bytes[other * 0x80 + 0x100] = 1;
                repair(&mut bytes, other * 0x80);
            }
            // Eight beaten opponents (stored as 7) clear the minor and major circuits, unlocking only their loss counters.
            bytes[base + 0x105] = 0x07;
            repair(&mut bytes, base);
            let choice = |name: &str| SaveValue::Enum(name.into());
            let edits = [
                edit("buttons.right_punch", choice("Auto")),
                edit("buttons.left_punch", choice("B")),
                edit("buttons.knockout_punch", choice("A")),
                edit("buttons.power_up", choice("L")),
                edit("circuits.minor.losses", SaveValue::U32(3)),
                edit("circuits.major.losses", SaveValue::U32(1)),
            ];
            let mut expected = bytes.clone();
            expected[base + 0x106] = 0x56;
            expected[base + 0x107] = 0x13;
            expected[base + 0x110] = 0x23;
            expected[base + 0x111] = 0x21;
            repair(&mut expected, base);
            assert_eq!(
                apply(&handler, bytes.clone(), &edits).unwrap(),
                expected,
                "slot {slot}"
            );
            for (field, value) in [
                ("circuits.world.losses", SaveValue::U32(1)),
                ("circuits.special.losses", SaveValue::U32(1)),
                ("circuits.minor.losses", SaveValue::U32(4)),
                ("buttons.power_up", choice("Select")),
            ] {
                assert!(
                    apply(&handler, bytes.clone(), &[edit(field, value)]).is_err(),
                    "{field}"
                );
            }
        }
    }
}
