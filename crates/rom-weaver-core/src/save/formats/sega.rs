use super::SaveFormatDefinition;

const fn genesis(
    id: &'static str,
    display_name: &'static str,
    supported_sizes: &'static [usize],
) -> SaveFormatDefinition {
    SaveFormatDefinition {
        id,
        display_name,
        platform: "genesis",
        platform_name: "Sega Genesis and Mega Drive",
        supported_sizes,
        signature: None,
    }
}

const fn sms(
    id: &'static str,
    display_name: &'static str,
    supported_sizes: &'static [usize],
) -> SaveFormatDefinition {
    SaveFormatDefinition {
        id,
        display_name,
        platform: "master-system",
        platform_name: "Sega Master System and Game Gear",
        supported_sizes,
        signature: None,
    }
}

/// Genesis Plus GX reserves 64 KiB of cartridge SRAM and writes the whole
/// block, so a libretro `.srm` is 64 KiB even for an 8 KiB chip.
pub const FORMATS: &[SaveFormatDefinition] = &[
    genesis("genesis_sram_8k", "Cartridge SRAM 8 KiB", &[8 * 1024]),
    genesis("genesis_sram_32k", "Cartridge SRAM 32 KiB", &[32 * 1024]),
    genesis("genesis_sram_64k", "Cartridge SRAM 64 KiB", &[64 * 1024]),
    sms("sms_sram_8k", "Cartridge SRAM 8 KiB", &[8 * 1024]),
    sms("sms_sram_32k", "Cartridge SRAM 32 KiB", &[32 * 1024]),
];
