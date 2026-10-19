//! `playlist`: build an `.m3u` disc-change playlist for a multi-disc game.
//!
//! The ordering and playlist-text helpers are pure so the native CLI and the
//! browser (the same code compiled to WASM) produce identical playlists.

use std::cmp::Ordering;
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

/// The name the browser stages a file under: `normalizeVirtualFileName` runs
/// twice (once building the source ref with the `disc.bin` fallback, again in
/// `createVirtualInputPath` with `input.bin`), so `ときめき.bin` goes `_.bin` ->
/// `bin`. Each pass turns runs of its characters into one `_` (a run of non-ASCII
/// next to a reserved character gives `__`) and drops leading dots and edge
/// whitespace or `_`; an empty result takes the pass's fallback. A sheet that
/// names `Pokémon.bin` still finds the staged `Pok_mon.bin`.
pub(crate) fn staged_file_name(name: &str) -> String {
    let first = normalize_virtual_file_name(name, "disc.bin");
    normalize_virtual_file_name(&first, "input.bin")
}

fn normalize_virtual_file_name(name: &str, fallback: &str) -> String {
    let name = if name.is_empty() { fallback } else { name };
    // Plain function pointers: one shared `replace_runs` body, not one copy per pass.
    let passes: [fn(char) -> bool; 4] = [
        |ch| matches!(ch, '\\' | '/'),
        |ch| ch.is_ascii_control(),
        |ch| !(' '..='~').contains(&ch),
        |ch| matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|'),
    ];
    let mut out = name.to_string();
    for pass in passes {
        out = replace_runs(&out, pass);
    }
    let trimmed = out
        .trim_start_matches('.')
        .trim_matches(|ch: char| ch == '_' || ch.is_whitespace());
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Replace each maximal run of characters matching `pred` with one `_`.
fn replace_runs(text: &str, pred: fn(char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for ch in text.chars() {
        if pred(ch) {
            if !in_run {
                out.push('_');
            }
            in_run = true;
        } else {
            out.push(ch);
            in_run = false;
        }
    }
    out
}

/// A track file a sheet names, as it sits next to the sheet: under the exact
/// name, or else under its [`staged_file_name`] form.
fn sheet_track_path(sheet_dir: &Path, archive_name: &str) -> PathBuf {
    let exact = sheet_dir.join(archive_name);
    if exact.is_file() {
        return exact;
    }
    let (folder, name) = archive_name
        .rsplit_once('/')
        .map_or(("", archive_name), |(folder, name)| (folder, name));
    let staged = sheet_dir.join(folder).join(staged_file_name(name));
    if staged.is_file() { staged } else { exact }
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
    let mut found = Vec::new();
    for extension in wanted {
        for cased in [extension.to_string(), extension.to_ascii_uppercase()] {
            let name = format!("{stem}.{cased}");
            if dir.join(&name).is_file() {
                found.push((dir.join(&name), name));
            }
        }
    }
    found
}

/// Drop inputs that a disc sheet among the inputs already names (a `.cue`/`.gdi`
/// track file, or the data files stored with a `.ccd`/`.mds`), and collect
/// those named files as companions. Only a ZIP reads or copies companions, so
/// only a ZIP refuses names that point outside the sheet's folder.
fn plan_playlist(inputs: &[PathBuf], sort: bool, zip: bool) -> Result<PlaylistPlan> {
    let mut named: Vec<String> = Vec::new();
    let mut companions = Vec::new();
    for input in inputs {
        for (path, name) in image_companions(input) {
            named.push(name.to_ascii_lowercase());
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
            let track_name = file_name_of(Path::new(&archive_name));
            named.push(track_name.to_ascii_lowercase());
            named.push(staged_file_name(&track_name).to_ascii_lowercase());
            if zip {
                companions.push((sheet_track_path(sheet_dir, &archive_name), archive_name));
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
        if let Some(index) = names
            .iter()
            .position(|taken| taken.eq_ignore_ascii_case(&name))
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
        let relative = output_kind == PlaylistOutput::M3u && !args.flat;
        let mut entries = Vec::with_capacity(plan.discs.len());
        for disc in &plan.discs {
            entries.push(if relative {
                relative_playlist_path(&output_dir, disc)?
            } else {
                file_name_of(disc)
            });
        }
        if let Some(duplicate) = entries.iter().enumerate().find_map(|(index, entry)| {
            entries[..index]
                .iter()
                .any(|earlier| earlier.eq_ignore_ascii_case(entry))
                .then_some(entry)
        }) {
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
