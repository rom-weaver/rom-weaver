use super::playstation_card::{self, BLOCK_SIZE};
use super::*;

// Fields MUST follow the pinned PlayStation layouts; the Windows port is not supported.
// The game keeps no checksum or mirrored copy in these fields, so only the card allocation
// metadata is validated.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/resident-evil/saveEditor
const RELEASES: [(&str, &str, u32); 10] = [
    ("europe", "SLES-00200", 50),
    ("directorscut-europe", "SLES-00969", 50),
    ("usa", "SLUS-00170", 60),
    ("directorscut-usa", "SLUS-00551", 60),
    ("japan", "SLPS-00222", 60),
    ("directorscut-japan", "SLPS-00998", 60),
    ("france", "SLES-00227", 50),
    ("directorscut-france", "SLES-00970", 50),
    ("germany", "SLES-00228", 50),
    ("directorscut-germany", "SLES-00971", 50),
];

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for block in 1..=15 {
        let base = block * BLOCK_SIZE;
        for (region, product, ticks_per_second) in RELEASES {
            let fields = vec![
                catalog_field("health", "Health", base + 0x21e, Storage::U16Le)
                    .min(0)
                    .max(140),
                catalog_field(
                    "ink_ribbons_used",
                    "Ink ribbons used",
                    base + 0x228,
                    Storage::U8,
                )
                .min(0)
                .max(99),
                catalog_field(
                    "playtime_ticks",
                    "Playtime ticks",
                    base + 0x224,
                    Storage::U32Le,
                )
                .min(0)
                .max(360_000 * i64::from(ticks_per_second) - 1)
                .description(
                    format!("The game counts {ticks_per_second} ticks per second in this release; the maximum is 99 hours 59 minutes 59 seconds."),
                ),
                catalog_field("poisoned", "Poisoned", base + 0x232, Storage::Bit).bit(1),
                catalog_field("com_radio", "Com. Radio", base + 0x2ac, Storage::Bit).bit(0),
                catalog_field(
                    "unlimited_rocket_launcher",
                    "Unlimited rocket launcher",
                    base + 0x2ac,
                    Storage::Bit,
                )
                .bit(1),
                catalog_field(
                    "alternative_outfit",
                    "Alternative outfit",
                    base + 0x2a6,
                    Storage::Bit,
                )
                .bit(5),
            ];
            games.push(playstation_card::definition(
                "resident-evil",
                "Resident Evil",
                region,
                product,
                block,
                fields,
            ));
        }
    }
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handler(id: &str) -> SchemaSaveHandler {
        schemas()
            .into_iter()
            .find(|handler| handler.definitions()[0].identity.id == id)
            .unwrap()
    }

    // Every payload byte is distinct so a write to a wrong offset changes the comparison.
    fn fixture(product: &str, block: usize) -> Vec<u8> {
        let mut bytes = playstation_card::fixture(product, block);
        let base = block * BLOCK_SIZE;
        for offset in 0x200..BLOCK_SIZE {
            bytes[base + offset] = (offset * 29 + 7) as u8;
        }
        bytes
    }

    fn apply(id: &str, bytes: &[u8], edits: &[SaveEdit]) -> crate::Result<Vec<u8>> {
        let handler = handler(id);
        let identity = handler.definitions()[0].identity.clone();
        handler
            .apply(
                &SaveDetectionInput {
                    bytes: bytes.to_vec(),
                    selected_game: Some(id.into()),
                    rom_sha1: None,
                },
                &identity,
                edits,
                false,
            )
            .map(|result| result.bytes.unwrap_or_else(|| bytes.to_vec()))
    }

    fn edit(field: &str, value: u32) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value: SaveValue::U32(value),
        }
    }

    fn flag(field: &str, value: bool) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value: SaveValue::Bool(value),
        }
    }

    #[test]
    fn edits_only_the_selected_fields_in_every_release() {
        for (region, product, ticks) in RELEASES {
            let id = format!("resident-evil-{region}-block-9");
            let input = fixture(product, 9);
            let base = 9 * BLOCK_SIZE;
            let output = apply(
                &id,
                &input,
                &[
                    edit("health", 140),
                    edit("ink_ribbons_used", 99),
                    edit("playtime_ticks", 360_000 * ticks - 1),
                    flag("poisoned", true),
                    flag("com_radio", true),
                    flag("unlimited_rocket_launcher", false),
                    flag("alternative_outfit", true),
                ],
            )
            .unwrap();
            assert_eq!(&output[base + 0x21e..base + 0x220], &140u16.to_le_bytes());
            assert_eq!(output[base + 0x228], 99);
            assert_eq!(
                &output[base + 0x224..base + 0x228],
                &(360_000 * ticks - 1).to_le_bytes()
            );
            assert_eq!(output[base + 0x232], input[base + 0x232] | 0b10);
            assert_eq!(output[base + 0x2ac], input[base + 0x2ac] & !0b10 | 0b01);
            assert_eq!(output[base + 0x2a6], input[base + 0x2a6] | 0b10_0000);
            let changed = [
                0x21e..0x220,
                0x224..0x229,
                0x232..0x233,
                0x2a6..0x2a7,
                0x2ac..0x2ad,
            ];
            for (index, (&after, &before)) in output.iter().zip(&input).enumerate() {
                if !changed
                    .iter()
                    .any(|range| range.contains(&index.wrapping_sub(base)))
                {
                    assert_eq!(after, before, "{id} at {index:x}");
                }
            }
            assert_eq!(apply(&id, &output, &[]).unwrap(), output);
        }
    }

    #[test]
    fn limits_are_enforced_and_card_damage_is_rejected() {
        let id = "resident-evil-usa-block-9";
        let input = fixture("SLUS-00170", 9);
        assert!(apply(id, &input, &[edit("health", 141)]).is_err());
        assert!(apply(id, &input, &[edit("ink_ribbons_used", 100)]).is_err());
        assert!(apply(id, &input, &[edit("playtime_ticks", 360_000 * 60)]).is_err());
        let europe = fixture("SLES-00200", 9);
        assert!(
            apply(
                "resident-evil-europe-block-9",
                &europe,
                &[edit("playtime_ticks", 360_000 * 50)]
            )
            .is_err()
        );
        assert!(
            apply(
                "resident-evil-europe-block-9",
                &europe,
                &[edit("playtime_ticks", 360_000 * 50 - 1)]
            )
            .is_ok()
        );
        assert!(apply(id, &fixture("SLUS-00551", 9), &[]).is_err());
        let mut damaged = input.clone();
        damaged[9 * 0x80] ^= 0x01;
        assert!(apply(id, &damaged, &[]).is_err());
        let mut short = input;
        short.pop();
        assert!(apply(id, &short, &[]).is_err());
    }
}
