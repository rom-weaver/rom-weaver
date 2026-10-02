use super::*;

// Layout and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/donkey-kong-land/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    let mut signatures = Vec::new();
    let mut checksums = Vec::new();
    for slot in 0..3 {
        let base = 0xa00 + slot * 0x40;
        let p = format!("slot_{}", slot + 1);
        fields.push(FieldDefinition::new(
            format!("{p}.progression_level"),
            format!("Slot {} progression level", slot + 1),
            base + 6,
            Storage::U16Be,
        ));
        fields.push(FieldDefinition::new(
            format!("{p}.current_level"),
            format!("Slot {} current level", slot + 1),
            base + 0x1a,
            Storage::U16Be,
        ));
        for (key, label, off, max) in [
            ("hours", "hours", 0x1c, 99),
            ("minutes", "minutes", 0x1d, 59),
            ("seconds", "seconds", 0x1e, 59),
        ] {
            fields.push(
                FieldDefinition::new(
                    format!("{p}.{key}"),
                    format!("Slot {} playtime {label}", slot + 1),
                    base + off,
                    Storage::U8,
                )
                .min(0)
                .max(max),
            );
        }
        signatures.push(SignatureDefinition {
            offset: base,
            bytes: b"PFLOYD".to_vec(),
        });
        let exclude = vec![ChecksumExclusion {
            offset: base + 0x3e,
            length: 2,
        }];
        checksums.push(ChecksumDefinition {
            start: Some(base),
            length: Some(0x40),
            exclude: exclude.clone(),
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add8, base + 0x3e)
        });
        checksums.push(ChecksumDefinition {
            start: Some(base),
            length: Some(0x40),
            exclude,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor8, base + 0x3f)
        });
    }
    build(
        vec![GameDefinition {
            fields,
            description: "Edits progression and playtime in all three slots.".into(),
            signatures,
            checksums,
            ..GameDefinition::new(
                "donkey-kong-land".into(),
                "Donkey Kong Land".into(),
                "game-boy".into(),
                8192,
            )
        }],
        BTreeMap::new(),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repair(b: &mut [u8]) {
        for slot in 0..3 {
            let base = 0xa00 + slot * 0x40;
            let data = &b[base..base + 0x3e];
            let add = data.iter().fold(0u8, |s, v| s.wrapping_add(*v));
            let xor = data.iter().fold(0u8, |s, v| s ^ *v);
            b[base + 0x3e] = add;
            b[base + 0x3f] = xor;
        }
    }
    #[test]
    fn edits_slot_and_repairs_independent_sum_and_xor_bytes() {
        let h = schemas().remove(0);
        let id = h.definitions().remove(0).identity;
        let mut bytes = vec![0x35; 8192];
        for s in 0..3 {
            bytes[0xa00 + s * 0x40..0xa06 + s * 0x40].copy_from_slice(b"PFLOYD");
        }
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
                    field: "slot_3.minutes".into(),
                    value: SaveValue::U32(42),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(out[0xa9d], 42);
        let mut expected = input.bytes.clone();
        expected[0xa9d] = 42;
        repair(&mut expected);
        assert_eq!(out, expected);
        assert!(h.apply(&input, &id, &[], false).unwrap().bytes.is_none());
        let mut bad = input;
        bad.bytes[0xa3f] ^= 1;
        assert!(h.apply(&bad, &id, &[], false).is_err());
    }
}
