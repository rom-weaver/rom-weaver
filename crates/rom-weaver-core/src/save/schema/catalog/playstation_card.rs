use super::*;
use rules::{Check, Condition};

pub(super) const CARD_SIZE: usize = 0x20000;
pub(super) const BLOCK_SIZE: usize = 0x2000;

// Directory fields MUST be checked before treating a card block as a game payload.
// https://github.com/RyudoSynbios/game-tools-collection/blob/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/utils/common/playstation/memoryCard.ts
pub(super) fn definition(
    id: &str,
    title: &str,
    region: &str,
    product: &'static str,
    block: usize,
    fields: Vec<FieldDefinition>,
) -> GameDefinition {
    let directory = block * 0x80;
    let base = block * BLOCK_SIZE;
    let check = Check {
        when: None,
        assert: Condition::new(move |bytes| {
            let header_xor = bytes[..0x7f].iter().fold(0, |xor, value| xor ^ value);
            let directory_xor = bytes[directory..directory + 0x7f]
                .iter()
                .fold(0, |xor, value| xor ^ value);
            Ok(bytes[..2] == *b"MC"
                && bytes[0x7f] == header_xor
                && bytes[directory + 0x7f] == directory_xor
                && bytes[directory] == 0x51
                && bytes[directory + 4..directory + 8] == (BLOCK_SIZE as u32).to_le_bytes()
                && bytes[directory + 8..directory + 10] == [0xff, 0xff]
                && bytes[directory + 0xc..directory + 0x16] == *product.as_bytes()
                && (1..=15).filter(|other| *other != block).all(|other| {
                    let offset = other * 0x80;
                    !matches!(bytes[offset], 0x51..=0x53)
                        || bytes[offset + 8..offset + 10] != ((block - 1) as u16).to_le_bytes()
                })
                && bytes[base..base + 2] == *b"SC"
                && matches!(bytes[base + 2], 0x11..=0x13)
                && bytes[base + 3] == 1
                && bytes[base + 0x200..base + BLOCK_SIZE].iter().any(|value| *value != 0 && *value != 0xff))
        }),
        code: "playstation_card_directory".into(),
        message: "selected block is not an initialized, single-block save for this game, or its card/directory checksum is invalid".into(),
        section_id: None,
        warning: None,
    };
    GameDefinition {
        fields,
        description: format!(
            "Edits {title} {region} in allocated block {block} of a raw 128 KiB PlayStation memory card. Requires a game-made single-block template; preserves the directory and every other block."
        ),
        runtime: runtime::Runtime {
            checks: vec![check.clone()],
            recognition: Some(runtime::Recognition {
                checks: vec![check],
                reasons: vec![
                    SaveRecognitionReason::SignatureValid,
                    SaveRecognitionReason::ChecksumValid,
                ],
                confidence: SaveRecognitionConfidence::High,
                incomplete_confidence: None,
                selected_reason: true,
                empty_top_level_reasons: false,
            }),
            ..Default::default()
        },
        ..GameDefinition::new(
            format!("{id}-{region}-block-{block}"),
            format!("{title} ({region}, card block {block})"),
            "playstation".into(),
            CARD_SIZE,
        )
    }
}

#[cfg(test)]
pub(super) fn fixture(product: &str, block: usize) -> Vec<u8> {
    let mut bytes = vec![0xa5; CARD_SIZE];
    bytes[..0x80].fill(0);
    bytes[..2].copy_from_slice(b"MC");
    bytes[0x7f] = b'M' ^ b'C';
    let directory = block * 0x80;
    bytes[directory..directory + 0x80].fill(0);
    bytes[directory] = 0x51;
    bytes[directory + 4..directory + 8].copy_from_slice(&(BLOCK_SIZE as u32).to_le_bytes());
    bytes[directory + 8..directory + 10].fill(0xff);
    bytes[directory + 0xa..directory + 0xc].copy_from_slice(b"BA");
    bytes[directory + 0xc..directory + 0x16].copy_from_slice(product.as_bytes());
    bytes[directory + 0x7f] = bytes[directory..directory + 0x7f]
        .iter()
        .fold(0, |xor, value| xor ^ value);
    let base = block * BLOCK_SIZE;
    bytes[base..base + BLOCK_SIZE].fill(0);
    bytes[base..base + 4].copy_from_slice(&[b'S', b'C', 0x11, 1]);
    bytes[base + 0x200] = 1;
    bytes
}
