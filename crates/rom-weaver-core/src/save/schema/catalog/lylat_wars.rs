use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

fn checksum(bytes: &[u8]) -> u16 {
    let mut value = 0u16;
    for byte in &bytes[..0xfe] {
        value ^= u16::from(*byte);
        value = ((value << 1) & 0xfe) | ((value >> 7) & 1);
    }
    (value & 0xff) | 0x9500
}

// Layout and checksum rules: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/lylat-wars/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    for (id, label, offset) in [
        ("corneria", "Corneria", 0x9),
        ("meteo", "Meteo", 0x0),
        ("sector_y", "Sector Y", 0x5),
    ] {
        for (suffix, bit) in [
            ("played", 2),
            ("complete", 0),
            ("medal", 1),
            ("expert_complete", 3),
            ("expert_medal", 4),
        ] {
            fields.push(
                FieldDefinition::new(
                    format!("{id}.{suffix}"),
                    format!("{label} {suffix}"),
                    offset,
                    Storage::Bit,
                )
                .bit(bit),
            );
        }
    }
    let check = Check {
        when: None,
        assert: Condition::new(|bytes| {
            Ok(u16::from_be_bytes([bytes[0xfe], bytes[0xff]]) == checksum(bytes))
        }),
        code: "lylat_wars_checksum".into(),
        message: "the Lylat Wars checksum is invalid".into(),
        section_id: None,
        warning: None,
    };
    let game = GameDefinition {
        fields,
        description: "Edits mission completion and medals in normalized 16 Kbit EEPROM. Requires a game-made template.".into(),
        runtime: runtime::Runtime { require_selection: true, recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: false }), checks: vec![check], after_edit: vec![Store { when: None, destination: Scalar { offset: 0xfe, storage: Storage::U16Be, mask: None }, value: ReadValue::new(|bytes| Ok(i64::from(checksum(bytes)))) }], save_format: Some("n64_eeprom_16k".into()), save_format_name: Some("Nintendo 64 EEPROM 16 Kbit".into()), ..Default::default() },
        ..GameDefinition::new("lylat-wars".into(), "Lylat Wars / Star Fox 64".into(), "nintendo-64".into(), 2048)
    };
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0x33; 2048];
        let sum = checksum(&bytes);
        bytes[0xfe..0x100].copy_from_slice(&sum.to_be_bytes());
        SaveDetectionInput {
            bytes,
            selected_game: Some("lylat-wars".into()),
            rom_sha1: None,
        }
    }
    #[test]
    fn checksum_matches_independent_known_vector() {
        let mut bytes = vec![0; 2048];
        bytes[..4].copy_from_slice(&[1, 2, 3, 4]);
        assert_eq!(checksum(&bytes), 0x9510);
    }
    #[test]
    fn edit_repairs_checksum_and_preserves_tail() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "corneria.medal".into(),
                    value: SaveValue::Bool(false),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(
            u16::from_be_bytes([bytes[0xfe], bytes[0xff]]),
            checksum(&bytes)
        );
        assert_eq!(&bytes[0x100..], &original.bytes[0x100..]);
        assert!(
            handler
                .apply(&original, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input();
        bad.bytes[4] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }
}
