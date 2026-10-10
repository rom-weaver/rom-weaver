use rom_weaver_containers::libarchive::RegularArchiveFileEntry;

use super::weave_parse::{
    WEAVE_BASE_FILE_NAME, is_weave_json_candidate, weave_bytes_are_valid, weave_file_name_codec,
    weave_validation,
};
use super::*;

/// Limit plain and decompressed weave JSON to bound metadata allocations.
pub(crate) const WEAVE_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Container-registry format names that are single-payload stream codecs.
const STREAM_CODEC_FORMAT_NAMES: [&str; 4] = ["gz", "bz2", "xz", "zst"];

pub(crate) fn is_stream_codec_format_name(name: &str) -> bool {
    STREAM_CODEC_FORMAT_NAMES
        .iter()
        .any(|codec| codec.eq_ignore_ascii_case(name))
}

/// A weave's raw JSON bytes plus where they came from.
pub(crate) struct LoadedWeaveSource {
    pub bytes: Vec<u8>,
    pub kind: WeaveSourceKind,
    /// Container-registry format name when `kind` is `Archive`.
    pub archive_format: Option<&'static str>,
    /// Entry name of the weave member when `kind` is `Archive`.
    pub archive_member: Option<String>,
    /// Full entry listing when `kind` is `Archive` (reused to resolve `path`
    /// entries without re-listing).
    pub archive_entries: Vec<RegularArchiveFileEntry>,
    pub warnings: Vec<String>,
}

/// Forward-slash-normalize an archive entry name for comparisons.
fn normalize_entry_name(name: &str) -> String {
    let normalized = name.replace('\\', "/");
    normalized
        .strip_prefix("./")
        .map(str::to_owned)
        .unwrap_or(normalized)
}

impl CliApp {
    /// Load weave JSON bytes from `source`: a plain JSON file (any name - its
    /// bytes are read verbatim and validated by the caller), a
    /// stream-codec-compressed one (`rom-weaver-weave.json.gz`/`.bz2`/`.xz`/`.zst`), or an
    /// archive carrying a weave at its root. Inside archives a root-level
    /// `rom-weaver-weave.json` is the trusted fast-path; failing that, every
    /// other root-level `*.json` is content-probed and the first that validates
    /// as a weave wins (so pre-rename `rw.json` archives keep working).
    pub(super) fn load_weave_source(&self, source: &Path) -> Result<LoadedWeaveSource> {
        let Some(handler) = self.containers.probe(source) else {
            let size = fs::metadata(source)?.len();
            if size > WEAVE_MAX_BYTES {
                return Err(weave_too_large(source.to_string_lossy().as_ref(), size));
            }
            trace!(source = %source.display(), size, "loading plain weave file");
            return Ok(LoadedWeaveSource {
                bytes: fs::read(source)?,
                kind: WeaveSourceKind::Json,
                archive_format: None,
                archive_member: None,
                archive_entries: Vec::new(),
                warnings: Vec::new(),
            });
        };

        let format_name = handler.descriptor().name;
        if is_stream_codec_format_name(format_name) {
            let filter = Self::libarchive_read_filter_for_stream_format(format_name)?;
            trace!(
                source = %source.display(),
                format = format_name,
                "loading stream-codec-compressed weave"
            );
            let bytes = with_raw_stream_reader(source, format_name, filter, 64 * 1024, |reader| {
                read_weave_bytes_capped(reader, source.to_string_lossy().as_ref())
            })?;
            return Ok(LoadedWeaveSource {
                bytes,
                kind: WeaveSourceKind::CompressedJson,
                archive_format: None,
                archive_member: None,
                archive_entries: Vec::new(),
                warnings: Vec::new(),
            });
        }

        let entries = list_regular_archive_file_entries(source, format_name)?;
        let mut warnings = Vec::new();
        // A root-level `rom-weaver-weave.json` is the trusted fast-path: its
        // name alone marks it, and its own parse errors surface downstream.
        // Any other root-level `*.json` is only a *candidate* - it is read and
        // must parse+validate as a weave to be accepted (content probing), so
        // pre-rename `rw.json` weaves and other names keep working without
        // misclassifying a stray JSON.
        let read_member = |entry: &RegularArchiveFileEntry| -> Result<Vec<u8>> {
            with_regular_archive_file_entry_reader(
                source,
                format_name,
                entry.index,
                &entry.name,
                |reader| read_weave_bytes_capped(reader, &entry.name),
            )
        };

        let mut root_canonical: Option<&RegularArchiveFileEntry> = None;
        let mut root_candidates: Vec<&RegularArchiveFileEntry> = Vec::new();
        for entry in &entries {
            let normalized = normalize_entry_name(&entry.name);
            let (directory, base_name) = match normalized.rsplit_once('/') {
                Some((directory, base_name)) => (Some(directory), base_name),
                None => (None, normalized.as_str()),
            };
            if let Some(codec) = weave_file_name_codec(base_name) {
                if directory.is_some() {
                    warnings.push(format!(
                        "ignoring `{}`: only a root-level rom-weaver-weave.json is recognized",
                        entry.name
                    ));
                    continue;
                }
                if codec.is_some() {
                    return Err(weave_validation(
                        "bundle.member.unsupported",
                        "compressed weave members inside archives are not supported; store rom-weaver-weave.json uncompressed",
                    ));
                }
                if let Some(existing) = root_canonical {
                    let prefer_new = base_name.eq_ignore_ascii_case(WEAVE_BASE_FILE_NAME)
                        && !normalize_entry_name(&existing.name)
                            .eq_ignore_ascii_case(WEAVE_BASE_FILE_NAME);
                    let (ignored, selected) = if prefer_new {
                        (existing, entry)
                    } else {
                        (entry, existing)
                    };
                    let selected_name = normalize_entry_name(&selected.name);
                    let ignored_name = normalize_entry_name(&ignored.name);
                    let identical_legacy_alias = selected_name
                        .eq_ignore_ascii_case(WEAVE_BASE_FILE_NAME)
                        && ignored_name.eq_ignore_ascii_case("rom-weaver-bundle.json")
                        && matches!((read_member(selected), read_member(ignored)), (Ok(selected), Ok(ignored)) if selected == ignored);
                    if !identical_legacy_alias {
                        warnings.push(format!(
                            "ignoring extra weave member `{}`: using `{}`",
                            ignored.name, selected.name
                        ));
                    }
                    root_canonical = Some(selected);
                    continue;
                }
                root_canonical = Some(entry);
            } else if directory.is_none() && is_weave_json_candidate(base_name) {
                root_candidates.push(entry);
            }
        }

        let (member, bytes) = if let Some(entry) = root_canonical {
            trace!(
                source = %source.display(),
                format = format_name,
                member = %entry.name,
                entries = entries.len(),
                "loading canonical weave member from archive"
            );
            (entry, read_member(entry)?)
        } else {
            // No canonical name: content-probe each root-level `*.json`, in
            // listing order, and take the first that validates as a weave.
            let mut chosen: Option<(&RegularArchiveFileEntry, Vec<u8>)> = None;
            for candidate in &root_candidates {
                let bytes = read_member(candidate)?;
                if weave_bytes_are_valid(&bytes) {
                    trace!(
                        source = %source.display(),
                        format = format_name,
                        member = %candidate.name,
                        "content-probed weave member from archive"
                    );
                    chosen = Some((candidate, bytes));
                    break;
                }
                trace!(
                    source = %source.display(),
                    member = %candidate.name,
                    "skipping JSON member: not a valid weave"
                );
            }
            let Some((entry, bytes)) = chosen else {
                return Err(RomWeaverError::ValidationCode(
                    rom_weaver_core::ValidationCodeError::new("bundle.missing")
                        .with_message("archive contains no rom-weaver-weave.json weave at its root")
                        .with_field("source", source.to_string_lossy().into_owned()),
                ));
            };
            (entry, bytes)
        };

        let archive_member = Some(member.name.clone());
        Ok(LoadedWeaveSource {
            bytes,
            kind: WeaveSourceKind::Archive,
            archive_format: Some(format_name),
            archive_member,
            archive_entries: entries,
            warnings,
        })
    }

    /// Find the archive entry a weave `path` value refers to.
    pub(super) fn find_weave_archive_entry<'entries>(
        entries: &'entries [RegularArchiveFileEntry],
        path: &str,
    ) -> Option<&'entries RegularArchiveFileEntry> {
        let wanted = normalize_entry_name(path);
        entries
            .iter()
            .find(|entry| normalize_entry_name(&entry.name) == wanted)
            .or_else(|| {
                entries
                    .iter()
                    .find(|entry| normalize_entry_name(&entry.name).eq_ignore_ascii_case(&wanted))
            })
    }

    /// Extract one weave-referenced archive member below `extract_dir`,
    /// preserving its (validated-relative) archive path.
    pub(super) fn extract_weave_archive_member(
        archive: &Path,
        format_name: &str,
        entry: &RegularArchiveFileEntry,
        extract_dir: &Path,
    ) -> Result<PathBuf> {
        let target = weave_archive_target(entry, extract_dir)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        // Recheck after creating parents; create_new also protects existing and
        // dangling-symlink leaf destinations atomically.
        weave_archive_target(entry, extract_dir)?;
        let mut outputs = WeaveOutputGuard::default();
        with_regular_archive_file_entry_reader(
            archive,
            format_name,
            entry.index,
            &entry.name,
            |reader| {
                let mut file = outputs.create(&target)?;
                io::copy(reader, &mut file)?;
                file.flush()?;
                Ok(())
            },
        )?;
        outputs.commit();
        trace!(
            archive = %archive.display(),
            member = %entry.name,
            target = %target.display(),
            "extracted weave-referenced archive member"
        );
        Ok(target)
    }
}

/// Validate the actual archive name, not only the manifest reference. Never
/// follow a symlink at the output root, within it, or at the destination leaf.
/// Ancestors of the user-supplied root may be platform aliases (e.g. macOS /tmp).
pub(super) fn weave_archive_target(
    entry: &RegularArchiveFileEntry,
    extract_dir: &Path,
) -> Result<PathBuf> {
    let normalized = normalize_entry_name(&entry.name);
    let relative = Path::new(&normalized);
    if normalized.is_empty()
        || normalized.contains(':')
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(weave_validation(
            "bundle.path.invalid",
            "weave archive member must have a safe relative path",
        ));
    }
    // Trailing separators and dots make symlink_metadata follow a root symlink.
    // Components remove those aliases while preserving parent traversal.
    let extract_dir: PathBuf = extract_dir.components().collect();
    let target = extract_dir.join(relative);
    let mut current = extract_dir;
    check_weave_destination(&current, false)?;
    for component in relative.components() {
        current.push(component);
        check_weave_destination(&current, current == target)?;
    }
    Ok(target)
}

fn check_weave_destination(path: &Path, leaf: bool) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(RomWeaverError::Validation(
            format!("refusing symlink weave output `{}`", path.display()),
        )),
        Ok(_) if leaf => Err(RomWeaverError::Validation(format!(
            "refusing to overwrite existing weave output `{}`",
            path.display()
        ))),
        Ok(metadata) if !metadata.is_dir() => Err(RomWeaverError::Validation(format!(
            "weave output parent is not a directory: `{}`",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Roll back only files this operation created, never pre-existing outputs.
/// Empty directories can remain after failure; extraction is not a filesystem
/// transaction against other processes concurrently changing directory entries.
#[derive(Default)]
pub(super) struct WeaveOutputGuard {
    paths: Vec<PathBuf>,
}

impl WeaveOutputGuard {
    pub(super) fn create(&mut self, target: &Path) -> Result<File> {
        let file = rom_weaver_core::create_extract_output_file(target, false)?;
        self.paths.push(target.to_path_buf());
        Ok(file)
    }

    pub(super) fn commit(mut self) {
        self.paths.clear();
    }
}

impl Drop for WeaveOutputGuard {
    fn drop(&mut self) {
        for path in self.paths.iter().rev() {
            let _ = fs::remove_file(path);
        }
    }
}

fn weave_too_large(label: &str, size: u64) -> RomWeaverError {
    RomWeaverError::ValidationCode(
        rom_weaver_core::ValidationCodeError::new("bundle.parse")
            .with_message("weave exceeds the maximum supported size")
            .with_field("source", label.to_owned())
            .with_field("size", size)
            .with_field("limit", WEAVE_MAX_BYTES),
    )
}

fn read_weave_bytes_capped(reader: &mut dyn Read, label: &str) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(WEAVE_MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > WEAVE_MAX_BYTES {
        return Err(weave_too_large(label, bytes.len() as u64));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(index: usize, name: &str) -> RegularArchiveFileEntry {
        RegularArchiveFileEntry {
            index,
            name: name.to_string(),
            size: None,
        }
    }

    #[test]
    fn find_weave_archive_entry_normalizes_and_falls_back_case_insensitively() {
        let entries = vec![entry(3, "./roms\\Game.BIN"), entry(7, "readme.txt")];

        assert_eq!(
            CliApp::find_weave_archive_entry(&entries, "roms/Game.BIN")
                .expect("normalized archive path should match")
                .index,
            3
        );
        assert_eq!(
            CliApp::find_weave_archive_entry(&entries, "ROMS/game.bin")
                .expect("archive path lookup should ignore case")
                .index,
            3
        );
        assert!(CliApp::find_weave_archive_entry(&entries, "roms/missing.bin").is_none());
    }
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn weave_output_guard_removes_only_new_files_on_failure() {
        let temp = assert_fs::TempDir::new().expect("temp directory");
        let existing = temp.path().join("existing");
        let created = temp.path().join("created");
        fs::write(&existing, b"keep").expect("existing file");
        {
            let mut guard = WeaveOutputGuard::default();
            guard
                .create(&created)
                .expect("new file")
                .write_all(b"partial")
                .expect("partial write");
            assert!(guard.create(&existing).is_err());
        }
        assert!(!created.exists());
        assert_eq!(fs::read(existing).expect("existing file"), b"keep");
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn weave_output_rejects_unsafe_archive_names() {
        let temp = assert_fs::TempDir::new().expect("temp directory");
        for name in ["../escape", "/absolute", "C:/drive", "a/../../escape", ""] {
            assert!(
                weave_archive_target(&entry(0, name), temp.path()).is_err(),
                "{name}"
            );
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn weave_output_accepts_dot_prefix_and_normalized_separators() {
        let temp = assert_fs::TempDir::new().expect("temp directory");
        assert_eq!(
            weave_archive_target(&entry(0, "./patches\\main.ips"), temp.path()).expect("safe path"),
            temp.path().join("patches/main.ips"),
        );
    }
}
