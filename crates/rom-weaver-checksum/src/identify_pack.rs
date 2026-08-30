//! Shared RWFP5 container validation and dispatch.

use std::collections::HashMap;

use rom_weaver_core::{Result, RomWeaverError};

#[derive(Debug)]
pub enum IdentifyPackFile {
    V5(crate::identify_pack_v5::ArtifactPack),
}

impl IdentifyPackFile {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.starts_with(crate::identify_pack_v5::PACK_V5_MAGIC) {
            return Ok(Self::V5(crate::identify_pack_v5::ArtifactPack::parse(
                bytes,
            )?));
        }
        Err(invalid_pack("pack magic does not match RWFP5"))
    }
}

pub(crate) fn read_members_with_magic<'a>(
    bytes: &'a [u8],
    magic: &[u8],
    label: &str,
) -> Result<HashMap<String, &'a [u8]>> {
    if bytes.len() < magic.len() + 4 || &bytes[..magic.len()] != magic {
        return Err(invalid_pack(format!("pack magic does not match {label}")));
    }
    let mut cursor = magic.len();
    let count = read_u32(bytes, cursor)? as usize;
    cursor += 4;
    if count > (bytes.len() - cursor) / 10 {
        return Err(invalid_pack("pack directory entry count is out of range"));
    }
    let mut directory = Vec::with_capacity(count);
    for _ in 0..count {
        let name_len = read_u16(bytes, cursor)? as usize;
        cursor += 2;
        let byte_len = usize::try_from(read_u64(bytes, cursor)?)
            .map_err(|_| invalid_pack("pack member length does not fit this platform"))?;
        cursor += 8;
        let name_end = cursor
            .checked_add(name_len)
            .ok_or_else(|| invalid_pack("pack directory name offset overflow"))?;
        let name = std::str::from_utf8(
            bytes
                .get(cursor..name_end)
                .ok_or_else(|| invalid_pack("pack directory name is out of bounds"))?,
        )
        .map_err(|error| invalid_pack(format!("pack member name is not UTF-8: {error}")))?
        .to_string();
        cursor = name_end;
        directory.push((name, byte_len));
    }
    let mut members = HashMap::with_capacity(directory.len());
    for (name, byte_len) in directory {
        let end = cursor
            .checked_add(byte_len)
            .ok_or_else(|| invalid_pack("pack member offset overflow"))?;
        let member = bytes
            .get(cursor..end)
            .ok_or_else(|| invalid_pack("pack member is out of bounds"))?;
        if members.insert(name.clone(), member).is_some() {
            return Err(invalid_pack(format!("duplicate pack member: {name}")));
        }
        cursor = end;
    }
    if cursor != bytes.len() {
        return Err(invalid_pack("pack has trailing bytes"));
    }
    Ok(members)
}

pub(crate) fn required_member<'a>(
    members: &'a HashMap<String, &'a [u8]>,
    name: &str,
) -> Result<&'a [u8]> {
    members
        .get(name)
        .copied()
        .ok_or_else(|| invalid_pack(format!("required member is missing: {name}")))
}

pub(crate) fn hex_to_bytes(hex: &str) -> Result<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return Err(RomWeaverError::Validation(format!(
            "identify checksum must have an even number of hexadecimal characters: {hex}"
        )));
    }
    (0..hex.len() / 2)
        .map(|index| {
            u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "identify checksum contains invalid hexadecimal characters: {error}"
                ))
            })
        })
        .collect()
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let end = offset
        .checked_add(2)
        .ok_or_else(|| invalid_pack("u16 read offset overflow"))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| invalid_pack("u16 read is out of bounds"))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| invalid_pack("u32 read offset overflow"))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| invalid_pack("u32 read is out of bounds"))?;
    Ok(u32::from_le_bytes(
        slice.try_into().expect("four-byte slice"),
    ))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64> {
    let end = offset
        .checked_add(8)
        .ok_or_else(|| invalid_pack("u64 read offset overflow"))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| invalid_pack("u64 read is out of bounds"))?;
    Ok(u64::from_le_bytes(
        slice.try_into().expect("eight-byte slice"),
    ))
}

pub(crate) fn invalid_pack(message: impl Into<String>) -> RomWeaverError {
    RomWeaverError::Validation(format!("invalid ROM identify pack: {}", message.into()))
}
