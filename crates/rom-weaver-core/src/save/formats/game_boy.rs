use super::SaveFormatDefinition;

const fn sram(
    id: &'static str,
    display_name: &'static str,
    supported_sizes: &'static [usize],
) -> SaveFormatDefinition {
    SaveFormatDefinition {
        id,
        display_name,
        platform: "game-boy",
        platform_name: "Game Boy and Game Boy Color",
        supported_sizes,
        signature: None,
    }
}

pub const GAME_BOY_SRAM_32K: SaveFormatDefinition =
    sram("game_boy_sram_32k", "Battery SRAM 32 KiB", &[32 * 1024]);

/// Cartridge RAM sizes from the cartridge header RAM-size byte, plus the
/// MBC2 built-in 512 x 4-bit RAM that emulators dump as 512 bytes.
pub const FORMATS: &[SaveFormatDefinition] = &[
    sram("game_boy_sram_512", "Battery SRAM 512 B (MBC2)", &[512]),
    sram("game_boy_sram_2k", "Battery SRAM 2 KiB", &[2 * 1024]),
    sram("game_boy_sram_8k", "Battery SRAM 8 KiB", &[8 * 1024]),
    GAME_BOY_SRAM_32K,
    sram("game_boy_sram_128k", "Battery SRAM 128 KiB", &[128 * 1024]),
];
