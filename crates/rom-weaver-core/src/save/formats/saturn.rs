use super::SaveFormatDefinition;

/// The BIOS formats internal backup RAM with this header repeated four times.
const BACKUP_RAM_HEADER: &[u8] = b"BackUpRam Format";

fn is_backup_ram(bytes: &[u8]) -> bool {
    bytes.starts_with(BACKUP_RAM_HEADER)
}

/// The internal RAM sits on the odd bytes of a 16-bit bus, so a bus-width
/// dump (Yabause, Mednafen) doubles the size and interleaves the header.
fn is_interleaved_backup_ram(bytes: &[u8]) -> bool {
    bytes.len() >= BACKUP_RAM_HEADER.len() * 2
        && bytes
            .iter()
            .skip(1)
            .step_by(2)
            .zip(BACKUP_RAM_HEADER)
            .all(|(actual, expected)| actual == expected)
}

pub const FORMATS: &[SaveFormatDefinition] = &[
    SaveFormatDefinition {
        id: "saturn_backup_ram_32k",
        display_name: "Internal backup RAM 32 KiB",
        platform: "saturn",
        platform_name: "Sega Saturn",
        supported_sizes: &[32 * 1024],
        signature: Some(is_backup_ram),
    },
    SaveFormatDefinition {
        id: "saturn_backup_ram_64k",
        display_name: "Internal backup RAM 64 KiB (16-bit dump)",
        platform: "saturn",
        platform_name: "Sega Saturn",
        supported_sizes: &[64 * 1024],
        signature: Some(is_interleaved_backup_ram),
    },
];
