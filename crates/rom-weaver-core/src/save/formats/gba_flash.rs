use super::SaveFormatDefinition;

pub const GBA_FLASH_128K: SaveFormatDefinition = SaveFormatDefinition {
    id: "gba_flash_128k",
    display_name: "Flash 128 KiB",
    supported_sizes: &[128 * 1024],
};
