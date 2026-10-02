use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

fn gp_checksum(bytes: &[u8]) -> u16 {
    let sum = bytes[0x180..0x185]
        .iter()
        .enumerate()
        .fold(0u16, |sum, (index, byte)| {
            sum.wrapping_add((u16::from(*byte) + 1) * (index as u16 + 1) + index as u16)
        });
    (sum << 8) | (0x5a + (sum & 0xff))
}

// Layout and checksum rules: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/mario-kart-64/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let cups = [
        ("mushroom", 0x03),
        ("flower", 0x0c),
        ("star", 0x30),
        ("special", 0xc0),
    ];
    let fields = (0..4)
        .flat_map(|class| {
            cups.into_iter().map(move |(cup, mask)| {
                FieldDefinition::new(
                    format!("class_{}.{}_cup", class + 1, cup),
                    format!("Class {} {} Cup trophy", class + 1, cup),
                    0x180 + class,
                    Storage::U8,
                )
                .mask(mask)
                .max(3)
            })
        })
        .collect();
    let check = Check {
        when: None,
        assert: Condition::new(|bytes| {
            Ok(u16::from_be_bytes([bytes[0x186], bytes[0x187]]) == gp_checksum(bytes))
        }),
        code: "mario_kart_64_gp_checksum".into(),
        message: "the Mario GP checksum is invalid".into(),
        section_id: None,
        warning: None,
    };
    let game = GameDefinition {
        fields,
        description: "Edits Mario GP cup trophies in normalized 16 Kbit EEPROM. Requires a game-made template.".into(),
        runtime: runtime::Runtime { require_selection: true, recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: false }), checks: vec![check], after_edit: vec![Store { when: None, destination: Scalar { offset: 0x186, storage: Storage::U16Be, mask: None }, value: ReadValue::new(|bytes| Ok(i64::from(gp_checksum(bytes)))) }], save_format: Some("n64_eeprom_16k".into()), save_format_name: Some("Nintendo 64 EEPROM 16 Kbit".into()), ..Default::default() },
        ..GameDefinition::new("mario-kart-64".into(), "Mario Kart 64".into(), "nintendo-64".into(), 2048)
    };
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0x42; 2048];
        let sum = gp_checksum(&bytes);
        bytes[0x186..0x188].copy_from_slice(&sum.to_be_bytes());
        SaveDetectionInput {
            bytes,
            selected_game: Some("mario-kart-64".into()),
            rom_sha1: None,
        }
    }
    #[test]
    fn edit_repairs_gp_checksum_and_preserves_other_records() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "class_1.special_cup".into(),
                    value: SaveValue::U32(3),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(bytes[0x180] >> 6, 3);
        assert_eq!(
            u16::from_be_bytes([bytes[0x186], bytes[0x187]]),
            gp_checksum(&bytes)
        );
        assert_eq!(&bytes[..0x180], &original.bytes[..0x180]);
        assert_eq!(&bytes[0x188..], &original.bytes[0x188..]);
        assert!(
            handler
                .apply(&original, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input();
        bad.bytes[0x181] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }
}
