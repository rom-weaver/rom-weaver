use super::SaveFormatDefinition;

pub const GAME_BOY_SRAM_32K: SaveFormatDefinition = SaveFormatDefinition {
    id: "game_boy_sram_32k",
    display_name: "Battery SRAM 32 KiB",
    supported_sizes: &[32 * 1024],
};

pub const SNES_SRAM_8K: SaveFormatDefinition = SaveFormatDefinition {
    id: "snes_sram_8k",
    display_name: "Battery SRAM 8 KiB",
    supported_sizes: &[8 * 1024],
};
