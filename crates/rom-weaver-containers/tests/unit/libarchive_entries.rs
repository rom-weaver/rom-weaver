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

fn streamed_zip_listing(
    bytes: &[u8],
    block_size: usize,
) -> Result<rom_weaver_core::NestedArchiveListing> {
    let visitor = rom_weaver_core::NestedEntryVisitor {
        action: &|_| rom_weaver_core::NestedEntryAction::List,
        stop_after_prefix: &|_, _| false,
        end_pass_on_stop: false,
    };
    with_streamed_regular_archive(
        &mut io::Cursor::new(bytes),
        block_size,
        "streamed ZIP fixture",
        0,
        &visitor,
    )
}

#[test]
fn nested_archive_listing_omits_duplicate_source_keys_requested_once() {
    let dir = unique_temp_dir("nested-duplicate-key");
    let inner = dir.join("inner.zip");
    create_zip_fixture(&inner).expect("inner ZIP");
    let payload = fs::read(inner).expect("inner bytes");
    let source = dir.join("outer.zip");
    let mut writer = WriteArchive::new("fixture").expect("writer");
    writer.set_format(WriteFormat::Zip, "fixture").expect("ZIP");
    writer
        .add_filter(WriteFilter::None, "fixture")
        .expect("no filter");
    writer
        .open_filename(&source, "fixture", "fixture")
        .expect("output");
    for _ in 0..2 {
        writer
            .start_entry(
                EntrySpec {
                    pathname: "inner.zip",
                    file_type: EntryFileType::Regular,
                    perm: 0o644,
                    size: payload.len() as u64,
                },
                "fixture",
            )
            .expect("duplicate entry");
        writer.write_data_all(&payload, "fixture").expect("payload");
        writer.finish_entry("fixture").expect("finish entry");
    }
    writer.close("fixture", "fixture").expect("close");
    let visitor = rom_weaver_core::NestedEntryVisitor {
        action: &|_| rom_weaver_core::NestedEntryAction::List,
        stop_after_prefix: &|_, _| false,
        end_pass_on_stop: false,
    };
    let listings = read_nested_regular_archive_entry_prefixes(
        &source,
        "zip",
        &|path| (path == "inner.zip").then(|| path.to_owned()),
        1,
        0,
        &visitor,
    )
    .expect("ambiguous entries fall back to extraction");
    assert!(listings.is_empty());
}

#[test]
fn streamed_zip_checks_central_names_offsets_counts_and_footer() {
    let dir = unique_temp_dir("streamed-directory");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("ZIP fixture");
    let bytes = fs::read(&source).expect("ZIP bytes");
    let central = bytes
        .windows(4)
        .position(|bytes| bytes == b"PK\x01\x02")
        .expect("central directory");
    let footer = bytes.len() - 22;
    assert_eq!(
        streamed_zip_listing(&bytes, 17)
            .expect("ordinary ZIP")
            .entries
            .len(),
        3
    );
    for (label, offset) in [
        ("central name", central + 46),
        ("local offset", central + 42),
        ("entry count", footer + 10),
        ("directory offset", footer + 16),
    ] {
        let mut changed = bytes.clone();
        changed[offset] ^= 1;
        assert!(streamed_zip_listing(&changed, 17).is_err(), "{label}");
    }
    let mut zip64 = bytes.clone();
    zip64[footer + 8..footer + 12].fill(255);
    assert!(
        streamed_zip_listing(&zip64, 17).is_err(),
        "ZIP64 count sentinels"
    );
    assert!(
        streamed_zip_listing(&[], 17)
            .expect("empty archive")
            .entries
            .is_empty()
    );
    for length in [1, 21, footer, bytes.len() - 1] {
        assert!(
            streamed_zip_listing(&bytes[..length], 17).is_err(),
            "truncated at {length}"
        );
    }
    let mut trailing = bytes.clone();
    trailing.extend(b"unrecognized trailer");
    assert!(
        streamed_zip_listing(&trailing, 17).is_err(),
        "trailing data"
    );
    let name_len = usize::from(u16::from_le_bytes([
        bytes[central + 28],
        bytes[central + 29],
    ]));
    for (tag, accepted) in [(0x0001_u16, false), (0x7075, false), (0xffff, true)] {
        let mut changed = bytes.clone();
        let extra = central + 46 + name_len;
        changed.splice(extra..extra, [tag as u8, (tag >> 8) as u8, 0, 0]);
        changed[central + 30..central + 32].copy_from_slice(&4_u16.to_le_bytes());
        let size = u32::from_le_bytes(
            bytes[footer + 12..footer + 16]
                .try_into()
                .expect("directory size"),
        );
        changed[footer + 16..footer + 20].copy_from_slice(&(size + 4).to_le_bytes());
        assert_eq!(
            streamed_zip_listing(&changed, 17).is_ok(),
            accepted,
            "extra tag {tag:x}"
        );
    }
}

#[test]
fn streamed_zip_accepts_comments_and_split_read_boundaries() {
    let dir = unique_temp_dir("streamed-comment");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("ZIP fixture");
    let original = fs::read(&source).expect("ZIP bytes");
    for length in [0, 1, 65535] {
        let mut bytes = original.clone();
        let footer = bytes.len() - 22;
        bytes[footer + 20..footer + 22].copy_from_slice(&(length as u16).to_le_bytes());
        bytes.extend(vec![b'x'; length]);
        for block_size in [1, 3, 4, 17, 65536] {
            assert_eq!(
                streamed_zip_listing(&bytes, block_size)
                    .expect("ZIP comment")
                    .entries
                    .len(),
                3,
                "length={length}, block_size={block_size}"
            );
        }
    }
}

#[test]
fn streamed_zip_bounds_the_directory_snapshot() {
    let dir = unique_temp_dir("streamed-directory-limit");
    let source = dir.join("fixture.zip");
    let mut writer = WriteArchive::new("fixture").expect("writer");
    writer.set_format(WriteFormat::Zip, "fixture").expect("ZIP");
    writer
        .add_filter(WriteFilter::None, "fixture")
        .expect("no filter");
    writer
        .open_filename(&source, "fixture", "fixture")
        .expect("output");
    for index in 0..20 {
        let name = format!("{index}-{}.txt", "a".repeat(60000));
        writer
            .start_entry(
                EntrySpec {
                    pathname: &name,
                    file_type: EntryFileType::Regular,
                    perm: 0o644,
                    size: 0,
                },
                "fixture",
            )
            .expect("entry");
        writer.finish_entry("fixture").expect("finish entry");
    }
    writer.close("fixture", "fixture").expect("close");
    let bytes = fs::read(&source).expect("ZIP bytes");
    assert!(
        streamed_zip_listing(&bytes, 65536).is_err(),
        "oversized central directory"
    );
}

#[test]
fn streamed_zip_rejects_ambiguous_comment_footer() {
    let dir = unique_temp_dir("streamed-comment-footer");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("ZIP fixture");
    let mut bytes = fs::read(&source).expect("ZIP bytes");
    let footer = bytes.len() - 22;
    bytes[footer + 20..footer + 22].copy_from_slice(&44_u16.to_le_bytes());
    bytes.extend(b"PK\x05\x06");
    bytes.extend([0; 18]);
    bytes.extend([b'x'; 22]);
    assert!(
        streamed_zip_listing(&bytes, 17).is_err(),
        "a comment can select another seekable ZIP directory"
    );
}

#[test]
fn streamed_zip_accepts_a_large_payload_and_preserves_early_stop() {
    let dir = unique_temp_dir("streamed-large-payload");
    let source = dir.join("fixture.zip");
    let mut writer = WriteArchive::new("fixture").expect("writer");
    writer.set_format(WriteFormat::Zip, "fixture").expect("ZIP");
    writer
        .set_format_option(Some("zip"), "compression", "store", "fixture")
        .expect("stored ZIP");
    writer
        .add_filter(WriteFilter::None, "fixture")
        .expect("no filter");
    writer
        .open_filename(&source, "fixture", "fixture")
        .expect("output");
    let payload = vec![42_u8; 2 * 1024 * 1024];
    writer
        .start_entry(
            EntrySpec {
                pathname: "disc.iso",
                file_type: EntryFileType::Regular,
                perm: 0o644,
                size: payload.len() as u64,
            },
            "fixture",
        )
        .expect("entry");
    writer.write_data_all(&payload, "fixture").expect("payload");
    writer.finish_entry("fixture").expect("finish entry");
    writer
        .start_entry(
            EntrySpec {
                pathname: "readme.txt",
                file_type: EntryFileType::Regular,
                perm: 0o644,
                size: 0,
            },
            "fixture",
        )
        .expect("entry after large payload");
    writer.finish_entry("fixture").expect("finish second entry");
    writer.close("fixture", "fixture").expect("close");
    let bytes = fs::read(&source).expect("ZIP bytes");
    assert_eq!(
        streamed_zip_listing(&bytes, 65536)
            .expect("small directory after large payload")
            .entries
            .len(),
        2
    );

    let visitor = rom_weaver_core::NestedEntryVisitor {
        action: &|_| rom_weaver_core::NestedEntryAction::Stop,
        stop_after_prefix: &|_, _| false,
        end_pass_on_stop: true,
    };
    let listing = with_streamed_regular_archive(
        &mut io::Cursor::new(&bytes[..128]),
        17,
        "stopped ZIP fixture",
        0,
        &visitor,
    )
    .expect("stopped listing does not require a directory or drain the payload");
    assert!(listing.stopped);
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
fn rar5_skips_links_whose_names_are_not_valid_utf8() {
    let dir = unique_temp_dir("rar5-invalid-link-name");
    let source = dir.join("invalid-link.rar");
    let mut bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/rar/rar5-unicode.rar"
    ))
    .to_vec();
    let link = "Ⓗⓐⓡⓓ Ⓛⓘⓝⓚ.txt".as_bytes();
    let name_at = bytes
        .windows(link.len())
        .position(|window| window == link)
        .expect("hard link name in the fixture");
    // The name's last byte is ASCII; 0xff makes it malformed UTF-8 for a link only.
    bytes[name_at + link.len() - 1] = 0xff;
    // Keep the header checksum valid: find the header whose checked range holds the name.
    let mut patched = false;
    for crc_at in 0..name_at {
        let size_at = crc_at + 4;
        let mut size = 0usize;
        let mut shift = 0;
        let mut length = 0;
        while let Some(&byte) = bytes.get(size_at + length) {
            size |= usize::from(byte & 0x7f) << shift;
            length += 1;
            shift += 7;
            if byte & 0x80 == 0 || length == 3 {
                break;
            }
        }
        let end = size_at + length + size;
        if end < name_at + link.len() || end > bytes.len() {
            continue;
        }
        let mut original = bytes[size_at..end].to_vec();
        original[name_at + link.len() - 1 - size_at] = link[link.len() - 1];
        let stored = u32::from_le_bytes(bytes[crc_at..crc_at + 4].try_into().expect("crc"));
        if crc32fast::hash(&original) == stored {
            let fixed = crc32fast::hash(&bytes[size_at..end]);
            bytes[crc_at..crc_at + 4].copy_from_slice(&fixed.to_le_bytes());
            patched = true;
            break;
        }
    }
    assert!(patched, "the link header checksum must be located");
    fs::write(&source, bytes).expect("write malformed link name RAR5 fixture");

    let entries = list_regular_archive_entries(&source, "rar")
        .expect("a link with an undecodable name is skipped, not an error");
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].path, "👋🌎.txt");
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
fn reading_entry_prefixes_returns_bounded_headers_for_wanted_entries_only() {
    let dir = unique_temp_dir("entry-prefixes");
    let source = dir.join("fixture.zip");
    create_zip_fixture(&source).expect("create the zip fixture");

    let prefixes = read_regular_archive_entry_prefixes(&source, "zip", 1, 3, |path| {
        (path == "dir/file.txt").then(|| path.to_string())
    })
    .expect("read entry prefixes");

    assert_eq!(
        prefixes.into_iter().collect::<Vec<_>>(),
        vec![("dir/file.txt".to_string(), b"hel".to_vec())],
        "only the wanted entry is read, truncated to the requested length"
    );
    assert!(
        read_regular_archive_entry_prefixes(&source, "zip", 1, 3, |_| None::<String>)
            .expect("read with nothing wanted")
            .is_empty()
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
