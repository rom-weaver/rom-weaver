//! Bounded Yay0 decoder for Star Rod Classic `.mod` packages
//! (`game/yay0/Yay0Helper.java` in z64a/star-rod-classic).

use rom_weaver_core::{ERROR_CODE_RESOURCE_OUT_OF_MEMORY, Result, RomWeaverError};
use tracing::trace;

pub(crate) const YAY0_MAGIC: &[u8; 4] = b"Yay0";
const YAY0_HEADER_BYTES: usize = 16;
const YAY0_EXTENDED_LENGTH_BIAS: usize = 18;
const YAY0_LINK_LENGTH_BIAS: usize = 2;
/// The longest copy is 273 bytes (255 + 18) and costs a 2-byte link, a length byte and an
/// eighth of a command byte, so a valid stream expands by under 88 times.
const YAY0_MAX_EXPANSION: u64 = 88;

/// Decodes a Yay0 stream. Fails when the declared decoded length exceeds `max_decoded_len` or
/// what the stream's own size can produce, when an offset points past the stream, or when a
/// link reaches before the start of the output or beyond the declared length.
pub(crate) fn decode_yay0(source: &[u8], max_decoded_len: u64) -> Result<Vec<u8>> {
    if source.get(..YAY0_MAGIC.len()) != Some(YAY0_MAGIC.as_slice()) {
        return Err(yay0_error("stream does not start with the Yay0 magic"));
    }
    let decoded_len = u64::from(read_header_u32(source, 4)?);
    let link_offset = read_header_u32(source, 8)?;
    let chunk_offset = read_header_u32(source, 12)?;

    let source_len = source.len() as u64;
    let limit = max_decoded_len.min(source_len.saturating_mul(YAY0_MAX_EXPANSION));
    if decoded_len > limit {
        return Err(yay0_error(&format!(
            "declares {decoded_len} decoded byte(s), more than the {limit} byte limit for a {source_len} byte stream"
        )));
    }
    for (label, offset) in [("link", link_offset), ("chunk", chunk_offset)] {
        if usize::try_from(offset)
            .ok()
            .is_none_or(|offset| offset < YAY0_HEADER_BYTES || offset > source.len())
        {
            return Err(yay0_error(&format!(
                "{label} table offset {offset} is outside the {source_len} byte stream"
            )));
        }
    }
    trace!(
        decoded_len,
        link_offset, chunk_offset, source_len, "yay0 decode"
    );

    let decoded_len = usize::try_from(decoded_len)
        .map_err(|_| yay0_error("decoded length exceeded addressable memory"))?;
    let mut decoded = Vec::new();
    decoded.try_reserve_exact(decoded_len).map_err(|_| {
        RomWeaverError::coded(
            ERROR_CODE_RESOURCE_OUT_OF_MEMORY,
            format!("cannot reserve {decoded_len} byte(s) for the Yay0 output"),
        )
    })?;

    let mut tables = Yay0Tables {
        source,
        command_pos: YAY0_HEADER_BYTES,
        link_pos: link_offset as usize,
        chunk_pos: chunk_offset as usize,
    };
    let mut command = 0u8;
    let mut bits_left = 0u8;
    while decoded.len() < decoded_len {
        if bits_left == 0 {
            command = tables.next_command()?;
            bits_left = 8;
        }
        if command & 0x80 != 0 {
            decoded.push(tables.next_chunk_byte()?);
        } else {
            copy_link(&mut decoded, &mut tables, decoded_len)?;
        }
        command <<= 1;
        bits_left -= 1;
    }
    Ok(decoded)
}

struct Yay0Tables<'a> {
    source: &'a [u8],
    command_pos: usize,
    link_pos: usize,
    chunk_pos: usize,
}

impl Yay0Tables<'_> {
    fn next_command(&mut self) -> Result<u8> {
        take_byte(self.source, &mut self.command_pos, "command bits")
    }

    fn next_chunk_byte(&mut self) -> Result<u8> {
        take_byte(self.source, &mut self.chunk_pos, "chunk table")
    }

    fn next_link(&mut self) -> Result<u16> {
        let high = take_byte(self.source, &mut self.link_pos, "link table")?;
        let low = take_byte(self.source, &mut self.link_pos, "link table")?;
        Ok(u16::from_be_bytes([high, low]))
    }
}

fn copy_link(decoded: &mut Vec<u8>, tables: &mut Yay0Tables, decoded_len: usize) -> Result<()> {
    let link = tables.next_link()?;
    let distance = usize::from(link & 0x0FFF) + 1;
    let length = match usize::from(link >> 12) {
        0 => usize::from(tables.next_chunk_byte()?) + YAY0_EXTENDED_LENGTH_BIAS,
        nibble => nibble + YAY0_LINK_LENGTH_BIAS,
    };
    if distance > decoded.len() {
        return Err(yay0_error(&format!(
            "link at output byte {} reaches {distance} byte(s) back before the start of the output",
            decoded.len()
        )));
    }
    if length > decoded_len - decoded.len() {
        return Err(yay0_error(&format!(
            "link at output byte {} copies {length} byte(s) past the declared {decoded_len} byte length",
            decoded.len()
        )));
    }
    // Source and destination may overlap, so copy byte by byte.
    for _ in 0..length {
        decoded.push(decoded[decoded.len() - distance]);
    }
    Ok(())
}

fn take_byte(source: &[u8], position: &mut usize, label: &str) -> Result<u8> {
    let byte = *source
        .get(*position)
        .ok_or_else(|| yay0_error(&format!("stream ended while reading the {label}")))?;
    *position += 1;
    Ok(byte)
}

fn read_header_u32(source: &[u8], offset: usize) -> Result<u32> {
    let bytes: [u8; 4] = source
        .get(offset..offset + 4)
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| yay0_error("stream is shorter than the 16 byte header"))?;
    Ok(u32::from_be_bytes(bytes))
}

fn yay0_error(message: &str) -> RomWeaverError {
    RomWeaverError::Validation(format!("Yay0 {message}"))
}

#[cfg(test)]
#[path = "../tests/unit/yay0.rs"]
mod tests;
