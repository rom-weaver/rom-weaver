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
