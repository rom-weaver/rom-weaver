//! Minimal ISO9660 (ECMA-119) primary-descriptor *writer*.
//!
//! Authors a cooked (2048-byte logical sectors) ISO9660 image from a flat list
//! of files, deterministically: stable directory ordering, a pinnable
//! timestamp, and a configurable absolute-LBA bias so the recorded extents
//! match a GD-ROM high-density track (which begins at LBA 45000, not 0). This
//! is the write counterpart to [`super::iso9660`] and is what rebuilds a
//! patched GD-ROM data track.
//!
//! Scope mirrors the reader: a single Primary Volume Descriptor with 8.3
//! uppercase identifiers, directory records, and both path tables (L/M). No
//! Joliet, El Torito, or extended attributes. Layout after the volume
//! descriptors is: L-path table, M-path table, directory extents (path-table
//! order), then file data - each aligned to a logical sector.

use std::collections::BTreeMap;

use rom_weaver_core::{Result, RomWeaverError};

use super::sector::LOGICAL_SECTOR_SIZE;

const SECTOR: usize = LOGICAL_SECTOR_SIZE;
const ROOT_NAME: u8 = 0x00;
const PARENT_NAME: u8 = 0x01;
const FILE_FLAG_DIRECTORY: u8 = 0x02;
/// Logical sectors in the ISO9660 system area (the IP.BIN boot area on a
/// Dreamcast data track), overlaid from the boot area at stream time.
const SYSTEM_AREA_SECTORS: u32 = 16;

/// A file to place in the authored volume.
#[derive(Debug, Clone)]
pub struct IsoFile {
    /// `/`-separated path within the volume (no leading slash), e.g.
    /// `"COSCAP.BIN"` or `"data/R01.MLT"`.
    pub path: String,
    /// File contents.
    pub data: Vec<u8>,
}

/// A file's path and size, without its bytes - the input to [`plan_iso`]. The
/// streaming writer plans the whole layout from sizes alone, so file contents
/// never need to be buffered up front.
#[derive(Debug, Clone)]
pub struct IsoEntry {
    /// `/`-separated path within the volume (no leading slash).
    pub path: String,
    /// File size in bytes.
    pub size: u32,
}

/// A file placed at a concrete extent by [`plan_iso`].
#[derive(Debug, Clone)]
pub struct PlannedFile {
    /// Uppercase `/`-separated path within the volume.
    pub path: String,
    /// Track-relative starting logical sector (recorded LBA is `lba + start_lba`).
    pub lba: u32,
    /// File size in bytes.
    pub size: u32,
}

/// A fully planned ISO9660 layout: the rendered header region (system area,
/// volume descriptors, path tables, directory extents) plus the placement of
/// every file. File data is *not* included - it is streamed at write time.
pub struct IsoPlan {
    /// The extent bias (track start LBA).
    pub start_lba: u32,
    /// Total logical sectors in the volume.
    pub volume_space_size: u32,
    /// The header occupies logical sectors `[0, first_file_sector)`; files
    /// follow contiguously.
    pub first_file_sector: u32,
    /// Rendered header bytes (`first_file_sector * 2048`), system area zeroed.
    header: Vec<u8>,
    /// Files in ascending-LBA (write) order, contiguous from `first_file_sector`.
    pub files: Vec<PlannedFile>,
}

/// A fixed volume timestamp. Pinning it keeps output reproducible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IsoTimestamp {
    /// Full year (e.g. 2026).
    pub year: u16,
    /// Month 1-12.
    pub month: u8,
    /// Day 1-31.
    pub day: u8,
    /// Hour 0-23.
    pub hour: u8,
    /// Minute 0-59.
    pub minute: u8,
    /// Second 0-59.
    pub second: u8,
}

impl Default for IsoTimestamp {
    /// A fixed epoch (2000-01-01 00:00:00) for reproducible output.
    fn default() -> Self {
        IsoTimestamp {
            year: 2000,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        }
    }
}

fn both_endian_u16(value: u16) -> [u8; 4] {
    let le = value.to_le_bytes();
    let be = value.to_be_bytes();
    [le[0], le[1], be[0], be[1]]
}

fn both_endian_u32(value: u32) -> [u8; 8] {
    let le = value.to_le_bytes();
    let be = value.to_be_bytes();
    [le[0], le[1], le[2], le[3], be[0], be[1], be[2], be[3]]
}

/// Round `bytes` up to a whole number of logical sectors.
fn sectors_for(bytes: usize) -> u32 {
    (bytes.div_ceil(SECTOR)).max(1) as u32
}

fn checked_file_size(path: &str, size: usize) -> Result<u32> {
    u32::try_from(size).map_err(|_| {
        RomWeaverError::Validation(format!(
            "ISO9660 file `{path}` is {size} bytes and exceeds the 32-bit data length field"
        ))
    })
}

fn biased_lba(relative_lba: u32, start_lba: u32, field: &str) -> Result<u32> {
    relative_lba.checked_add(start_lba).ok_or_else(|| {
        RomWeaverError::Validation(format!(
            "ISO9660 {field} LBA {relative_lba} plus start LBA {start_lba} exceeds the 32-bit extent field"
        ))
    })
}

/// A node in the directory tree being authored.
#[derive(Default)]
struct DirNode {
    /// Child subdirectories by name (sorted).
    dirs: BTreeMap<String, DirNode>,
    /// Child files by name (sorted), value is an index into the file list.
    files: BTreeMap<String, usize>,
}

/// A directory record's on-disc length for an identifier of `name_len` bytes
/// (padded to even total length).
fn directory_record_len(name_len: usize) -> usize {
    let len = 33 + name_len;
    len + (len & 1)
}

fn checked_directory_record_len(name: &[u8]) -> Result<usize> {
    let record_len = directory_record_len(name.len());
    u8::try_from(name.len()).map_err(|_| {
        RomWeaverError::Validation(format!(
            "ISO9660 identifier is {} bytes and does not fit the one-byte identifier length",
            name.len()
        ))
    })?;
    u8::try_from(record_len).map_err(|_| {
        RomWeaverError::Validation(format!(
            "ISO9660 identifier is {} bytes and requires a {record_len}-byte directory record, which does not fit the one-byte record length",
            name.len()
        ))
    })?;
    Ok(record_len)
}

/// Encode one directory record. `name` is the raw identifier bytes
/// (`&[ROOT_NAME]`/`&[PARENT_NAME]` for the self/parent records, else an
/// uppercase file/dir identifier with any `;1` already included for files).
fn encode_directory_record(
    extent_lba: u32,
    data_len: u32,
    is_dir: bool,
    name: &[u8],
    timestamp: &IsoTimestamp,
) -> Result<Vec<u8>> {
    let record_len = checked_directory_record_len(name)?;
    let mut rec = vec![0u8; record_len];
    rec[0] = u8::try_from(record_len).expect("directory record length was validated");
    rec[2..10].copy_from_slice(&both_endian_u32(extent_lba));
    rec[10..18].copy_from_slice(&both_endian_u32(data_len));
    rec[18..25].copy_from_slice(&encode_directory_datetime(timestamp));
    rec[25] = if is_dir { FILE_FLAG_DIRECTORY } else { 0 };
    rec[28..32].copy_from_slice(&both_endian_u16(1)); // volume sequence number
    rec[32] = u8::try_from(name.len()).expect("directory identifier length was validated");
    rec[33..33 + name.len()].copy_from_slice(name);
    Ok(rec)
}

/// The 7-byte directory-record date/time form.
fn encode_directory_datetime(ts: &IsoTimestamp) -> [u8; 7] {
    [
        (ts.year.saturating_sub(1900)) as u8,
        ts.month,
        ts.day,
        ts.hour,
        ts.minute,
        ts.second,
        0, // GMT offset in 15-minute intervals
    ]
}

/// The 17-byte PVD date/time form (`YYYYMMDDHHMMSSCC` digits + GMT offset byte).
fn encode_volume_datetime(ts: &IsoTimestamp) -> [u8; 17] {
    let mut out = [0u8; 17];
    let digits = format!(
        "{:04}{:02}{:02}{:02}{:02}{:02}00",
        ts.year, ts.month, ts.day, ts.hour, ts.minute, ts.second
    );
    out[..16].copy_from_slice(&digits.as_bytes()[..16]);
    out[16] = 0; // GMT offset
    out
}

/// A directory assigned its on-disc location, used for both extent emission and
/// path-table generation. `path_index` is the 1-based path-table number;
/// `parent_index` is its parent's number (root's parent is itself, 1).
struct PlacedDir {
    name: Vec<u8>,
    lba: u32,
    size_sectors: u32,
    data_len: u32,
    path_index: u16,
    parent_index: u16,
    /// Child files: (identifier-with-version, lba, size).
    files: Vec<(Vec<u8>, u32, u32)>,
    /// Child dirs: (identifier, index into the placed-dir list).
    child_dirs: Vec<(Vec<u8>, usize)>,
}

/// Plan an ISO9660 layout from file paths and sizes alone. Renders the header
/// region (system area, volume descriptors, path tables, directory extents) and
/// places every file at a concrete extent, so the caller can stream file data
/// at write time without buffering the whole volume. Biases every recorded
/// extent LBA by `start_lba` and stamps `timestamp` throughout.
pub fn plan_iso(entries: &[IsoEntry], start_lba: u32, timestamp: IsoTimestamp) -> Result<IsoPlan> {
    let mut root = DirNode::default();
    for (index, entry) in entries.iter().enumerate() {
        insert_path(&mut root, &entry.path, index)?;
    }

    // Breadth-first walk assigns path-table numbers (root = 1) and flattens the
    // tree into `placed`, which we then lay out.
    let mut placed: Vec<PlacedDir> = Vec::new();
    flatten_tree(&root, &[ROOT_NAME], 1, 1, entries, &mut placed)?;

    // Path-table size depends only on directory names, not their extents. Use
    // one provisional render to lay out the tables and directories, then
    // render both endian variants again once directory LBAs are assigned.
    let path_table_size_bytes = encode_path_table(&placed, start_lba, false)?.len();
    let path_table_size = u32::try_from(path_table_size_bytes).map_err(|_| {
        RomWeaverError::Validation(format!(
            "ISO9660 path table is {} bytes and exceeds the 32-bit size field",
            path_table_size_bytes
        ))
    })?;

    // Layout: 16 VD, 17 terminator, 18 L-path, then M-path, then dirs, files.
    let l_path_sector = 18u32;
    let path_table_sectors = sectors_for(path_table_size_bytes);
    let m_path_sector = l_path_sector
        .checked_add(path_table_sectors)
        .ok_or_else(|| {
            RomWeaverError::Validation("ISO9660 path-table layout overflowed".to_string())
        })?;
    let mut next = m_path_sector
        .checked_add(path_table_sectors)
        .ok_or_else(|| {
            RomWeaverError::Validation("ISO9660 path-table layout overflowed".to_string())
        })?;

    for dir in &mut placed {
        dir.lba = next;
        dir.size_sectors = sectors_for(dir.data_len as usize);
        next = next.checked_add(dir.size_sectors).ok_or_else(|| {
            RomWeaverError::Validation("ISO9660 directory layout overflowed".to_string())
        })?;
    }
    let path_table = encode_path_table(&placed, start_lba, false)?;
    let path_table_be = encode_path_table(&placed, start_lba, true)?;
    debug_assert_eq!(path_table.len(), path_table_size_bytes);
    debug_assert_eq!(path_table_be.len(), path_table_size_bytes);
    let first_file_sector = next;

    // Assign file extents by walking placed dirs and their child files in
    // order, resolving each child file's index via its full path.
    let path_to_index: BTreeMap<String, usize> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| (e.path.to_ascii_uppercase(), i))
        .collect();
    let dir_paths = dir_full_paths(&placed);
    let mut files: Vec<PlannedFile> = Vec::with_capacity(entries.len());
    for (dir_idx, dir) in placed.iter_mut().enumerate() {
        for (ident, lba_slot, size) in &mut dir.files {
            let name = identifier_to_name(ident);
            let full = join_path(&dir_paths[dir_idx], &name);
            // Guard that the planned path corresponds to an input entry.
            path_to_index.get(full.as_str()).ok_or_else(|| {
                RomWeaverError::Validation(format!("internal: lost file `{full}` during layout"))
            })?;
            *lba_slot = next;
            files.push(PlannedFile {
                path: full,
                lba: next,
                size: *size,
            });
            next = next
                .checked_add(sectors_for(*size as usize))
                .ok_or_else(|| {
                    RomWeaverError::Validation("ISO9660 file layout overflowed".to_string())
                })?;
        }
    }
    let volume_space_size = next;
    let last_relative_lba = volume_space_size
        .checked_sub(1)
        .expect("ISO volume always contains its descriptor sectors");
    biased_lba(last_relative_lba, start_lba, "volume end")?;

    // Render the header region: sectors [0, first_file_sector).
    let mut header = vec![0u8; first_file_sector as usize * SECTOR];
    write_at(&mut header, l_path_sector, &path_table);
    write_at(&mut header, m_path_sector, &path_table_be);
    let root_lba = biased_lba(placed[0].lba, start_lba, "root directory")?;
    let root_data_len = placed[0].data_len;
    for dir_pos in 0..placed.len() {
        let extent = encode_directory_extent(&placed, dir_pos, start_lba, &timestamp)?;
        debug_assert_eq!(extent.len(), placed[dir_pos].size_sectors as usize * SECTOR);
        write_at(&mut header, placed[dir_pos].lba, &extent);
    }
    let l_path_lba = biased_lba(l_path_sector, start_lba, "little-endian path table")?;
    let m_path_lba = biased_lba(m_path_sector, start_lba, "big-endian path table")?;
    let pvd = encode_pvd(
        volume_space_size,
        path_table_size,
        l_path_lba,
        m_path_lba,
        root_lba,
        root_data_len,
        &timestamp,
    )?;
    write_at(&mut header, 16, &pvd);
    let mut term = vec![0u8; SECTOR];
    term[0] = 255;
    term[1..6].copy_from_slice(b"CD001");
    term[6] = 1;
    write_at(&mut header, 17, &term);

    tracing::debug!(
        files = files.len(),
        dirs = placed.len(),
        volume_space_size,
        first_file_sector,
        start_lba,
        "planned ISO9660 layout"
    );
    Ok(IsoPlan {
        start_lba,
        volume_space_size,
        first_file_sector,
        header,
        files,
    })
}

/// Build a cooked ISO9660 image from `files`, fully in memory. Convenience
/// wrapper over [`plan_iso`] for callers (and tests) that can hold the whole
/// image; the streaming [`write_track`] is preferred for large discs.
pub fn build_iso(files: &[IsoFile], start_lba: u32, timestamp: IsoTimestamp) -> Result<Vec<u8>> {
    let entries = files
        .iter()
        .map(|file| {
            Ok(IsoEntry {
                path: file.path.clone(),
                size: checked_file_size(&file.path, file.data.len())?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let plan = plan_iso(&entries, start_lba, timestamp)?;
    let by_path: BTreeMap<String, &[u8]> = files
        .iter()
        .map(|f| (f.path.to_ascii_uppercase(), f.data.as_slice()))
        .collect();

    let mut image = vec![0u8; plan.volume_space_size as usize * SECTOR];
    image[..plan.header.len()].copy_from_slice(&plan.header);
    for file in &plan.files {
        let data = by_path.get(&file.path).copied().ok_or_else(|| {
            RomWeaverError::Validation(format!("internal: lost file `{}` during build", file.path))
        })?;
        write_at(&mut image, file.lba, data);
    }
    Ok(image)
}

/// Stream a planned ISO9660 layout to `sink` as a raw `MODE1/2352` track,
/// re-encoding every cooked sector on the fly. `boot_area` (the IP.BIN system
/// area, [`super::filesystem::BOOT_AREA_SIZE`] bytes) overlays the first sectors;
/// `fetch` is called once per file, in write order, to supply its bytes. Memory
/// stays bounded by the header plus one file at a time - the cooked image and
/// raw track are never fully materialized.
pub fn write_track<W, F>(plan: &IsoPlan, boot_area: &[u8], mut fetch: F, sink: &mut W) -> Result<()>
where
    W: std::io::Write,
    F: FnMut(&PlannedFile) -> Result<Vec<u8>>,
{
    let boot_bytes = SYSTEM_AREA_SECTORS as usize * SECTOR;
    if boot_area.len() < boot_bytes {
        return Err(RomWeaverError::Validation(format!(
            "boot area is {} bytes; expected at least {boot_bytes}",
            boot_area.len()
        )));
    }

    let mut cooked = [0u8; SECTOR];
    let emit = |sink: &mut W, lba: u32, cooked: &[u8; SECTOR]| -> Result<()> {
        let raw = super::mode1::encode_mode1_sector(lba, cooked);
        sink.write_all(&raw)?;
        Ok(())
    };

    // Header region: system-area sectors come from the boot area, the rest from
    // the rendered header.
    for sector_index in 0..plan.first_file_sector {
        let src = if sector_index < SYSTEM_AREA_SECTORS {
            &boot_area[sector_index as usize * SECTOR..][..SECTOR]
        } else {
            &plan.header[sector_index as usize * SECTOR..][..SECTOR]
        };
        cooked.copy_from_slice(src);
        emit(
            sink,
            biased_lba(sector_index, plan.start_lba, "streamed header sector")?,
            &cooked,
        )?;
    }

    // File data, one file at a time. Emit exactly the planned number of
    // sectors (always at least one, so a zero-byte file still occupies its
    // reserved sector and the stream stays aligned with the recorded extents).
    for file in &plan.files {
        let data = fetch(file)?;
        let supplied_size = checked_file_size(&file.path, data.len())?;
        if supplied_size != file.size {
            return Err(RomWeaverError::Validation(format!(
                "file `{}` supplied {} bytes but layout planned {}",
                file.path,
                data.len(),
                file.size
            )));
        }
        let planned_sectors = sectors_for(data.len());
        let mut offset = 0usize;
        for i in 0..planned_sectors {
            cooked.fill(0);
            let take = (data.len() - offset).min(SECTOR);
            cooked[..take].copy_from_slice(&data[offset..offset + take]);
            let relative_lba = file.lba.checked_add(i).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "ISO9660 file `{}` relative sector overflowed",
                    file.path
                ))
            })?;
            emit(
                sink,
                biased_lba(relative_lba, plan.start_lba, "streamed file sector")?,
                &cooked,
            )?;
            offset += take;
        }
    }
    tracing::debug!(
        files = plan.files.len(),
        volume_space_size = plan.volume_space_size,
        "streamed raw MODE1/2352 track"
    );
    Ok(())
}

/// Insert a `/`-separated path into the directory tree.
fn insert_path(root: &mut DirNode, path: &str, file_index: usize) -> Result<()> {
    let mut components = path.split('/').filter(|c| !c.is_empty()).peekable();
    let mut node = root;
    while let Some(component) = components.next() {
        if components.peek().is_none() {
            // Leaf file.
            node.files
                .insert(component.to_ascii_uppercase(), file_index);
            return Ok(());
        }
        node = node.dirs.entry(component.to_ascii_uppercase()).or_default();
    }
    Err(RomWeaverError::Validation(format!(
        "cannot author an empty file path `{path}`"
    )))
}

/// Flatten the tree breadth-first into placed dirs, assigning path-table
/// numbers. Computes each dir's `data_len` from its records.
fn flatten_tree(
    root: &DirNode,
    root_name: &[u8],
    root_index: u16,
    root_parent: u16,
    entries: &[IsoEntry],
    placed: &mut Vec<PlacedDir>,
) -> Result<()> {
    // Queue holds (node, name, index, parent_index).
    let mut queue: std::collections::VecDeque<(&DirNode, Vec<u8>, u16, u16)> =
        std::collections::VecDeque::new();
    queue.push_back((root, root_name.to_vec(), root_index, root_parent));
    let mut next_index = u32::from(root_index) + 1;

    while let Some((node, name, index, parent)) = queue.pop_front() {
        // Reserve a slot; children indices are assigned as we enqueue them.
        let placed_slot = placed.len();
        placed.push(PlacedDir {
            name,
            lba: 0,
            size_sectors: 0,
            data_len: 0,
            path_index: index,
            parent_index: parent,
            files: Vec::new(),
            child_dirs: Vec::new(),
        });

        // Files (sorted by BTreeMap iteration).
        let mut file_children = Vec::new();
        for (fname, fidx) in &node.files {
            let ident = file_identifier(fname);
            file_children.push((ident, 0u32, entries[*fidx].size));
        }

        // Subdirectories: enqueue and record child links.
        let mut child_links = Vec::new();
        for (dname, child) in &node.dirs {
            let child_index = u16::try_from(next_index).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "ISO9660 directory count exceeds the {} entries addressable by the path table",
                    u16::MAX
                ))
            })?;
            next_index = next_index.checked_add(1).ok_or_else(|| {
                RomWeaverError::Validation("ISO9660 directory count overflowed".to_string())
            })?;
            child_links.push((dname.clone().into_bytes(), child_index));
            queue.push_back((child, dname.clone().into_bytes(), child_index, index));
        }

        // Compute directory data length: . , .. , then children (files+dirs),
        // honoring the no-straddle rule.
        let mut len = checked_directory_record_len(&[ROOT_NAME])? * 2; // . and ..
        let mut sector_pos = len;
        let add = |rl: usize, len: &mut usize, sector_pos: &mut usize| {
            if *sector_pos % SECTOR + rl > SECTOR {
                let pad = SECTOR - (*sector_pos % SECTOR);
                *len += pad;
                *sector_pos += pad;
            }
            *len += rl;
            *sector_pos += rl;
        };
        // ECMA-119 9.3: files and subdirectories share one record list sorted by
        // identifier bytes. Size math must walk that same order so the
        // no-straddle padding matches encode_directory_extent exactly.
        let mut record_idents: Vec<&[u8]> = Vec::new();
        for (ident, _, _) in &file_children {
            record_idents.push(ident);
        }
        for (dname, _) in &child_links {
            record_idents.push(dname);
        }
        record_idents.sort_unstable();
        for ident in &record_idents {
            add(
                checked_directory_record_len(ident)?,
                &mut len,
                &mut sector_pos,
            );
        }

        let slot = &mut placed[placed_slot];
        slot.files = file_children;
        // child_dirs store path-table index in the second field; resolve to
        // placed-list position later is unnecessary (we use path_index).
        slot.child_dirs = child_links
            .into_iter()
            .map(|(n, idx)| (n, idx as usize))
            .collect();
        // ECMA-119 requires a directory's recorded Data Length to be a whole
        // number of logical blocks; the on-disc extent already occupies whole
        // sectors, so only round the recorded field up to match.
        let padded_len = len.div_ceil(SECTOR).checked_mul(SECTOR).ok_or_else(|| {
            RomWeaverError::Validation("ISO9660 directory data length overflowed".to_string())
        })?;
        slot.data_len = u32::try_from(padded_len).map_err(|_| {
            RomWeaverError::Validation(format!(
                "ISO9660 directory data is {padded_len} bytes and exceeds the 32-bit data length field"
            ))
        })?;
    }
    Ok(())
}

/// Compute full `/`-separated paths for each placed dir (root = "").
fn dir_full_paths(placed: &[PlacedDir]) -> Vec<String> {
    // path_index is 1-based and assigned in BFS order, so a parent always
    // precedes its children; resolve iteratively.
    let mut paths = vec![String::new(); placed.len()];
    // Map path_index -> position in placed.
    let mut index_pos: BTreeMap<u16, usize> = BTreeMap::new();
    for (pos, dir) in placed.iter().enumerate() {
        index_pos.insert(dir.path_index, pos);
    }
    for (pos, dir) in placed.iter().enumerate() {
        if dir.path_index == dir.parent_index {
            paths[pos] = String::new(); // root
            continue;
        }
        let parent_pos = index_pos[&dir.parent_index];
        let name = String::from_utf8_lossy(&dir.name).into_owned();
        paths[pos] = join_path(&paths[parent_pos], &name);
    }
    paths
}

fn join_path(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// The file identifier as recorded on disc (uppercase + `;1` version suffix).
fn file_identifier(name: &str) -> Vec<u8> {
    format!("{name};1").into_bytes()
}

/// Strip the `;version` suffix from a recorded file identifier.
fn identifier_to_name(ident: &[u8]) -> String {
    let end = ident.iter().position(|&b| b == b';').unwrap_or(ident.len());
    String::from_utf8_lossy(&ident[..end]).into_owned()
}

/// Render a directory's full extent (`.`, `..`, then sorted child files and
/// subdirectories), padded to whole sectors, honoring the no-straddle rule.
/// `placed[dir_pos]` is the directory; child/parent locations are resolved from
/// `placed` by `path_index - 1`.
fn encode_directory_extent(
    placed: &[PlacedDir],
    dir_pos: usize,
    start_lba: u32,
    timestamp: &IsoTimestamp,
) -> Result<Vec<u8>> {
    let dir = &placed[dir_pos];
    let self_lba = biased_lba(dir.lba, start_lba, "directory")?;
    let parent = &placed[dir.parent_index as usize - 1];
    let parent_lba = biased_lba(parent.lba, start_lba, "parent directory")?;

    let mut buf = Vec::new();
    buf.extend(encode_directory_record(
        self_lba,
        dir.data_len,
        true,
        &[ROOT_NAME],
        timestamp,
    )?);
    buf.extend(encode_directory_record(
        parent_lba,
        parent.data_len,
        true,
        &[PARENT_NAME],
        timestamp,
    )?);

    let push = |buf: &mut Vec<u8>, rec: Vec<u8>| {
        if buf.len() % SECTOR + rec.len() > SECTOR {
            let pad = SECTOR - (buf.len() % SECTOR);
            buf.resize(buf.len() + pad, 0);
        }
        buf.extend(rec);
    };

    // ECMA-119 9.3: all child records (files and subdirectories) live in one
    // list sorted by identifier bytes, not two separate groups. flatten_tree's
    // size math walks this same order.
    let mut records: Vec<(&[u8], u32, u32, bool)> = Vec::new();
    for (ident, lba, size) in &dir.files {
        records.push((
            ident,
            biased_lba(*lba, start_lba, "file extent")?,
            *size,
            false,
        ));
    }
    for (name, child_path_index) in &dir.child_dirs {
        let child = &placed[*child_path_index - 1];
        records.push((
            name,
            biased_lba(child.lba, start_lba, "child directory")?,
            child.data_len,
            true,
        ));
    }
    records.sort_by(|a, b| a.0.cmp(b.0));
    for (ident, extent_lba, data_len, is_dir) in records {
        push(
            &mut buf,
            encode_directory_record(extent_lba, data_len, is_dir, ident, timestamp)?,
        );
    }
    let padded = buf.len().div_ceil(SECTOR) * SECTOR;
    buf.resize(padded, 0);
    Ok(buf)
}

/// Encode the path table (L = little-endian, M = big-endian) for all dirs.
fn encode_path_table(placed: &[PlacedDir], start_lba: u32, big_endian: bool) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for dir in placed {
        let name = &dir.name;
        let name_len = u8::try_from(name.len()).map_err(|_| {
            RomWeaverError::Validation(format!(
                "ISO9660 path-table identifier is {} bytes and does not fit the one-byte length field",
                name.len()
            ))
        })?;
        out.push(name_len);
        out.push(0); // extended attribute length
        let lba = biased_lba(dir.lba, start_lba, "path-table directory")?;
        if big_endian {
            out.extend_from_slice(&lba.to_be_bytes());
            out.extend_from_slice(&dir.parent_index.to_be_bytes());
        } else {
            out.extend_from_slice(&lba.to_le_bytes());
            out.extend_from_slice(&dir.parent_index.to_le_bytes());
        }
        out.extend_from_slice(name);
        if name.len() & 1 == 1 {
            out.push(0); // pad to even
        }
    }
    Ok(out)
}

/// Encode the Primary Volume Descriptor.
fn encode_pvd(
    volume_space_size: u32,
    path_table_size: u32,
    l_path_lba: u32,
    m_path_lba: u32,
    root_lba: u32,
    root_data_len: u32,
    timestamp: &IsoTimestamp,
) -> Result<Vec<u8>> {
    let mut pvd = vec![0u8; SECTOR];
    pvd[0] = 1; // primary
    pvd[1..6].copy_from_slice(b"CD001");
    pvd[6] = 1; // version
    // 8: unused; 8..40 system identifier (spaces); 40..72 volume identifier.
    pvd[8..72].fill(b' ');
    pvd[40..49].copy_from_slice(b"ROMWEAVER");
    pvd[80..88].copy_from_slice(&both_endian_u32(volume_space_size));
    pvd[120..124].copy_from_slice(&both_endian_u16(1)); // volume set size
    pvd[124..128].copy_from_slice(&both_endian_u16(1)); // volume sequence number
    pvd[128..132].copy_from_slice(&both_endian_u16(SECTOR as u16)); // logical block size
    pvd[132..140].copy_from_slice(&both_endian_u32(path_table_size));
    pvd[140..144].copy_from_slice(&l_path_lba.to_le_bytes()); // type-L path table
    // 144..148 optional L path table (0)
    pvd[148..152].copy_from_slice(&m_path_lba.to_be_bytes()); // type-M path table
    // 152..156 optional M path table (0)
    let root = encode_directory_record(root_lba, root_data_len, true, &[ROOT_NAME], timestamp)?;
    pvd[156..156 + root.len()].copy_from_slice(&root);
    // 190..318 volume set id, 318..446 publisher, etc.: spaces.
    pvd[190..813].fill(b' ');
    // Volume datetimes.
    pvd[813..830].copy_from_slice(&encode_volume_datetime(timestamp)); // creation
    pvd[830..847].copy_from_slice(&encode_volume_datetime(timestamp)); // modification
    pvd[847..864].fill(b'0'); // expiration: unspecified
    pvd[864..881].copy_from_slice(&encode_volume_datetime(timestamp)); // effective
    pvd[881] = 1; // file structure version
    Ok(pvd)
}

/// Copy `bytes` into `image` starting at logical sector `sector`.
fn write_at(image: &mut [u8], sector: u32, bytes: &[u8]) {
    let off = sector as usize * SECTOR;
    image[off..off + bytes.len()].copy_from_slice(bytes);
}

#[cfg(test)]
mod overflow_tests {
    use super::*;

    #[test]
    fn flatten_tree_rejects_directory_index_overflow() {
        let mut root = DirNode::default();
        root.dirs.insert("CHILD".to_string(), DirNode::default());

        let error = flatten_tree(
            &root,
            &[ROOT_NAME],
            u16::MAX,
            u16::MAX,
            &[],
            &mut Vec::new(),
        )
        .expect_err("child index must not wrap");

        assert!(error.to_string().contains("directory count exceeds"));
    }

    #[test]
    fn encode_path_table_rejects_identifier_length_overflow() {
        let placed = [PlacedDir {
            name: vec![b'A'; usize::from(u8::MAX) + 1],
            lba: 0,
            size_sectors: 1,
            data_len: SECTOR as u32,
            path_index: 1,
            parent_index: 1,
            files: Vec::new(),
            child_dirs: Vec::new(),
        }];

        let error = encode_path_table(&placed, 0, false)
            .expect_err("path-table identifier length must not wrap");

        assert!(error.to_string().contains("path-table identifier"));
    }

    #[cfg(target_pointer_width = "64")]
    #[test]
    fn file_size_rejects_values_above_iso9660_data_length_limit() {
        let oversized = usize::try_from(u64::from(u32::MAX) + 1).expect("64-bit usize");
        let error = checked_file_size("TOO-LARGE.BIN", oversized)
            .expect_err("ISO9660 file size must not wrap to u32");

        assert!(error.to_string().contains("32-bit data length"));
    }
}
