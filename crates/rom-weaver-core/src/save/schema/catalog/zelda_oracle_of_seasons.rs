use super::*;

// Layout: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/legend-of-zelda-the-oracle-of-seasons/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    super::zelda_oracle_of_ages::oracle_schema(
        "zelda-oracle-of-seasons",
        "The Legend of Zelda: Oracle of Seasons",
        b"Z11216-0",
        0x102,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seasons_signature_is_distinct_and_required() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0; 8192];
        for slot in 0..3 {
            let base = slot * 0x550;
            bytes[base + 0x12..base + 0x1a].copy_from_slice(b"Z11216-0");
            let sum = bytes[base + 0x12..base + 0x560]
                .chunks_exact(2)
                .fold(0u16, |sum, pair| {
                    sum.wrapping_add(u16::from_le_bytes([pair[0], pair[1]]))
                });
            bytes[base + 0x10..base + 0x12].copy_from_slice(&sum.to_le_bytes());
        }
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut ages = input.clone();
        ages.bytes[0x12..0x1a].copy_from_slice(b"Z21216-0");
        assert!(handler.apply(&ages, &identity, &[], false).is_err());
    }

    #[test]
    fn core_values_use_the_seasons_offsets_not_the_ages_ones() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0; 8192];
        for slot in 0..3 {
            let base = slot * 0x550;
            bytes[base + 0x12..base + 0x1a].copy_from_slice(b"Z11216-0");
        }
        let sum = bytes[0x12..0x560].chunks_exact(2).fold(0u16, |sum, pair| {
            sum.wrapping_add(u16::from_le_bytes([pair[0], pair[1]]))
        });
        bytes[0x10..0x12].copy_from_slice(&sum.to_le_bytes());
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edit = |field: &str, value| SaveEdit {
            field: field.into(),
            value: SaveValue::U32(value),
        };
        let out = handler
            .apply(
                &input,
                &identity,
                &[
                    edit("health", 12),
                    edit("max_health", 20),
                    edit("heart_pieces", 3),
                    edit("rupees_bcd", 999),
                ],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&out[0x102..0x108], &[12, 20, 3, 0x99, 0x09, 0]);
        assert_eq!(&out[0x10a..0x10e], &[0; 4]);
    }
}
