use super::SaveFormatDefinition;

const fn gba(
    id: &'static str,
    display_name: &'static str,
    supported_sizes: &'static [usize],
) -> SaveFormatDefinition {
    SaveFormatDefinition {
        id,
        display_name,
        platform: "gba",
        platform_name: "Game Boy Advance",
        supported_sizes,
        signature: None,
    }
}

pub const GBA_FLASH_128K: SaveFormatDefinition =
    gba("gba_flash_128k", "Flash 128 KiB", &[128 * 1024]);

/// The five backup chip types the GBA cartridge library exposes, as mGBA and
/// VBA-M dump them: EEPROM (4 or 64 Kbit), SRAM, and 512 Kbit or 1 Mbit flash.
pub const FORMATS: &[SaveFormatDefinition] = &[
    gba("gba_eeprom_512", "EEPROM 512 B", &[512]),
    gba("gba_eeprom_8k", "EEPROM 8 KiB", &[8 * 1024]),
    gba("gba_sram_32k", "SRAM 32 KiB", &[32 * 1024]),
    gba("gba_flash_64k", "Flash 64 KiB", &[64 * 1024]),
    GBA_FLASH_128K,
];
