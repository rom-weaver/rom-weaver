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

/// Latin names often also decode as Shift-JIS, because an accented byte plus the next ASCII
/// letter forms a valid two-byte character (CP437 `Hélène` reads as `HＭ穫e`). Such names never
/// pair two high bytes, while nearly every kana name does, so this requires one high-byte pair
/// and two adjacent Japanese characters.
fn decode_japanese(bytes: &[u8]) -> Option<String> {
    if !has_high_byte_pair(bytes) {
        return None;
    }
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

/// Whether a Shift-JIS two-byte character has a trail byte of 0x80 or above, or two half-width
/// katakana bytes sit together.
fn has_high_byte_pair(bytes: &[u8]) -> bool {
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        let next = bytes.get(index + 1).copied().unwrap_or(0);
        match byte {
            0x81..=0x9f | 0xe0..=0xfc => {
                if next >= 0x80 {
                    return true;
                }
                index += 2;
            }
            0xa1..=0xdf if (0xa1..=0xdf).contains(&next) => return true,
            _ => index += 1,
        }
    }
    false
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
