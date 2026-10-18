//! `playlist`: build an `.m3u` disc-change playlist for a multi-disc game.
//!
//! The ordering and playlist-text helpers are pure so the native CLI and the
//! browser (the same code compiled to WASM) produce identical playlists.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use super::*;

const PLAYLIST_FORMAT: &str = "m3u";

/// The disc number a file name carries, if any.
///
/// Recognizes `Disc 1`, `(Disc 2)`, `[Disk 3]`, `CD1`, `Disc_4`, and the
/// `.disc02` suffix rom-weaver writes when it extracts a multi-disc PBP. The
/// keyword must start a word, so `Abcd1` is not a disc. The final extension is
/// ignored.
pub(crate) fn disc_number(file_name: &str) -> Option<u32> {
    let stem = match file_name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.contains(' ') => stem,
        _ => file_name,
    };
    let lowered = stem.to_ascii_lowercase();
    let bytes = lowered.as_bytes();
    let mut best = None;
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
                && best.is_none_or(|(position, _)| start < position)
            {
                best = Some((start, number));
            }
        }
    }
    best.map(|(_, number)| number)
}

/// Compare names so `Disc 2` sorts before `Disc 10`.
fn natural_cmp(left: &str, right: &str) -> Ordering {
    let (left, right) = (left.to_ascii_lowercase(), right.to_ascii_lowercase());
    let (mut left, mut right) = (left.chars().peekable(), right.chars().peekable());
    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b)) if a.is_ascii_digit() && b.is_ascii_digit() => {
                let take = |chars: &mut std::iter::Peekable<std::str::Chars<'_>>| {
                    let mut digits = String::new();
                    while let Some(&digit) = chars.peek().filter(|c| c.is_ascii_digit()) {
                        digits.push(digit);
                        chars.next();
                    }
                    digits.trim_start_matches('0').to_string()
                };
                let (a, b) = (take(&mut left), take(&mut right));
                let order = a.len().cmp(&b.len()).then_with(|| a.cmp(&b));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(a), Some(b)) => {
                if a != b {
                    return a.cmp(&b);
                }
                left.next();
                right.next();
            }
        }
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Order disc files by their disc number; unnumbered files follow, and ties
/// fall back to a natural name order.
pub(crate) fn order_discs(mut discs: Vec<PathBuf>) -> Vec<PathBuf> {
    discs.sort_by(|left, right| {
        let (left_name, right_name) = (file_name_of(left), file_name_of(right));
        let left_number = disc_number(&left_name).unwrap_or(u32::MAX);
        let right_number = disc_number(&right_name).unwrap_or(u32::MAX);
        left_number
            .cmp(&right_number)
            .then_with(|| natural_cmp(&left_name, &right_name))
    });
    discs
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum PlaylistOutput {
    M3u,
    Zip,
}

impl PlaylistOutput {
    fn from_path(path: &Path) -> Result<Self> {
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase);
        match extension.as_deref() {
            Some("m3u" | "m3u8") => Ok(Self::M3u),
            Some("zip") => Ok(Self::Zip),
            _ => Err(RomWeaverError::Validation(format!(
                "playlist --output `{}` must end in .m3u (playlist alone) or .zip (playlist with its discs)",
                path.display()
            ))),
        }
    }
}

/// The discs a playlist lists plus every file a disc depends on.
struct PlaylistPlan {
    /// Disc files that become playlist lines, in playlist order.
    discs: Vec<PathBuf>,
    /// Files a `.cue`/`.gdi` names, with the archive-relative name to store them under.
    companions: Vec<(PathBuf, String)>,
}

/// The data files a `.ccd`/`.mds` image descriptor is stored with (`.img` and
/// `.sub`, or `.mdf`), as they sit next to it. Only files that exist count.
fn image_companions(input: &Path) -> Vec<(PathBuf, String)> {
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
    wanted
        .iter()
        .flat_map(|extension| [extension.to_string(), extension.to_ascii_uppercase()])
        .map(|extension| format!("{stem}.{extension}"))
        .filter(|name| dir.join(name).is_file())
        .map(|name| (dir.join(&name), name))
        .collect()
}

/// Drop inputs that a disc sheet among the inputs already names (a `.cue`/`.gdi`
/// track file, or the data files stored with a `.ccd`/`.mds`), and collect
/// those named files as companions. Only a ZIP reads or copies companions, so
/// only a ZIP refuses names that point outside the sheet's folder.
fn plan_playlist(inputs: &[PathBuf], sort: bool, zip: bool) -> Result<PlaylistPlan> {
    let mut named: HashSet<String> = HashSet::new();
    let mut companions = Vec::new();
    for input in inputs {
        for (path, name) in image_companions(input) {
            named.insert(name.to_ascii_lowercase());
            companions.push((path, name));
        }
        if detect_disc_sheet(input).is_none() {
            continue;
        }
        let refs = enumerate_disc_sheet_refs(input)?;
        let sheet_dir = input.parent().unwrap_or_else(|| Path::new(""));
        for reference in refs.referenced_files {
            let archive_name = reference.replace('\\', "/");
            let escapes = Path::new(&archive_name).is_absolute()
                || archive_name.split('/').any(|part| part == "..");
            if escapes && zip {
                return Err(RomWeaverError::Validation(format!(
                    "`{}` names `{reference}`, which is outside the sheet's folder",
                    input.display()
                )));
            }
            named.insert(file_name_of(Path::new(&archive_name)).to_ascii_lowercase());
            if zip {
                companions.push((sheet_dir.join(&archive_name), archive_name));
            }
        }
    }
    let mut discs = Vec::new();
    for input in inputs {
        let name = file_name_of(input).to_ascii_lowercase();
        if detect_disc_sheet(input).is_none() && named.contains(&name) {
            trace!(input = %input.display(), "playlist input is a track file of a given sheet");
            continue;
        }
        if !discs.contains(input) {
            discs.push(input.clone());
        }
    }
    if discs.is_empty() {
        return Err(RomWeaverError::Validation(
            "playlist needs at least one disc file".to_string(),
        ));
    }
    if sort {
        discs = order_discs(discs);
    }
    Ok(PlaylistPlan { discs, companions })
}

/// Pair each source with its archive name, merging a file listed twice and
/// rejecting two different files that would share a name.
fn unique_zip_entries(
    items: impl Iterator<Item = (PathBuf, String)>,
) -> Result<(Vec<PathBuf>, Vec<String>)> {
    let mut inputs: Vec<PathBuf> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for (source, name) in items {
        let key = name.to_ascii_lowercase();
        if let Some(index) = names
            .iter()
            .position(|taken| taken.to_ascii_lowercase() == key)
        {
            if super::patch_apply::paths_refer_to_same_file(&inputs[index], &source) {
                continue;
            }
            return Err(RomWeaverError::Validation(format!(
                "two files would be stored as `{name}` in the zip; rename one of them"
            )));
        }
        if !source.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "`{}` is missing; a disc sheet names it",
                source.display()
            )));
        }
        inputs.push(source);
        names.push(name);
    }
    Ok((inputs, names))
}

impl CliApp {
    pub(super) fn run_playlist(&self, args: PlaylistCommand) -> AppRunOutcome {
        let command = "playlist";
        let report = self.build_playlist(&args).unwrap_or_else(|error| {
            OperationReport::failed_with_error(
                OperationFamily::Command,
                Some(PLAYLIST_FORMAT.to_string()),
                "playlist",
                error,
                None,
            )
        });
        self.finish(command, report)
    }

    fn build_playlist(&self, args: &PlaylistCommand) -> Result<OperationReport> {
        let output_kind = PlaylistOutput::from_path(&args.output)?;
        for input in &args.input {
            if !input.is_file() {
                return Err(RomWeaverError::Validation(format!(
                    "playlist input `{}` is not a readable file",
                    input.display()
                )));
            }
            if super::patch_apply::paths_refer_to_same_file(input, &args.output) {
                return Err(RomWeaverError::Validation(format!(
                    "playlist output and input `{}` are the same file",
                    input.display()
                )));
            }
        }
        match fs::symlink_metadata(&args.output) {
            Ok(_) => {
                return Err(RomWeaverError::Validation(format!(
                    "refusing to overwrite existing output `{}`; choose a different --output path",
                    args.output.display()
                )));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let plan = plan_playlist(
            &args.input,
            !args.no_sort,
            output_kind == PlaylistOutput::Zip,
        )?;
        trace!(
            discs = plan.discs.len(),
            companions = plan.companions.len(),
            sorted = !args.no_sort,
            "planned playlist"
        );
        let output_dir = args
            .output
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map_or_else(|| PathBuf::from("."), Path::to_path_buf);
        let entries = match output_kind {
            PlaylistOutput::M3u if !args.flat => plan
                .discs
                .iter()
                .map(|disc| relative_playlist_path(&output_dir, disc))
                .collect::<Result<Vec<_>>>()?,
            PlaylistOutput::M3u | PlaylistOutput::Zip => {
                plan.discs.iter().map(|disc| file_name_of(disc)).collect()
            }
        };
        let mut seen = HashSet::new();
        if let Some(duplicate) = entries
            .iter()
            .find(|entry| !seen.insert(entry.to_ascii_lowercase()))
        {
            return Err(RomWeaverError::Validation(format!(
                "two discs share the name `{duplicate}`; rename one so each playlist line is unique"
            )));
        }
        let playlist_text = render_m3u(&entries);
        fs::create_dir_all(&output_dir)?;
        let thread_execution = None;
        self.emit_running(
            OperationLabel {
                command: "playlist",
                family: OperationFamily::Command,
                format: Some(PLAYLIST_FORMAT),
            },
            "playlist",
            format!("writing playlist of {} disc(s)", entries.len()),
            None,
            thread_execution.clone(),
        );
        match output_kind {
            PlaylistOutput::M3u => {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&args.output)?;
                io::Write::write_all(&mut file, playlist_text.as_bytes())?;
            }
            PlaylistOutput::Zip => self.write_playlist_zip(args, &plan, &playlist_text)?,
        }
        let mut report = OperationReport::succeeded(
            OperationFamily::Command,
            Some(PLAYLIST_FORMAT.to_string()),
            "playlist",
            format!(
                "wrote `{}` listing {} disc(s)",
                args.output.display(),
                entries.len()
            ),
            Some(100.0),
            thread_execution,
        );
        report.details = Some(json!({ "playlist": { "entries": entries } }));
        Ok(Self::attach_emitted_files_details(
            report,
            vec![args.output.clone()],
            Some(match output_kind {
                PlaylistOutput::M3u => "playlist",
                PlaylistOutput::Zip => "archive",
            }),
        ))
    }

    fn write_playlist_zip(
        &self,
        args: &PlaylistCommand,
        plan: &PlaylistPlan,
        playlist_text: &str,
    ) -> Result<()> {
        let stem = args
            .output
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| "playlist".to_string());
        let playlist_name = format!("{stem}.m3u");
        let context = self.context(ThreadBudget::default());
        let staged = context.temp_paths().next_path("playlist", Some("m3u"));
        if let Some(parent) = staged.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&staged, playlist_text)?;
        let result = (|| {
            let items = std::iter::once((staged.clone(), playlist_name))
                .chain(
                    plan.discs
                        .iter()
                        .map(|disc| (disc.clone(), file_name_of(disc))),
                )
                .chain(plan.companions.iter().cloned());
            let (inputs, names) = unique_zip_entries(items)?;
            let handler = self.containers.find_creatable_by_name("zip")?;
            let request = ContainerCreateRequest {
                inputs,
                archive_names: Some(names),
                output: args.output.clone(),
                format: handler.descriptor().name.to_string(),
                codec: None,
                level: None,
                parent: None,
            };
            handler.create(&request, &context).map(|_| ())
        })();
        let _ = fs::remove_file(&staged);
        result
    }
}

#[cfg(test)]
#[path = "../tests/unit/playlist.rs"]
mod tests;
