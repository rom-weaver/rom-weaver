//! Rebuild a GD-ROM data track from a `.dcp` applied to a source track.
//!
//! This is the disc-producing half of DCP apply. It plans the rebuilt ISO9660
//! layout from file *sizes* (each patched file's size is read cheaply from its
//! VCDIFF header without decoding), then **streams** the raw `MODE1/2352` track
//! straight to a writer, producing each file's bytes on demand as it is written
//! and dropping them immediately. Nothing accumulates across files: the cooked
//! image, the raw track, and the full file set are never buffered. Peak memory
//! is one file's working set (its delta + source + decoded output) at a time -
//! it scales with the largest single file, not the disc or the patch.
//!
//! Reassembling the full disc (the low-density tracks + sheet, then optional
//! CHD) is the caller's job.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Seek, Write};

use crate::gdrom::{
    BOOT_AREA_SIZE, FileEntry, GdRomFs, IsoEntry, IsoTimestamp, plan_iso, write_track,
};
use rom_weaver_core::{Result, RomWeaverError};

use super::manifest::{DcpManifest, DcpOperation};
use super::zip::{ZipEntry, extract_entry, read_central_directory};

/// What a rebuild produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RebuildSummary {
    /// Number of files in the rebuilt filesystem.
    pub file_count: usize,
    /// Whether the patch replaced the IP.BIN boot area.
    pub boot_sector_replaced: bool,
}

fn size_to_u32(size: u64, path: &str) -> Result<u32> {
    u32::try_from(size).map_err(|_| {
        RomWeaverError::Validation(format!(
            "file `{path}` is {size} bytes, which exceeds the 4 GiB ISO9660 limit"
        ))
    })
}

/// Apply `dcp` to `source` and stream the rebuilt raw `MODE1/2352` data track
/// to `sink`. `timestamp` is stamped into the authored ISO9660 volume (pin it
/// for reproducible output).
pub fn rebuild_track_to_writer<D, T, W>(
    dcp: &mut D,
    source: &mut GdRomFs<T>,
    timestamp: IsoTimestamp,
    sink: &mut W,
) -> Result<RebuildSummary>
where
    D: Read + Seek,
    T: Read + Seek,
    W: Write,
{
    // 1. Classify the patch into per-target ZIP entries (metadata only - no
    //    bytes held).
    let manifest = DcpManifest::from_entries(&read_central_directory(dcp)?);
    let mut delta_by_key: BTreeMap<String, ZipEntry> = BTreeMap::new();
    let mut verbatim_by_key: BTreeMap<String, ZipEntry> = BTreeMap::new();
    let mut boot_entry: Option<ZipEntry> = None;
    for op in &manifest.operations {
        match op {
            DcpOperation::Delta { target, entry } => {
                delta_by_key.insert(target.to_ascii_uppercase(), entry.clone());
            }
            DcpOperation::Verbatim { path, entry } => {
                verbatim_by_key.insert(path.to_ascii_uppercase(), entry.clone());
            }
            DcpOperation::BootSector { entry } => boot_entry = Some(entry.clone()),
        }
    }

    // 2. Plan the layout from sizes: every source file (patched size where
    //    applicable, read from the delta header without decoding) plus any
    //    patch-added files not present on the source.
    let source_entries: Vec<_> = source.files().values().cloned().collect();
    let source_by_key: BTreeMap<String, FileEntry> = source_entries
        .iter()
        .map(|entry| (entry.path.to_ascii_uppercase(), entry.clone()))
        .collect();

    let mut entries: Vec<IsoEntry> =
        Vec::with_capacity(source_entries.len() + verbatim_by_key.len());
    let mut consumed: BTreeSet<String> = BTreeSet::new();
    for entry in &source_entries {
        let key = entry.path.to_ascii_uppercase();
        let size = if let Some(delta_entry) = delta_by_key.get(&key) {
            consumed.insert(key.clone());
            let delta = extract_entry(dcp, delta_entry)?;
            size_to_u32(
                rom_weaver_patches::xdelta::vcdiff_output_size(&delta)?,
                &entry.path,
            )?
        } else if let Some(verbatim_entry) = verbatim_by_key.get(&key) {
            consumed.insert(key.clone());
            verbatim_entry.uncompressed_size
        } else {
            entry.size
        };
        entries.push(IsoEntry {
            path: entry.path.clone(),
            size,
        });
    }
    for (key, entry) in &verbatim_by_key {
        if !consumed.contains(key) {
            entries.push(IsoEntry {
                path: key.clone(),
                size: entry.uncompressed_size,
            });
        }
    }
    // Every delta must target a file present on the disc.
    for key in delta_by_key.keys() {
        if !consumed.contains(key) {
            return Err(RomWeaverError::Validation(format!(
                "`.dcp` delta targets `{key}`, which is not present on the disc"
            )));
        }
    }
    let file_count = entries.len();

    // 3. Resolve the boot area (preserve the source's unless the patch replaces
    //    it; a replacement must be exactly the boot-area size).
    let boot_area = match &boot_entry {
        Some(entry) => {
            let bytes = extract_entry(dcp, entry)?;
            if bytes.len() != BOOT_AREA_SIZE {
                return Err(RomWeaverError::Validation(format!(
                    "`.dcp` boot sector is {} bytes; expected {BOOT_AREA_SIZE} (IP.BIN)",
                    bytes.len()
                )));
            }
            bytes
        }
        None => source.read_boot_area()?,
    };

    // 4. Plan, then stream. Each file's bytes are produced on demand and dropped
    //    immediately: a delta target is decoded against its freshly-read source,
    //    a verbatim entry is inflated, and an untouched file is read straight
    //    from the source track.
    let plan = plan_iso(&entries, source.start_lba(), timestamp)?;
    write_track(
        &plan,
        &boot_area,
        |file| {
            let key = file.path.to_ascii_uppercase();
            if let Some(delta_entry) = delta_by_key.get(&key) {
                let delta = extract_entry(dcp, delta_entry)?;
                let source_entry = source_by_key.get(&key).ok_or_else(|| {
                    RomWeaverError::Validation(format!("internal: lost delta source `{key}`"))
                })?;
                let source_bytes = source.read_file(source_entry)?;
                return rom_weaver_patches::xdelta::apply_patch_bytes(&source_bytes, &delta)
                    .map_err(|err| {
                        RomWeaverError::Validation(format!(
                            "failed to apply `.dcp` delta for `{}`: {err}",
                            file.path
                        ))
                    });
            }
            if let Some(verbatim_entry) = verbatim_by_key.get(&key) {
                return extract_entry(dcp, verbatim_entry);
            }
            let source_entry = source_by_key.get(&key).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "internal: rebuilt file `{}` has no source or patched bytes",
                    file.path
                ))
            })?;
            source.read_file(source_entry)
        },
        sink,
    )?;

    tracing::debug!(
        file_count,
        boot_sector_replaced = boot_entry.is_some(),
        "streamed rebuilt GD-ROM data track"
    );
    Ok(RebuildSummary {
        file_count,
        boot_sector_replaced: boot_entry.is_some(),
    })
}
