//! Reader for variable-width RWFP4 artifact packs.

use std::collections::HashMap;

use rom_weaver_core::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::trace;

use crate::identify_catalog::IdentifySource;
use crate::identify_pack::{
    hex_to_bytes, invalid_pack, read_members_with_magic, read_u16, read_u32, read_u64,
    required_member,
};

pub(crate) const PACK_V4_MAGIC: &[u8] = b"RWFP4\0\0\0";
const FORMAT_V4: &str = "rom-weaver-identify-system-pack-v4";
const NONE_ID: u32 = u32::MAX;
const MAX_DECODED_TABLE_BYTES: usize = 128 * 1024 * 1024;
const MAX_GAMES: usize = 4_000_000;
const MAX_COMPONENTS_PER_GAME: usize = 10_000;
const MAX_STRING_LEN: usize = 4096;

/// Role of one pack component.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PackComponentRole {
    PrimaryPayload,
    DataTrack,
    AudioTrack,
    ArcadeRom,
    Partition,
    ContentFile,
    DiskSide,
    ChildDisc,
}

/// The upstream dump database that contributed a game record.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UpstreamSource {
    Libretro,
    Redump,
    NoIntro,
    Tosec,
    Mame,
    Fbneo,
    OpenGood,
    Unknown,
}

/// One upstream source that contributed metadata to a merged lookup record.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct PackProvenance {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}

/// One hashed component of a pack game.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackComponent {
    pub role: PackComponentRole,
    pub ordinal: u32,
    pub hash_scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crc32: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub md5: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub required: bool,
    pub discriminating: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<u32>,
}

/// One game record in a pack.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackGame {
    pub name: String,
    pub platform: String,
    pub source: IdentifySource,
    pub upstream_source: UpstreamSource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provenance: Vec<PackProvenance>,
    #[serde(default)]
    pub legacy_variant: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dump_tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disc_number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub components: Vec<PackComponent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackManifest {
    format: String,
    platform: String,
    source: IdentifySource,
    canonicalization_profile: String,
    canonicalization_version: u32,
    #[serde(default)]
    provenance: Vec<PackProvenance>,
    #[serde(default)]
    generation_date: Option<String>,
}

#[derive(Debug)]
struct HashRecord {
    size: u64,
    scope: String,
    crc32: Option<String>,
    md5: Option<String>,
    sha1: Option<String>,
    sha256: Option<String>,
}

#[derive(Debug)]
struct RouteIndex {
    hash_ids: Vec<u32>,
}

#[derive(Debug)]
pub struct ArtifactPack {
    games: Vec<PackGame>,
    component_refs: Vec<(u32, u16)>,
    hashes: Vec<HashRecord>,
    owners: Vec<Vec<u32>>,
    route: RouteIndex,
    manifest: PackManifest,
    manifest_provenance: Value,
}

impl ArtifactPack {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let members = read_members_with_magic(bytes, PACK_V4_MAGIC, "RWFP4")?;
        let strings = decode_strings(required_member(&members, "strings.bin")?)?;
        let converted = HashMap::from([
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
        ]);
        Self::parse_normalized(&converted)
    }

    pub fn platform(&self) -> &str {
        &self.manifest.platform
    }
    pub fn source(&self) -> IdentifySource {
        self.manifest.source
    }
    pub fn canonicalization_profile(&self) -> &str {
        &self.manifest.canonicalization_profile
    }
    pub fn provenance(&self) -> &Value {
        &self.manifest_provenance
    }
    pub fn generation_date(&self) -> Option<&str> {
        self.manifest.generation_date.as_deref()
    }
    pub fn games(&self) -> &[PackGame] {
        &self.games
    }
    pub fn game(&self, index: u32) -> Option<&PackGame> {
        self.games.get(index as usize)
    }
    pub fn route(&self, crc32: &str, size: u64) -> Result<Vec<(u32, u16)>> {
        let bytes = hex_to_bytes(&crc32.to_ascii_lowercase())?;
        let crc: [u8; 4] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| invalid_pack("route query crc32 is not 8 hex characters"))?;
        let start = self.route.hash_ids.partition_point(|&id| {
            let hash = &self.hashes[id as usize];
            hash.crc32.as_deref().map(hex_crc).unwrap_or([0; 4]) < crc
                || (hash.crc32.as_deref().map(hex_crc).unwrap_or([0; 4]) == crc && hash.size < size)
        });
        let mut out = Vec::new();
        for &hash_id in &self.route.hash_ids[start..] {
            let hash = &self.hashes[hash_id as usize];
            if hash.crc32.as_deref().map(hex_crc) != Some(crc) || hash.size != size {
                break;
            }
            for &component_id in &self.owners[hash_id as usize] {
                let (game, component) = self.component_refs[component_id as usize];
                if self.games[game as usize].components[component as usize].discriminating {
                    out.push((game, component));
                }
            }
        }
        Ok(out)
    }
}

impl ArtifactPack {
    fn parse_normalized(members: &HashMap<&str, Vec<u8>>) -> Result<Self> {
        let member = |name| {
            members
                .get(name)
                .map(Vec::as_slice)
                .ok_or_else(|| invalid_pack(format!("required member is missing: {name}")))
        };
        let strings = parse_strings(member("strings.bin")?)?;
        let manifest: PackManifest = serde_json::from_slice(member("manifest.json")?)
            .map_err(|error| invalid_pack(format!("manifest.json is invalid JSON: {error}")))?;
        if manifest.format != FORMAT_V4 {
            return Err(invalid_pack(format!(
                "manifest format `{}` is not `{FORMAT_V4}`",
                manifest.format
            )));
        }
        if manifest.canonicalization_version != 1 {
            return Err(invalid_pack(format!(
                "manifest canonicalization version {} is not supported",
                manifest.canonicalization_version
            )));
        }
        let hashes = parse_hashes(member("hashes.bin")?, &strings)?;
        let components = parse_components(member("components.bin")?, &strings, &hashes)?;
        let owners = parse_owners(member("owners.bin")?, hashes.len(), components.len())?;
        validate_owners(&owners, &components)?;
        let (provenance_sets, tag_sets) =
            parse_sets(member("sets.bin")?, manifest.provenance.len(), &strings)?;
        let games = parse_games(
            member("games.bin")?,
            &strings,
            &components,
            &manifest.provenance,
            &provenance_sets,
            &tag_sets,
        )?;
        let route = parse_routes(member("routes.bin")?, &hashes, &owners, &components)?;
        let component_refs = games
            .iter()
            .enumerate()
            .flat_map(|(game, value)| {
                (0..value.components.len()).map(move |component| (game as u32, component as u16))
            })
            .collect();
        let manifest_provenance = serde_json::to_value(&manifest.provenance)
            .map_err(|error| invalid_pack(format!("manifest provenance is invalid: {error}")))?;
        trace!(
            platform = %manifest.platform,
            games = games.len(),
            components = components.len(),
            hashes = hashes.len(),
            "parsed RWFP4 pack"
        );
        Ok(Self {
            games,
            component_refs,
            hashes,
            owners,
            route,
            manifest,
            manifest_provenance,
        })
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
    let mut out = fixed_header(b"RWSN", 0, count, 4)?;
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
    let mut out = fixed_header(b"RWHN", 92, count, 0)?;
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
    let mut out = fixed_header(b"RWCN", 28, count, 0)?;
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
    let mut out = fixed_header(b"RWGN", 52, count, 0)?;
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
    let mut out = fixed_header(b"RWON", 0, hashes, 4)?;
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
    let mut out = fixed_header(b"RWRN", 4, count, 0)?;
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
    serde_json::to_vec(&manifest)
        .map_err(|error| invalid_pack(format!("manifest.json cannot be converted: {error}")))
}

#[derive(Debug)]
struct ComponentRecord {
    hash_id: u32,
    component: PackComponent,
}

type ProvenanceSets = Vec<Vec<u32>>;
type TagSets = Vec<Vec<String>>;

fn parse_header<'a>(
    bytes: &'a [u8],
    magic: &[u8; 4],
    width: u16,
    label: &str,
) -> Result<(usize, &'a [u8])> {
    if bytes.len() < 12 || &bytes[..4] != magic {
        return Err(invalid_pack(format!("{label} table magic is invalid")));
    }
    if read_u16(bytes, 4)? != 1 || read_u16(bytes, 6)? != width {
        return Err(invalid_pack(format!(
            "{label} table layout is not supported"
        )));
    }
    let count = read_u32(bytes, 8)? as usize;
    let expected = 12usize
        .checked_add(
            count
                .checked_mul(width as usize)
                .ok_or_else(|| invalid_pack(format!("{label} table length overflow")))?,
        )
        .ok_or_else(|| invalid_pack(format!("{label} table length overflow")))?;
    if bytes.len() != expected {
        return Err(invalid_pack(format!(
            "{label} table length does not match its header"
        )));
    }
    Ok((count, &bytes[12..]))
}

fn parse_strings(bytes: &[u8]) -> Result<Vec<String>> {
    if bytes.len() < 16
        || &bytes[..4] != b"RWSN"
        || read_u16(bytes, 4)? != 1
        || read_u16(bytes, 6)? != 0
    {
        return Err(invalid_pack("strings table header is invalid"));
    }
    let count = read_u32(bytes, 8)? as usize;
    let byte_count = read_u32(bytes, 12)? as usize;
    let offset_count = count
        .checked_add(1)
        .ok_or_else(|| invalid_pack("string offset count overflow"))?;
    let data_start = 16usize
        .checked_add(
            offset_count
                .checked_mul(4)
                .ok_or_else(|| invalid_pack("string offsets overflow"))?,
        )
        .ok_or_else(|| invalid_pack("string data offset overflow"))?;
    if data_start.checked_add(byte_count) != Some(bytes.len()) {
        return Err(invalid_pack(
            "strings table length does not match its header",
        ));
    }
    let mut out = Vec::with_capacity(count);
    let mut prior = 0usize;
    for index in 0..count {
        let start = read_u32(bytes, 16 + index * 4)? as usize;
        let end = read_u32(bytes, 16 + (index + 1) * 4)? as usize;
        if start != prior || end < start || end > byte_count {
            return Err(invalid_pack("string offsets are not contiguous"));
        }
        if end - start > MAX_STRING_LEN {
            return Err(invalid_pack(format!(
                "string is longer than the {MAX_STRING_LEN}-byte cap"
            )));
        }
        let value = std::str::from_utf8(&bytes[data_start + start..data_start + end])
            .map_err(|error| invalid_pack(format!("string is not UTF-8: {error}")))?;
        out.push(value.to_string());
        prior = end;
    }
    if prior != byte_count {
        return Err(invalid_pack("string offsets do not cover the string data"));
    }
    Ok(out)
}

fn string(strings: &[String], id: u32, optional: bool, label: &str) -> Result<Option<String>> {
    if optional && id == NONE_ID {
        return Ok(None);
    }
    strings
        .get(id as usize)
        .cloned()
        .map(Some)
        .ok_or_else(|| invalid_pack(format!("{label} string id {id} is out of range")))
}

fn parse_hashes(bytes: &[u8], strings: &[String]) -> Result<Vec<HashRecord>> {
    let (count, records) = parse_header(bytes, b"RWHN", 92, "hashes")?;
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let off = index * 92;
        let record = &records[off..off + 92];
        let mask = record[12];
        if mask & !0x0f != 0 || record[13..16] != [0; 3] || read_u32(record, 88)? != 0 {
            return Err(invalid_pack("hash record reserved fields are not zero"));
        }
        let scope = string(strings, read_u32(record, 8)?, false, "hash scope")?.unwrap();
        let value = |bit, range: std::ops::Range<usize>| {
            if mask & bit != 0 {
                Some(bytes_to_hex(&record[range]))
            } else {
                None
            }
        };
        out.push(HashRecord {
            size: read_u64(record, 0)?,
            scope,
            crc32: value(1, 16..20),
            md5: value(2, 20..36),
            sha1: value(4, 36..56),
            sha256: value(8, 56..88),
        });
    }
    Ok(out)
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 15) as usize] as char);
    }
    out
}

fn hex_crc(value: &str) -> [u8; 4] {
    let bytes = hex_to_bytes(value).expect("reader produced validated hash");
    bytes.try_into().expect("reader produced a four-byte crc")
}

fn parse_role(value: u8) -> Result<PackComponentRole> {
    Ok(match value {
        0 => PackComponentRole::PrimaryPayload,
        1 => PackComponentRole::DataTrack,
        2 => PackComponentRole::AudioTrack,
        3 => PackComponentRole::ArcadeRom,
        4 => PackComponentRole::Partition,
        5 => PackComponentRole::ContentFile,
        6 => PackComponentRole::DiskSide,
        7 => PackComponentRole::ChildDisc,
        _ => return Err(invalid_pack(format!("component role {value} is invalid"))),
    })
}

fn parse_components(
    bytes: &[u8],
    strings: &[String],
    hashes: &[HashRecord],
) -> Result<Vec<ComponentRecord>> {
    let (count, records) = parse_header(bytes, b"RWCN", 28, "components")?;
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let record = &records[index * 28..index * 28 + 28];
        let hash_id = read_u32(record, 0)?;
        let hash = hashes
            .get(hash_id as usize)
            .ok_or_else(|| invalid_pack(format!("component hash id {hash_id} is out of range")))?;
        let flags = record[21];
        if flags & !3 != 0 || read_u16(record, 22)? != 0 || read_u32(record, 24)? != 0 {
            return Err(invalid_pack("component reserved fields are not zero"));
        }
        let optional_u32 = |value| if value == NONE_ID { None } else { Some(value) };
        out.push(ComponentRecord {
            hash_id,
            component: PackComponent {
                role: parse_role(record[20])?,
                ordinal: read_u32(record, 8)?,
                hash_scope: hash.scope.clone(),
                filename: string(strings, read_u32(record, 4)?, true, "component filename")?,
                size: hash.size,
                crc32: hash.crc32.clone(),
                md5: hash.md5.clone(),
                sha1: hash.sha1.clone(),
                sha256: hash.sha256.clone(),
                required: flags & 1 != 0,
                discriminating: flags & 2 != 0,
                track: optional_u32(read_u32(record, 12)?),
                session: optional_u32(read_u32(record, 16)?),
            },
        });
    }
    Ok(out)
}

fn parse_owners(bytes: &[u8], hash_count: usize, component_count: usize) -> Result<Vec<Vec<u32>>> {
    if bytes.len() < 16
        || &bytes[..4] != b"RWON"
        || read_u16(bytes, 4)? != 1
        || read_u16(bytes, 6)? != 0
    {
        return Err(invalid_pack("owners table header is invalid"));
    }
    if read_u32(bytes, 8)? as usize != hash_count {
        return Err(invalid_pack(
            "owners hash count does not match hashes table",
        ));
    }
    let owner_count = read_u32(bytes, 12)? as usize;
    let offset_count = hash_count
        .checked_add(1)
        .ok_or_else(|| invalid_pack("owner offset count overflow"))?;
    let values_start = 16usize
        .checked_add(
            offset_count
                .checked_mul(4)
                .ok_or_else(|| invalid_pack("owner offsets overflow"))?,
        )
        .ok_or_else(|| invalid_pack("owner values offset overflow"))?;
    if values_start.checked_add(
        owner_count
            .checked_mul(4)
            .ok_or_else(|| invalid_pack("owner values overflow"))?,
    ) != Some(bytes.len())
    {
        return Err(invalid_pack(
            "owners table length does not match its header",
        ));
    }
    let mut out = Vec::with_capacity(hash_count);
    let mut prior = 0usize;
    for index in 0..hash_count {
        let start = read_u32(bytes, 16 + index * 4)? as usize;
        let end = read_u32(bytes, 20 + index * 4)? as usize;
        if start != prior || end < start || end > owner_count {
            return Err(invalid_pack("owner offsets are not contiguous"));
        }
        let mut owners = Vec::with_capacity(end - start);
        for slot in start..end {
            let id = read_u32(bytes, values_start + slot * 4)?;
            if id as usize >= component_count {
                return Err(invalid_pack(format!(
                    "owner component id {id} is out of range"
                )));
            }
            owners.push(id);
        }
        out.push(owners);
        prior = end;
    }
    if prior != owner_count {
        return Err(invalid_pack("owner offsets do not cover owner values"));
    }
    Ok(out)
}

fn validate_owners(owners: &[Vec<u32>], components: &[ComponentRecord]) -> Result<()> {
    let mut seen = vec![0u8; components.len()];
    for (hash_id, ids) in owners.iter().enumerate() {
        for &id in ids {
            if components[id as usize].hash_id as usize != hash_id {
                return Err(invalid_pack(
                    "owner points to a component with a different hash id",
                ));
            }
            seen[id as usize] = seen[id as usize].saturating_add(1);
        }
    }
    if seen.iter().any(|&count| count != 1) {
        return Err(invalid_pack(
            "each component must have exactly one owner entry",
        ));
    }
    Ok(())
}

fn parse_sets(
    bytes: &[u8],
    provenance_count: usize,
    strings: &[String],
) -> Result<(ProvenanceSets, TagSets)> {
    if bytes.len() < 24
        || &bytes[..4] != b"RWSX"
        || read_u16(bytes, 4)? != 1
        || read_u16(bytes, 6)? != 0
    {
        return Err(invalid_pack("sets table header is invalid"));
    }
    let ps = read_u32(bytes, 8)? as usize;
    let pv = read_u32(bytes, 12)? as usize;
    let ts = read_u32(bytes, 16)? as usize;
    let tv = read_u32(bytes, 20)? as usize;
    let table_end = |start: usize, count: usize, label: &str| {
        start
            .checked_add(
                count
                    .checked_mul(4)
                    .ok_or_else(|| invalid_pack(format!("{label} table length overflow")))?,
            )
            .ok_or_else(|| invalid_pack(format!("{label} table offset overflow")))
    };
    let po = 24;
    let pvals = table_end(
        po,
        ps.checked_add(1)
            .ok_or_else(|| invalid_pack("provenance set count overflow"))?,
        "provenance offsets",
    )?;
    let to = table_end(pvals, pv, "provenance values")?;
    let tvals = table_end(
        to,
        ts.checked_add(1)
            .ok_or_else(|| invalid_pack("tag set count overflow"))?,
        "tag offsets",
    )?;
    if table_end(tvals, tv, "tag values")? != bytes.len() {
        return Err(invalid_pack("sets table length does not match its header"));
    }
    let parse = |offsets: usize,
                 values: usize,
                 set_count: usize,
                 value_count: usize,
                 limit: usize,
                 label: &str|
     -> Result<Vec<Vec<u32>>> {
        let mut out = Vec::with_capacity(set_count);
        let mut prior = 0usize;
        for index in 0..set_count {
            let start = read_u32(bytes, offsets + index * 4)? as usize;
            let end = read_u32(bytes, offsets + (index + 1) * 4)? as usize;
            if start != prior || end < start || end > value_count {
                return Err(invalid_pack(format!("{label} set offsets are invalid")));
            }
            let mut set = Vec::new();
            for slot in start..end {
                let id = read_u32(bytes, values + slot * 4)?;
                if id as usize >= limit {
                    return Err(invalid_pack(format!(
                        "{label} value id {id} is out of range"
                    )));
                }
                set.push(id);
            }
            out.push(set);
            prior = end;
        }
        if prior != value_count {
            return Err(invalid_pack(format!("{label} offsets do not cover values")));
        }
        Ok(out)
    };
    let provenance = parse(po, pvals, ps, pv, provenance_count, "provenance")?;
    let tags = parse(to, tvals, ts, tv, strings.len(), "tag")?
        .into_iter()
        .map(|set| {
            set.into_iter()
                .map(|id| strings[id as usize].clone())
                .collect()
        })
        .collect();
    Ok((provenance, tags))
}

fn parse_source(value: u8) -> Result<IdentifySource> {
    Ok(match value {
        0 => IdentifySource::Libretro,
        1 => IdentifySource::OpenGood,
        2 => IdentifySource::Redump,
        _ => return Err(invalid_pack(format!("game source {value} is invalid"))),
    })
}

fn parse_upstream(value: u8) -> Result<UpstreamSource> {
    Ok(match value {
        0 => UpstreamSource::Libretro,
        1 => UpstreamSource::Redump,
        2 => UpstreamSource::NoIntro,
        3 => UpstreamSource::Tosec,
        4 => UpstreamSource::Mame,
        5 => UpstreamSource::Fbneo,
        6 => UpstreamSource::OpenGood,
        7 => UpstreamSource::Unknown,
        _ => return Err(invalid_pack(format!("upstream source {value} is invalid"))),
    })
}

fn parse_games(
    bytes: &[u8],
    strings: &[String],
    records: &[ComponentRecord],
    provenance: &[PackProvenance],
    provenance_sets: &[Vec<u32>],
    tag_sets: &[Vec<String>],
) -> Result<Vec<PackGame>> {
    let (count, rows) = parse_header(bytes, b"RWGN", 52, "games")?;
    if count > MAX_GAMES {
        return Err(invalid_pack(format!(
            "pack has {count} games, more than the {MAX_GAMES} cap"
        )));
    }
    let mut games = Vec::with_capacity(count);
    let mut expected_component = 0usize;
    for index in 0..count {
        let row = &rows[index * 52..index * 52 + 52];
        let first = read_u32(row, 28)? as usize;
        let component_count = read_u32(row, 32)? as usize;
        if first != expected_component
            || component_count > MAX_COMPONENTS_PER_GAME
            || first
                .checked_add(component_count)
                .filter(|&end| end <= records.len())
                .is_none()
        {
            return Err(invalid_pack("game component ranges are invalid"));
        }
        let provenance_id = read_u32(row, 36)? as usize;
        let tag_id = read_u32(row, 40)? as usize;
        let provenance_ids = provenance_sets.get(provenance_id).ok_or_else(|| {
            invalid_pack(format!("provenance set id {provenance_id} is out of range"))
        })?;
        let dump_tags = tag_sets
            .get(tag_id)
            .ok_or_else(|| invalid_pack(format!("tag set id {tag_id} is out of range")))?
            .clone();
        let flags = row[50];
        if flags & !1 != 0 || row[51] != 0 {
            return Err(invalid_pack("game reserved fields are not zero"));
        }
        let mut components = Vec::with_capacity(component_count);
        for item in &records[first..first + component_count] {
            let hash = &item.component;
            components.push(hash.clone());
        }
        games.push(PackGame {
            name: string(strings, read_u32(row, 0)?, false, "game name")?.unwrap(),
            platform: string(strings, read_u32(row, 4)?, false, "game platform")?.unwrap(),
            source: parse_source(row[48])?,
            upstream_source: parse_upstream(row[49])?,
            provenance: provenance_ids
                .iter()
                .map(|&id| provenance[id as usize].clone())
                .collect(),
            legacy_variant: flags & 1 != 0,
            dump_tags,
            game_id: string(strings, read_u32(row, 8)?, true, "game id")?,
            region: string(strings, read_u32(row, 12)?, true, "game region")?,
            language: string(strings, read_u32(row, 16)?, true, "game language")?,
            revision: string(strings, read_u32(row, 20)?, true, "game revision")?,
            parent: string(strings, read_u32(row, 24)?, true, "game parent")?,
            disc_number: {
                let value = read_u32(row, 44)?;
                (value != NONE_ID).then_some(value)
            },
            components,
        });
        expected_component += component_count;
    }
    if expected_component != records.len() {
        return Err(invalid_pack("game ranges do not cover all components"));
    }
    Ok(games)
}

fn parse_routes(
    bytes: &[u8],
    hashes: &[HashRecord],
    owners: &[Vec<u32>],
    components: &[ComponentRecord],
) -> Result<RouteIndex> {
    let (count, records) = parse_header(bytes, b"RWRN", 4, "routes")?;
    let mut ids = Vec::with_capacity(count);
    let mut previous: Option<([u8; 4], u64, &str, u32)> = None;
    for index in 0..count {
        let id = read_u32(records, index * 4)?;
        let hash = hashes
            .get(id as usize)
            .ok_or_else(|| invalid_pack(format!("route hash id {id} is out of range")))?;
        let crc = hash
            .crc32
            .as_deref()
            .map(hex_crc)
            .ok_or_else(|| invalid_pack("routed hash has no crc32"))?;
        if hash.size == 0
            || !owners[id as usize]
                .iter()
                .any(|&owner| components[owner as usize].component.discriminating)
        {
            return Err(invalid_pack("route references an ineligible hash"));
        }
        let key = (crc, hash.size, hash.scope.as_str(), id);
        if previous.as_ref().is_some_and(|prior| prior >= &key) {
            return Err(invalid_pack("route hash ids are not in strict key order"));
        }
        previous = Some(key);
        ids.push(id);
    }
    Ok(RouteIndex { hash_ids: ids })
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
