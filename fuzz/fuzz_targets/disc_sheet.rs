#![no_main]
use libfuzzer_sys::fuzz_target;
use rom_weaver_core::{DiscSheetKind, parse_disc_sheet_refs_from_text};
use std::collections::HashSet;

fuzz_target!(|data: &[u8]| {
    if data.len() > 8192 {
        return;
    }
    let text = String::from_utf8_lossy(data);
    for kind in [DiscSheetKind::Cue, DiscSheetKind::Gdi] {
        if let Ok(refs) = parse_disc_sheet_refs_from_text(kind, &text, "fuzz.cue") {
            assert!(refs.len() <= data.len());
            assert_eq!(refs.iter().collect::<HashSet<_>>().len(), refs.len());
            assert!(refs.iter().all(|name| !name.is_empty()));
            assert_eq!(
                refs,
                parse_disc_sheet_refs_from_text(kind, &text, "fuzz.cue").unwrap()
            );
        }
    }
});
