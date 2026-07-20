//! Small helpers shared by the patch format crates (`rom-weaver-patches` and
//! `rom-weaver-patches`'s `xdelta` module). They live here, in the foundation crate,
//! so the wording of the errors/labels stays identical across formats.

use std::path::PathBuf;

use crate::{Result, RomWeaverError};

/// Require that a patch apply was handed exactly one patch file, returning it.
///
/// Every single-patch apply handler enforced this identically; centralizing the
/// check keeps the error message consistent.
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
///
/// Every checksum-bearing apply handler (APS/BPS/PPF/PMSR/SOLID/DPS/UPS/RUP/xdelta/...)
/// built this same `if validate_checksums { "" } else { "; checksum validation
/// skipped" }` inline; centralizing it keeps the wording identical across formats.
pub fn checksum_validation_suffix(validate_checksums: bool) -> &'static str {
    if validate_checksums {
        ""
    } else {
        "; checksum validation skipped"
    }
}
