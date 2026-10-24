use rom_weaver_core::{DiscSheetKind, RomWeaverError, parse_disc_sheet_refs_from_text};

#[test]
fn empty_quoted_disc_sheet_filename_is_rejected() {
    for (kind, text) in [
        (DiscSheetKind::Cue, "FILE \"\""),
        (
            DiscSheetKind::Cue,
            "FILE \"valid.bin\" BINARY\nFILE \"\" BINARY\n",
        ),
        (DiscSheetKind::Gdi, "1\n1 0 4 2352 \"\" 0\n"),
    ] {
        let result = parse_disc_sheet_refs_from_text(kind, text, "regression.sheet");
        assert!(
            matches!(result, Err(RomWeaverError::Validation(_))),
            "empty filename must be a validation error: {kind:?}, {result:?}"
        );
    }
}

#[test]
fn quoted_disc_sheet_filename_with_spaces_is_preserved() {
    for (kind, text) in [
        (DiscSheetKind::Cue, "FILE \"track 01.bin\" BINARY\n"),
        (DiscSheetKind::Gdi, "1\n1 0 4 2352 \"track 01.bin\" 0\n"),
    ] {
        assert_eq!(
            parse_disc_sheet_refs_from_text(kind, text, "regression.sheet").unwrap(),
            ["track 01.bin"]
        );
    }
}
