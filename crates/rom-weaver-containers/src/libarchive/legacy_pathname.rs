use encoding_rs::{SHIFT_JIS, WINDOWS_1252};
use tracing::trace;

use super::sys::{
    ARCHIVE_FORMAT_BASE_MASK, ARCHIVE_FORMAT_CAB, ARCHIVE_FORMAT_LHA, ARCHIVE_FORMAT_RAR,
    ARCHIVE_FORMAT_ZIP,
};

/// IBM code page 437 for bytes 0x80-0xFF; the low half is ASCII.
/// https://en.wikipedia.org/wiki/Code_page_437#Character_set
const CP437_HIGH: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐\
└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u{a0}";

/// Decodes an entry name that is not valid UTF-8. Such names carry no charset marker, so this
/// picks Shift-JIS when the bytes read as Japanese text, and otherwise the legacy default of the
/// archive's origin: CP437 for DOS-era formats (the ZIP spec's default) and Windows-1252 for
/// Unix formats such as tar.
pub(super) fn decode_legacy_pathname(bytes: &[u8], format: i32) -> String {
    if let Some(name) = decode_japanese(bytes) {
        trace!(?bytes, %name, "decoded legacy archive pathname as Shift-JIS");
        return name;
    }
    let base_format = format & ARCHIVE_FORMAT_BASE_MASK;
    let name = if [
        ARCHIVE_FORMAT_ZIP,
        ARCHIVE_FORMAT_RAR,
        ARCHIVE_FORMAT_CAB,
        ARCHIVE_FORMAT_LHA,
    ]
    .contains(&base_format)
    {
        bytes.iter().map(|&byte| cp437_char(byte)).collect()
    } else {
        WINDOWS_1252
            .decode_without_bom_handling(bytes)
            .0
            .into_owned()
    };
    trace!(?bytes, %name, format, "decoded legacy archive pathname with the format default");
    name
}

/// Short Latin names often also decode as Shift-JIS, because a lone accented byte plus the next
/// letter forms a valid two-byte character. Requiring two adjacent Japanese characters rejects
/// those while keeping real kana and kanji names.
fn decode_japanese(bytes: &[u8]) -> Option<String> {
    let name = SHIFT_JIS.decode_without_bom_handling_and_without_replacement(bytes)?;
    let mut previous_japanese = false;
    for character in name.chars() {
        let japanese = matches!(
            character,
            '\u{3000}'..='\u{30ff}' | '\u{4e00}'..='\u{9fff}' | '\u{ff01}'..='\u{ff9f}'
        );
        if japanese && previous_japanese {
            return Some(name.into_owned());
        }
        previous_japanese = japanese;
    }
    None
}

fn cp437_char(byte: u8) -> char {
    if byte.is_ascii() {
        return char::from(byte);
    }
    CP437_HIGH
        .chars()
        .nth(usize::from(byte - 0x80))
        .expect("CP437_HIGH covers every byte from 0x80 to 0xFF")
}

#[cfg(test)]
#[path = "../../tests/unit/libarchive_legacy_pathname.rs"]
mod tests;
