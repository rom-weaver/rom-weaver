use super::SaveFormatDefinition;

const fn nds(
    id: &'static str,
    display_name: &'static str,
    supported_sizes: &'static [usize],
) -> SaveFormatDefinition {
    SaveFormatDefinition {
        id,
        display_name,
        platform: "nds",
        platform_name: "Nintendo DS",
        supported_sizes,
        signature: None,
    }
}

pub const NINTENDO_DS_512K: SaveFormatDefinition = nds(
    "nintendo_ds_512k",
    "Nintendo DS save 512 KiB",
    &[512 * 1024],
);

/// Backup chip sizes melonDS and DeSmuME recognize: EEPROM (4 Kbit to 1 Mbit),
/// FRAM, and flash (2 Mbit to 256 Mbit).
pub const FORMATS: &[SaveFormatDefinition] = &[
    nds("nintendo_ds_512", "Nintendo DS save 512 B", &[512]),
    nds("nintendo_ds_8k", "Nintendo DS save 8 KiB", &[8 * 1024]),
    nds("nintendo_ds_64k", "Nintendo DS save 64 KiB", &[64 * 1024]),
    nds(
        "nintendo_ds_128k",
        "Nintendo DS save 128 KiB",
        &[128 * 1024],
    ),
    nds(
        "nintendo_ds_256k",
        "Nintendo DS save 256 KiB",
        &[256 * 1024],
    ),
    NINTENDO_DS_512K,
    nds("nintendo_ds_1m", "Nintendo DS save 1 MiB", &[1024 * 1024]),
    nds(
        "nintendo_ds_8m",
        "Nintendo DS save 8 MiB",
        &[8 * 1024 * 1024],
    ),
    nds(
        "nintendo_ds_32m",
        "Nintendo DS save 32 MiB",
        &[32 * 1024 * 1024],
    ),
];
