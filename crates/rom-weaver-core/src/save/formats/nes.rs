use super::SaveFormatDefinition;

/// Battery-backed WRAM at $6000-$7FFF, the one size FCEUmm writes.
pub const FORMATS: &[SaveFormatDefinition] = &[SaveFormatDefinition {
    id: "nes_sram_8k",
    display_name: "Battery WRAM 8 KiB",
    platform: "nes",
    platform_name: "Nintendo Entertainment System",
    supported_sizes: &[8 * 1024],
    signature: None,
}];
