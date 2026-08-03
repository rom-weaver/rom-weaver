use std::ffi::c_void;
use std::fs::File;
use std::{
    borrow::Cow,
    collections::BTreeSet,
    ffi::{CStr, CString},
    fs,
    io::{self, Read, Write},
    path::Path,
    ptr::{self, NonNull},
};

use rom_weaver_core::{Result, RomWeaverError};

pub mod sys;

use sys::{
    ARCHIVE_EOF, ARCHIVE_FORMAT_7ZIP, ARCHIVE_FORMAT_BASE_MASK, ARCHIVE_FORMAT_RAR,
    ARCHIVE_FORMAT_RAR_V5, ARCHIVE_FORMAT_TAR, ARCHIVE_FORMAT_ZIP, ARCHIVE_OK, ARCHIVE_WARN,
    archive, archive_entry, archive_entry_filetype, archive_entry_pathname,
    archive_entry_pathname_utf8, archive_entry_size, archive_entry_size_is_set, archive_errno,
    archive_error_string, archive_format, archive_read_close, archive_read_data, archive_read_free,
    archive_read_new, archive_read_next_header, archive_read_open_filename,
    archive_read_support_filter_bzip2, archive_read_support_filter_compress,
    archive_read_support_filter_gzip, archive_read_support_filter_lzip,
    archive_read_support_filter_lzma, archive_read_support_filter_rpm,
    archive_read_support_filter_uu, archive_read_support_filter_xz,
    archive_read_support_filter_zstd, archive_read_support_format_7zip,
    archive_read_support_format_ar, archive_read_support_format_cab,
    archive_read_support_format_cpio, archive_read_support_format_empty,
    archive_read_support_format_iso9660, archive_read_support_format_lha,
    archive_read_support_format_mtree, archive_read_support_format_rar,
    archive_read_support_format_rar5, archive_read_support_format_raw,
    archive_read_support_format_tar, archive_read_support_format_warc,
    archive_read_support_format_zip,
};
use sys::{
    archive_entry_free, archive_entry_new, archive_entry_set_filetype, archive_entry_set_pathname,
    archive_entry_set_perm, archive_entry_set_size, archive_write_add_filter_none,
    archive_write_close, archive_write_data, archive_write_finish_entry, archive_write_free,
    archive_write_header, archive_write_new, archive_write_open, archive_write_open_filename,
    archive_write_set_bytes_in_last_block, archive_write_set_filter_option,
    archive_write_set_format_7zip, archive_write_set_format_7zip_progress_callback,
    archive_write_set_format_7zip_size_hint, archive_write_set_format_option,
    archive_write_set_format_zip,
};
#[cfg(feature = "libarchive-write-extra")]
use sys::{
    archive_write_add_filter_bzip2, archive_write_add_filter_gzip, archive_write_add_filter_xz,
    archive_write_add_filter_zstd, archive_write_set_format_pax_restricted,
    archive_write_set_format_raw,
};

mod entries;
mod ffi;
mod read;
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
pub use write::{EntryFileType, EntrySpec, WriteArchive, WriteFilter, WriteFormat};

#[cfg(test)]
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
        archive.write_data_all(file_payload, "zip fixture write file failed")?;
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
        archive.write_data_all(&top_payload, "zip fixture write top file failed")?;
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

    // --- Error-code translation (ffi.rs) ---------------------------------

    #[test]
    fn path_to_cstring_accepts_a_normal_path() {
        let cstring = path_to_cstring(Path::new("archive.zip"), "test path").unwrap();
        assert_eq!(cstring.as_bytes(), b"archive.zip");
    }

    #[test]
    fn path_to_cstring_rejects_interior_nul_byte() {
        #[cfg(unix)]
        {
            use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
            let bytes = b"bad\0name.zip";
            let path = Path::new(OsStr::from_bytes(bytes));
            let err = path_to_cstring(path, "test path").unwrap_err();
            assert!(matches!(err, RomWeaverError::Validation(_)));
            assert!(err.to_string().contains("interior NUL byte"));
        }
    }

    #[test]
    fn check_status_ok_and_warn_are_success() {
        // ARCHIVE_OK and ARCHIVE_WARN both resolve to Ok without needing a
        // live archive pointer to format an error message from.
        assert!(check_free_status(ARCHIVE_OK, "ok status").is_ok());
        assert!(check_free_status(ARCHIVE_WARN, "warn status").is_ok());
    }

    #[test]
    fn check_free_status_translates_a_non_ok_status_to_validation_error() {
        let err = check_free_status(-30 /* ARCHIVE_FATAL */, "free failed").unwrap_err();
        assert!(matches!(err, RomWeaverError::Validation(_)));
        let message = err.to_string();
        assert!(message.contains("free failed"));
        assert!(message.contains("-30"));
    }

    #[test]
    fn read_archive_open_filename_translates_missing_file_error() -> Result<()> {
        run_with_large_stack("missing-file", || {
            let temp_dir = TempDir::new("missing-file")?;
            let missing = temp_dir.path().join("does-not-exist.zip");

            let mut reader = ReadArchive::new("reader alloc")?;
            reader.support_regular_archives("reader setup")?;
            let err = reader
                .open_filename(&missing, "archive source", 2 * 1024 * 1024, "open failed")
                .unwrap_err();
            assert!(matches!(err, RomWeaverError::Validation(_)));
            assert!(err.to_string().contains("open failed"));
            Ok(())
        })
    }

    #[test]
    fn list_regular_archive_entries_rejects_a_truncated_archive() -> Result<()> {
        run_with_large_stack("truncated", || {
            let temp_dir = TempDir::new("truncated")?;
            let source = temp_dir.path().join("fixture.zip");
            create_zip_fixture(&source)?;

            // Cut the valid zip down to its first few bytes: not a
            // recognizable header, so listing must fail cleanly rather than
            // panic on a partially-decoded structure.
            let truncated_bytes = fs::read(&source)?;
            fs::write(&source, &truncated_bytes[..truncated_bytes.len().min(8)])?;

            let err = list_regular_archive_entries(&source, "zip").unwrap_err();
            assert!(matches!(err, RomWeaverError::Validation(_)));

            let probe_err =
                probe_regular_archive_format(&source, "zip", RegularArchiveProbeFormat::Zip)
                    .unwrap_err();
            assert!(matches!(probe_err, RomWeaverError::Validation(_)));
            Ok(())
        })
    }

    #[test]
    fn list_regular_archive_entries_treats_a_zero_byte_file_as_the_empty_format() -> Result<()> {
        // libarchive's "empty format" support (enabled by
        // `support_regular_archives`) recognizes a 0-byte input as a valid,
        // empty archive rather than an error -- unlike a truncated non-empty
        // file, which fails header parsing (see the truncated-archive test).
        run_with_large_stack("empty-file", || {
            let temp_dir = TempDir::new("empty-file")?;
            let source = temp_dir.path().join("empty.zip");
            fs::write(&source, [])?;

            let entries = list_regular_archive_entries(&source, "zip")?;
            assert!(entries.is_empty());
            Ok(())
        })
    }

    #[test]
    fn write_archive_open_filename_rejects_missing_parent_directory() -> Result<()> {
        run_with_large_stack("write-missing-dir", || {
            let temp_dir = TempDir::new("write-missing-dir")?;
            let output = temp_dir.path().join("no/such/dir/out.zip");

            let mut archive = WriteArchive::new("writer alloc")?;
            archive.set_format(WriteFormat::Zip, "format")?;
            archive.add_filter(WriteFilter::None, "filter")?;
            let err = archive
                .open_filename(&output, "archive output", "open failed")
                .unwrap_err();
            assert!(matches!(err, RomWeaverError::Validation(_)));
            assert!(err.to_string().contains("open failed"));
            Ok(())
        })
    }

    // --- Entry metadata handling -------------------------------------------

    #[test]
    fn entry_metadata_reports_file_sizes_and_no_solid_block_for_zip() -> Result<()> {
        run_with_large_stack("metadata", || {
            let temp_dir = TempDir::new("metadata")?;
            let source = temp_dir.path().join("fixture.zip");
            create_zip_fixture(&source)?;

            let entries = list_regular_archive_entries(&source, "zip")?;
            let file_entry = entries
                .iter()
                .find(|entry| normalize_relaxed(&entry.path) == "dir/file.txt")
                .ok_or_else(|| RomWeaverError::Validation("missing dir/file.txt entry".into()))?;
            assert!(!file_entry.is_dir);
            assert_eq!(file_entry.size, Some(5));
            // Zip has no solid-block concept; only 7z folders populate this.
            assert_eq!(file_entry.solid_block, None);

            let dir_entry = entries
                .iter()
                .find(|entry| normalize_relaxed(&entry.path) == "dir")
                .ok_or_else(|| RomWeaverError::Validation("missing dir entry".into()))?;
            assert!(dir_entry.is_dir);
            Ok(())
        })
    }

    // --- Write -> read round trip through the low-level read.rs API --------

    #[test]
    fn seven_zip_write_then_low_level_read_round_trips_payload() -> Result<()> {
        run_with_large_stack("7z-round-trip", || {
            let temp_dir = TempDir::new("7z-round-trip")?;
            let source = temp_dir.path().join("fixture.7z");

            let mut writer = WriteArchive::new("7z writer alloc")?;
            writer.set_format(WriteFormat::SevenZ, "7z format")?;
            writer.add_filter(WriteFilter::None, "7z filter")?;
            writer.open_filename(&source, "7z output", "7z open")?;

            let payload = b"round trip payload";
            writer.start_entry(
                EntrySpec {
                    pathname: "payload.bin",
                    file_type: EntryFileType::Regular,
                    perm: 0o644,
                    size: payload.len() as u64,
                },
                "7z start entry",
            )?;
            writer.write_data_all(payload, "7z write data")?;
            writer.finish_entry("7z finish entry")?;
            writer.close("7z close", "7z release")?;

            // Read it back with the raw ReadArchive API directly (not the
            // higher-level entries.rs helpers), to exercise read.rs on its own.
            let mut reader = ReadArchive::new("7z reader alloc")?;
            reader.support_regular_archives("7z reader setup")?;
            reader.open_filename(&source, "7z source", 2 * 1024 * 1024, "7z open for read")?;
            assert!(reader.next_header("7z next header")?);

            let mut decoded = Vec::new();
            let copied = reader.read_entry_to_writer(&mut decoded, 4096, "7z read entry")?;
            assert_eq!(copied, payload.len() as u64);
            assert_eq!(decoded, payload);

            assert!(!reader.next_header("7z next header (eof)")?);
            reader.close("7z reader close", "7z reader release")?;
            Ok(())
        })
    }
}
