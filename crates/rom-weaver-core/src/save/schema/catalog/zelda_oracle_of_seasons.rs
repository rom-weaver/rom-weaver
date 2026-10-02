use super::*;

// Layout: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/legend-of-zelda-the-oracle-of-seasons/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    super::zelda_oracle_of_ages::oracle_schema(
        "zelda-oracle-of-seasons",
        "The Legend of Zelda: Oracle of Seasons",
        b"Z11216-0",
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
}
