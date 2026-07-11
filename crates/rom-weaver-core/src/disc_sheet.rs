//! Lightweight disc-sheet reference enumeration.
//!
//! A multi-track CD/GD disc is described by a `.cue` and/or `.gdi` sheet that
//! references one or more data files (`.bin`/`.img`/`.iso`/...). The container
//! crates parse these sheets into fully-resolved track geometry (frame math,
//! MSF parsing, sector sizing, GD-ROM high-density layout), which requires the
//! data files to exist on disk. The app layer only needs a far smaller fact:
//! *which files, in order, does this sheet reference?* - for example to apply a
//! `--target` glob or to stage a disc for patching before the bins are present.
//!
//! This module provides exactly that: a pure, dependency-free text scan that
//! mirrors the same `FILE`/track grammar without any disc-geometry logic and
//! without touching the referenced files. Keeping it here (rather than exposing
//! the container-internal parser) avoids leaking disc geometry into the public
//! API and avoids an app→container crate dependency for a filename list.

use std::path::{Path, PathBuf};

use crate::error::{Result, RomWeaverError};

/// The kind of disc sheet, distinguished by extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscSheetKind {
    /// A CD-ROM `.cue` sheet.
    Cue,
    /// A GD-ROM `.gdi` sheet.
    Gdi,
}

/// The data files a disc sheet references, in declaration order with duplicates
/// removed (a single `FILE` can back several `TRACK`s).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscSheetRefs {
    /// Whether this came from a `.cue` or a `.gdi`.
    pub kind: DiscSheetKind,
    /// The sheet that was parsed.
    pub sheet_path: PathBuf,
    /// Referenced data-file names exactly as written in the sheet (no path
    /// resolution), in order, de-duplicated.
    pub referenced_files: Vec<String>,
}

/// Classify `path` as a disc sheet by its extension. Returns `None` for any
/// other input (a plain ROM, an archive, ...).
pub fn detect_disc_sheet(path: &Path) -> Option<DiscSheetKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "cue" => Some(DiscSheetKind::Cue),
        "gdi" => Some(DiscSheetKind::Gdi),
        _ => None,
    }
}

/// Parse a `.cue`/`.gdi` and return the ordered, de-duplicated list of data
/// files it references. Does no frame math and does **not** require the
/// referenced files to exist.
///
/// Returns an error if `path` is not a recognized disc sheet or if the sheet is
/// malformed (missing `FILE` name, empty/invalid `.gdi`).
pub fn enumerate_disc_sheet_refs(path: &Path) -> Result<DiscSheetRefs> {
    let kind = detect_disc_sheet(path).ok_or_else(|| {
        RomWeaverError::Validation(format!(
            "`{}` is not a disc sheet (.cue/.gdi)",
            path.display()
        ))
    })?;
    let text = std::fs::read_to_string(path)?;
    let referenced_files = match kind {
        DiscSheetKind::Cue => enumerate_cue_refs(&text, path)?,
        DiscSheetKind::Gdi => enumerate_gdi_refs(&text, path)?,
    };
    Ok(DiscSheetRefs {
        kind,
        sheet_path: path.to_path_buf(),
        referenced_files,
    })
}

/// Parse disc-sheet `text` of the given `kind` into its ordered, de-duplicated
/// referenced-file list - the text-only half of [`enumerate_disc_sheet_refs`]
/// for callers that already hold the sheet bytes (e.g. a browser extracted the
/// `.cue` from an archive) and must not touch the filesystem. `label` is used in
/// error messages only. Same `FILE`/track grammar, no disc geometry, no I/O.
pub fn parse_disc_sheet_refs_from_text(
    kind: DiscSheetKind,
    text: &str,
    label: &str,
) -> Result<Vec<String>> {
    let path = Path::new(label);
    match kind {
        DiscSheetKind::Cue => enumerate_cue_refs(text, path),
        DiscSheetKind::Gdi => enumerate_gdi_refs(text, path),
    }
}

/// Return the `.gdi` sitting next to a `.cue` (same stem) when it exists. A
/// `.cue` with a sibling `.gdi` is treated as a GD-ROM whose referenced files
/// are the union of both sheets, so callers stage both sheets and both file
/// sets.
pub fn sibling_gdi_path(cue_path: &Path) -> Option<PathBuf> {
    if detect_disc_sheet(cue_path) != Some(DiscSheetKind::Cue) {
        return None;
    }
    let gdi_path = cue_path.with_extension("gdi");
    gdi_path.is_file().then_some(gdi_path)
}

/// Push `name` onto `out` unless an equal name (case-insensitive) is already
/// present, preserving first-seen order.
fn push_unique(out: &mut Vec<String>, name: &str) {
    let lowered = name.to_ascii_lowercase();
    if !out
        .iter()
        .any(|existing| existing.to_ascii_lowercase() == lowered)
    {
        out.push(name.to_string());
    }
}

/// Collect the `FILE "<name>" <TYPE>` references from a cue sheet, in order.
fn enumerate_cue_refs(text: &str, path: &Path) -> Result<Vec<String>> {
    let mut files = Vec::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let keyword_end = line.find(char::is_whitespace).unwrap_or(line.len());
        if !line[..keyword_end].eq_ignore_ascii_case("FILE") {
            continue;
        }
        let remainder = line[keyword_end..].trim_start();
        let (name, _) = split_token(remainder).ok_or_else(|| {
            RomWeaverError::Validation(format!("invalid FILE entry in cue `{}`", path.display()))
        })?;
        push_unique(&mut files, name);
    }
    if files.is_empty() {
        return Err(RomWeaverError::Validation(format!(
            "cue `{}` does not reference any FILE entries",
            path.display()
        )));
    }
    Ok(files)
}

/// Collect the filename column (5th token) from each track line of a gdi sheet.
fn enumerate_gdi_refs(text: &str, path: &Path) -> Result<Vec<String>> {
    let mut files = Vec::new();
    let mut saw_header = false;
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if !saw_header {
            line.parse::<usize>().map_err(|_| {
                RomWeaverError::Validation(format!(
                    "gdi `{}` has an invalid track count header",
                    path.display()
                ))
            })?;
            saw_header = true;
            continue;
        }
        // number, physframeofs, track_type, sector_size, name, file_offset
        let name = (|| {
            let (_number, rest) = split_token(line)?;
            let (_physframeofs, rest) = split_token(rest)?;
            let (_track_type, rest) = split_token(rest)?;
            let (_sector_size, rest) = split_token(rest)?;
            let (name, _rest) = split_token(rest)?;
            Some(name)
        })()
        .ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "gdi track entry in `{}` is missing its filename",
                path.display()
            ))
        })?;
        push_unique(&mut files, name);
    }
    if files.is_empty() {
        return Err(RomWeaverError::Validation(format!(
            "gdi `{}` does not define any tracks",
            path.display()
        )));
    }
    Ok(files)
}

/// Split the first whitespace- or quote-delimited token off `text`, returning
/// `(token, remainder)`. Mirrors the cue/gdi tokenizer used by the container
/// crates: a leading `"` quotes a token up to the next `"`.
fn split_token(text: &str) -> Option<(&str, &str)> {
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix('"') {
        let end = rest.find('"')?;
        Some((&rest[..end], &rest[end + 1..]))
    } else {
        let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
        Some((&trimmed[..end], &trimmed[end..]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use assert_fs::prelude::*;

    #[test]
    fn detect_recognizes_cue_and_gdi_case_insensitively() {
        assert_eq!(
            detect_disc_sheet(Path::new("game.cue")),
            Some(DiscSheetKind::Cue)
        );
        assert_eq!(
            detect_disc_sheet(Path::new("game.CUE")),
            Some(DiscSheetKind::Cue)
        );
        assert_eq!(
            detect_disc_sheet(Path::new("game.GDI")),
            Some(DiscSheetKind::Gdi)
        );
        assert_eq!(detect_disc_sheet(Path::new("game.bin")), None);
        assert_eq!(detect_disc_sheet(Path::new("game")), None);
    }

    #[test]
    fn enumerate_cue_collects_files_in_order() {
        let cue = concat!(
            "FILE \"Game (Track 1).bin\" BINARY\n",
            "  TRACK 01 MODE2/2352\n",
            "    INDEX 01 00:00:00\n",
            "FILE \"Game (Track 2).bin\" BINARY\n",
            "  TRACK 02 AUDIO\n",
            "    INDEX 00 00:00:00\n",
            "    INDEX 01 00:02:00\n",
        );
        let files = enumerate_cue_refs(cue, Path::new("game.cue")).expect("parse");
        assert_eq!(
            files,
            vec![
                "Game (Track 1).bin".to_string(),
                "Game (Track 2).bin".to_string()
            ]
        );
    }

    #[test]
    fn enumerate_cue_dedupes_repeated_file_and_takes_bareword() {
        let cue = concat!(
            "FILE game.bin BINARY\n",
            "  TRACK 01 MODE1/2352\n",
            "    INDEX 01 00:00:00\n",
            "  TRACK 02 AUDIO\n",
            "    INDEX 00 10:00:00\n",
            "FILE game.bin BINARY\n",
            "  TRACK 03 AUDIO\n",
            "    INDEX 01 20:00:00\n",
        );
        let files = enumerate_cue_refs(cue, Path::new("game.cue")).expect("parse");
        assert_eq!(files, vec!["game.bin".to_string()]);
    }

    #[test]
    fn enumerate_cue_rejects_empty() {
        let error = enumerate_cue_refs("REM nothing here\n", Path::new("game.cue"))
            .expect_err("should reject");
        assert!(matches!(error, RomWeaverError::Validation(_)));
    }

    #[test]
    fn enumerate_gdi_collects_filename_column() {
        let gdi = "2\n1 0 4 2352 track01.bin 0\n2 600 0 2352 track02.raw 0\n";
        let files = enumerate_gdi_refs(gdi, Path::new("game.gdi")).expect("parse");
        assert_eq!(
            files,
            vec!["track01.bin".to_string(), "track02.raw".to_string()]
        );
    }

    #[test]
    fn enumerate_gdi_handles_quoted_filename_with_spaces() {
        let gdi = "1\n1 0 4 2352 \"disc track 01.bin\" 0\n";
        let files = enumerate_gdi_refs(gdi, Path::new("game.gdi")).expect("parse");
        assert_eq!(files, vec!["disc track 01.bin".to_string()]);
    }

    #[test]
    fn enumerate_gdi_rejects_bad_header() {
        let error =
            enumerate_gdi_refs("notanumber\n", Path::new("game.gdi")).expect_err("should reject");
        assert!(matches!(error, RomWeaverError::Validation(_)));
    }

    #[test]
    fn parse_from_text_matches_cue_and_gdi_grammar() {
        let cue = "FILE \"a.bin\" BINARY\n  TRACK 01 MODE1/2352\nFILE \"b.bin\" BINARY\n";
        assert_eq!(
            parse_disc_sheet_refs_from_text(DiscSheetKind::Cue, cue, "game.cue").expect("cue"),
            vec!["a.bin".to_string(), "b.bin".to_string()]
        );
        let gdi = "1\n1 0 4 2352 track01.bin 0\n";
        assert_eq!(
            parse_disc_sheet_refs_from_text(DiscSheetKind::Gdi, gdi, "game.gdi").expect("gdi"),
            vec!["track01.bin".to_string()]
        );
        assert!(
            parse_disc_sheet_refs_from_text(DiscSheetKind::Cue, "REM only\n", "game.cue").is_err()
        );
    }

    #[test]
    fn enumerate_disc_sheet_refs_reads_from_disk() {
        let dir = assert_fs::TempDir::new().expect("tempdir");
        let cue = dir.child("game.cue");
        cue.write_str("FILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n")
            .expect("write");
        let refs = enumerate_disc_sheet_refs(cue.path()).expect("enumerate");
        assert_eq!(refs.kind, DiscSheetKind::Cue);
        assert_eq!(refs.referenced_files, vec!["track01.bin".to_string()]);
    }

    #[test]
    fn enumerate_rejects_non_sheet() {
        let dir = assert_fs::TempDir::new().expect("tempdir");
        let bin = dir.child("game.bin");
        bin.write_str("not a sheet").expect("write");
        let error = enumerate_disc_sheet_refs(bin.path()).expect_err("should reject");
        assert!(matches!(error, RomWeaverError::Validation(_)));
    }

    #[test]
    fn sibling_gdi_only_for_cue_with_existing_gdi() {
        let dir = assert_fs::TempDir::new().expect("tempdir");
        let cue = dir.child("game.cue");
        cue.write_str("FILE \"game.bin\" BINARY\n")
            .expect("write cue");
        assert_eq!(sibling_gdi_path(cue.path()), None);
        let gdi = dir.child("game.gdi");
        gdi.write_str("1\n1 0 4 2352 game.bin 0\n")
            .expect("write gdi");
        assert_eq!(sibling_gdi_path(cue.path()), Some(gdi.path().to_path_buf()));
        assert_eq!(sibling_gdi_path(dir.child("game.bin").path()), None);
    }
}
