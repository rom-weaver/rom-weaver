//! Reader for variable-width RWFP4 artifact packs.

use rom_weaver_core::Result;
use serde_json::Value;

use crate::identify_catalog::IdentifySource;
use crate::identify_pack::{invalid_pack, read_members_with_magic, read_u32, required_member};
use crate::identify_pack_v2::PackGame;

pub(crate) const PACK_V4_MAGIC: &[u8] = b"RWFP4\0\0\0";
const FORMAT_V4: &str = "rom-weaver-identify-system-pack-v4";
const FORMAT_V3: &str = "rom-weaver-identify-system-pack-v3";
const NONE_ID: u32 = u32::MAX;
const MAX_DECODED_TABLE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug)]
pub struct ArtifactPack {
    inner: crate::identify_pack_v3::ArtifactPack,
}

impl ArtifactPack {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let members = read_members_with_magic(bytes, PACK_V4_MAGIC, "RWFP4")?;
        let strings = decode_strings(required_member(&members, "strings.bin")?)?;
        let converted = [
            ("strings.bin", strings.bytes),
            (
                "hashes.bin",
                decode_hashes(required_member(&members, "hashes.bin")?, &strings.values)?,
            ),
            (
                "components.bin",
                decode_components(required_member(&members, "components.bin")?)?,
            ),
            (
                "games.bin",
                decode_games(required_member(&members, "games.bin")?)?,
            ),
            (
                "owners.bin",
                decode_owners(required_member(&members, "owners.bin")?)?,
            ),
            (
                "routes.bin",
                decode_routes(required_member(&members, "routes.bin")?)?,
            ),
            (
                "sets.bin",
                decode_sets(required_member(&members, "sets.bin")?)?,
            ),
            (
                "manifest.json",
                decode_manifest(required_member(&members, "manifest.json")?)?,
            ),
        ];
        let inner = crate::identify_pack_v3::ArtifactPack::parse(&write_v3_pack(&converted))?;
        Ok(Self { inner })
    }

    pub fn platform(&self) -> &str {
        self.inner.platform()
    }
    pub fn source(&self) -> IdentifySource {
        self.inner.source()
    }
    pub fn canonicalization_profile(&self) -> &str {
        self.inner.canonicalization_profile()
    }
    pub fn provenance(&self) -> &Value {
        self.inner.provenance()
    }
    pub fn generation_date(&self) -> Option<&str> {
        self.inner.generation_date()
    }
    pub fn games(&self) -> &[PackGame] {
        self.inner.games()
    }
    pub fn game(&self, index: u32) -> Option<&PackGame> {
        self.inner.game(index)
    }
    pub fn route(&self, crc32: &str, size: u64) -> Result<Vec<(u32, u16)>> {
        self.inner.route(crc32, size)
    }
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8], magic: &[u8; 4]) -> Result<Self> {
        if bytes.len() < 5 || &bytes[..4] != magic || bytes[4] != 1 {
            return Err(invalid_pack("RWFP4 table header is invalid"));
        }
        Ok(Self { bytes, offset: 5 })
    }
    fn var_u64(&mut self) -> Result<u64> {
        let start = self.offset;
        let mut value = 0u64;
        for shift in (0..=63).step_by(7) {
            let byte = *self
                .bytes
                .get(self.offset)
                .ok_or_else(|| invalid_pack("RWFP4 variable integer is truncated"))?;
            self.offset += 1;
            if shift == 63 && byte > 1 {
                return Err(invalid_pack("RWFP4 variable integer overflows u64"));
            }
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                if self.offset - start > 1 && byte == 0 {
                    return Err(invalid_pack("RWFP4 variable integer is not canonical"));
                }
                return Ok(value);
            }
        }
        Err(invalid_pack("RWFP4 variable integer is too long"))
    }
    fn var_u32(&mut self) -> Result<u32> {
        u32::try_from(self.var_u64()?)
            .map_err(|_| invalid_pack("RWFP4 variable integer overflows u32"))
    }
    fn count(&mut self, label: &str) -> Result<usize> {
        usize::try_from(self.var_u64()?)
            .map_err(|_| invalid_pack(format!("RWFP4 {label} count does not fit this platform")))
    }
    fn byte(&mut self) -> Result<u8> {
        let value = *self
            .bytes
            .get(self.offset)
            .ok_or_else(|| invalid_pack("RWFP4 record is truncated"))?;
        self.offset += 1;
        Ok(value)
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or_else(|| invalid_pack("RWFP4 record offset overflow"))?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| invalid_pack("RWFP4 record is truncated"))?;
        self.offset = end;
        Ok(value)
    }
    fn finish(&self, label: &str) -> Result<()> {
        if self.offset != self.bytes.len() {
            return Err(invalid_pack(format!(
                "RWFP4 {label} table has trailing bytes"
            )));
        }
        Ok(())
    }
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}
fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}
fn push_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn fixed_header(magic: &[u8; 4], width: u16, count: usize, extra: usize) -> Result<Vec<u8>> {
    let count =
        u32::try_from(count).map_err(|_| invalid_pack("RWFP4 table count overflows u32"))?;
    let mut out = Vec::with_capacity(12 + extra);
    out.extend_from_slice(magic);
    push_u16(&mut out, 1);
    push_u16(&mut out, width);
    push_u32(&mut out, count);
    out.resize(12 + extra, 0);
    Ok(out)
}

fn check_decoded_size(label: &str, count: usize, width: usize, extra: usize) -> Result<()> {
    let size = count
        .checked_mul(width)
        .and_then(|value| value.checked_add(extra))
        .ok_or_else(|| invalid_pack(format!("RWFP4 {label} decoded size overflows")))?;
    if size > MAX_DECODED_TABLE_BYTES {
        return Err(invalid_pack(format!(
            "RWFP4 {label} decoded size exceeds the limit"
        )));
    }
    Ok(())
}

#[derive(Debug)]
struct Strings {
    bytes: Vec<u8>,
    values: Vec<String>,
}

fn decode_strings(bytes: &[u8]) -> Result<Strings> {
    let mut input = Cursor::new(bytes, b"RWS4")?;
    let count = input.count("string")?;
    if count > bytes.len() {
        return Err(invalid_pack("RWFP4 string count is out of range"));
    }
    let string_bytes = bytes
        .len()
        .checked_mul(2)
        .ok_or_else(|| invalid_pack("RWFP4 strings decoded size overflows"))?;
    check_decoded_size("strings", count, size_of::<String>() + 4, string_bytes)?;
    let mut values = Vec::with_capacity(count);
    let mut data = Vec::new();
    let mut offsets = vec![0u32];
    for _ in 0..count {
        let len = input.count("string byte")?;
        let raw = input.take(len)?;
        values.push(
            std::str::from_utf8(raw)
                .map_err(|error| invalid_pack(format!("RWFP4 string is not UTF-8: {error}")))?
                .to_string(),
        );
        data.extend_from_slice(raw);
        offsets.push(
            u32::try_from(data.len())
                .map_err(|_| invalid_pack("RWFP4 string data is too large"))?,
        );
    }
    input.finish("strings")?;
    let mut out = fixed_header(b"RWS3", 0, count, 4)?;
    out[12..16].copy_from_slice(
        &u32::try_from(data.len())
            .map_err(|_| invalid_pack("RWFP4 string data is too large"))?
            .to_le_bytes(),
    );
    for offset in offsets {
        push_u32(&mut out, offset);
    }
    out.extend_from_slice(&data);
    Ok(Strings { bytes: out, values })
}

fn decode_hashes(bytes: &[u8], strings: &[String]) -> Result<Vec<u8>> {
    let mut input = Cursor::new(bytes, b"RWH4")?;
    let count = input.count("hash")?;
    check_decoded_size(
        "hashes",
        count,
        92 + size_of::<(usize, usize)>(),
        bytes.len(),
    )?;
    let offsets_len = count
        .checked_add(1)
        .and_then(|v| v.checked_mul(4))
        .ok_or_else(|| invalid_pack("RWFP4 hash offsets overflow"))?;
    let raw_offsets = input.take(offsets_len)?;
    let data_start = input.offset;
    let mut prior = 0usize;
    let mut ranges = Vec::with_capacity(count);
    for index in 0..count {
        let start = read_u32(raw_offsets, index * 4)? as usize;
        let end = read_u32(raw_offsets, (index + 1) * 4)? as usize;
        if start != prior || end < start || end > bytes.len() - data_start {
            return Err(invalid_pack("RWFP4 hash offsets are invalid"));
        }
        ranges.push((data_start + start, data_start + end));
        prior = end;
    }
    if prior != bytes.len() - data_start {
        return Err(invalid_pack("RWFP4 hash offsets do not cover hash data"));
    }
    let mut out = fixed_header(b"RWH3", 92, count, 0)?;
    let full_file_scope = strings.iter().position(|value| value == "full_file");
    let track_file_scope = strings.iter().position(|value| value == "track_file");
    for (start, end) in ranges {
        let mut row = Cursor {
            bytes: &bytes[start..end],
            offset: 0,
        };
        let size = row.var_u64()?;
        let code = row.byte()?;
        let scope = match code {
            0 => full_file_scope,
            1 => track_file_scope,
            255 => Some(row.var_u32()? as usize),
            _ => return Err(invalid_pack(format!("RWFP4 hash scope {code} is invalid"))),
        }
        .filter(|&id| id < strings.len())
        .ok_or_else(|| invalid_pack("RWFP4 hash scope string is missing"))?;
        let mask = row.byte()?;
        if mask & !0x0f != 0 {
            return Err(invalid_pack("RWFP4 hash mask is invalid"));
        }
        let mut record = vec![0u8; 92];
        record[..8].copy_from_slice(&size.to_le_bytes());
        record[8..12].copy_from_slice(&(scope as u32).to_le_bytes());
        record[12] = mask;
        for (bit, offset, width) in [(1, 16, 4), (2, 20, 16), (4, 36, 20), (8, 56, 32)] {
            if mask & bit != 0 {
                record[offset..offset + width].copy_from_slice(row.take(width)?);
            }
        }
        row.finish("hash record")?;
        out.extend_from_slice(&record);
    }
    Ok(out)
}

fn optional(value: u32) -> u32 {
    value.checked_sub(1).unwrap_or(NONE_ID)
}

fn decode_components(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut input = Cursor::new(bytes, b"RWC4")?;
    let count = input.count("component")?;
    check_decoded_size("components", count, 28, 12)?;
    let mut out = fixed_header(b"RWC3", 28, count, 0)?;
    for _ in 0..count {
        let mut row = vec![0u8; 28];
        for (offset, value) in [
            (0, input.var_u32()?),
            (4, optional(input.var_u32()?)),
            (8, input.var_u32()?),
            (12, optional(input.var_u32()?)),
            (16, optional(input.var_u32()?)),
        ] {
            row[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        row[20] = input.byte()?;
        row[21] = input.byte()?;
        out.extend_from_slice(&row);
    }
    input.finish("components")?;
    Ok(out)
}

fn decode_games(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut input = Cursor::new(bytes, b"RWG4")?;
    let count = input.count("game")?;
    check_decoded_size("games", count, 52, 12)?;
    let mut out = fixed_header(b"RWG3", 52, count, 0)?;
    let mut first = 0u32;
    for _ in 0..count {
        let mut row = vec![0u8; 52];
        let fields = [
            input.var_u32()?,
            input.var_u32()?,
            optional(input.var_u32()?),
            optional(input.var_u32()?),
            optional(input.var_u32()?),
            optional(input.var_u32()?),
            optional(input.var_u32()?),
        ];
        for (index, value) in fields.into_iter().enumerate() {
            row[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        let component_count = input.var_u32()?;
        row[28..32].copy_from_slice(&first.to_le_bytes());
        row[32..36].copy_from_slice(&component_count.to_le_bytes());
        first = first
            .checked_add(component_count)
            .ok_or_else(|| invalid_pack("RWFP4 game component range overflows"))?;
        for offset in [36, 40] {
            row[offset..offset + 4].copy_from_slice(&input.var_u32()?.to_le_bytes());
        }
        row[44..48].copy_from_slice(&optional(input.var_u32()?).to_le_bytes());
        row[48] = input.byte()?;
        row[49] = input.byte()?;
        row[50] = input.byte()?;
        out.extend_from_slice(&row);
    }
    input.finish("games")?;
    Ok(out)
}

fn decode_owners(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut input = Cursor::new(bytes, b"RWO4")?;
    let hashes = input.count("owner hash")?;
    let owners = input.count("owner")?;
    let total = hashes
        .checked_add(1)
        .and_then(|v| v.checked_add(owners))
        .ok_or_else(|| invalid_pack("RWFP4 owners count overflow"))?;
    check_decoded_size("owners", total, 4, 16)?;
    let mut out = fixed_header(b"RWO3", 0, hashes, 4)?;
    out[12..16].copy_from_slice(
        &u32::try_from(owners)
            .map_err(|_| invalid_pack("RWFP4 owner count overflows u32"))?
            .to_le_bytes(),
    );
    for _ in 0..total {
        push_u32(&mut out, input.var_u32()?);
    }
    input.finish("owners")?;
    Ok(out)
}

fn decode_routes(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut input = Cursor::new(bytes, b"RWR4")?;
    let count = input.count("route")?;
    check_decoded_size("routes", count, 4, 12)?;
    let mut out = fixed_header(b"RWR3", 4, count, 0)?;
    for _ in 0..count {
        push_u32(&mut out, input.var_u32()?);
    }
    input.finish("routes")?;
    Ok(out)
}

fn decode_sets(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut input = Cursor::new(bytes, b"RWX4")?;
    let ps = input.count("provenance set")?;
    let pv = input.count("provenance value")?;
    let ts = input.count("tag set")?;
    let tv = input.count("tag value")?;
    let total = ps
        .checked_add(1)
        .and_then(|v| v.checked_add(pv))
        .and_then(|v| v.checked_add(ts.checked_add(1)?))
        .and_then(|v| v.checked_add(tv))
        .ok_or_else(|| invalid_pack("RWFP4 set count overflow"))?;
    check_decoded_size("sets", total, 4, 24)?;
    let mut out = fixed_header(b"RWSX", 0, ps, 12)?;
    for (offset, value) in [(12, pv), (16, ts), (20, tv)] {
        out[offset..offset + 4].copy_from_slice(
            &u32::try_from(value)
                .map_err(|_| invalid_pack("RWFP4 set count overflows u32"))?
                .to_le_bytes(),
        );
    }
    for _ in 0..total {
        push_u32(&mut out, input.var_u32()?);
    }
    input.finish("sets")?;
    Ok(out)
}

fn decode_manifest(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut manifest: Value = serde_json::from_slice(bytes)
        .map_err(|error| invalid_pack(format!("manifest.json is invalid JSON: {error}")))?;
    let format = manifest
        .get_mut("format")
        .ok_or_else(|| invalid_pack("manifest format is missing"))?;
    if format.as_str() != Some(FORMAT_V4) {
        return Err(invalid_pack("manifest format is not RWFP4"));
    }
    *format = Value::String(FORMAT_V3.to_string());
    serde_json::to_vec(&manifest)
        .map_err(|error| invalid_pack(format!("manifest.json cannot be converted: {error}")))
}

fn write_v3_pack(members: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut out = crate::identify_pack_v3::PACK_V3_MAGIC.to_vec();
    push_u32(&mut out, members.len() as u32);
    for (name, value) in members {
        push_u16(&mut out, name.len() as u16);
        push_u64(&mut out, value.len() as u64);
        out.extend_from_slice(name.as_bytes());
    }
    for (_, value) in members {
        out.extend_from_slice(value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identify_pack::IdentifyPackFile;

    const MIXED_FIXTURE: &str = "UldGUDQAAAAIAAAACwCmAAAAAAAAAHN0cmluZ3MuYmluCgBPAAAAAAAAAGhhc2hlcy5iaW4OABsAAAAAAAAAY29tcG9uZW50cy5iaW4JADAAAAAAAAAAZ2FtZXMuYmluCgAOAAAAAAAAAG93bmVycy5iaW4KAAkAAAAAAAAAcm91dGVzLmJpbggAGwAAAAAAAABzZXRzLmJpbg0ADwUAAAAAAABtYW5pZmVzdC5qc29uUldTNAEMASERQWxwaGEgUXVlc3QgKFVTQSkQQmV0YSBRdWVzdCAoVVNBKRxMZWdhY3kgUXVlc3QgKFUpIFtiMV1bVC1FbmddKE5pbnRlbmRvIC0gTmludGVuZG8gRW50ZXJ0YWlubWVudCBTeXN0ZW0FVC1FbmcDVVNBCWFscGhhLm5lcwJiMQhiZXRhLm5lcwlmdWxsX2ZpbGUKbGVnYWN5Lm5lc1JXSDQBAwAAAAAHAAAAMgAAADkAAAAIAAERIjNEEAAHqrvM3QARIjNEVWZ3iJmqu8zd7v8AESIzRFVmd4iZqrvM3e7/ABEiMyAAAd6tvu9SV0M0AQMBCAAAAAADAAoAAAAAAwIMAAAAAANSV0c0AQMBBAAHAAAAAQEBAAAAAAIEAAcAAAABAgAAAAAAAwQAAAAAAAEDAgABBgFSV080AQMDAAECAwEAAlJXUjQBAwABAlJXWDQBBAYDAwAAAwUGAAECAAECAAABAwAIBXsiZm9ybWF0Ijoicm9tLXdlYXZlci1pZGVudGlmeS1zeXN0ZW0tcGFjay12NCIsInBsYXRmb3JtIjoiTmludGVuZG8gLSBOaW50ZW5kbyBFbnRlcnRhaW5tZW50IFN5c3RlbSIsInNvdXJjZSI6ImxpYnJldHJvIiwiZ2VuZXJhdGlvbkRhdGUiOiIyMDI2LTA4LTI3IiwiY2Fub25pY2FsaXphdGlvblByb2ZpbGUiOiJsaWJyZXRyby1jbHJtYW1lcHJvLXYxIiwiY2Fub25pY2FsaXphdGlvblZlcnNpb24iOjEsInByb3ZlbmFuY2UiOlt7ImxpY2Vuc2UiOiJDQy1CWS1TQS00LjAiLCJzb3VyY2UiOiJsaWJyZXRybyIsInNvdXJjZUNvbW1pdCI6IjY5ZWE2MmEyODIzODIzODIwZDRmMTIxYzJiNTNiZjIwZmQwODhhYjQiLCJzb3VyY2VOYW1lIjoibGlicmV0cm8iLCJzb3VyY2VVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vbGlicmV0cm8vbGlicmV0cm8tZGF0YWJhc2UvYmxvYi82OWVhNjJhMjgyMzgyMzgyMGQ0ZjEyMWMyYjUzYmYyMGZkMDg4YWI0L2RhdC9OaW50ZW5kbyUyMC0lMjBOaW50ZW5kbyUyMEVudGVydGFpbm1lbnQlMjBTeXN0ZW0uZGF0IiwiZ2VuZXJhdGlvbkRhdGUiOiIyMDI2LTA4LTI3In0seyJsaWNlbnNlIjoiQ0MtQlktU0EtNC4wIiwic291cmNlIjoibm8taW50cm8iLCJzb3VyY2VDb21taXQiOiI2OWVhNjJhMjgyMzgyMzgyMGQ0ZjEyMWMyYjUzYmYyMGZkMDg4YWI0Iiwic291cmNlTmFtZSI6Im5vLWludHJvIiwic291cmNlVXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2xpYnJldHJvL2xpYnJldHJvLWRhdGFiYXNlL2Jsb2IvNjllYTYyYTI4MjM4MjM4MjBkNGYxMjFjMmI1M2JmMjBmZDA4OGFiNC9tZXRhZGF0L25vLWludHJvL05pbnRlbmRvJTIwLSUyME5pbnRlbmRvJTIwRW50ZXJ0YWlubWVudCUyMFN5c3RlbS5kYXQiLCJnZW5lcmF0aW9uRGF0ZSI6IjIwMjYtMDgtMjcifSx7ImxpY2Vuc2UiOiJDQzAtMS4wIiwic291cmNlIjoiU25vd2ZsYWtlUG93ZXJlZC9vcGVuZ29vZCIsInNvdXJjZUNvbW1pdCI6IjVjYmQ5NWVmM2Y1OTA0YjllMDY3MDQyYWU4ZGQwOGEzNWMzOWM4OWEiLCJzb3VyY2VOYW1lIjoiU25vd2ZsYWtlUG93ZXJlZC9vcGVuZ29vZCIsInNvdXJjZVVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9Tbm93Zmxha2VQb3dlcmVkL29wZW5nb29kL2Jsb2IvNWNiZDk1ZWYzZjU5MDRiOWUwNjcwNDJhZThkZDA4YTM1YzM5Yzg5YS9kYXRzL09wZW5ORVMuZGF0IiwiZ2VuZXJhdGlvbkRhdGUiOiIyMDIxLTEyLTI3In1dLCJjb3VudHMiOnsiZ2FtZXMiOjMsImNvbXBvbmVudHMiOjMsImhhc2hlcyI6Mywicm91dGVkS2V5cyI6Mywic2hhcmVkQ29tcG9uZW50cyI6MH19";

    fn base64(value: &str) -> Vec<u8> {
        let decode = |byte| match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => 0,
        };
        let mut out = Vec::new();
        for chunk in value.as_bytes().chunks(4) {
            let bits = (u32::from(decode(chunk[0])) << 18)
                | (u32::from(decode(chunk[1])) << 12)
                | (u32::from(decode(chunk[2])) << 6)
                | u32::from(decode(chunk[3]));
            out.push((bits >> 16) as u8);
            if chunk[2] != b'=' {
                out.push((bits >> 8) as u8);
            }
            if chunk[3] != b'=' {
                out.push(bits as u8);
            }
        }
        out
    }

    #[test]
    fn finds_primary_only_fallback_only_and_overlapping_records() {
        let bytes = base64(MIXED_FIXTURE);
        let pack = ArtifactPack::parse(&bytes).expect("RWFP4 fixture parses");
        assert_eq!(pack.route("11223344", 8).unwrap(), [(1, 0)]);
        assert_eq!(pack.route("deadbeef", 32).unwrap(), [(2, 0)]);
        assert_eq!(pack.route("aabbccdd", 16).unwrap(), [(0, 0)]);
        assert_eq!(pack.games()[0].name, "Alpha Quest (USA)");
        assert_eq!(pack.games()[0].provenance.len(), 3);
        assert!(!pack.games()[0].legacy_variant);
        assert_eq!(pack.games()[2].name, "Legacy Quest (U) [b1][T-Eng]");
        assert!(pack.games()[2].legacy_variant);
        assert!(matches!(
            IdentifyPackFile::parse(&bytes).unwrap(),
            IdentifyPackFile::V4(_)
        ));
    }

    #[test]
    fn rejects_noncanonical_variable_integers() {
        let error = decode_strings(b"RWS4\x01\x80\x00").unwrap_err();
        assert!(error.to_string().contains("not canonical"));
    }

    #[test]
    fn rejects_invalid_hash_offsets_and_masks() {
        let strings = vec!["full_file".to_string()];
        let mut offset = b"RWH4\x01\x01".to_vec();
        offset.extend_from_slice(&1u32.to_le_bytes());
        offset.extend_from_slice(&1u32.to_le_bytes());
        assert!(
            decode_hashes(&offset, &strings)
                .unwrap_err()
                .to_string()
                .contains("offsets")
        );

        let mut mask = b"RWH4\x01\x01".to_vec();
        mask.extend_from_slice(&0u32.to_le_bytes());
        mask.extend_from_slice(&3u32.to_le_bytes());
        mask.extend_from_slice(&[1, 0, 0x10]);
        assert!(
            decode_hashes(&mask, &strings)
                .unwrap_err()
                .to_string()
                .contains("mask")
        );
    }

    #[test]
    fn rejects_counts_that_exceed_the_decoded_size_limit() {
        fn varint(mut value: u64) -> Vec<u8> {
            let mut bytes = Vec::new();
            loop {
                let mut byte = (value & 0x7f) as u8;
                value >>= 7;
                if value != 0 {
                    byte |= 0x80;
                }
                bytes.push(byte);
                if value == 0 {
                    return bytes;
                }
            }
        }

        let mut components = b"RWC4\x01".to_vec();
        components.extend_from_slice(&varint((MAX_DECODED_TABLE_BYTES / 28 + 1) as u64));
        assert!(
            decode_components(&components)
                .unwrap_err()
                .to_string()
                .contains("decoded size exceeds")
        );

        let count = MAX_DECODED_TABLE_BYTES / (size_of::<String>() + 4) + 1;
        let mut strings = b"RWS4\x01".to_vec();
        strings.extend_from_slice(&varint(count as u64));
        strings.resize(strings.len() + count, 0);
        assert!(
            decode_strings(&strings)
                .unwrap_err()
                .to_string()
                .contains("decoded size exceeds")
        );
    }
}
