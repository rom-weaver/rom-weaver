use super::*;

#[test]
fn source_names_preserve_case_and_repeated_declarations() {
    let temp = assert_fs::TempDir::new().expect("temp");
    for (extension, kind, text) in [
        (
            "cue",
            DiscSheetKind::Cue,
            "FILE track.bin BINARY\nFILE TRACK.bin BINARY\nFILE track.bin BINARY\n",
        ),
        (
            "gdi",
            DiscSheetKind::Gdi,
            "3\n1 0 4 2048 track.bin 0\n2 10 4 2048 TRACK.bin 0\n3 20 4 2048 track.bin 0\n",
        ),
    ] {
        let path = temp.path().join(format!("disc.{extension}"));
        std::fs::write(&path, text).expect("sheet");
        assert_eq!(
            enumerate_disc_sheet_file_names(&path).expect("all sources"),
            ["track.bin", "TRACK.bin", "track.bin"]
        );
        let references = enumerate_disc_sheet_refs(&path).expect("logical references");
        assert_eq!(references.kind, kind);
        assert_eq!(references.sheet_path, path);
        assert_eq!(references.referenced_files, ["track.bin"]);
    }
}
