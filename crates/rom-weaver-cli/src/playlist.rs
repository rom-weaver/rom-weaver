//! `playlist`: build an `.m3u` disc-change playlist for a multi-disc game.
//!
//! The ordering and playlist-text helpers are pure so the native CLI and the
//! browser (the same code compiled to WASM) produce identical playlists.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::ops::Range;
use std::path::{Component, Path, PathBuf};

use super::*;
use rom_weaver_core::{IoOp, IoResultExt};

const PLAYLIST_FORMAT: &str = "m3u";

/// Characters that join a disc marker to the rest of a name, as in `Game - Disc 2` or `Game.disc02`.
const NAME_SEPARATORS: [char; 4] = [' ', '.', '_', '-'];

/// A file name without its final extension. A dotted tail containing a space is not an extension.
fn stem_of(file_name: &str) -> &str {
    match file_name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.contains(' ') => stem,
        _ => file_name,
    }
}

/// The byte range and number of the disc marker in a file stem, such as `Disc 2` in
/// `Game (Disc 2)`.
///
/// Recognizes `Disc 1`, `(Disc 2)`, `[Disk 3]`, `CD1`, `Disc_4`, and the
/// `.disc02` suffix rom-weaver writes when it extracts a multi-disc PBP. The
/// keyword must start a word, so `Abcd1` is not a disc.
fn disc_marker(stem: &str) -> Option<(Range<usize>, u32)> {
    let lowered = stem.to_ascii_lowercase();
    let bytes = lowered.as_bytes();
    let mut best: Option<(Range<usize>, u32)> = None;
    for keyword in ["disc", "disk", "cd"] {
        let mut from = 0;
        while let Some(found) = lowered[from..].find(keyword) {
            let start = from + found;
            let end = start + keyword.len();
            from = end;
            if start > 0 && bytes[start - 1].is_ascii_alphanumeric() {
                continue;
            }
            let mut digits_at = end;
            while digits_at < bytes.len() && matches!(bytes[digits_at], b' ' | b'_' | b'-') {
                digits_at += 1;
            }
            let digits = lowered[digits_at..]
                .bytes()
                .take_while(u8::is_ascii_digit)
                .count();
            if digits == 0 {
                continue;
            }
            if let Ok(number) = lowered[digits_at..digits_at + digits].parse::<u32>()
                && best.as_ref().is_none_or(|(marker, _)| start < marker.start)
            {
                best = Some((start..digits_at + digits, number));
            }
        }
    }
    best
}

/// The disc number a file name carries, if any. The final extension is ignored.
pub(crate) fn disc_number(file_name: &str) -> Option<u32> {
    disc_marker(stem_of(file_name)).map(|(_, number)| number)
}

/// The game a disc file belongs to: its name without the extension and the disc marker, so
/// `Game (Disc 1).cue`, `Game (Disc 1 of 2)[!].gdi`, and `Game.disc01.cue` name `Game`,
/// `Game[!]`, and `Game`.
pub(crate) fn game_name(file_name: &str) -> String {
    let stem = stem_of(file_name);
    let Some((marker, _)) = disc_marker(stem) else {
        return stem.trim().to_string();
    };
    let bytes = stem.as_bytes();
    let (mut start, mut end) = (marker.start, marker.end);
    // TOSEC names count the discs: `(Disc 1 of 2)`.
    if bytes[end..].len() > 4 && bytes[end..end + 4].eq_ignore_ascii_case(b" of ") {
        let digits = bytes[end + 4..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if digits > 0 {
            end += 4 + digits;
        }
    }
    if start > 0
        && end < bytes.len()
        && matches!((bytes[start - 1], bytes[end]), (b'(', b')') | (b'[', b']'))
    {
        start -= 1;
        end += 1;
    }
    let before = stem[..start].trim_end_matches(NAME_SEPARATORS);
    let after = if before.is_empty() {
        stem[end..].trim_start_matches(NAME_SEPARATORS)
    } else {
        &stem[end..]
    };
    format!("{before}{after}").trim().to_string()
}

/// `name` when it can name a file and folder of its own, trimmed. A sheet quotes its file
/// names, so a game name MUST NOT contain `"`.
fn checked_game_name(name: &str) -> Option<String> {
    let name = name.trim();
    let valid = !matches!(name, "" | "." | "..")
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | '"'));
    valid.then(|| name.to_string())
}

fn without_leading_zeros(digits: &[u8]) -> &[u8] {
    let zeros = digits.iter().take_while(|digit| **digit == b'0').count();
    &digits[zeros..]
}

/// Compare names so `Disc 2` sorts before `Disc 10`.
///
/// Works on the UTF-8 bytes: byte order is code point order, and only ASCII
/// letters fold case, so this matches comparing lowercased characters.
fn natural_cmp(left: &str, right: &str) -> Ordering {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    let digits_end = |bytes: &[u8], from: usize| {
        from + bytes[from..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count()
    };
    let (mut at_left, mut at_right) = (0, 0);
    loop {
        match (left.get(at_left), right.get(at_right)) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b)) if a.is_ascii_digit() && b.is_ascii_digit() => {
                let (end_left, end_right) =
                    (digits_end(left, at_left), digits_end(right, at_right));
                let a = without_leading_zeros(&left[at_left..end_left]);
                let b = without_leading_zeros(&right[at_right..end_right]);
                let order = a.len().cmp(&b.len()).then_with(|| a.cmp(b));
                if order != Ordering::Equal {
                    return order;
                }
                (at_left, at_right) = (end_left, end_right);
            }
            (Some(a), Some(b)) => {
                let (a, b) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
                if a != b {
                    return a.cmp(&b);
                }
                at_left += 1;
                at_right += 1;
            }
        }
    }
}

fn sheet_track_path(
    sheet_dir: &Path,
    archive_name: &str,
    staged_paths: &BTreeMap<PathBuf, PathBuf>,
) -> Option<PathBuf> {
    let exact = sheet_dir.join(archive_name);
    if staged_paths.is_empty() {
        return Some(exact);
    }
    let key = normalize_lexically(&exact);
    if let Some(staged) = staged_paths.get(&key) {
        return Some(staged.clone());
    }
    // A sheet made on a case-insensitive filesystem can name `GAME.BIN` for `Game.bin`. Natively
    // the filesystem resolves that, so the staging map accepts one file differing only in case.
    let parent = key.parent()?;
    let name = key.file_name()?.to_str()?;
    let mut matches = staged_paths
        .range(parent.to_path_buf()..)
        .take_while(|(logical, _)| logical.starts_with(parent))
        .filter(|(logical, _)| {
            logical.parent() == Some(parent)
                && logical
                    .file_name()
                    .and_then(|file_name| file_name.to_str())
                    .is_some_and(|file_name| file_name.eq_ignore_ascii_case(name))
        });
    let (_, staged) = matches.next()?;
    matches.next().is_none().then(|| staged.clone())
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Order disc files by their disc number; unnumbered files follow, and ties
/// fall back to a natural name order.
pub(crate) fn order_discs(discs: Vec<PathBuf>) -> Vec<PathBuf> {
    let compare = |left: &Path, right: &Path| {
        let (left_name, right_name) = (file_name_of(left), file_name_of(right));
        let left_number = disc_number(&left_name).unwrap_or(u32::MAX);
        let right_number = disc_number(&right_name).unwrap_or(u32::MAX);
        left_number
            .cmp(&right_number)
            .then_with(|| natural_cmp(&left_name, &right_name))
    };
    // A stable insertion by binary search: the same order `sort_by` gives, without
    // pulling a whole generic sort for `PathBuf` into the WASM module.
    let mut sorted: Vec<PathBuf> = Vec::with_capacity(discs.len());
    for disc in discs {
        let at = sorted.partition_point(|other| compare(other, &disc) != Ordering::Greater);
        sorted.insert(at, disc);
    }
    sorted
}

/// Playlist text: one path per line, `/` separators, LF line ends, with a
/// trailing newline. RetroArch reads this form (no `#EXTM3U` header needed).
pub(crate) fn render_m3u(entries: &[String]) -> String {
    let mut text = entries.join("\n");
    text.push('\n');
    text
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir if normalized.file_name().is_some() => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn absolute_normalized(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    Ok(normalize_lexically(&absolute))
}

/// `target` as a `/`-separated path relative to the directory `base_dir`.
pub(crate) fn relative_playlist_path(base_dir: &Path, target: &Path) -> Result<String> {
    let base = absolute_normalized(base_dir)?;
    let target = absolute_normalized(target)?;
    let base_parts = base.components().collect::<Vec<_>>();
    let target_parts = target.components().collect::<Vec<_>>();
    let shared = base_parts
        .iter()
        .zip(&target_parts)
        .take_while(|(a, b)| a == b)
        .count();
    if shared == 0 {
        return Err(RomWeaverError::Validation(format!(
            "cannot write `{}` relative to the playlist directory `{}`; keep them on one drive",
            target.display(),
            base.display()
        )));
    }
    let mut parts = vec!["..".to_string(); base_parts.len() - shared];
    parts.extend(
        target_parts[shared..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().into_owned()),
    );
    Ok(parts.join("/"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlaylistOutput {
    M3u,
    Zip,
    Folder,
}

impl PlaylistOutput {
    fn from_path(path: &Path) -> Result<Self> {
        if path == Path::new("-") {
            return Err(RomWeaverError::Validation(
                "playlist cannot write to stdout; give a .m3u, .zip, or folder --output"
                    .to_string(),
            ));
        }
        let text = path.as_os_str().to_string_lossy();
        if text.ends_with(['/', std::path::MAIN_SEPARATOR]) || path.is_dir() {
            return Ok(Self::Folder);
        }
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase);
        match extension.as_deref() {
            Some("m3u" | "m3u8") => Ok(Self::M3u),
            Some("zip") => Ok(Self::Zip),
            None => Ok(Self::Folder),
            Some(_) => Err(RomWeaverError::Validation(format!(
                "playlist --output `{}` must end in .m3u (playlist alone) or .zip (playlist with its discs), or name a folder; end a folder path with `/`",
                path.display()
            ))),
        }
    }
}

/// A file a disc needs beside it: a track its `.cue`/`.gdi` names, or a data file stored
/// with its `.ccd`/`.mds`.
struct Companion {
    source: PathBuf,
    /// The `/`-separated path from the disc's folder.
    name: String,
    /// The reference exactly as the sheet writes it; `None` for a `.ccd`/`.mds` data file.
    reference: Option<String>,
}

/// A disc the playlist lists, with the files it needs.
struct PlannedDisc {
    path: PathBuf,
    companions: Vec<Companion>,
}

/// The data files a `.ccd`/`.mds` image descriptor is stored with (`.img` and
/// `.sub`, or `.mdf`), as they sit next to it. Only files that exist count.
fn image_companions(input: &Path) -> Vec<Companion> {
    let extension = input
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    let wanted: &[&str] = match extension.as_deref() {
        Some("ccd") => &["img", "sub"],
        Some("mds") => &["mdf"],
        _ => return Vec::new(),
    };
    let Some(stem) = input
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
    else {
        return Vec::new();
    };
    let dir = input.parent().unwrap_or_else(|| Path::new(""));
    let mut found = Vec::new();
    for extension in wanted {
        for cased in [extension.to_string(), extension.to_ascii_uppercase()] {
            let name = format!("{stem}.{cased}");
            if dir.join(&name).is_file() {
                found.push(Companion {
                    source: dir.join(&name),
                    name,
                    reference: None,
                });
            }
        }
    }
    found
}

/// The discs among the inputs, each with the files it needs. An input that a disc sheet among
/// the inputs names (a `.cue`/`.gdi` track file, or the data files stored with a `.ccd`/`.mds`)
/// is not a disc. Only a bundle copies companions, so only a bundle refuses names that point
/// outside the sheet's folder or are missing.
fn plan_playlist(
    inputs: &[PathBuf],
    sort: bool,
    bundle: bool,
    staged_paths: &BTreeMap<PathBuf, PathBuf>,
) -> Result<Vec<PlannedDisc>> {
    let mut found: Vec<Vec<Companion>> = Vec::with_capacity(inputs.len());
    for input in inputs {
        let mut companions = image_companions(input);
        if detect_disc_sheet(input).is_some() {
            let refs = enumerate_disc_sheet_refs(input)?;
            let sheet_dir = input.parent().unwrap_or_else(|| Path::new(""));
            if bundle {
                // The parser keeps one of two names that differ only by case, so a copied sheet
                // could name a track the bundle lacks on a case-sensitive filesystem.
                let mut written = Vec::new();
                super::patch_apply_disc::rewrite_sheet(input, |reference| {
                    written.push(reference.to_string());
                    Ok(reference.to_string())
                })?;
                if let Some(variant) = written
                    .iter()
                    .find(|name| !refs.referenced_files.contains(*name))
                {
                    let kept = refs
                        .referenced_files
                        .iter()
                        .find(|name| name.eq_ignore_ascii_case(variant))
                        .map_or("", String::as_str);
                    return Err(RomWeaverError::Validation(format!(
                        "`{}` names both `{kept}` and `{variant}`; use one spelling so the copied sheet finds its tracks",
                        input.display()
                    )));
                }
            }
            for reference in refs.referenced_files {
                let archive_name = reference.replace('\\', "/");
                let escapes = Path::new(&archive_name).is_absolute()
                    || archive_name.split('/').any(|part| part == "..");
                if escapes && bundle {
                    return Err(RomWeaverError::Validation(format!(
                        "`{}` names `{reference}`, which is outside the sheet's folder",
                        input.display()
                    )));
                }
                let Some(source) = sheet_track_path(sheet_dir, &archive_name, staged_paths) else {
                    if bundle {
                        return Err(RomWeaverError::Validation(format!(
                            "`{reference}` is missing; disc sheet `{}` names it",
                            input.display()
                        )));
                    }
                    continue;
                };
                companions.push(Companion {
                    source,
                    name: archive_name,
                    reference: Some(reference),
                });
            }
        }
        found.push(companions);
    }
    let named: Vec<PathBuf> = found
        .iter()
        .flatten()
        .map(|companion| companion.source.clone())
        .collect();
    let mut discs: Vec<PlannedDisc> = Vec::new();
    for (input, companions) in inputs.iter().zip(found) {
        if detect_disc_sheet(input).is_none()
            && named
                .iter()
                .any(|track| super::path_access::paths_refer_to_same_file(input, track))
        {
            trace!(input = %input.display(), "playlist input is a track file of a given sheet");
            continue;
        }
        if !discs.iter().any(|disc| disc.path == *input) {
            discs.push(PlannedDisc {
                path: input.clone(),
                companions,
            });
        }
    }
    if discs.is_empty() {
        return Err(RomWeaverError::Validation(
            "playlist needs at least one disc file".to_string(),
        ));
    }
    if sort {
        let mut sorted = Vec::with_capacity(discs.len());
        for path in order_discs(discs.iter().map(|disc| disc.path.clone()).collect()) {
            if let Some(at) = discs.iter().position(|disc| disc.path == path) {
                sorted.push(discs.swap_remove(at));
            }
        }
        discs = sorted;
    }
    Ok(discs)
}

enum BundleSource {
    File(PathBuf),
    Text(String),
    /// A disc sheet's text naming its renamed tracks.
    Sheet {
        source: PathBuf,
        text: String,
    },
}

/// One file of a `.zip` or folder output.
struct BundleEntry {
    /// The `/`-separated path inside the output.
    path: String,
    source: BundleSource,
}

/// A disc's companions under `--rename`: a lone sheet track takes the disc's name, and several
/// become `<disc> (Track N)` as Redump names them. A `.ccd`/`.mds` data file keeps the disc's
/// name, because its descriptor finds it by name.
fn renamed_companions(disc: &PlannedDisc, disc_stem: &str) -> Vec<String> {
    let tracks = disc
        .companions
        .iter()
        .filter(|companion| companion.reference.is_some())
        .count();
    let width = tracks.to_string().len();
    let mut track = 0;
    disc.companions
        .iter()
        .map(|companion| {
            let base = companion.name.rsplit('/').next().unwrap_or_default();
            let extension = &base[stem_of(base).len()..];
            if companion.reference.is_none() || tracks == 1 {
                return format!("{disc_stem}{extension}");
            }
            track += 1;
            format!("{disc_stem} (Track {track:0width$}){extension}")
        })
        .collect()
}

/// The playlist lines and the files of a `.zip` or folder output, the playlist first, placed as
/// `layout` arranges them for a frontend.
fn plan_bundle(
    discs: &[PlannedDisc],
    game: &str,
    layout: PlaylistLayout,
    rename: bool,
) -> Result<(Vec<String>, Vec<BundleEntry>)> {
    let root = match layout {
        PlaylistLayout::Flat | PlaylistLayout::DiscFolders => String::new(),
        PlaylistLayout::Folder => format!("{game}/"),
        PlaylistLayout::M3uFolder => format!("{game}.m3u/"),
    };
    let mut lines = Vec::with_capacity(discs.len());
    let mut files = Vec::with_capacity(discs.len());
    let mut companions = Vec::new();
    for (index, disc) in discs.iter().enumerate() {
        let original = file_name_of(&disc.path);
        let extension = &original[stem_of(&original).len()..];
        if rename && extension.eq_ignore_ascii_case(".mds") {
            return Err(RomWeaverError::Validation(format!(
                "--rename cannot rename `{original}`: an .mds can name its .mdf inside"
            )));
        }
        let name = if rename {
            format!("{game} (Disc {}){extension}", index + 1)
        } else {
            original.clone()
        };
        let disc_stem = stem_of(&name);
        let folder = if layout == PlaylistLayout::DiscFolders {
            format!("{disc_stem}/")
        } else {
            String::new()
        };
        let names = if rename {
            renamed_companions(disc, disc_stem)
        } else {
            disc.companions
                .iter()
                .map(|companion| companion.name.clone())
                .collect()
        };
        let source = if rename && detect_disc_sheet(&disc.path).is_some() {
            BundleSource::Sheet {
                source: disc.path.clone(),
                text: super::patch_apply_disc::rewrite_sheet(&disc.path, |reference| {
                    disc.companions
                        .iter()
                        .zip(&names)
                        .find(|(companion, _)| companion.reference.as_deref() == Some(reference))
                        .map(|(_, name)| name.clone())
                        .ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "disc sheet `{original}` changed its files while the playlist was planned"
                            ))
                        })
                })?,
            }
        } else {
            BundleSource::File(disc.path.clone())
        };
        files.push(BundleEntry {
            path: format!("{root}{folder}{name}"),
            source,
        });
        for (companion, companion_name) in disc.companions.iter().zip(names) {
            companions.push(BundleEntry {
                path: format!("{root}{folder}{companion_name}"),
                source: BundleSource::File(companion.source.clone()),
            });
        }
        lines.push(format!("{folder}{name}"));
    }
    let mut entries = vec![BundleEntry {
        path: format!("{root}{game}.m3u"),
        source: BundleSource::Text(render_m3u(&lines)),
    }];
    entries.extend(files);
    entries.extend(companions);
    Ok((lines, entries))
}

/// Merge a file listed twice under one path, and reject two different files that would share
/// one.
fn unique_entries(entries: Vec<BundleEntry>) -> Result<Vec<BundleEntry>> {
    let mut unique: Vec<BundleEntry> = Vec::with_capacity(entries.len());
    for entry in entries {
        if let Some(taken) = unique
            .iter()
            .find(|taken| taken.path.eq_ignore_ascii_case(&entry.path))
        {
            if let (BundleSource::File(left), BundleSource::File(right)) =
                (&taken.source, &entry.source)
                && super::path_access::paths_refer_to_same_file(left, right)
            {
                continue;
            }
            return Err(RomWeaverError::Validation(format!(
                "two files would both be written as `{}`; rename one of them",
                entry.path
            )));
        }
        if let BundleSource::File(source) = &entry.source
            && !source.is_file()
        {
            return Err(RomWeaverError::Validation(format!(
                "`{}` is missing; a disc sheet names it",
                source.display()
            )));
        }
        unique.push(entry);
    }
    Ok(unique)
}

/// One file a rename-in-place plan gives a new name in the folder it is already in.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PlaylistRename {
    /// The file to rename.
    pub from: String,
    /// Its new file name.
    pub to: String,
    /// A disc sheet's new text, naming its renamed tracks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub text: Option<String>,
}

/// A disc a dry-run `playlist` lists, with the game its name names.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PlaylistPlannedDisc {
    /// The disc file.
    pub path: String,
    /// The disc's name without its extension and disc number.
    pub game: String,
}

/// The playlist a dry-run `playlist` plans, reported under `details.playlist`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PlaylistDryRunPlan {
    /// The playlist lines, in order.
    pub entries: Vec<String>,
    /// The listed discs, in playlist order.
    pub discs: Vec<PlaylistPlannedDisc>,
    /// The playlist's file name.
    pub file_name: String,
    /// The playlist's text.
    pub text: String,
    /// What a rename-in-place plan renames; empty for every other plan.
    pub renames: Vec<PlaylistRename>,
}

/// What a `playlist` run writes, decided before anything is written.
pub(super) struct PlaylistJob {
    kind: PlaylistOutput,
    /// The `.m3u`, `.zip`, or folder to write.
    output: PathBuf,
    /// The playlist's file name.
    playlist_name: String,
    lines: Vec<String>,
    /// The listed discs, in playlist order.
    discs: Vec<PathBuf>,
    /// The files of a `.zip` or folder output, the playlist first; empty for a lone `.m3u`.
    entries: Vec<BundleEntry>,
    /// The files a rename-in-place plan renames.
    renames: Vec<PlaylistRename>,
}

impl PlaylistJob {
    /// The files a run creates.
    pub(super) fn writes(&self) -> Vec<PathBuf> {
        if self.kind != PlaylistOutput::Folder {
            let folder = self.output.parent().unwrap_or_else(|| Path::new(""));
            let mut writes = vec![self.output.clone()];
            writes.extend(self.renames.iter().map(|rename| folder.join(&rename.to)));
            return writes;
        }
        self.entries
            .iter()
            .map(|entry| folder_target(&self.output, &entry.path))
            .collect()
    }

    pub(super) fn dry_run_plan(&self) -> PlaylistDryRunPlan {
        PlaylistDryRunPlan {
            entries: self.lines.clone(),
            discs: self
                .discs
                .iter()
                .map(|path| PlaylistPlannedDisc {
                    path: path.display().to_string(),
                    game: game_name(&file_name_of(path)),
                })
                .collect(),
            file_name: self.playlist_name.clone(),
            text: render_m3u(&self.lines),
            renames: self.renames.clone(),
        }
    }
}

/// Where a folder output writes an entry: its `/`-separated path joined part by part, so the
/// result uses the platform's separator.
fn folder_target(folder: &Path, entry_path: &str) -> PathBuf {
    entry_path
        .split('/')
        .fold(folder.to_path_buf(), |path, part| path.join(part))
}

fn check_inputs_are_files(inputs: &[PathBuf]) -> Result<()> {
    for input in inputs {
        if !input.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "playlist input `{}` is not a readable file",
                input.display()
            )));
        }
    }
    Ok(())
}

/// The game's name: `--name`, else the `.m3u`/`.zip` output's stem, else the first disc's name
/// without its disc number.
fn resolve_game_name(
    args: &PlaylistCommand,
    kind: PlaylistOutput,
    discs: &[PlannedDisc],
) -> Result<String> {
    match (&args.name, &args.output) {
        (Some(name), _) => checked_game_name(name).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "--name `{name}` cannot name a file; leave out `/`, `\\`, and `\"`"
            ))
        }),
        (None, Some(output)) if kind != PlaylistOutput::Folder => {
            Ok(output.file_stem().map_or_else(
                || "playlist".to_string(),
                |stem| stem.to_string_lossy().into_owned(),
            ))
        }
        _ => {
            let first = file_name_of(&discs[0].path);
            checked_game_name(&game_name(&first)).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "cannot name the game from `{first}`; pass --name"
                ))
            })
        }
    }
}

/// Plan renaming the discs `<game> (Disc N)` in the folder they are in, with their track files
/// and same-named companions (such as a LibCrypt `.sbi`), and the playlist beside them. The
/// browser carries it out, so the plan refuses anything a rename could lose or overwrite.
fn plan_rename_in_place(args: &PlaylistCommand) -> Result<PlaylistJob> {
    if args.output.is_some() || args.layout != PlaylistLayout::Flat || args.rename || args.flat {
        return Err(RomWeaverError::Validation(
            "renaming in place writes the playlist beside the discs; drop --output, --layout, --rename, and --flat"
                .to_string(),
        ));
    }
    check_inputs_are_files(&args.input)?;
    let discs = plan_playlist(&args.input, !args.no_sort, true, &args.staged_paths)?;
    let folder = discs[0]
        .path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_path_buf();
    check_discs_share_folder(&discs, &folder)?;
    check_discs_are_numbered_in_order(&discs)?;
    let game = resolve_game_name(args, PlaylistOutput::M3u, &discs)?;
    let (lines, entries) = plan_bundle(&discs, &game, PlaylistLayout::Flat, true)?;
    let entries = unique_entries(entries)?;
    let (mut renames, mut sources) = disc_renames(&entries)?;
    let folder_names = folder_file_names(&folder)?;
    for (path, companion) in companion_renames(&folder, &folder_names, &sources, &renames)? {
        sources.insert(path);
        renames.push(companion);
    }
    let playlist_name = format!("{game}.m3u");
    let others = names_outside_renames(&folder, &folder_names, &sources);
    check_rename_targets(&renames, &playlist_name, &others)?;
    debug!(
        discs = discs.len(),
        renames = renames.len(),
        "planned renaming the discs in place"
    );
    Ok(PlaylistJob {
        kind: PlaylistOutput::M3u,
        output: folder.join(&playlist_name),
        playlist_name,
        lines,
        discs: discs.into_iter().map(|disc| disc.path).collect(),
        entries: Vec::new(),
        renames,
    })
}

fn check_discs_share_folder(discs: &[PlannedDisc], folder: &Path) -> Result<()> {
    for path in discs.iter().flat_map(|disc| {
        std::iter::once(&disc.path).chain(disc.companions.iter().map(|companion| &companion.source))
    }) {
        if path.parent() != Some(folder) {
            return Err(RomWeaverError::Validation(format!(
                "renaming in place needs every disc and track file in one folder; `{}` is in another",
                path.display()
            )));
        }
    }
    Ok(())
}

fn check_discs_are_numbered_in_order(discs: &[PlannedDisc]) -> Result<()> {
    for (index, disc) in discs.iter().enumerate() {
        let name = file_name_of(&disc.path);
        let number = index + 1;
        if disc_number(&name).and_then(|found| usize::try_from(found).ok()) != Some(number) {
            return Err(RomWeaverError::Validation(format!(
                "renaming in place needs discs numbered 1 to {}; `{name}` would become Disc {number}",
                discs.len()
            )));
        }
    }
    Ok(())
}

/// The renames of the planned disc and track files, and the set of files they rename.
fn disc_renames(entries: &[BundleEntry]) -> Result<(Vec<PlaylistRename>, HashSet<PathBuf>)> {
    let mut sources: HashSet<PathBuf> = HashSet::new();
    let mut renames = Vec::with_capacity(entries.len());
    for entry in entries {
        let (source, text) = match &entry.source {
            BundleSource::File(source) => (source, None),
            BundleSource::Sheet { source, text } => (source, Some(text.clone())),
            BundleSource::Text(_) => continue,
        };
        if !sources.insert(source.clone()) {
            return Err(RomWeaverError::Validation(format!(
                "`{}` belongs to two discs, so it cannot take both names",
                file_name_of(source)
            )));
        }
        renames.push(PlaylistRename {
            from: source.display().to_string(),
            to: entry.path.clone(),
            text,
        });
    }
    Ok((renames, sources))
}

/// The sorted names of the files directly in `folder`.
fn folder_file_names(folder: &Path) -> Result<Vec<String>> {
    let mut folder_names = Vec::new();
    for item in fs::read_dir(folder).io_op(IoOp::ReadDir, folder)? {
        let item = item.io_op(IoOp::ReadDir, folder)?;
        if item
            .file_type()
            .io_op(IoOp::Inspect, item.path())?
            .is_file()
        {
            folder_names.push(item.file_name().to_string_lossy().into_owned());
        }
    }
    folder_names.sort();
    Ok(folder_names)
}

/// A file sharing a renamed file's name, such as `Game.sbi` beside `Game.cue`, follows it. Maps
/// each old lowercase stem to its new stem, or to `None` when its files get different new stems.
fn renamed_stems(renames: &[PlaylistRename]) -> HashMap<String, Option<String>> {
    let mut new_stems: HashMap<String, Option<String>> = HashMap::new();
    for rename in renames {
        let old = file_name_of(Path::new(&rename.from));
        let new_stem = stem_of(&rename.to).to_string();
        new_stems
            .entry(stem_of(&old).to_ascii_lowercase())
            .and_modify(|stem| {
                if stem.as_deref() != Some(new_stem.as_str()) {
                    *stem = None;
                }
            })
            .or_insert(Some(new_stem));
    }
    new_stems
}

/// The renames of the same-named companions in `folder` that follow a renamed disc or track
/// file, each with the companion's path.
fn companion_renames(
    folder: &Path,
    folder_names: &[String],
    sources: &HashSet<PathBuf>,
    renames: &[PlaylistRename],
) -> Result<Vec<(PathBuf, PlaylistRename)>> {
    let new_stems = renamed_stems(renames);
    let mut companions = Vec::new();
    for name in folder_names {
        let path = folder.join(name);
        let extension = &name[stem_of(name).len()..];
        if sources.contains(&path)
            || extension.eq_ignore_ascii_case(".m3u")
            || extension.eq_ignore_ascii_case(".m3u8")
        {
            continue;
        }
        let Some(new_stem) = new_stems.get(&stem_of(name).to_ascii_lowercase()) else {
            continue;
        };
        let Some(new_stem) = new_stem else {
            return Err(RomWeaverError::Validation(format!(
                "`{name}` shares its name with files that get different names; rename it first"
            )));
        };
        trace!(file = %name, "renaming a same-named companion with its disc");
        let rename = PlaylistRename {
            from: path.display().to_string(),
            to: format!("{new_stem}{extension}"),
            text: None,
        };
        companions.push((path, rename));
    }
    Ok(companions)
}

/// The lowercase names of the files in `folder` that the plan does not rename.
fn names_outside_renames(
    folder: &Path,
    folder_names: &[String],
    sources: &HashSet<PathBuf>,
) -> HashSet<String> {
    folder_names
        .iter()
        .filter(|name| !sources.contains(&folder.join(name)))
        .map(|name| name.to_ascii_lowercase())
        .collect()
}

/// Refuse a new name, the playlist's included, that an untouched file already has or that two
/// files would share.
fn check_rename_targets(
    renames: &[PlaylistRename],
    playlist_name: &str,
    others: &HashSet<String>,
) -> Result<()> {
    let mut targets = HashSet::new();
    for target in renames
        .iter()
        .map(|rename| rename.to.as_str())
        .chain(std::iter::once(playlist_name))
    {
        let folded = target.to_ascii_lowercase();
        if others.contains(&folded) {
            return Err(RomWeaverError::Validation(format!(
                "`{target}` already exists beside the discs; move it away first"
            )));
        }
        if !targets.insert(folded) {
            return Err(RomWeaverError::Validation(format!(
                "two files would both be named `{target}`; rename one of them"
            )));
        }
    }
    Ok(())
}

/// Validate a `playlist` request and decide every file it writes, without writing any.
pub(super) fn plan_job(args: &PlaylistCommand) -> Result<PlaylistJob> {
    if args.rename_in_place {
        return plan_rename_in_place(args);
    }
    let kind = checked_output_kind(args)?;
    check_inputs_are_files(&args.input)?;
    let discs = plan_playlist(
        &args.input,
        !args.no_sort,
        kind != PlaylistOutput::M3u,
        &args.staged_paths,
    )?;
    let game = resolve_game_name(args, kind, &discs)?;
    let output = args.output.clone().unwrap_or_else(|| {
        discs[0]
            .path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(format!("{game}.m3u"))
    });
    if kind != PlaylistOutput::Folder {
        check_file_output_is_free(&args.input, &output)?;
    }
    let (lines, entries) = if kind == PlaylistOutput::M3u {
        (m3u_lines(args, &discs, &output)?, Vec::new())
    } else {
        let (lines, entries) = plan_bundle(&discs, &game, args.layout, args.rename)?;
        (lines, unique_entries(entries)?)
    };
    check_lines_are_unique(&lines)?;
    if kind == PlaylistOutput::Folder {
        check_folder_output_is_free(&output, &entries)?;
    }
    check_entries_are_readable(&entries)?;
    debug!(
        ?kind,
        layout = ?args.layout,
        rename = args.rename,
        discs = discs.len(),
        files = entries.len(),
        "planned playlist"
    );
    let playlist_name = if kind == PlaylistOutput::M3u {
        file_name_of(&output)
    } else {
        format!("{game}.m3u")
    };
    Ok(PlaylistJob {
        kind,
        output,
        playlist_name,
        lines,
        discs: discs.into_iter().map(|disc| disc.path).collect(),
        entries,
        renames: Vec::new(),
    })
}

/// The output kind `--output` names (a lone `.m3u` without it), after refusing options that
/// kind cannot honor.
fn checked_output_kind(args: &PlaylistCommand) -> Result<PlaylistOutput> {
    let kind = match &args.output {
        Some(output) => PlaylistOutput::from_path(output)?,
        None => PlaylistOutput::M3u,
    };
    if kind == PlaylistOutput::M3u && (args.layout != PlaylistLayout::Flat || args.rename) {
        return Err(RomWeaverError::Validation(
            "--layout and --rename copy the discs, so they need a .zip or folder --output"
                .to_string(),
        ));
    }
    if kind == PlaylistOutput::M3u && args.output.is_some() && args.name.is_some() {
        return Err(RomWeaverError::Validation(
            "the .m3u --output already names the playlist; drop --name".to_string(),
        ));
    }
    Ok(kind)
}

/// Refuse a `.m3u` or `.zip` output that is one of the inputs or already exists.
fn check_file_output_is_free(inputs: &[PathBuf], output: &Path) -> Result<()> {
    if let Some(input) = inputs
        .iter()
        .find(|input| super::path_access::paths_refer_to_same_file(input, output))
    {
        return Err(RomWeaverError::Validation(format!(
            "playlist output and input `{}` are the same file",
            input.display()
        )));
    }
    match fs::symlink_metadata(output) {
        Ok(_) => Err(RomWeaverError::Validation(format!(
            "refusing to overwrite existing output `{}`; choose a different --output path",
            output.display()
        ))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// The playlist lines of a lone `.m3u`: each disc's file name with `--flat`, else its path
/// relative to the playlist's folder.
fn m3u_lines(args: &PlaylistCommand, discs: &[PlannedDisc], output: &Path) -> Result<Vec<String>> {
    let output_dir = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut lines = Vec::with_capacity(discs.len());
    for disc in discs {
        lines.push(if args.flat {
            file_name_of(&disc.path)
        } else {
            relative_playlist_path(output_dir, &disc.path)?
        });
    }
    Ok(lines)
}

fn check_lines_are_unique(lines: &[String]) -> Result<()> {
    if let Some(duplicate) = lines.iter().enumerate().find_map(|(index, line)| {
        lines[..index]
            .iter()
            .any(|earlier| earlier.eq_ignore_ascii_case(line))
            .then_some(line)
    }) {
        return Err(RomWeaverError::Validation(format!(
            "two discs share the name `{duplicate}`; rename one so each playlist line is unique"
        )));
    }
    Ok(())
}

/// Refuse a folder output that sits under a file or would overwrite or be blocked by an
/// existing path.
fn check_folder_output_is_free(output: &Path, entries: &[BundleEntry]) -> Result<()> {
    let folder: PathBuf = output.components().collect();
    if let Some(file) = folder
        .ancestors()
        .find(|dir| !dir.as_os_str().is_empty() && dir.exists())
        .filter(|dir| !dir.is_dir())
    {
        return Err(RomWeaverError::Validation(format!(
            "`{}` is a file, so it cannot hold the --output folder",
            file.display()
        )));
    }
    for target in entries
        .iter()
        .map(|entry| folder_target(output, &entry.path))
    {
        check_folder_target_is_free(&target)?;
    }
    Ok(())
}

fn check_folder_target_is_free(target: &Path) -> Result<()> {
    if fs::symlink_metadata(target).is_ok() {
        return Err(RomWeaverError::Validation(format!(
            "refusing to overwrite existing `{}`; choose a different --output folder",
            target.display()
        )));
    }
    // A file where the game's or a disc's folder goes would stop the copy midway.
    if let Some(file) = target
        .ancestors()
        .skip(1)
        .find(|dir| !dir.as_os_str().is_empty() && dir.exists())
        .filter(|dir| !dir.is_dir())
    {
        return Err(RomWeaverError::Validation(format!(
            "`{}` is a file, so it cannot hold `{}`; choose a different --output folder",
            file.display(),
            target.display()
        )));
    }
    Ok(())
}

fn check_entries_are_readable(entries: &[BundleEntry]) -> Result<()> {
    for entry in entries {
        if let BundleSource::File(source) = &entry.source {
            // Name an unreadable disc file before anything is written.
            fs::File::open(source).io_op(IoOp::Open, source)?;
        }
    }
    Ok(())
}

pub(super) fn playlist_failure(error: RomWeaverError) -> OperationReport {
    OperationReport::failed_with_error(
        OperationFamily::Command,
        Some(PLAYLIST_FORMAT.to_string()),
        "playlist",
        error,
        None,
    )
}

/// Copy a folder output's files under `folder`, never replacing a file. A failed or cancelled
/// run removes the files and folders it made, so no partial game is left behind.
fn write_playlist_folder(
    folder: &Path,
    targets: &[PathBuf],
    entries: &[BundleEntry],
) -> Result<()> {
    let token = rom_weaver_core::process_cancellation_token();
    let mut made_dirs: Vec<PathBuf> = Vec::new();
    let mut made_files: Vec<&Path> = Vec::new();
    let result = (|| -> Result<()> {
        for (entry, target) in entries.iter().zip(targets) {
            let parent = target.parent().unwrap_or(folder);
            let missing: Vec<PathBuf> = parent
                .ancestors()
                .take_while(|dir| !dir.as_os_str().is_empty() && !dir.exists())
                .map(Path::to_path_buf)
                .collect();
            fs::create_dir_all(parent).io_op(IoOp::CreateDir, parent)?;
            made_dirs.extend(missing);
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .io_op(IoOp::Create, target)?;
            // A forced second Ctrl-C exits without unwinding; the registry still removes this.
            rom_weaver_core::register_in_progress_output(target);
            made_files.push(target.as_path());
            match &entry.source {
                BundleSource::Text(text) | BundleSource::Sheet { text, .. } => {
                    io::Write::write_all(&mut file, text.as_bytes()).io_op(IoOp::Write, target)?;
                }
                BundleSource::File(source) => {
                    let mut source = fs::File::open(source).io_op(IoOp::Open, source)?;
                    rom_weaver_core::copy_cancelable(&mut source, &mut file, &token).map_err(
                        |error| match error {
                            RomWeaverError::Io(error) => {
                                RomWeaverError::io_path(IoOp::Write, target, error)
                            }
                            other => other,
                        },
                    )?;
                }
            }
        }
        token.check()
    })();
    if result.is_ok() {
        for file in &made_files {
            rom_weaver_core::complete_in_progress_output(file);
        }
    } else {
        for file in &made_files {
            let _ = fs::remove_file(file);
        }
        // Deepest first, so each folder is empty when it is removed.
        made_dirs.sort_by_key(|dir| std::cmp::Reverse(dir.components().count()));
        for dir in &made_dirs {
            let _ = fs::remove_dir(dir);
        }
    }
    result
}

impl CliApp {
    pub(super) fn run_playlist(&self, args: PlaylistCommand) -> AppRunOutcome {
        let command = "playlist";
        for input in &args.input {
            if let Some(report) =
                self.require_readable_file(OperationFamily::Command, None, input, None)
            {
                return self.finish(command, report);
            }
        }
        let report = self.build_playlist(&args).unwrap_or_else(playlist_failure);
        self.finish(command, report)
    }

    fn build_playlist(&self, args: &PlaylistCommand) -> Result<OperationReport> {
        if args.rename_in_place {
            return Err(RomWeaverError::Validation(
                "renaming in place runs only as a dry run; the browser renames the files"
                    .to_string(),
            ));
        }
        let job = plan_job(args)?;
        let thread_execution = None;
        self.emit_running(
            OperationLabel {
                command: "playlist",
                family: OperationFamily::Command,
                format: Some(PLAYLIST_FORMAT),
            },
            "playlist",
            format!("writing playlist of {} disc(s)", job.lines.len()),
            None,
            thread_execution.clone(),
        );
        let writes = job.writes();
        if job.kind == PlaylistOutput::Folder {
            write_playlist_folder(&job.output, &writes, &job.entries)?;
        } else {
            // The ZIP writer's errors name no path, so a denied folder is reported here first.
            let parent = job
                .output
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            super::path_access::check_writable_dir(parent)?;
            // `plan_job` refused an existing output, so a cancelled run may remove this one.
            rom_weaver_core::register_in_progress_output(&job.output);
            if job.kind == PlaylistOutput::Zip {
                self.write_playlist_zip(&job)?;
            } else {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&job.output)
                    .io_op(IoOp::Create, &job.output)?;
                io::Write::write_all(&mut file, render_m3u(&job.lines).as_bytes())
                    .io_op(IoOp::Write, &job.output)?;
            }
            // A Ctrl-C after the last write ends the run here, and the registry removes the
            // output, so a cancelled run never keeps it.
            rom_weaver_core::process_cancellation_token().check()?;
            rom_weaver_core::complete_in_progress_output(&job.output);
        }
        let playlist = match job.kind {
            PlaylistOutput::Folder => &writes[0],
            _ => &job.output,
        };
        let mut report = OperationReport::succeeded(
            OperationFamily::Command,
            Some(PLAYLIST_FORMAT.to_string()),
            "playlist",
            format!(
                "wrote `{}` listing {} disc(s)",
                playlist.display(),
                job.lines.len()
            ),
            Some(100.0),
            thread_execution,
        );
        report.details = Some(json!({ "playlist": { "entries": job.lines } }));
        Ok(Self::attach_emitted_files_details(
            report,
            writes,
            match job.kind {
                PlaylistOutput::M3u => Some("playlist"),
                PlaylistOutput::Zip => Some("archive"),
                PlaylistOutput::Folder => None,
            },
        ))
    }

    fn write_playlist_zip(&self, job: &PlaylistJob) -> Result<()> {
        let context = self.context(ThreadBudget::default());
        let mut staged = Vec::new();
        let result = (|| {
            let mut inputs = Vec::with_capacity(job.entries.len());
            for entry in &job.entries {
                inputs.push(match &entry.source {
                    BundleSource::File(path) => path.clone(),
                    BundleSource::Text(text) | BundleSource::Sheet { text, .. } => {
                        let extension = Path::new(&entry.path)
                            .extension()
                            .and_then(|extension| extension.to_str());
                        let path = context.temp_paths().next_path("playlist", extension);
                        if let Some(parent) = path.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        staged.push(path.clone());
                        fs::write(&path, text)?;
                        path
                    }
                });
            }
            let handler = self.containers.find_creatable_by_name("zip")?;
            let request = ContainerCreateRequest {
                inputs,
                archive_names: Some(job.entries.iter().map(|entry| entry.path.clone()).collect()),
                output: job.output.clone(),
                format: handler.descriptor().name.to_string(),
                codec: None,
                level: None,
                rvz_block_size: None,
                parent: None,
            };
            handler.create(&request, &context).map(|_| ())
        })();
        for path in &staged {
            let _ = fs::remove_file(path);
        }
        if result.is_err() {
            // `plan_job` refused an existing output, so a file here is this run's partial ZIP.
            let _ = fs::remove_file(&job.output);
        }
        result
    }
}

#[cfg(test)]
#[path = "../tests/unit/playlist.rs"]
mod tests;
