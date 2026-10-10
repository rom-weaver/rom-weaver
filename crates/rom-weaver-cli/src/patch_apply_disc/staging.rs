//! Source paths may leave the sheet directory; generated paths must never do so.

use super::{DiscFile, DiscSheetKind, Path, PathBuf, Result, RomWeaverError, fs};
use std::collections::BTreeSet;

fn portable_file_name(name: &str) -> bool {
    name.is_ascii()
        && !name.is_empty()
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
        && !matches!(
            name.split('.')
                .next()
                .unwrap_or_default()
                .trim_end_matches(' ')
                .to_ascii_uppercase()
                .as_str(),
            "CON"
                | "CONIN$"
                | "CONOUT$"
                | "CLOCK$"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
}

/// Reserve existing simple ASCII names first so rebasing cannot steal a later
/// track's name. Sheets share this namespace. Non-ASCII source names get ASCII
/// names to avoid filesystem-specific Unicode case and normalization aliases.
pub(super) fn output_names(sheets: &[PathBuf], names: &[String]) -> Vec<String> {
    let mut used: BTreeSet<String> = sheets
        .iter()
        .filter_map(|path| path.file_name())
        .map(|name| name.to_string_lossy().to_lowercase())
        .collect();
    let preserved: Vec<bool> = names
        .iter()
        .map(|name| portable_file_name(name) && used.insert(name.to_ascii_lowercase()))
        .collect();
    names
        .iter()
        .zip(preserved)
        .enumerate()
        .map(|(index, (name, preserve))| {
            if preserve {
                return name.clone();
            }
            let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
            if portable_file_name(base) && used.insert(base.to_ascii_lowercase()) {
                return base.to_owned();
            }
            let extension = Path::new(base)
                .extension()
                .and_then(|value| value.to_str())
                .filter(|value| {
                    !value.is_empty()
                        && value.len() <= 32
                        && value.chars().all(|c| c.is_ascii_alphanumeric())
                })
                .unwrap_or("bin");
            for suffix in 0_u64.. {
                let candidate = format!("rom-weaver-track-{}-{suffix}.{extension}", index + 1);
                if used.insert(candidate.to_ascii_lowercase()) {
                    return candidate;
                }
            }
            unreachable!("finite disc references cannot exhaust output names")
        })
        .collect()
}

/// Token content range plus next-token offset, retaining whitespace and quotes.
/// These are the same boundaries used by the core disc-sheet enumerator.
fn token(text: &str, start: usize) -> Option<(std::ops::Range<usize>, usize)> {
    let rest = &text[start..];
    let start = start + rest.len() - rest.trim_start().len();
    let rest = &text[start..];
    if let Some(quoted) = rest.strip_prefix('"') {
        let end = start + 1 + quoted.find('"')?;
        Some((start + 1..end, end + 1))
    } else if !rest.is_empty() {
        let end = start + rest.find(char::is_whitespace).unwrap_or(rest.len());
        Some((start..end, end))
    } else {
        None
    }
}

pub(super) fn write_sheet(source: &Path, dest: &Path, files: &[DiscFile]) -> Result<()> {
    let text = fs::read_to_string(source)?;
    let kind = super::detect_disc_sheet(source).ok_or_else(|| {
        RomWeaverError::Validation(format!("unrecognized disc sheet `{}`", source.display()))
    })?;
    let mut output = String::with_capacity(text.len());
    let mut saw_gdi_header = false;
    for line in text.split_inclusive('\n') {
        let range = match kind {
            DiscSheetKind::Cue => token(line, 0).and_then(|(keyword, end)| {
                (!line.trim_start().starts_with('"') && line[keyword].eq_ignore_ascii_case("FILE"))
                    .then(|| token(line, end))
                    .flatten()
            }),
            DiscSheetKind::Gdi if line.trim().is_empty() => None,
            DiscSheetKind::Gdi if !saw_gdi_header => {
                saw_gdi_header = true;
                None
            }
            DiscSheetKind::Gdi => {
                let mut end = 0;
                for _ in 0..4 {
                    end = token(line, end).map(|(_, end)| end).unwrap_or(line.len());
                }
                token(line, end)
            }
        };
        if let Some((range, _)) = range {
            let name = &line[range.clone()];
            let file = files
                .iter()
                .find(|file| file.name.eq_ignore_ascii_case(name))
                .ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "disc sheet `{}` changed its referenced files before staging",
                        source.display()
                    ))
                })?;
            output.push_str(&line[..range.start]);
            output.push_str(&file.output_name);
            output.push_str(&line[range.end..]);
        } else {
            output.push_str(line);
        }
    }
    // Reject any unhandled reference before copying track bytes.
    let refs = rom_weaver_core::parse_disc_sheet_refs_from_text(
        kind,
        &output,
        &source.display().to_string(),
    )?;
    if refs
        .iter()
        .any(|name| !files.iter().any(|file| &file.output_name == name))
    {
        return Err(RomWeaverError::Validation(format!(
            "disc sheet `{}` has an unexpected staged reference",
            source.display()
        )));
    }
    let mut target = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)?;
    std::io::Write::write_all(&mut target, output.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_names_are_portable_unique_and_cannot_replace_sheets() {
        let names: Vec<String> = [
            "../track.bin",
            "track.bin",
            "nested/track.bin",
            "/absolute/track.bin",
            "C:\\tracks\\track.bin",
            "\\\\server\\share\\track.bin",
            "C:track.bin",
            "disc.cue",
            "DISC.GDI",
            "CON",
            "NUL.bin",
            "LPT1.bin",
            "trailing.",
            "track.bin:stream",
            "../rom-weaver-track-1-0.bin",
            "rom-weaver-track-1-0.bin",
            "dir/Unicode 日本語.bin",
            "dir/track.bin ",
            "Ä.bin",
            "ä.bin",
            "é.bin",
            "e\u{301}.bin",
            "CON .bin",
            "CONIN$",
            "CONOUT$",
            "COM¹.bin",
            "COM².bin",
            "COM³.bin",
            "LPT¹.bin",
            "LPT².bin",
            "LPT³.bin",
            ".",
            "..",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        let outputs = output_names(&["disc.cue".into(), "disc.gdi".into()], &names);
        assert_eq!(outputs.len(), names.len());
        assert_eq!(outputs[1], "track.bin");
        assert_eq!(outputs[15], "rom-weaver-track-1-0.bin");
        let mut unique = BTreeSet::new();
        for name in outputs {
            assert!(portable_file_name(&name), "unsafe output: {name}");
            assert_eq!(Path::new(&name).components().count(), 1);
            assert!(!name.eq_ignore_ascii_case("disc.cue"));
            assert!(!name.eq_ignore_ascii_case("disc.gdi"));
            assert!(
                unique.insert(name.to_ascii_lowercase()),
                "duplicate output: {name}"
            );
        }
    }

    #[test]
    fn write_sheet_never_replaces_an_existing_staged_member() {
        let temp = assert_fs::TempDir::new().expect("temp directory");
        let source = temp.path().join("source.cue");
        let dest = temp.path().join("staged.cue");
        fs::write(
            &source,
            "FILE track.bin BINARY\n TRACK 01 MODE1/2352\n INDEX 01 00:00:00\n",
        )
        .expect("source");
        fs::write(&dest, b"existing member").expect("member");
        let files = [DiscFile {
            name: "track.bin".into(),
            output_name: "track.bin".into(),
            path: temp.path().join("track.bin"),
        }];
        assert!(write_sheet(&source, &dest, &files).is_err());
        assert_eq!(
            fs::read(dest).expect("preserved member"),
            b"existing member"
        );
    }

    #[test]
    fn write_sheet_preserves_token_boundaries_and_non_reference_text() {
        let temp = assert_fs::TempDir::new().expect("temp directory");
        let files = [DiscFile {
            name: "../a.bin".into(),
            output_name: "a.bin".into(),
            path: temp.path().join("a.bin"),
        }];
        for (extension, text, expected) in [
            (
                "cue",
                "REM ../a.bin\r\n\"FILE\" ../ignored.bin BINARY\r\n\tFILE\u{2003}\"../a.bin\"BINARY\r\n TRACK 01 AUDIO\r\n",
                "REM ../a.bin\r\n\"FILE\" ../ignored.bin BINARY\r\n\tFILE\u{2003}\"a.bin\"BINARY\r\n TRACK 01 AUDIO\r\n",
            ),
            (
                "gdi",
                "\r\n 1 \r\n\"1\" 0\t4\u{2003}2352 \"../a.bin\"0\r\n",
                "\r\n 1 \r\n\"1\" 0\t4\u{2003}2352 \"a.bin\"0\r\n",
            ),
        ] {
            let source = temp.path().join(format!("source.{extension}"));
            let dest = temp.path().join(format!("staged.{extension}"));
            fs::write(&source, text).expect("source");
            write_sheet(&source, &dest, &files).expect("staged sheet");
            assert_eq!(fs::read_to_string(dest).expect("staged text"), expected);
        }
    }
}
