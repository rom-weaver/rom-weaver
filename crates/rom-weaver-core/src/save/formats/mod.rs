mod gba_flash;
mod nintendo_ds;
mod raw_sram;

pub use gba_flash::GBA_FLASH_128K;
pub use nintendo_ds::NINTENDO_DS_512K;
pub use raw_sram::{GAME_BOY_SRAM_32K, SNES_SRAM_8K};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SaveFormatDefinition {
    pub id: &'static str,
    pub display_name: &'static str,
    pub supported_sizes: &'static [usize],
}

impl SaveFormatDefinition {
    pub fn accepts(self, bytes: &[u8]) -> bool {
        self.supported_sizes.contains(&bytes.len())
    }
}
