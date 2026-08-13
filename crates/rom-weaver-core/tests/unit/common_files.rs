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
