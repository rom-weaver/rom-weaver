use super::*;
use rules::{Check, Condition, ReadValue, Scalar, Store};
use std::sync::Arc;
use tracing::trace;

pub(super) const CARD_SIZE: usize = 0x20000;
pub(super) const BLOCK_SIZE: usize = 0x2000;

fn directory_xor(bytes: &[u8], block: usize) -> u8 {
    bytes[block * 0x80..block * 0x80 + 0x7f]
        .iter()
        .fold(0, |xor, value| xor ^ value)
}

/// Whether `blocks` contiguous ascending blocks from `first` form an initialized save of
/// `product`, as the card manager writes it to free space: a 0x51 frame with the file size, 0x52
/// frames, then a closing 0x53 frame (a lone file is a single 0x51 frame).
fn valid(bytes: &[u8], product: &str, first: usize, blocks: usize) -> bool {
    let last = first + blocks - 1;
    let start = first * 0x80;
    let base = first * BLOCK_SIZE;
    let header_xor = bytes[..0x7f].iter().fold(0, |xor, value| xor ^ value);
    let ok = bytes[..2] == *b"MC"
        && bytes[0x7f] == header_xor
        && (first..=last).all(|block| {
            let offset = block * 0x80;
            let mode = match block {
                _ if block == first => 0x51,
                _ if block == last => 0x53,
                _ => 0x52,
            };
            let link = if block == last {
                [0xff, 0xff]
            } else {
                (block as u16).to_le_bytes()
            };
            bytes[offset] == mode
                && bytes[offset + 8..offset + 10] == link
                && bytes[offset + 0x7f] == directory_xor(bytes, block)
        })
        && bytes[start + 4..start + 8] == ((blocks * BLOCK_SIZE) as u32).to_le_bytes()
        && bytes[start + 0xc..start + 0xc + product.len()] == *product.as_bytes()
        && (1..=15)
            .filter(|other| !(first..=last).contains(other))
            .all(|other| {
                let offset = other * 0x80;
                !matches!(bytes[offset], 0x51..=0x53)
                    || !(first - 1..last)
                        .any(|index| bytes[offset + 8..offset + 10] == (index as u16).to_le_bytes())
            })
        && bytes[base..base + 2] == *b"SC"
        && matches!(bytes[base + 2], 0x11..=0x13)
        // Multi-block saves skip the title frame's block count: the directory chain validates it,
        // and the upstream editor for the only such game never reads that byte.
        && (blocks > 1 || bytes[base + 3] == 1)
        && bytes[base + 0x200..base + blocks * BLOCK_SIZE]
            .iter()
            .any(|value| *value != 0 && *value != 0xff);
    trace!(first, blocks, ok, "checked PlayStation card directory");
    ok
}

// Directory fields MUST be checked before treating card blocks as a game payload. `product`
// MAY extend past the 10-byte product code into the rest of the directory file name.
// https://github.com/RyudoSynbios/game-tools-collection/blob/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/utils/common/playstation/memoryCard.ts
// Directory chain frames (0x51, 0x52, 0x53 with next-block links) follow the card format.
// https://psx-spx.consoledev.net/controllersandmemorycards/#memory-card-data-format
pub(super) fn definition(
    id: &str,
    title: &str,
    region: &str,
    product: &'static str,
    block: usize,
    blocks: usize,
    fields: Vec<FieldDefinition>,
) -> GameDefinition {
    let check = Check {
        when: None,
        assert: Condition::new(move |bytes| Ok(valid(bytes, product, block, blocks))),
        code: "playstation_card_directory".into(),
        message: if blocks == 1 {
            "selected block is not an initialized, single-block save for this game, or its card/directory checksum is invalid".into()
        } else {
            format!(
                "selected blocks are not an initialized {blocks}-block save for this game, or a card or directory checksum is invalid"
            )
        },
        section_id: None,
        warning: None,
    };
    let (location, requirement, blocks_title) = if blocks == 1 {
        (
            format!("allocated block {block}"),
            "game-made single-block template",
            format!("card block {block}"),
        )
    } else {
        (
            format!("the {blocks} contiguous allocated blocks starting at block {block}"),
            "game-made template",
            format!("card blocks {block}-{}", block + blocks - 1),
        )
    };
    GameDefinition {
        fields,
        description: format!(
            "Edits {title} {region} in {location} of a raw 128 KiB PlayStation memory card. Requires a {requirement}; preserves the directory and every other block."
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
            format!("{title} ({region}, {blocks_title})"),
            "playstation".into(),
            CARD_SIZE,
        )
    }
}

/// Where a game stores the checksum that guards its card blocks.
pub(super) struct Integrity<'a> {
    pub code: &'a str,
    pub message: &'a str,
    pub storage: Storage,
    /// Offsets of each stored copy, relative to the game's first block.
    pub offsets: &'a [usize],
    /// Bytes from the first block that `guard` and `checksum` read.
    pub span: usize,
}

/// Rejects saves whose stored checksum copies, or whose `guard`, disagree with `checksum`, and
/// rewrites every copy after an edit. `guard` and `checksum` receive the `span` bytes starting at
/// `base`.
pub(super) fn integrity(
    game: &mut GameDefinition,
    base: usize,
    spec: &Integrity,
    guard: impl Fn(&[u8]) -> bool + Send + Sync + 'static,
    checksum: impl Fn(&[u8]) -> u32 + Send + Sync + 'static,
) {
    let span = spec.span;
    let checksum = Arc::new(checksum);
    let destinations: Vec<Scalar> = spec
        .offsets
        .iter()
        .map(|offset| Scalar {
            offset: base + offset,
            storage: spec.storage,
            mask: None,
        })
        .collect();
    let check = Check {
        when: None,
        assert: Condition::new({
            let checksum = checksum.clone();
            let destinations = destinations.clone();
            move |bytes| {
                let block = &bytes[base..base + span];
                if !guard(block) {
                    return Ok(false);
                }
                let expected = i64::from(checksum(block));
                for destination in &destinations {
                    if destination.read(bytes)? != expected {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
        }),
        code: spec.code.into(),
        message: spec.message.into(),
        section_id: None,
        warning: None,
    };
    game.runtime.checks.push(check.clone());
    game.runtime
        .recognition
        .as_mut()
        .unwrap()
        .checks
        .push(check);
    for destination in destinations {
        let checksum = checksum.clone();
        let code = spec.code.to_owned();
        game.runtime.after_edit.push(Store {
            when: None,
            destination,
            value: ReadValue::new(move |bytes| {
                let value = checksum(&bytes[base..base + span]);
                trace!(code, value, "recomputed save checksum");
                Ok(i64::from(value))
            }),
        });
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
