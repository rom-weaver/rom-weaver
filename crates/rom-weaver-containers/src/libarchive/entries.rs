use super::*;
use tracing::trace;

const REGULAR_ARCHIVE_READ_BLOCK_BYTES: usize = 2 * 1024 * 1024;
#[derive(Clone, Debug)]
pub struct RegularArchiveFileEntry {
    pub index: usize,
    pub name: String,
    pub size: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct RegularArchiveEntryMetadata {
    pub index: usize,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct RegularArchiveProbeSummary {
    pub entries_total: usize,
    pub files: usize,
    pub directories: usize,
    pub archive_bytes: u64,
    pub logical_bytes: u64,
}

#[derive(Clone, Copy, Debug)]
pub enum RegularArchiveProbeFormat {
    Zip,
    SevenZ,
    Rar,
    Tar,
}

pub enum SelectedRegularArchiveEntry<'a> {
    Directory {
        entry: RegularArchiveEntryMetadata,
    },
    File {
        entry: RegularArchiveEntryMetadata,
        reader: &'a mut dyn Read,
    },
}
pub fn list_regular_archive_file_entries(
    source: &Path,
    format_name: &str,
) -> Result<Vec<RegularArchiveFileEntry>> {
    let mut reader = open_regular_archive_reader(source, format_name)?;
    let result = (|| -> Result<Vec<RegularArchiveFileEntry>> {
        let mut entries = Vec::new();
        let mut index = 0usize;

        while let Some(entry) = reader.next_entry().map_err(|error| {
            RomWeaverError::Validation(format!(
                "{format_name} list failed while reading entry {index}: {error}"
            ))
        })? {
            if entry.is_file() {
                let entry_path = match entry.pathname_utf8() {
                    Ok(path) => path.to_owned(),
                    Err(_) => entry
                        .pathname_mb()
                        .map(|path| path.to_string_lossy().into_owned())
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "{format_name} list failed while decoding entry {index}: {error}"
                            ))
                        })?,
                };
                if let Some(name) = normalize_archive_name(&entry_path) {
                    entries.push(RegularArchiveFileEntry {
                        index,
                        name,
                        size: entry.size(),
                    });
                }
            }
            index = index.saturating_add(1);
        }

        Ok(entries)
    })();

    match (result, close_regular_archive_reader(reader, format_name)) {
        (Ok(entries), Ok(())) => Ok(entries),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub fn probe_regular_archive_format(
    source: &Path,
    format_name: &str,
    expected: RegularArchiveProbeFormat,
) -> Result<bool> {
    Ok(regular_archive_format_matches(
        detect_regular_archive_format(source, format_name)?,
        expected,
    ))
}

pub fn probe_regular_archive(
    source: &Path,
    format_name: &str,
) -> Result<RegularArchiveProbeSummary> {
    trace!(
        format = format_name,
        source = %source.display(),
        "regular archive probe start"
    );
    let mut reader = open_regular_archive_reader(source, format_name)?;
    let result = (|| -> Result<RegularArchiveProbeSummary> {
        let mut summary = RegularArchiveProbeSummary {
            entries_total: 0,
            files: 0,
            directories: 0,
            archive_bytes: fs::metadata(source)?.len(),
            logical_bytes: 0,
        };
        let mut index = 0usize;

        while let Some(entry) = reader.next_entry().map_err(|error| {
            RomWeaverError::Validation(format!(
                "{format_name} probe failed while reading entry {index}: {error}"
            ))
        })? {
            let entry_path = match entry.pathname_utf8() {
                Ok(path) => path.to_owned(),
                Err(_) => entry
                    .pathname_mb()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "{format_name} probe failed while decoding entry {index}: {error}"
                        ))
                    })?,
            };
            if normalize_archive_name_relaxed(&entry_path).is_empty() {
                index = index.saturating_add(1);
                continue;
            }

            summary.entries_total = summary.entries_total.saturating_add(1);
            if entry.is_dir() {
                summary.directories = summary.directories.saturating_add(1);
            } else {
                summary.files = summary.files.saturating_add(1);
                if let Some(size) = entry.size() {
                    summary.logical_bytes = summary.logical_bytes.saturating_add(size);
                }
            }
            index = index.saturating_add(1);
        }

        trace!(
            format = format_name,
            entries = summary.entries_total,
            files = summary.files,
            directories = summary.directories,
            archive_bytes = summary.archive_bytes,
            logical_bytes = summary.logical_bytes,
            "regular archive probe result"
        );
        Ok(summary)
    })();

    match (result, close_regular_archive_reader(reader, format_name)) {
        (Ok(summary), Ok(())) => Ok(summary),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub fn list_regular_archive_entries(
    source: &Path,
    format_name: &str,
) -> Result<Vec<RegularArchiveEntryMetadata>> {
    trace!(
        format = format_name,
        source = %source.display(),
        "regular archive list start"
    );
    let mut reader = open_regular_archive_reader(source, format_name)?;
    let result = (|| -> Result<Vec<RegularArchiveEntryMetadata>> {
        let mut entries = Vec::new();
        let mut index = 0usize;

        while let Some(entry) = reader.next_entry().map_err(|error| {
            RomWeaverError::Validation(format!(
                "{format_name} list failed while reading entry {index}: {error}"
            ))
        })? {
            let entry_path = match entry.pathname_utf8() {
                Ok(path) => path.to_owned(),
                Err(_) => entry
                    .pathname_mb()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "{format_name} list failed while decoding entry {index}: {error}"
                        ))
                    })?,
            };
            entries.push(RegularArchiveEntryMetadata {
                index,
                is_dir: entry.is_dir() || entry_path.ends_with('/') || entry_path.ends_with('\\'),
                path: entry_path,
                size: entry.size(),
            });
            index = index.saturating_add(1);
        }

        trace!(
            format = format_name,
            entries = entries.len(),
            "regular archive list result"
        );
        Ok(entries)
    })();

    match (result, close_regular_archive_reader(reader, format_name)) {
        (Ok(entries), Ok(())) => Ok(entries),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub fn visit_selected_regular_archive_entries<F>(
    source: &Path,
    format_name: &str,
    selected_indices: &BTreeSet<usize>,
    visit_entry: F,
) -> Result<usize>
where
    F: FnMut(SelectedRegularArchiveEntry<'_>) -> Result<()>,
{
    if selected_indices.is_empty() {
        return Ok(0);
    }
    let reader = open_regular_archive_reader(source, format_name)?;
    visit_selected_regular_archive_entries_with_reader(
        reader,
        format_name,
        selected_indices,
        visit_entry,
    )
}

fn visit_selected_regular_archive_entries_with_reader<F>(
    mut reader: ReadArchive,
    format_name: &str,
    selected_indices: &BTreeSet<usize>,
    mut visit_entry: F,
) -> Result<usize>
where
    F: FnMut(SelectedRegularArchiveEntry<'_>) -> Result<()>,
{
    trace!(
        format = format_name,
        selected = selected_indices.len(),
        "regular archive visit-selected start"
    );
    let result = (|| -> Result<usize> {
        let mut index = 0usize;
        let mut matched = 0usize;

        while let Some(entry) = reader.next_entry().map_err(|error| {
            RomWeaverError::Validation(format!(
                "{format_name} extract failed while reading entry {index}: {error}"
            ))
        })? {
            if !selected_indices.contains(&index) {
                index = index.saturating_add(1);
                continue;
            }

            let entry_path = match entry.pathname_utf8() {
                Ok(path) => path.to_owned(),
                Err(_) => entry
                    .pathname_mb()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "{format_name} extract failed while decoding entry {index}: {error}"
                        ))
                    })?,
            };
            let entry_info = RegularArchiveEntryMetadata {
                index,
                is_dir: entry.is_dir() || entry_path.ends_with('/') || entry_path.ends_with('\\'),
                path: entry_path,
                size: entry.size(),
            };
            trace!(
                format = format_name,
                index = entry_info.index,
                name = %entry_info.path,
                is_dir = entry_info.is_dir,
                size = entry_info.size.unwrap_or(0),
                "regular archive visit entry"
            );

            if entry_info.is_dir {
                visit_entry(SelectedRegularArchiveEntry::Directory { entry: entry_info })?;
            } else {
                let mut entry_reader = entry.into_reader();
                visit_entry(SelectedRegularArchiveEntry::File {
                    entry: entry_info,
                    reader: &mut entry_reader,
                })?;
            }

            matched = matched.saturating_add(1);
            if matched == selected_indices.len() {
                break;
            }
            index = index.saturating_add(1);
        }

        Ok(matched)
    })();

    match (result, close_regular_archive_reader(reader, format_name)) {
        (Ok(count), Ok(())) => Ok(count),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub fn with_regular_archive_file_entry_reader<T, F>(
    source: &Path,
    format_name: &str,
    expected_index: usize,
    expected_name: &str,
    read_entry: F,
) -> Result<T>
where
    F: FnOnce(&mut dyn Read) -> Result<T>,
{
    let mut reader = open_regular_archive_reader(source, format_name)?;
    let result = (|| -> Result<T> {
        let mut index = 0usize;

        while let Some(entry) = reader.next_entry().map_err(|error| {
            RomWeaverError::Validation(format!(
                "{format_name} read failed while reading entry {index}: {error}"
            ))
        })? {
            if index != expected_index {
                index = index.saturating_add(1);
                continue;
            }

            if !entry.is_file() {
                return Err(RomWeaverError::Validation(format!(
                    "{format_name} entry `{expected_name}` is no longer a file entry"
                )));
            }

            let entry_path = match entry.pathname_utf8() {
                Ok(path) => path.to_owned(),
                Err(_) => entry
                    .pathname_mb()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "{format_name} read failed while decoding entry {index}: {error}"
                        ))
                    })?,
            };
            let entry_name = normalize_archive_name(&entry_path).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "{format_name} read failed because entry {index} could not be normalized"
                ))
            })?;
            if entry_name != expected_name {
                return Err(RomWeaverError::Validation(format!(
                    "{format_name} entry changed while reading: expected `{expected_name}`, found `{entry_name}`"
                )));
            }

            let mut entry_reader = entry.into_reader();
            return read_entry(&mut entry_reader);
        }

        Err(RomWeaverError::Validation(format!(
            "{format_name} entry `{expected_name}` was not found"
        )))
    })();

    match (result, close_regular_archive_reader(reader, format_name)) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}
fn open_regular_archive_reader(source: &Path, format_name: &str) -> Result<ReadArchive> {
    let mut reader = ReadArchive::new(&format!("{format_name} archive reader allocation failed"))?;
    reader.support_regular_archives(&format!("{format_name} archive setup failed"))?;
    reader.open_filename(
        source,
        "archive source",
        REGULAR_ARCHIVE_READ_BLOCK_BYTES,
        &format!("{format_name} archive is invalid"),
    )?;
    Ok(reader)
}

fn close_regular_archive_reader(reader: ReadArchive, format_name: &str) -> Result<()> {
    reader.close(
        &format!("{format_name} archive close failed"),
        &format!("{format_name} archive release failed"),
    )
}

fn detect_regular_archive_format(source: &Path, format_name: &str) -> Result<i32> {
    let mut reader = open_regular_archive_reader(source, format_name)?;
    let result = (|| -> Result<i32> {
        let _ = reader.next_entry().map_err(|error| {
            RomWeaverError::Validation(format!(
                "{format_name} probe failed while reading header: {error}"
            ))
        })?;
        Ok(reader.format())
    })();

    match (result, close_regular_archive_reader(reader, format_name)) {
        (Ok(format), Ok(())) => Ok(format),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn regular_archive_format_matches(format: i32, expected: RegularArchiveProbeFormat) -> bool {
    let base_format = format & ARCHIVE_FORMAT_BASE_MASK;
    match expected {
        RegularArchiveProbeFormat::Zip => base_format == ARCHIVE_FORMAT_ZIP,
        RegularArchiveProbeFormat::SevenZ => base_format == ARCHIVE_FORMAT_7ZIP,
        RegularArchiveProbeFormat::Rar => {
            base_format == ARCHIVE_FORMAT_RAR || base_format == ARCHIVE_FORMAT_RAR_V5
        }
        RegularArchiveProbeFormat::Tar => base_format == ARCHIVE_FORMAT_TAR,
    }
}

fn normalize_archive_name(name: &str) -> Option<String> {
    let normalized = name.trim().replace('\\', "/");
    if normalized.starts_with('/') {
        return None;
    }

    let mut parts = Vec::new();
    for segment in normalized.split('/') {
        let segment = segment.trim();
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        parts.push(segment);
    }

    (!parts.is_empty()).then(|| parts.join("/"))
}

fn normalize_archive_name_relaxed(name: &str) -> String {
    name.trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_matches('/')
        .to_string()
}
