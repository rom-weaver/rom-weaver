//! Unit coverage for the entry-walking helpers over libarchive
//! (`src/libarchive/entries.rs`): the file-entry listing, the single-entry
//! reader, format matching, and archive-name normalization.

use super::*;

fn unique_temp_dir(tag: &str) -> crate::test_support::TempPath {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is after the unix epoch")
        .as_nanos();
    let dir = crate::test_support::TempPath::new(std::env::temp_dir().join(format!(
        "rom-weaver-entries-{tag}-{}-{nanos}",
        std::process::id()
    )));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// A zip holding a directory, a file inside it, and a top-level file whose
/// stored name carries a `./` prefix, so normalization has something to strip.
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

    for (name, payload) in [
        ("dir/file.txt", b"hello".as_slice()),
        ("./top.bin", &[1, 2, 3]),
    ] {
        archive.start_entry(
            EntrySpec {
                pathname: name,
                file_type: EntryFileType::Regular,
                perm: 0o644,
                size: payload.len() as u64,
            },
            "zip fixture start file failed",
        )?;
        archive.write_data_all(payload, "zip fixture write file failed")?;
        archive.finish_entry("zip fixture finish file failed")?;
    }

    archive.close("zip fixture close failed", "zip fixture release failed")
}

fn read_all(reader: &mut dyn Read) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| RomWeaverError::Validation(format!("fixture read failed: {error}")))?;
    Ok(bytes)
}

fn tar_link_fixture(kind: u8) -> Vec<u8> {
    let mut bytes = vec![0u8; 1536];
    let header = &mut bytes[..512];
    header[..9].copy_from_slice(b"alias.bin");
    header[100..108].copy_from_slice(b"0000644\0");
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    header[124..136].copy_from_slice(b"00000000000\0");
    header[136..148].copy_from_slice(b"00000000000\0");
    header[148..156].fill(b' ');
    header[156] = kind;
    header[157..167].copy_from_slice(b"target.bin");
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
    header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
    bytes
}

#[test]
fn archive_links_are_skipped_instead_of_becoming_empty_files() {
    let dir = unique_temp_dir("links");
    for kind in *b"12" {
        let source = dir.join(format!("link-{kind}.tar"));
        fs::write(&source, tar_link_fixture(kind)).expect("write tar link fixture");
        let entries = list_regular_archive_entries(&source, "tar")
            .expect("a tar holding only a link lists without error");
        assert!(
            entries.is_empty(),
            "link kind {}: a link must not be listed as an empty regular file: {entries:?}",
            kind as char
        );
    }
}

#[test]
fn rar_links_are_skipped_instead_of_listed_as_regular_files() {
    let dir = unique_temp_dir("rar-links");
    for (name, bytes, link_names) in [
        (
            "rar4",
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/fixtures/rar/rar4-unicode.rar"
            ))
            .as_slice(),
            &["表だよ/ファイル"][..],
        ),
        (
            "rar5",
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/fixtures/rar/rar5-unicode.rar"
            ))
            .as_slice(),
            &["Ⓗⓐⓡⓓ Ⓛⓘⓝⓚ.txt", "𝒮𝓎𝓂𝒷𝑜𝓁𝒾𝒸 𝐿𝒾𝓃𝓀.txt"][..],
        ),
    ] {
        let source = dir.join(format!("{name}.rar"));
        fs::write(&source, bytes).expect("write upstream RAR link fixture");
        let entries = list_regular_archive_entries(&source, "rar")
            .expect("RAR links are skipped, not an error");
        assert!(
            !entries.is_empty(),
            "{name}: the regular files must still list"
        );
        for link in link_names {
            assert!(
                entries.iter().all(|entry| entry.path != *link),
                "{name}: link `{link}` must not be listed as a regular file: {entries:?}"
            );
        }
    }
}

#[test]
fn rar5_preserves_stored_unicode_names_and_payloads() {
    let dir = unique_temp_dir("rar5-unicode");
    let source = dir.join("unicode.rar");
    fs::write(
        &source,
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/rar/rar5-unicode.rar"
        )),
    )
    .expect("write upstream RAR5 Unicode fixture");
    let entries = list_regular_archive_file_entries(&source, "rar").expect("list Unicode names");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "👋🌎.txt");
    assert_eq!(entries[0].size, Some(13));
    assert_eq!(
        with_regular_archive_file_entry_reader(
            &source,
            "rar",
            entries[0].index,
            "👋🌎.txt",
            read_all
        )
        .expect("read the Unicode entry"),
        b"Hello, world!"
    );
}

#[test]
fn rar5_rejects_invalid_utf8_instead_of_substituting_a_name() {
    let dir = unique_temp_dir("rar5-invalid-utf8");
    let source = dir.join("invalid.rar");
    let mut bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/rar/rar5-stored.rar"
    ))
    .to_vec();
    assert_eq!(&bytes[34..39], b"empty");
    // Keep the header checksum valid so the pathname decoder sees the malformed name.
    bytes[34] = 0xff;
    let header_crc = crc32fast::hash(&bytes[20..39]);
    bytes[16..20].copy_from_slice(&header_crc.to_le_bytes());
    fs::write(&source, bytes).expect("write invalid UTF-8 RAR5 fixture");

    let error = list_regular_archive_file_entries(&source, "rar")
        .expect_err("invalid UTF-8 must not become a legacy or substituted name");
    assert!(
        error
            .to_string()
            .contains("invalid UTF-8 archive entry pathname"),
        "{error}"
    );
}

#[test]
fn empty_regular_tar_entries_remain_supported() {
    let dir = unique_temp_dir("empty-regular");
    let source = dir.join("empty.tar");
    fs::write(&source, tar_link_fixture(b'0')).expect("write empty regular tar entry");
    let entries = list_regular_archive_entries(&source, "tar").expect("list empty regular file");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].size, Some(0));
    assert!(!entries[0].is_dir);
    assert_eq!(
        with_regular_archive_file_entry_reader(&source, "tar", 0, "alias.bin", read_all)
            .expect("read empty regular file"),
        b""
    );
}

#[test]
fn listing_file_entries_skips_directories_and_normalizes_names() {
    let dir = unique_temp_dir("file-entries");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("create the zip fixture");

    let entries = list_regular_archive_file_entries(&source, "zip").expect("list file entries");

    assert_eq!(
        entries
            .iter()
            .map(|entry| (entry.index, entry.name.clone(), entry.size))
            .collect::<Vec<_>>(),
        vec![
            (1, "dir/file.txt".to_string(), Some(5)),
            (2, "top.bin".to_string(), Some(3)),
        ],
        "the directory entry must be skipped and `./` stripped from the top-level name"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn listing_file_entries_skips_backslash_directories_of_legacy_zips() {
    // DOS-made entries `saves\` (no directory attribute) and `saves\a.sav`, no UTF-8 flag.
    const ZIP: &[u8] = b"\x50\x4b\x03\x04\x14\x00\x00\x00\x00\x00\x00\x00\x55\x5d\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x06\x00\x00\x00\x73\x61\x76\x65\x73\x5c\x50\x4b\x03\x04\x14\x00\x00\x00\x00\x00\x00\x00\x55\x5d\x7a\x9f\xe9\x53\x05\x00\x00\x00\x05\x00\x00\x00\x0b\x00\x00\x00\x73\x61\x76\x65\x73\x5c\x61\x2e\x73\x61\x76\x73\x61\x76\x65\x0a\x50\x4b\x01\x02\x14\x00\x14\x00\x00\x00\x00\x00\x00\x00\x55\x5d\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x06\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x80\x01\x00\x00\x00\x00\x73\x61\x76\x65\x73\x5c\x50\x4b\x01\x02\x14\x00\x14\x00\x00\x00\x00\x00\x00\x00\x55\x5d\x7a\x9f\xe9\x53\x05\x00\x00\x00\x05\x00\x00\x00\x0b\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x80\x01\x24\x00\x00\x00\x73\x61\x76\x65\x73\x5c\x61\x2e\x73\x61\x76\x50\x4b\x05\x06\x00\x00\x00\x00\x02\x00\x02\x00\x6d\x00\x00\x00\x52\x00\x00\x00\x00\x00";
    let dir = unique_temp_dir("backslash-dirs");
    let source = dir.join("legacy.zip");
    fs::write(&source, ZIP).expect("write the zip fixture");

    let entries = list_regular_archive_file_entries(&source, "zip").expect("list file entries");
    let summary = probe_regular_archive(&source, "zip").expect("probe the zip fixture");

    assert_eq!(
        entries
            .iter()
            .map(|entry| (entry.index, entry.name.clone()))
            .collect::<Vec<_>>(),
        vec![(1, "saves/a.sav".to_string())]
    );
    assert_eq!((summary.files, summary.directories), (1, 1));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn listing_file_entries_rejects_a_truncated_archive() {
    let dir = unique_temp_dir("file-entries-truncated");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("create the zip fixture");
    let bytes = fs::read(&source).expect("read the fixture");
    // Half a zip still carries intact local file headers, which libarchive happily
    // streams back with unknown sizes. Cut below the first header so there is no
    // entry left to recover and the reader must actually fail.
    fs::write(&source, &bytes[..8]).expect("truncate the fixture");

    let error = list_regular_archive_file_entries(&source, "zip")
        .expect_err("a truncated archive must be rejected");

    assert!(
        error.to_string().contains("zip"),
        "unexpected error: {error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn probing_a_truncated_archive_is_reported() {
    let dir = unique_temp_dir("probe-truncated");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("create the zip fixture");
    let bytes = fs::read(&source).expect("read the fixture");
    // Half a zip still carries intact local file headers, which libarchive happily
    // streams back with unknown sizes. Cut below the first header so there is no
    // entry left to recover and the reader must actually fail.
    fs::write(&source, &bytes[..8]).expect("truncate the fixture");

    let error =
        probe_regular_archive(&source, "zip").expect_err("a truncated archive must be rejected");

    assert!(
        error.to_string().contains("zip"),
        "unexpected error: {error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_entry_reader_streams_the_named_entry() {
    let dir = unique_temp_dir("entry-reader");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("create the zip fixture");

    let payload =
        with_regular_archive_file_entry_reader(&source, "zip", 1, "dir/file.txt", read_all)
            .expect("read the named entry");

    assert_eq!(payload, b"hello");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_entry_reader_rejects_an_entry_that_no_longer_matches() {
    let dir = unique_temp_dir("entry-reader-mismatch");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("create the zip fixture");

    let error = with_regular_archive_file_entry_reader(&source, "zip", 1, "other.txt", read_all)
        .expect_err("a name mismatch must be rejected");

    assert!(
        error
            .to_string()
            .contains("expected `other.txt`, found `dir/file.txt`"),
        "unexpected error: {error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_entry_reader_rejects_a_directory_entry() {
    let dir = unique_temp_dir("entry-reader-directory");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("create the zip fixture");

    let error = with_regular_archive_file_entry_reader(&source, "zip", 0, "dir", read_all)
        .expect_err("a directory index must be rejected");

    assert!(
        error.to_string().contains("is no longer a file entry"),
        "unexpected error: {error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_entry_reader_reports_an_index_past_the_end_of_the_archive() {
    let dir = unique_temp_dir("entry-reader-missing");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("create the zip fixture");

    let error = with_regular_archive_file_entry_reader(&source, "zip", 99, "ghost.bin", read_all)
        .expect_err("an index past the end must be reported");

    assert!(
        error
            .to_string()
            .contains("entry `ghost.bin` was not found"),
        "unexpected error: {error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn visiting_no_selected_indices_matches_nothing_and_never_opens_the_archive() {
    let dir = unique_temp_dir("visit-empty");
    let missing = dir.join("absent.zip");

    let matched =
        visit_selected_regular_archive_entries(&missing, "zip", &BTreeSet::new(), |_| Ok(()))
            .expect("an empty selection must succeed");

    assert_eq!(matched, 0);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn visiting_a_selection_surfaces_a_visitor_error() {
    let dir = unique_temp_dir("visit-error");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("create the zip fixture");

    let error =
        visit_selected_regular_archive_entries(&source, "zip", &BTreeSet::from([1usize]), |_| {
            Err(RomWeaverError::Validation(
                "visitor refused the entry".into(),
            ))
        })
        .expect_err("the visitor error must propagate");

    assert!(
        error.to_string().contains("visitor refused the entry"),
        "unexpected error: {error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn archive_names_are_normalized_and_traversal_is_refused() {
    for (input, expected) in [
        ("dir/file.txt", Some("dir/file.txt")),
        ("./a/./b", Some("a/b")),
        ("  spaced.bin  ", Some("spaced.bin")),
        ("dir\\win\\file.bin", Some("dir/win/file.bin")),
        ("dir//double//slash.bin", Some("dir/double/slash.bin")),
        ("/absolute.bin", None),
        ("a/../b", None),
        ("..", None),
        ("", None),
        ("./", None),
    ] {
        assert_eq!(
            normalize_archive_name(input).as_deref(),
            expected,
            "unexpected normalization for `{input}`"
        );
    }
}

#[test]
fn relaxed_archive_names_keep_traversal_segments_but_trim_wrappers() {
    for (input, expected) in [
        ("./dir/file.txt", "dir/file.txt"),
        ("/leading/and/trailing/", "leading/and/trailing"),
        ("dir\\win.bin", "dir/win.bin"),
        ("  ", ""),
        ("a/../b", "a/../b"),
    ] {
        assert_eq!(
            normalize_archive_name_relaxed(input),
            expected,
            "unexpected relaxed normalization for `{input}`"
        );
    }
}

#[test]
fn format_matching_accepts_both_rar_generations_and_rejects_mismatches() {
    use RegularArchiveProbeFormat::{Rar, SevenZ, Tar, Zip};

    assert!(regular_archive_format_matches(ARCHIVE_FORMAT_ZIP, Zip));
    assert!(regular_archive_format_matches(ARCHIVE_FORMAT_7ZIP, SevenZ));
    assert!(regular_archive_format_matches(ARCHIVE_FORMAT_TAR, Tar));
    // Both RAR generations report different base formats and must both match.
    assert!(regular_archive_format_matches(ARCHIVE_FORMAT_RAR, Rar));
    assert!(regular_archive_format_matches(ARCHIVE_FORMAT_RAR_V5, Rar));

    assert!(!regular_archive_format_matches(ARCHIVE_FORMAT_ZIP, Tar));
    assert!(!regular_archive_format_matches(ARCHIVE_FORMAT_TAR, SevenZ));
    assert!(!regular_archive_format_matches(ARCHIVE_FORMAT_ZIP, Rar));
    assert!(!regular_archive_format_matches(ARCHIVE_FORMAT_7ZIP, Zip));
}

#[test]
fn a_missing_source_is_reported_by_every_entry_helper() {
    let dir = unique_temp_dir("missing-source");
    let missing = dir.join("absent.zip");

    assert!(list_regular_archive_file_entries(&missing, "zip").is_err());
    assert!(list_regular_archive_entries(&missing, "zip").is_err());
    assert!(probe_regular_archive(&missing, "zip").is_err());
    assert!(probe_regular_archive_format(&missing, "zip", RegularArchiveProbeFormat::Zip).is_err());
    assert!(
        with_regular_archive_file_entry_reader(&missing, "zip", 0, "any.bin", read_all).is_err()
    );
    fs::remove_dir_all(&dir).ok();
}
