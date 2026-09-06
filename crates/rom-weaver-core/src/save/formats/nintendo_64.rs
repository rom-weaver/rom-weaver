use super::SaveFormatDefinition;

const fn n64(
    id: &'static str,
    display_name: &'static str,
    supported_sizes: &'static [usize],
) -> SaveFormatDefinition {
    SaveFormatDefinition {
        id,
        display_name,
        platform: "n64",
        platform_name: "Nintendo 64",
        supported_sizes,
        signature: None,
    }
}

/// Mupen64Plus-Next (libretro) stores every backup device in one `.srm`:
/// EEPROM, four Controller Paks, SRAM, then FlashRAM, in that order.
/// https://github.com/libretro/mupen64plus-libretro-nx/blob/develop/libretro/libretro.c
pub const MUPEN64PLUS_COMBINED_SIZE: usize = 0x800 + 4 * 0x8000 + 0x8000 + 0x20000;

pub const FORMATS: &[SaveFormatDefinition] = &[
    n64("n64_eeprom_512", "EEPROM 512 B (4 Kbit)", &[512]),
    n64("n64_eeprom_2k", "EEPROM 2 KiB (16 Kbit)", &[2 * 1024]),
    n64("n64_sram_32k", "SRAM 32 KiB", &[32 * 1024]),
    n64("n64_flashram_128k", "FlashRAM 128 KiB", &[128 * 1024]),
    n64(
        "n64_controller_pak_32k",
        "Controller Pak 32 KiB",
        &[32 * 1024],
    ),
    n64(
        "n64_mupen64plus_combined",
        "Mupen64Plus combined save 290 KiB",
        &[MUPEN64PLUS_COMBINED_SIZE],
    ),
];
