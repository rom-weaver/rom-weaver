//! Classify a `.dcp` archive's entries into filesystem operations.
//!
//! Universal Dreamcast Patcher encodes everything by convention in the ZIP
//! entry names - there is no manifest file:
//!
//! - `bootsector/IP.BIN` - a complete replacement boot sector (IP.BIN). It is
//!   applied to the disc bootstrap and excluded from the rebuilt filesystem.
//! - `PATH.xdelta` - an xdelta3/VCDIFF delta against the same-named source file
//!   already on the disc; the target path is the entry name with `.xdelta`
//!   removed.
//! - any other entry - a new file added to the filesystem verbatim at `PATH`.
//!
//! This module turns the raw entry list into a typed [`DcpManifest`] so the
//! apply pipeline can drive each operation without re-deriving the convention.

use super::zip::ZipEntry;

/// The `bootsector/` prefix whose `IP.BIN` overrides the disc bootstrap.
pub const BOOTSECTOR_PREFIX: &str = "bootsector/";
/// The suffix marking an xdelta/VCDIFF delta entry.
pub const DELTA_SUFFIX: &str = ".xdelta";

/// One classified filesystem operation derived from a ZIP entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DcpOperation {
    /// Apply a VCDIFF delta to the existing source file at `target`.
    Delta {
        /// Filesystem path of the file to patch (entry name minus `.xdelta`).
        target: String,
        /// ZIP entry holding the delta bytes.
        entry: ZipEntry,
    },
    /// Add (or overwrite) a file verbatim at `path`.
    Verbatim {
        /// Filesystem path the entry's bytes are written to.
        path: String,
        /// ZIP entry holding the file bytes.
        entry: ZipEntry,
    },
    /// Replace the disc bootstrap with this IP.BIN (excluded from the rebuilt
    /// filesystem).
    BootSector {
        /// ZIP entry holding the IP.BIN bytes.
        entry: ZipEntry,
    },
}

impl DcpOperation {
    /// The ZIP entry this operation reads its bytes from.
    pub fn entry(&self) -> &ZipEntry {
        match self {
            DcpOperation::Delta { entry, .. }
            | DcpOperation::Verbatim { entry, .. }
            | DcpOperation::BootSector { entry } => entry,
        }
    }
}

/// The typed view of a `.dcp` archive's contents.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DcpManifest {
    /// All operations in central-directory order.
    pub operations: Vec<DcpOperation>,
}

impl DcpManifest {
    /// Classify a ZIP entry list into operations, skipping directory markers.
    pub fn from_entries(entries: &[ZipEntry]) -> DcpManifest {
        let mut operations = Vec::new();
        for entry in entries {
            if entry.is_directory() {
                continue;
            }
            operations.push(classify(entry.clone()));
        }
        DcpManifest { operations }
    }

    /// The number of delta operations.
    pub fn delta_count(&self) -> usize {
        self.operations
            .iter()
            .filter(|op| matches!(op, DcpOperation::Delta { .. }))
            .count()
    }

    /// The number of verbatim file operations.
    pub fn verbatim_count(&self) -> usize {
        self.operations
            .iter()
            .filter(|op| matches!(op, DcpOperation::Verbatim { .. }))
            .count()
    }

    /// Whether the patch carries a replacement boot sector.
    pub fn has_boot_sector(&self) -> bool {
        self.operations
            .iter()
            .any(|op| matches!(op, DcpOperation::BootSector { .. }))
    }

    /// The set of source filesystem paths each delta requires from the disc.
    pub fn required_source_paths(&self) -> Vec<&str> {
        self.operations
            .iter()
            .filter_map(|op| match op {
                DcpOperation::Delta { target, .. } => Some(target.as_str()),
                _ => None,
            })
            .collect()
    }
}

/// Classify a single entry by the DCP naming convention.
fn classify(entry: ZipEntry) -> DcpOperation {
    if entry.name == format!("{BOOTSECTOR_PREFIX}IP.BIN")
        || entry.name.eq_ignore_ascii_case("bootsector/ip.bin")
    {
        return DcpOperation::BootSector { entry };
    }
    if let Some(target) = entry.name.strip_suffix(DELTA_SUFFIX) {
        return DcpOperation::Delta {
            target: target.to_string(),
            entry,
        };
    }
    DcpOperation::Verbatim {
        path: entry.name.clone(),
        entry,
    }
}
