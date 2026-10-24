use super::SaveFormatDefinition;

// BRAM size and header: https://github.com/libretro/beetle-pce-libretro/blob/b96c11e095b6a40a412d2da02766ae1c3f4fd539/mednafen/pce/huc.cpp
pub const FORMATS: &[SaveFormatDefinition] = &[SaveFormatDefinition {
    id: "pc_engine_bram_2k",
    display_name: "Backup RAM 2 KiB",
    platform: "pc-engine-cd",
    platform_name: "PC Engine / TurboGrafx-CD",
    supported_sizes: &[2048],
    signature: Some(|bytes| bytes.starts_with(b"HUBM")),
}];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bram_requires_both_size_and_header() {
        let mut bytes = vec![0; 2048];
        assert!(!FORMATS[0].matches(&bytes));
        bytes[..4].copy_from_slice(b"HUBM");
        assert!(FORMATS[0].matches(&bytes));
        bytes.pop();
        assert!(!FORMATS[0].matches(&bytes));
    }
}
