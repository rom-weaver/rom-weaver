use super::SaveFormatDefinition;

pub const NINTENDO_DS_512K: SaveFormatDefinition = SaveFormatDefinition {
    id: "nintendo_ds_512k",
    display_name: "Nintendo DS save 512 KiB",
    supported_sizes: &[512 * 1024],
};
