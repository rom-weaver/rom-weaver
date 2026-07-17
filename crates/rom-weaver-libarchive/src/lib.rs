#[cfg(feature = "write-archives")]
use std::ffi::c_void;
use std::{
    borrow::Cow,
    collections::BTreeSet,
    ffi::{CStr, CString},
    fs::{self, File},
    io::{self, Read, Seek, Write},
    path::Path,
    ptr::{self, NonNull},
};

use rom_weaver_akv::reader::ArchiveReader as RegularArchiveReader;
use rom_weaver_core::{Result, RomWeaverError};

pub use rom_weaver_libarchive_sys as sys;

use sys::{
    ARCHIVE_EOF, ARCHIVE_FORMAT_7ZIP, ARCHIVE_FORMAT_BASE_MASK, ARCHIVE_FORMAT_RAR,
    ARCHIVE_FORMAT_RAR_V5, ARCHIVE_FORMAT_TAR, ARCHIVE_FORMAT_ZIP, ARCHIVE_OK, ARCHIVE_WARN,
    archive, archive_errno, archive_error_string, archive_read_close, archive_read_data,
    archive_read_free, archive_read_new, archive_read_next_header, archive_read_open_filename,
    archive_read_support_filter_bzip2, archive_read_support_filter_gzip,
    archive_read_support_filter_xz, archive_read_support_filter_zstd,
    archive_read_support_format_raw,
};
#[cfg(feature = "write-archives")]
use sys::{
    archive_entry_free, archive_entry_new, archive_entry_set_filetype, archive_entry_set_pathname,
    archive_entry_set_perm, archive_entry_set_size, archive_write_add_filter_none,
    archive_write_close, archive_write_data, archive_write_finish_entry, archive_write_free,
    archive_write_header, archive_write_new, archive_write_open, archive_write_open_filename,
    archive_write_set_filter_option, archive_write_set_format_7zip,
    archive_write_set_format_7zip_progress_callback, archive_write_set_format_7zip_size_hint,
    archive_write_set_format_option, archive_write_set_format_zip,
};
#[cfg(feature = "write-extra")]
use sys::{
    archive_write_add_filter_bzip2, archive_write_add_filter_gzip, archive_write_add_filter_xz,
    archive_write_add_filter_zstd, archive_write_set_format_pax_restricted,
    archive_write_set_format_raw,
};

mod entries;
mod ffi;
mod read;
#[cfg(feature = "write-archives")]
mod write;

pub(crate) use ffi::{
    check_free_status, check_status_for_ptr, error_from_archive, path_to_cstring,
};

pub use entries::{
    RegularArchiveEntryMetadata, RegularArchiveFileEntry, RegularArchiveProbeFormat,
    RegularArchiveProbeSummary, SelectedRegularArchiveEntry, list_regular_archive_entries,
    list_regular_archive_file_entries, probe_regular_archive, probe_regular_archive_format,
    visit_selected_regular_archive_entries, with_regular_archive_file_entry_reader,
};
pub use read::{ReadArchive, ReadFilter, with_raw_stream_reader};
#[cfg(feature = "write-archives")]
pub use write::{
    EntryFileType, EntrySpec, WriteArchive, WriteFilter, WriteFormat, ZeroWriteBehavior,
};

#[cfg(all(test, feature = "write-archives"))]
mod tests {
    use super::*;
    use std::{
        collections::{BTreeMap, BTreeSet},
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Result<Self> {
            let mut path = std::env::temp_dir();
            let timestamp_nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to compute test timestamp for `{tag}`: {error}"
                    ))
                })?
                .as_nanos();
            path.push(format!(
                "rom-weaver-libarchive-{tag}-{}-{timestamp_nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path)?;
            Ok(Self { path })
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn create_zip_fixture(path: &Path) -> Result<()> {
        let mut archive = WriteArchive::new("zip fixture create failed")?;
        archive.set_format(WriteFormat::Zip, "zip fixture format failed")?;
        archive.add_filter(WriteFilter::None, "zip fixture filter failed")?;
        archive.open_filename(path, "zip fixture output", "zip fixture open failed")?;

        archive.start_entry(
            EntrySpec {
                pathname: "dir/",
                file_type: EntryFileType::Directory,
                perm: 0o755,
                size: 0,
            },
            "zip fixture start directory failed",
        )?;
        archive.finish_entry("zip fixture finish directory failed")?;

        let file_payload = b"hello";
        archive.start_entry(
            EntrySpec {
                pathname: "dir/file.txt",
                file_type: EntryFileType::Regular,
                perm: 0o644,
                size: file_payload.len() as u64,
            },
            "zip fixture start file failed",
        )?;
        archive.write_data_all(
            file_payload,
            "zip fixture write file failed",
            ZeroWriteBehavior::Error,
        )?;
        archive.finish_entry("zip fixture finish file failed")?;

        let top_payload = [1_u8, 2_u8, 3_u8];
        archive.start_entry(
            EntrySpec {
                pathname: "./top.bin",
                file_type: EntryFileType::Regular,
                perm: 0o644,
                size: top_payload.len() as u64,
            },
            "zip fixture start top file failed",
        )?;
        archive.write_data_all(
            &top_payload,
            "zip fixture write top file failed",
            ZeroWriteBehavior::Error,
        )?;
        archive.finish_entry("zip fixture finish top file failed")?;

        archive.close("zip fixture close failed", "zip fixture release failed")
    }

    fn normalize_relaxed(name: &str) -> String {
        name.trim()
            .replace('\\', "/")
            .trim_start_matches("./")
            .trim_matches('/')
            .to_string()
    }

    fn run_with_large_stack(
        label: &str,
        test_fn: impl FnOnce() -> Result<()> + Send + 'static,
    ) -> Result<()> {
        std::thread::Builder::new()
            .name(format!("libarchive-test-{label}"))
            .stack_size(8 * 1024 * 1024)
            .spawn(test_fn)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to spawn `{label}` test thread: {error}"
                ))
            })?
            .join()
            .map_err(|_| RomWeaverError::Validation(format!("`{label}` test thread panicked")))?
    }

    #[test]
    fn probe_regular_archive_format_detects_zip() -> Result<()> {
        run_with_large_stack("probe", || {
            let temp_dir = TempDir::new("probe")?;
            let source = temp_dir.path().join("fixture.zip");
            create_zip_fixture(&source)?;

            assert!(probe_regular_archive_format(
                &source,
                "zip",
                RegularArchiveProbeFormat::Zip
            )?);
            assert!(!probe_regular_archive_format(
                &source,
                "zip",
                RegularArchiveProbeFormat::Tar
            )?);
            Ok(())
        })
    }

    #[test]
    fn probe_and_list_regular_archive_entries_report_expected_values() -> Result<()> {
        run_with_large_stack("probe-list", || {
            let temp_dir = TempDir::new("probe-list")?;
            let source = temp_dir.path().join("fixture.zip");
            create_zip_fixture(&source)?;

            let summary = probe_regular_archive(&source, "zip")?;
            assert_eq!(summary.entries_total, 3);
            assert_eq!(summary.files, 2);
            assert_eq!(summary.directories, 1);
            assert_eq!(summary.logical_bytes, 8);
            assert!(summary.archive_bytes > 0);

            let entries = list_regular_archive_entries(&source, "zip")?;
            assert_eq!(entries.len(), 3);

            let normalized = entries
                .iter()
                .map(|entry| normalize_relaxed(&entry.path))
                .collect::<Vec<_>>();
            assert!(normalized.contains(&"dir".to_string()));
            assert!(normalized.contains(&"dir/file.txt".to_string()));
            assert!(normalized.contains(&"top.bin".to_string()));

            let directory = entries
                .iter()
                .find(|entry| normalize_relaxed(&entry.path) == "dir")
                .ok_or_else(|| {
                    RomWeaverError::Validation("zip fixture missing `dir` directory entry".into())
                })?;
            assert!(directory.is_dir);
            Ok(())
        })
    }

    #[test]
    fn visit_selected_regular_archive_entries_reads_selected_payloads() -> Result<()> {
        run_with_large_stack("visit-selected", || {
            let temp_dir = TempDir::new("visit-selected")?;
            let source = temp_dir.path().join("fixture.zip");
            create_zip_fixture(&source)?;

            let entries = list_regular_archive_entries(&source, "zip")?;
            let entry_index_by_name = entries
                .iter()
                .map(|entry| (normalize_relaxed(&entry.path), entry.index))
                .collect::<BTreeMap<_, _>>();

            let selected_indices = [
                *entry_index_by_name.get("dir").ok_or_else(|| {
                    RomWeaverError::Validation("zip fixture missing `dir` entry index".into())
                })?,
                *entry_index_by_name.get("dir/file.txt").ok_or_else(|| {
                    RomWeaverError::Validation(
                        "zip fixture missing `dir/file.txt` entry index".into(),
                    )
                })?,
            ]
            .into_iter()
            .collect::<BTreeSet<_>>();

            let mut seen_directories = Vec::new();
            let mut seen_files = BTreeMap::new();
            let matched = visit_selected_regular_archive_entries(
                &source,
                "zip",
                &selected_indices,
                |selected| {
                    match selected {
                        SelectedRegularArchiveEntry::Directory { entry } => {
                            seen_directories.push(normalize_relaxed(&entry.path));
                        }
                        SelectedRegularArchiveEntry::File { entry, reader } => {
                            let mut bytes = Vec::new();
                            reader.read_to_end(&mut bytes).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "zip fixture read failed for `{}`: {error}",
                                    entry.path
                                ))
                            })?;
                            seen_files.insert(normalize_relaxed(&entry.path), bytes);
                        }
                    }
                    Ok(())
                },
            )?;

            assert_eq!(matched, 2);
            assert_eq!(seen_directories, vec!["dir".to_string()]);
            assert_eq!(seen_files.get("dir/file.txt"), Some(&b"hello".to_vec()));
            assert!(!seen_files.contains_key("top.bin"));
            Ok(())
        })
    }
}
