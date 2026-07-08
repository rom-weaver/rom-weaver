mod engine;
pub mod platform_detection;
pub mod rom_headers;
pub mod rom_identity;
mod variants;

pub use engine::*;
pub use rom_identity::{
    DETECT_PREFIX_BYTES, DiscFormat, IdentityPrefix, RomIdentity, detect_rom_identity,
    detect_rom_identity_for_path,
};
pub use variants::*;
