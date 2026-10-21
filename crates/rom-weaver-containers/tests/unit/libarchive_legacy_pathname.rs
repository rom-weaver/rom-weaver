//! Unit coverage for legacy (non-UTF-8) archive entry name decoding
//! (`src/libarchive/legacy_pathname.rs`).

use super::*;
use crate::libarchive::sys::{ARCHIVE_FORMAT_7ZIP, ARCHIVE_FORMAT_TAR, ARCHIVE_FORMAT_ZIP};

const ZIP: i32 = ARCHIVE_FORMAT_ZIP;
const TAR_GNU: i32 = ARCHIVE_FORMAT_TAR | 4;

#[test]
fn decodes_shift_jis_names_in_any_format() {
    let bytes = SHIFT_JIS.encode("ゼルダの伝説.gb").0;
    for format in [ZIP, TAR_GNU, ARCHIVE_FORMAT_7ZIP] {
        assert_eq!(decode_legacy_pathname(&bytes, format), "ゼルダの伝説.gb");
    }
}

#[test]
fn decodes_half_width_katakana_shift_jis_names() {
    assert_eq!(
        decode_legacy_pathname(&SHIFT_JIS.encode("ﾛｯｸﾏﾝ.nes").0, ZIP),
        "ﾛｯｸﾏﾝ.nes"
    );
}

#[test]
fn zip_falls_back_to_cp437() {
    // 0x82 0x6D is also the valid Shift-JIS character "Ｎ"; a lone match must not win.
    assert_eq!(decode_legacy_pathname(b"Pok\x82mon.gb", ZIP), "Pokémon.gb");
    assert_eq!(decode_legacy_pathname(b"\x8e\x99\x9a.bin", ZIP), "ÄÖÜ.bin");
    assert_eq!(decode_legacy_pathname(b"\xe1\xff", ZIP), "ß\u{a0}");
}

#[test]
fn tar_falls_back_to_windows_1252() {
    assert_eq!(
        decode_legacy_pathname(b"Pok\xe9mon.gb", TAR_GNU),
        "Pokémon.gb"
    );
    assert_eq!(
        decode_legacy_pathname(b"M\xfcller.sfc", TAR_GNU),
        "Müller.sfc"
    );
}

#[test]
fn cp437_table_maps_every_high_byte_to_a_distinct_character() {
    let decoded: std::collections::HashSet<char> = (0x80..=0xff).map(cp437_char).collect();
    assert_eq!(decoded.len(), 128);
    assert!(decoded.iter().all(|character| !character.is_ascii()));
}
