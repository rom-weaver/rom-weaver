use super::SaveFormatDefinition;

const fn sram(
    id: &'static str,
    display_name: &'static str,
    supported_sizes: &'static [usize],
) -> SaveFormatDefinition {
    SaveFormatDefinition {
        id,
        display_name,
        platform: "snes",
        platform_name: "Super Nintendo",
        supported_sizes,
        signature: None,
    }
}

pub const SNES_SRAM_8K: SaveFormatDefinition =
    sram("snes_sram_8k", "Battery SRAM 8 KiB", &[8 * 1024]);

/// Cartridge SRAM sizes from the ROM header RAM-size byte (16 Kbit to 1 Mbit).
pub const FORMATS: &[SaveFormatDefinition] = &[
    sram("snes_sram_2k", "Battery SRAM 2 KiB", &[2 * 1024]),
    SNES_SRAM_8K,
    sram("snes_sram_32k", "Battery SRAM 32 KiB", &[32 * 1024]),
    sram("snes_sram_64k", "Battery SRAM 64 KiB", &[64 * 1024]),
    sram("snes_sram_128k", "Battery SRAM 128 KiB", &[128 * 1024]),
];
