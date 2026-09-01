pub mod artifact_match;
mod engine;
pub mod identify_catalog;
pub mod identify_pack;
pub mod identify_pack_types;
pub mod identify_pack_v1;
pub mod platform_detection;
pub mod rom_headers;
pub mod rom_identity;
mod variants;

// One owner for the shared test subscriber: `#[path]`-including it from each test
// module instead would compile the same file several times over (clippy::duplicate_mod).
#[cfg(test)]
#[path = "../tests/unit/trace_capture.rs"]
pub(crate) mod trace_capture;

pub use engine::*;
pub use rom_identity::{
    DETECT_PREFIX_BYTES, DiscFormat, IdentityPrefix, RomIdentity, detect_rom_identity,
    detect_rom_identity_for_path,
};
pub use variants::*;
