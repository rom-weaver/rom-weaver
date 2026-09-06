use super::SaveFormatDefinition;

pub const MEMORY_CARD_SIZE: usize = 128 * 1024;
const MEMORY_CARD_MAGIC: &[u8] = b"MC";

/// Frame 0 of a formatted memory card starts with the `MC` header id.
/// https://psx-spx.consoledev.net/controllersandmemorycards/#memory-card-data-format
fn is_memory_card(bytes: &[u8]) -> bool {
    bytes.starts_with(MEMORY_CARD_MAGIC)
}

/// A raw 15-block memory card image (`.mcr`, `.mcd`, libretro `.srm`).
/// DexDrive and VGS headers are stripped by the save container layer first.
pub const FORMATS: &[SaveFormatDefinition] = &[SaveFormatDefinition {
    id: "psx_memory_card_128k",
    display_name: "Memory card 128 KiB",
    platform: "psx",
    platform_name: "Sony PlayStation",
    supported_sizes: &[MEMORY_CARD_SIZE],
    signature: Some(is_memory_card),
}];
