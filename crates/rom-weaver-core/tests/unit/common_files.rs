use super::*;

#[test]
fn kind_filter_flag_label_includes_the_patch_filter() {
    let filter = ArchiveEntryKindFilter::new(true, true);

    assert_eq!(filter.flag_names(), ["--filter rom", "--filter patch"]);
    assert_eq!(filter.flag_label(), "--filter rom/--filter patch");
}

#[test]
fn common_file_filter_ignores_known_metadata_names() {
    for name in [
        "folder/.DS_Store",
        "folder/Thumbs.db",
        "folder/desktop.ini",
        r"folder\._resource",
    ] {
        assert!(should_ignore_common_container_file(name), "{name}");
    }

    assert!(!should_ignore_common_container_file("folder/game.bin"));
}

#[test]
fn kind_filters_defer_unnamed_payloads_and_streams_to_content() {
    for name in [
        "patch",
        "nested/patch",
        "Dr. Mario (Japan, USA)",
        "Hack v1.1",
        "patch.gz",
        "Hack v1.1.gz.xz",
    ] {
        for filter in [
            ArchiveEntryKindFilter::new(true, false),
            ArchiveEntryKindFilter::new(false, true),
        ] {
            assert!(filter.matches_payload_name(name), "{name}: {filter:?}");
        }
    }
    let patch_filter = ArchiveEntryKindFilter::new(false, true);
    assert!(patch_filter.matches_payload_name("hack.bps.gz"));
    assert!(!patch_filter.matches_payload_name("game.bin.gz"));
    assert!(!patch_filter.matches_payload_name("notes.txt.gz"));
    assert!(!patch_filter.matches_payload_name("archive.tar.gz"));
}

#[test]
fn kind_filters_reject_real_extensions_and_directories() {
    for name in [
        "game.exe",
        "game.bat",
        "game.sh",
        "game.url",
        "game.srm",
        "game.sav",
        "game.cht",
        "game.msu",
        "game-1.pcm",
        "game.xml",
        "game.a",
        "game.a1234567",
        "folder/",
        "folder.sfc/",
        "folder.bps/",
        r"folder\",
        "",
        ".",
        "..",
        "folder/tool.EXE.gz",
        "folder/save.srm.gz.xz",
    ] {
        for filter in [
            ArchiveEntryKindFilter::new(true, false),
            ArchiveEntryKindFilter::new(false, true),
        ] {
            assert!(!filter.matches_payload_name(name), "{name}: {filter:?}");
            assert!(
                !filter.matches_payload_or_container_name(name)
                    || name.ends_with(".gz")
                    || name.ends_with(".xz"),
                "{name}"
            );
        }
    }
}

#[test]
fn kind_filters_accept_non_extension_tails() {
    for name in [
        "dump",
        "folder.with.dot/dump",
        r"folder.with.dot\dump",
        "Hack v1.1",
        "Dr. Mario (Japan, USA)",
        "Game.",
        "Game.a12345678",
        "Game.a-b",
        "Game.é",
        "Game.1a",
        "Game.abc def",
        "Game.(USA)",
        "Game.Japan,USA",
    ] {
        for filter in [
            ArchiveEntryKindFilter::new(true, false),
            ArchiveEntryKindFilter::new(false, true),
        ] {
            assert!(filter.matches_payload_name(name), "{name}: {filter:?}");
        }
    }
}

#[test]
fn kind_filter_selection_keeps_containers_beside_unnamed_entries() {
    let filter = ArchiveEntryKindFilter::new(true, false);
    let select = |names: &[&'static str], include_containers: bool| {
        select_kind_filter_matches(
            names
                .iter()
                .map(|name| (filter.classify_name(name), *name))
                .collect(),
            include_containers,
        )
    };
    assert_eq!(
        filter.classify_name("game.nes"),
        KindFilterNameMatch::Payload
    );
    assert_eq!(
        filter.classify_name("game.nes.gz"),
        KindFilterNameMatch::Payload
    );
    assert_eq!(
        filter.classify_name("LICENSE"),
        KindFilterNameMatch::Unnamed
    );
    assert_eq!(
        filter.classify_name("Hack v1.1.GZ"),
        KindFilterNameMatch::UnnamedStream
    );
    assert_eq!(
        filter.classify_name("inner.zip"),
        KindFilterNameMatch::Container
    );
    assert_eq!(
        filter.classify_name("notes.txt"),
        KindFilterNameMatch::Rejected
    );
    assert_eq!(
        select(&["LICENSE", "inner.zip", "patch.gz", "notes.txt"], false),
        ["inner.zip", "patch.gz"]
    );
    assert_eq!(
        select(&["LICENSE", "game.nes", "inner.zip", "patch.gz"], false),
        ["LICENSE", "game.nes", "patch.gz"]
    );
    assert_eq!(select(&["LICENSE", "notes.txt"], false), ["LICENSE"]);
    assert_eq!(
        select(&["LICENSE", "game.nes", "inner.zip", "notes.txt"], true),
        ["LICENSE", "game.nes", "inner.zip"]
    );
    assert!(select(&["notes.txt"], false).is_empty());
}
