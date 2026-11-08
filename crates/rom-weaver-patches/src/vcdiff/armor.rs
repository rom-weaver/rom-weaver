//! xdelta3 "armor": BLAKE3 digests of the source and target carried in the application header as
//! `<target name>#<hex>/<target compression>/<source name>#<hex>/<source compression>`
//! (xdelta3-main.h, `main_armor_parse_appheader`).
use super::*;
use crate::shared::checksum_io::checksum_path_cached;
use rom_weaver_core::ERROR_CODE_PATCH_CHECKSUM_MISMATCH;

const ARMOR_HEX_LEN: usize = 64;

/// Lowercase hex BLAKE3 digests an xdelta3 armored application header declares.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct ArmorHashes {
    pub(super) source: Option<String>,
    pub(super) target: Option<String>,
}

/// Reads the armor digests out of an application header. A header that is not armored, or whose
/// name fields do not end in `#` plus 64 lowercase hex digits, yields no digests.
pub(super) fn parse_armor_hashes(app_header: &[u8]) -> ArmorHashes {
    let fields: Vec<&[u8]> = app_header.splitn(4, |byte| *byte == b'/').collect();
    let target = matches!(fields.len(), 2 | 4)
        .then(|| armor_hash_of_name(fields[0]))
        .flatten();
    let source = (fields.len() == 4)
        .then(|| armor_hash_of_name(fields[2]))
        .flatten();
    ArmorHashes { source, target }
}

/// The digest after the last `#` of an armored `name#<hex>` field. File names may contain `#`,
/// so only a suffix of exactly 64 lowercase hex digits counts.
fn armor_hash_of_name(name: &[u8]) -> Option<String> {
    let hash_start = name.iter().rposition(|byte| *byte == b'#')? + 1;
    let hash = &name[hash_start..];
    let is_hex = hash.len() == ARMOR_HEX_LEN
        && hash
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte));
    is_hex.then(|| String::from_utf8_lossy(hash).into_owned())
}

/// Returns a checksum-mismatch error when the source's BLAKE3 differs from the armored source digest.
pub(super) fn verify_armor_source(
    armor: &ArmorHashes,
    source_path: &Path,
    context: &OperationContext,
) -> Result<()> {
    let Some(expected) = armor.source.as_deref() else {
        return Ok(());
    };
    let actual = checksum_path_cached(source_path, "blake3", context)?;
    trace!(expected, actual, "xdelta armor source digest");
    if actual != expected {
        return Err(RomWeaverError::coded(
            ERROR_CODE_PATCH_CHECKSUM_MISMATCH,
            format!("source file BLAKE3 mismatch: expected {expected}, got {actual}"),
        ));
    }
    Ok(())
}

/// Fails when the patched output does not hash to the target digest the patch declares.
pub(super) fn verify_armor_target(
    armor: &ArmorHashes,
    output_path: &Path,
    context: &OperationContext,
) -> Result<()> {
    let Some(expected) = armor.target.as_deref() else {
        return Ok(());
    };
    let actual = checksum_path_cached(output_path, "blake3", context)?;
    trace!(expected, actual, "xdelta armor target digest");
    if actual != expected {
        return Err(RomWeaverError::coded(
            ERROR_CODE_PATCH_CHECKSUM_MISMATCH,
            format!("target BLAKE3 mismatch after apply: expected {expected}, got {actual}"),
        ));
    }
    Ok(())
}
