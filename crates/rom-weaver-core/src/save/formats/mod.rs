mod gba_flash;

pub use gba_flash::GBA_FLASH_128K;

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
