//! GD-ROM data-track filesystem: read the ISO9660 file tree out of a single
//! data track, honoring the GD-ROM's absolute-LBA bias.
//!
//! On a GD-ROM the high-density data track does not begin at LBA 0; its
//! ISO9660 volume records every extent location as an *absolute* disc LBA,
//! biased by the track's start LBA (45000 for the standard high-density area -
//! see [`GD_HIGH_DENSITY_START_LBA`]). The Primary Volume Descriptor still sits
//! at volume sector 16 (i.e. `start_lba + 16`), so the bias is the track's
//! start LBA: a file recorded at absolute LBA `L` lives at track-relative
//! logical sector `L - start_lba`.
//!
//! [`GdRomFs`] opens such a track, parses the directory tree once, and lets the
//! caller list files and read any file's bytes.

use std::collections::BTreeMap;
use std::io::{Read, Seek};

use rom_weaver_core::{Result, RomWeaverError};

use super::iso9660::{
    self, DirectoryRecord, FIRST_VOLUME_DESCRIPTOR_SECTOR, PrimaryVolumeDescriptor,
};
use super::sector::TrackSectors;

/// The start LBA of the standard GD-ROM high-density area, used as the default
/// extent bias when a data track is read on its own.
pub const GD_HIGH_DENSITY_START_LBA: u32 = 45000;

/// Number of logical sectors in the ISO9660 system area, which on a Dreamcast
/// data track holds the IP.BIN bootstrap.
pub const BOOT_AREA_SECTORS: u64 = 16;

/// Size in bytes of the IP.BIN boot area (16 logical sectors = 0x8000).
pub const BOOT_AREA_SIZE: usize = BOOT_AREA_SECTORS as usize * super::sector::LOGICAL_SECTOR_SIZE;

/// A located file within a GD-ROM data track's filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    /// Full `/`-separated path within the volume (no leading slash).
    pub path: String,
    /// Absolute extent LBA as recorded on the disc (biased by the track start).
    pub extent_lba: u32,
    /// File size in bytes.
    pub size: u32,
}

/// A read-only view of the ISO9660 filesystem on one GD-ROM data track.
pub struct GdRomFs<R> {
    sectors: TrackSectors<R>,
    /// Absolute-LBA bias: the track's start LBA. Subtracted from recorded
    /// extent LBAs to get track-relative logical sectors.
    start_lba: u32,
    pvd: PrimaryVolumeDescriptor,
    files: BTreeMap<String, FileEntry>,
}

/// Guard against a malformed disc pointing directories at each other and
/// causing unbounded recursion.
const MAX_DIRECTORY_DEPTH: usize = 32;

impl<R: Read + Seek> GdRomFs<R> {
    /// Open the data track in `reader`, detecting its physical sector format,
    /// and parse the ISO9660 tree using `start_lba` as the extent bias. For the
    /// standard GD high-density track pass [`GD_HIGH_DENSITY_START_LBA`].
    pub fn open(reader: R, start_lba: u32) -> Result<GdRomFs<R>> {
        let mut sectors = TrackSectors::open(reader)?;
        let pvd_data = read_logical_at(&mut sectors, FIRST_VOLUME_DESCRIPTOR_SECTOR)?;
        let pvd = iso9660::parse_primary_volume_descriptor(&pvd_data)?;
        tracing::debug!(
            start_lba,
            logical_block_size = pvd.logical_block_size,
            volume_space_size = pvd.volume_space_size,
            root_lba = pvd.root.extent_lba,
            "parsed GD-ROM PVD"
        );
        let mut fs = GdRomFs {
            sectors,
            start_lba,
            pvd,
            files: BTreeMap::new(),
        };
        fs.index_tree()?;
        Ok(fs)
    }

    /// The parsed Primary Volume Descriptor.
    pub fn primary_volume_descriptor(&self) -> &PrimaryVolumeDescriptor {
        &self.pvd
    }

    /// The track's extent bias (start LBA).
    pub fn start_lba(&self) -> u32 {
        self.start_lba
    }

    /// The detected physical sector format of the underlying track.
    pub fn sector_format(&self) -> super::sector::SectorFormat {
        self.sectors.format()
    }

    /// All files in the volume, keyed by their full `/`-separated path.
    pub fn files(&self) -> &BTreeMap<String, FileEntry> {
        &self.files
    }

    /// Look up one file by its full path.
    pub fn file(&self, path: &str) -> Option<&FileEntry> {
        self.files.get(path)
    }

    /// Look up one file by path, falling back to a case-insensitive match. The
    /// exact match is preferred; the fallback covers callers (such as `.dcp`
    /// targets) whose path casing may not match the ISO9660 identifiers.
    pub fn file_ignore_ascii_case(&self, path: &str) -> Option<&FileEntry> {
        if let Some(entry) = self.files.get(path) {
            return Some(entry);
        }
        self.files
            .values()
            .find(|entry| entry.path.eq_ignore_ascii_case(path))
    }

    /// Read the data track's IP.BIN boot area: the first
    /// [`BOOT_AREA_SECTORS`] logical sectors (the ISO9660 system area), which a
    /// rebuilt track must preserve unless the patch replaces it.
    pub fn read_boot_area(&mut self) -> Result<Vec<u8>> {
        self.sectors.read_logical_range(0, BOOT_AREA_SIZE as u64)
    }

    /// Read the full contents of `entry`.
    pub fn read_file(&mut self, entry: &FileEntry) -> Result<Vec<u8>> {
        let start_sector = self.track_relative_sector(entry.extent_lba)?;
        self.sectors
            .read_logical_range(start_sector, u64::from(entry.size))
    }

    /// Convert an absolute recorded LBA to a track-relative logical sector,
    /// erroring if it falls before the track start.
    fn track_relative_sector(&self, extent_lba: u32) -> Result<u64> {
        let relative = extent_lba.checked_sub(self.start_lba).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "ISO9660 extent LBA {extent_lba} is before the track start LBA {}",
                self.start_lba
            ))
        })?;
        Ok(u64::from(relative))
    }

    /// Read one directory extent's records.
    fn read_directory(&mut self, record: &DirectoryRecord) -> Result<Vec<DirectoryRecord>> {
        let start_sector = self.track_relative_sector(record.extent_lba)?;
        let data = self
            .sectors
            .read_logical_range(start_sector, u64::from(record.data_len))?;
        iso9660::parse_directory(&data)
    }

    /// Walk the directory tree from the root, populating `self.files`.
    fn index_tree(&mut self) -> Result<()> {
        let root = self.pvd.root.clone();
        let mut stack = vec![(root, String::new(), 0usize)];
        while let Some((dir, prefix, depth)) = stack.pop() {
            if depth > MAX_DIRECTORY_DEPTH {
                return Err(RomWeaverError::Validation(format!(
                    "ISO9660 directory nesting exceeds {MAX_DIRECTORY_DEPTH} levels at `{prefix}`"
                )));
            }
            for child in self.read_directory(&dir)? {
                let path = if prefix.is_empty() {
                    child.name.clone()
                } else {
                    format!("{prefix}/{}", child.name)
                };
                if child.is_dir {
                    stack.push((child, path, depth + 1));
                } else {
                    self.files.insert(
                        path.clone(),
                        FileEntry {
                            path,
                            extent_lba: child.extent_lba,
                            size: child.data_len,
                        },
                    );
                }
            }
        }
        tracing::debug!(files = self.files.len(), "indexed GD-ROM filesystem");
        Ok(())
    }
}

/// Read the 2048-byte logical sector `index` into an owned buffer.
fn read_logical_at<R: Read + Seek>(sectors: &mut TrackSectors<R>, index: u64) -> Result<Vec<u8>> {
    let mut buf = [0u8; super::sector::LOGICAL_SECTOR_SIZE];
    sectors.read_logical(index, &mut buf)?;
    Ok(buf.to_vec())
}
