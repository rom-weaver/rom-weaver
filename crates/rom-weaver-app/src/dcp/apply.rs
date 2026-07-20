//! Apply a `.dcp` patch against a GD-ROM data track's filesystem.
//!
//! This drives the per-file half of DCP apply: for each manifest operation it
//! produces the resulting bytes - a delta applied to its source file, a
//! verbatim new file, or a replacement IP.BIN - and hands them to a caller
//! supplied sink. It deliberately performs no filesystem or OPFS I/O of its
//! own so the same code runs natively and in the browser; the caller decides
//! where each emitted file lands. Reassembling the full disc (carrying through
//! the source files the patch does not touch, then rebuilding the ISO9660 /
//! GD-ROM image) is a separate step and not done here.

use std::io::{Read, Seek};

use crate::gdrom::GdRomFs;
use rom_weaver_core::{Result, RomWeaverError};

use super::DcpManifest;
use super::manifest::DcpOperation;
use super::zip::{extract_entry, read_central_directory};

/// One output produced by applying a `.dcp`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DcpOutput {
    /// A file to write into the rebuilt filesystem at `path`.
    File {
        /// Destination path within the volume.
        path: String,
        /// Final file bytes (delta applied, or verbatim).
        bytes: Vec<u8>,
    },
    /// A replacement boot sector (IP.BIN) for the disc bootstrap.
    BootSector {
        /// IP.BIN bytes.
        bytes: Vec<u8>,
    },
}

/// Counts describing what an apply produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DcpApplySummary {
    /// Number of source files patched with a delta.
    pub deltas_applied: usize,
    /// Number of verbatim files written.
    pub verbatim_written: usize,
    /// Whether a replacement boot sector was emitted.
    pub boot_sector: bool,
}

/// Apply every operation in `dcp` against the filesystem `fs`, invoking `emit`
/// once per produced output (in manifest order).
///
/// Delta operations read their source file from `fs` (matching the target path
/// case-insensitively) and apply the VCDIFF delta in memory; the clean decode
/// validates that the source matched. A missing source file is an error.
pub fn apply_dcp<D, T, F>(dcp: &mut D, fs: &mut GdRomFs<T>, mut emit: F) -> Result<DcpApplySummary>
where
    D: Read + Seek,
    T: Read + Seek,
    F: FnMut(DcpOutput) -> Result<()>,
{
    let entries = read_central_directory(dcp)?;
    let manifest = DcpManifest::from_entries(&entries);
    tracing::debug!(
        operations = manifest.operations.len(),
        deltas = manifest.delta_count(),
        verbatim = manifest.verbatim_count(),
        boot_sector = manifest.has_boot_sector(),
        "applying .dcp"
    );

    let mut summary = DcpApplySummary::default();
    for op in &manifest.operations {
        match op {
            DcpOperation::Delta { target, entry } => {
                let source_entry = fs.file_ignore_ascii_case(target).cloned().ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "`.dcp` delta targets `{target}`, which is not present on the disc"
                    ))
                })?;
                let source = fs.read_file(&source_entry)?;
                let delta = extract_entry(dcp, entry)?;
                let patched =
                    rom_weaver_xdelta::apply_patch_bytes(&source, &delta).map_err(|err| {
                        RomWeaverError::Validation(format!(
                            "failed to apply `.dcp` delta for `{target}`: {err}"
                        ))
                    })?;
                tracing::trace!(
                    target,
                    source_len = source.len(),
                    patched_len = patched.len(),
                    "applied delta"
                );
                emit(DcpOutput::File {
                    path: target.clone(),
                    bytes: patched,
                })?;
                summary.deltas_applied += 1;
            }
            DcpOperation::Verbatim { path, entry } => {
                let bytes = extract_entry(dcp, entry)?;
                tracing::trace!(path, len = bytes.len(), "wrote verbatim file");
                emit(DcpOutput::File {
                    path: path.clone(),
                    bytes,
                })?;
                summary.verbatim_written += 1;
            }
            DcpOperation::BootSector { entry } => {
                let bytes = extract_entry(dcp, entry)?;
                tracing::trace!(len = bytes.len(), "replaced boot sector");
                emit(DcpOutput::BootSector { bytes })?;
                summary.boot_sector = true;
            }
        }
    }
    tracing::debug!(?summary, "finished .dcp apply");
    Ok(summary)
}
