//! Common patch-handler validation and report labels.

use std::path::PathBuf;

use crate::{Result, RomWeaverError};

/// Require that a patch apply was handed exactly one patch file, returning it.
pub fn require_single_patch_file<'a>(
    patches: &'a [PathBuf],
    format_name: &str,
) -> Result<&'a PathBuf> {
    if patches.len() != 1 {
        return Err(RomWeaverError::Validation(format!(
            "{format_name} apply expects exactly one patch file"
        )));
    }
    Ok(&patches[0])
}

/// The trailing note appended to an operation label when checksum validation was
/// disabled.
pub fn checksum_validation_suffix(validate_checksums: bool) -> &'static str {
    if validate_checksums {
        ""
    } else {
        "; checksum validation skipped"
    }
}
