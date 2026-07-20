//! GD-ROM / CD data-track filesystem support for rom-weaver.
//!
//! Reads the ISO9660 filesystem out of a Dreamcast GD-ROM (or CD) data track,
//! handling raw `MODE1/2352` sector framing and the GD-ROM's absolute-LBA bias.
//! This is the read foundation the `.dcp` (Universal Dreamcast Patcher) apply
//! pipeline builds on: extract a source file by name, apply a per-file delta,
//! and (later) rebuild the track.
//!
//! - [`sector`] - detect a track's physical sector format and read cooked
//!   2048-byte logical sectors.
//! - [`iso9660`] - parse the Primary Volume Descriptor and directory records.
//! - [`gdrom`] - [`GdRomFs`], the file-tree view of a data track.
//! - [`iso_writer`] - author a cooked ISO9660 image from a file tree.
//! - [`mode1`] - re-encode cooked sectors into raw `MODE1/2352` for a rebuilt
//!   data track.

mod filesystem;
pub mod iso9660;
pub mod iso_writer;
pub mod mode1;
pub mod sector;

pub use filesystem::{BOOT_AREA_SIZE, FileEntry, GD_HIGH_DENSITY_START_LBA, GdRomFs};
pub use iso_writer::{
    IsoEntry, IsoFile, IsoPlan, IsoTimestamp, PlannedFile, build_iso, plan_iso, write_track,
};
pub use mode1::{RAW_SECTOR_SIZE, USER_DATA_SIZE, encode_mode1_sector};
pub use sector::{LOGICAL_SECTOR_SIZE, SectorFormat, TrackSectors};

#[cfg(test)]
#[path = "tests/gdrom.rs"]
mod tests;

#[cfg(test)]
#[path = "tests/mode1.rs"]
mod mode1_tests;

#[cfg(test)]
#[path = "tests/iso_writer.rs"]
mod iso_writer_tests;
