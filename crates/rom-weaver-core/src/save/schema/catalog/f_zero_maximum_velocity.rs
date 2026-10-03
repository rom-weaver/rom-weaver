use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

// Layout and checksum algorithms: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/f-zero-maximum-velocity/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    for slot in 0..3 {
        let base = 0x48b0 + slot * 0x330;
        let prefix = format!("slot_{}", slot + 1);
        fields.push(FieldDefinition::new(
            format!("{prefix}.championship_clear_count"),
            format!("Slot {} Championship clear count", slot + 1),
            base + 0x2e,
            Storage::U8,
        ));
        fields.push(
            FieldDefinition::new(
                format!("{prefix}.queen_class"),
                format!("Slot {} Queen Class unlocked", slot + 1),
                base + 0x17,
                Storage::Bit,
            )
            .bit(6),
        );
        fields.push(
            FieldDefinition::new(
                format!("{prefix}.championship"),
                format!("Slot {} Championship unlocked", slot + 1),
                base + 0x17,
                Storage::Bit,
            )
            .bit(7),
        );
        fields.push(
            FieldDefinition::new(
                format!("{prefix}.jet_vermilion"),
                format!("Slot {} Jet Vermilion unlocked", slot + 1),
                base + 0x17,
                Storage::Bit,
            )
            .bit(5),
        );
    }
    let ranges = [
        (0x4010, 0x48b0, 0x4008, 0x400c),
        (0x48c0, 0x4be0, 0x48b8, 0x48bc),
        (0x4bf0, 0x4f10, 0x4be8, 0x4bec),
        (0x4f20, 0x5240, 0x4f18, 0x4f1c),
    ];
    let mut checks = Vec::new();
    let mut stores = Vec::new();
    for (start, end, sum_offset, count_offset) in ranges {
        checks.push(check(
            sum_offset,
            move |bytes| sum_words(bytes, start, end),
            "sum",
        ));
        checks.push(check(
            count_offset,
            move |bytes| count_words(bytes, start, end),
            "count",
        ));
        stores.push(store(sum_offset, move |bytes| sum_words(bytes, start, end)));
        stores.push(store(count_offset, move |bytes| {
            count_words(bytes, start, end)
        }));
    }
    for (offset, starts) in [
        (0x7658, [0x4008, 0x48b8, 0x4be8, 0x4f18, 0x5248]),
        (0x765c, [0x400c, 0x48bc, 0x4bec, 0x4f1c, 0x524c]),
    ] {
        checks.push(check(
            offset,
            move |bytes| sparse_sum(bytes, starts),
            "summary",
        ));
        stores.push(store(offset, move |bytes| sparse_sum(bytes, starts)));
    }
    let mut game = GameDefinition { fields, description: "Edits unlocks and Championship clear counts in three save slots. Packed player names and race records are omitted.".into(), signatures: vec![SignatureDefinition { offset: 4, bytes: vec![0xe8, 0xb4, 0xa6, 0x19] }], ..GameDefinition::new("f-zero-maximum-velocity".into(), "F-Zero: Maximum Velocity".into(), "game-boy-advance".into(), 32768) };
    game.runtime.checks = checks.clone();
    game.runtime.recognition = Some(runtime::Recognition {
        checks,
        reasons: vec![
            SaveRecognitionReason::ChecksumValid,
            SaveRecognitionReason::SignatureValid,
        ],
        confidence: SaveRecognitionConfidence::High,
        incomplete_confidence: None,
        selected_reason: true,
        empty_top_level_reasons: false,
    });
    game.runtime.after_edit = stores;
    build(vec![game], BTreeMap::new(), true)
}

fn sum_words(bytes: &[u8], start: usize, end: usize) -> Result<i64> {
    Ok(i64::from(
        bytes[start..end].chunks_exact(4).fold(0u32, |sum, word| {
            sum.wrapping_add(u32::from_le_bytes(word.try_into().unwrap()))
        }),
    ))
}
fn count_words(bytes: &[u8], start: usize, end: usize) -> Result<i64> {
    Ok(bytes[start..end]
        .chunks_exact(4)
        .filter(|word| word.iter().any(|byte| *byte != 0))
        .count() as i64)
}
fn sparse_sum(bytes: &[u8], starts: [usize; 5]) -> Result<i64> {
    Ok(i64::from(starts.into_iter().fold(0u32, |sum, offset| {
        sum.wrapping_add(u32::from_le_bytes(
            bytes[offset..offset + 4].try_into().unwrap(),
        ))
    })))
}
fn check(
    offset: usize,
    expected: impl Fn(&[u8]) -> Result<i64> + Send + Sync + 'static,
    label: &str,
) -> Check {
    Check {
        when: None,
        assert: Condition::new(move |bytes| {
            Ok(i64::from(u32::from_le_bytes(
                bytes[offset..offset + 4].try_into().unwrap(),
            )) == expected(bytes)?)
        }),
        code: "save_checksum".into(),
        message: format!("the F-Zero {label} checksum is invalid"),
        section_id: None,
        warning: None,
    }
}
fn store(offset: usize, value: impl Fn(&[u8]) -> Result<i64> + Send + Sync + 'static) -> Store {
    Store {
        when: None,
        destination: Scalar {
            offset,
            storage: Storage::U32Le,
            mask: None,
        },
        value: ReadValue::new(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repair(bytes: &mut [u8]) {
        for (start, end, sum, count) in [
            (0x4010, 0x48b0, 0x4008, 0x400c),
            (0x48c0, 0x4be0, 0x48b8, 0x48bc),
            (0x4bf0, 0x4f10, 0x4be8, 0x4bec),
            (0x4f20, 0x5240, 0x4f18, 0x4f1c),
        ] {
            let a = sum_words(bytes, start, end).unwrap() as u32;
            let c = count_words(bytes, start, end).unwrap() as u32;
            bytes[sum..sum + 4].copy_from_slice(&a.to_le_bytes());
            bytes[count..count + 4].copy_from_slice(&c.to_le_bytes());
        }
        for (o, s) in [
            (0x7658, [0x4008, 0x48b8, 0x4be8, 0x4f18, 0x5248]),
            (0x765c, [0x400c, 0x48bc, 0x4bec, 0x4f1c, 0x524c]),
        ] {
            let v = sparse_sum(bytes, s).unwrap() as u32;
            bytes[o..o + 4].copy_from_slice(&v.to_le_bytes());
        }
    }
    #[test]
    fn repairs_word_sum_nonzero_count_and_summary_checksums() {
        let h = schemas().remove(0);
        let id = h.definitions().remove(0).identity;
        let mut bytes = vec![0; 32768];
        bytes[4..8].copy_from_slice(&[0xe8, 0xb4, 0xa6, 0x19]);
        bytes[0x4010..0x5240].fill(1);
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(id.id.clone()),
            rom_sha1: None,
        };
        let out = h
            .apply(
                &input,
                &id,
                &[SaveEdit {
                    field: "slot_2.championship_clear_count".into(),
                    value: SaveValue::U32(9),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(out[0x4c0e], 9);
        let mut expected = input.bytes.clone();
        expected[0x4c0e] = 9;
        repair(&mut expected);
        assert_eq!(out, expected);
        assert!(h.apply(&input, &id, &[], false).unwrap().bytes.is_none());
        let mut bad = input;
        bad.bytes[0x4008] ^= 1;
        let recognition = h.recognize(&bad);
        assert!(matches!(
            recognition.outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
        assert!(
            recognition
                .reasons
                .contains(&SaveRecognitionReason::ChecksumMismatch)
        );
        assert!(h.apply(&bad, &id, &[], false).is_err());
    }
}
