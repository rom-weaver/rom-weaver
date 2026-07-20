//! Universal Dreamcast Patcher (`.dcp`) patch-format support.
//!
//! A `.dcp` is a ZIP archive of per-file xdelta/VCDIFF deltas (and verbatim new
//! files, and an optional replacement IP.BIN boot sector) applied inside a
//! Dreamcast GD-ROM's ISO9660 filesystem. This module owns the format knowledge:
//!
//! - [`zip`] - read the ZIP central directory (entry names + sizes).
//! - [`manifest`] - classify entries into typed [`DcpOperation`]s per the DCP
//!   naming convention.
//!
//! The orchestration that reads source files (via [`crate::gdrom`]), applies
//! deltas (via `rom-weaver-patches`'s `xdelta` module), and rebuilds the disc lives in the app
//! layer.

pub mod apply;
pub mod manifest;
pub mod rebuild;
pub mod zip;

pub use apply::{DcpApplySummary, DcpOutput, apply_dcp};
pub use manifest::{DcpManifest, DcpOperation};
pub use rebuild::{RebuildSummary, rebuild_track_to_writer};
pub use zip::{ZipEntry, extract_entry, read_central_directory};

use std::io::{Read, Seek};

use rom_weaver_core::Result;

/// Read a `.dcp` archive's central directory and classify it into a
/// [`DcpManifest`].
pub fn read_manifest<R: Read + Seek>(reader: &mut R) -> Result<DcpManifest> {
    let entries = read_central_directory(reader)?;
    Ok(DcpManifest::from_entries(&entries))
}

#[cfg(test)]
#[path = "tests/dcp.rs"]
mod tests;
