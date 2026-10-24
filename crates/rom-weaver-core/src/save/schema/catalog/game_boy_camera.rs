use super::*;

// Record fields and XOR/sum checksums: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/game-boy-camera/saveEditor (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut game = GameDefinition::new(
        "game-boy-camera".into(),
        "Game Boy Camera".into(),
        "game-boy".into(),
        0x20000,
    );
    game.description = "Edits packed-BCD record counts and Space Fever II/Ball high scores in raw 128 KiB Europe/USA/Japan SRAM saves. Validates the records, user metadata, and all 30 photo-metadata XOR/sum checksums; photos and metadata remain unchanged. Dates, names, Run! Run! Run! encoding, wrappers, and fresh generation are omitted.".into();
    game.signatures = vec![SignatureDefinition {
        offset: 0x10d2,
        bytes: b"Magic".to_vec(),
    }];
    for (offset, length, id, label) in [
        (0x10bb, 2, "shots", "Shots"),
        (0x10bd, 2, "deleted", "Deleted photographs"),
        (0x10bf, 2, "transfers", "Transfers"),
        (0x10c1, 2, "prints", "Prints"),
        (0x10c3, 1, "received_male", "Received male"),
        (0x10c4, 1, "received_female", "Received female"),
        (
            0x10c5,
            4,
            "space_fever_ii_score",
            "Space Fever II high score",
        ),
        (0x10c9, 2, "ball_score", "Ball high score"),
    ] {
        game.fields.push(
            FieldDefinition::new(
                format!("records.{id}"),
                label.into(),
                offset,
                Storage::BcdLe,
            )
            .length(length),
        );
    }
    integrity(&mut game, 0, 0x10d2, 0x10d7);
    integrity(&mut game, 0x2fb8, 0x2fca, 0x2fcf);
    for photo in 0..30 {
        let base = photo * 0x1000;
        integrity(&mut game, base + 0x2f00, base + 0x2f55, base + 0x2f5a);
    }
    build(vec![game], BTreeMap::new(), true)
}

fn integrity(game: &mut GameDefinition, start: usize, end: usize, offset: usize) {
    for (target, algorithm, seed) in [
        (offset, ChecksumAlgorithm::Add8, 0x2f),
        (offset + 1, ChecksumAlgorithm::Xor8, 0x15),
    ] {
        game.checksums.push(ChecksumDefinition {
            start: Some(start),
            length: Some(end - start),
            target: Some(seed),
            ..ChecksumDefinition::new(algorithm, target)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8]) {
        let ranges = [(0, 0x10d2, 0x10d7), (0x2fb8, 0x2fca, 0x2fcf)]
            .into_iter()
            .chain((0..30).map(|photo| {
                (
                    photo * 0x1000 + 0x2f00,
                    photo * 0x1000 + 0x2f55,
                    photo * 0x1000 + 0x2f5a,
                )
            }));
        for (start, end, checksum) in ranges {
            let mut high = 0x15u8;
            let mut low = 0x2fu8;
            for byte in &bytes[start..end] {
                high ^= *byte;
                low = low.wrapping_add(*byte);
            }
            bytes[checksum..checksum + 2].copy_from_slice(&[low, high]);
        }
    }

    #[test]
    fn bcd_record_exact_xor_sum_footprint_and_photo_preservation() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0; 0x20000];
        bytes[0x10d2..0x10d7].copy_from_slice(b"Magic");
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edits = [SaveEdit {
            field: "records.shots".into(),
            value: SaveValue::U32(1234),
        }];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        expected[0x10bb..0x10bd].copy_from_slice(&[0x34, 0x12]);
        repair(&mut expected);
        assert_eq!(out, expected);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let noop = SaveDetectionInput {
            bytes: out,
            ..input.clone()
        };
        assert!(
            handler
                .apply(&noop, &identity, &edits, false)
                .unwrap()
                .bytes
                .is_none()
        );
        for position in [0x10d2, 0x10d7, 0x10d8, 0x2fcf, 0x2f5a, 0x1ff5b] {
            let mut bad = input.clone();
            bad.bytes[position] ^= 1;
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
        for size in [0, 0x1ffff, 0x20001] {
            let bad = SaveDetectionInput {
                bytes: vec![0; size],
                ..input.clone()
            };
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
        let empty = SaveDetectionInput {
            bytes: vec![0; 0x20000],
            ..input
        };
        assert!(handler.apply(&empty, &identity, &edits, false).is_err());
    }
}
