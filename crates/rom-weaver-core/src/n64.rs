//! Nintendo 64 ROM byte orders: magic bytes, stable ids, detection, and word transforms.

use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript-types")]
use ts_rs::TS;

pub const N64_BIG_ENDIAN_MAGIC: [u8; 4] = [0x80, 0x37, 0x12, 0x40];
pub const N64_LITTLE_ENDIAN_MAGIC: [u8; 4] = [0x40, 0x12, 0x37, 0x80];
pub const N64_BYTE_SWAPPED_MAGIC: [u8; 4] = [0x37, 0x80, 0x40, 0x12];

/// Physical byte order of an N64 ROM image (`.z64`, `.n64`, `.v64`).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum N64ByteOrder {
    BigEndian,
    LittleEndian,
    ByteSwapped,
}

impl N64ByteOrder {
    pub const ALL: [Self; 3] = [Self::BigEndian, Self::LittleEndian, Self::ByteSwapped];

    /// Stable kebab-case id (matches the serde and TypeScript value).
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::BigEndian => "big-endian",
            Self::LittleEndian => "little-endian",
            Self::ByteSwapped => "byte-swapped",
        }
    }

    /// The four bytes a valid N64 ROM starts with in this order.
    #[must_use]
    pub const fn magic(self) -> [u8; 4] {
        match self {
            Self::BigEndian => N64_BIG_ENDIAN_MAGIC,
            Self::LittleEndian => N64_LITTLE_ENDIAN_MAGIC,
            Self::ByteSwapped => N64_BYTE_SWAPPED_MAGIC,
        }
    }

    /// Detect the order from the first four bytes; `None` when too short or unknown.
    #[must_use]
    pub fn detect(prefix: &[u8]) -> Option<Self> {
        let magic = prefix.get(..4)?;
        Self::ALL.into_iter().find(|order| order.magic() == magic)
    }

    /// Convert one 4-byte word between this order and big-endian (an involution).
    pub fn transform_word(self, bytes: &mut [u8; 4]) {
        match self {
            Self::BigEndian => {}
            Self::LittleEndian => bytes.reverse(),
            Self::ByteSwapped => {
                bytes.swap(0, 1);
                bytes.swap(2, 3);
            }
        }
    }

    /// Read a 4-byte word stored in `bytes` (original on-disk order) as a
    /// big-endian value after normalizing for this byte order.
    #[must_use]
    pub fn word_normalized(self, mut bytes: [u8; 4]) -> u32 {
        self.transform_word(&mut bytes);
        u32::from_be_bytes(bytes)
    }

    /// Re-encode a big-endian value into this byte order's on-disk layout.
    #[must_use]
    pub fn word_original_order(self, value: u32) -> [u8; 4] {
        let mut bytes = value.to_be_bytes();
        self.transform_word(&mut bytes);
        bytes
    }
}
