//! Reader for compact RWFP3 artifact packs.

use rom_weaver_core::Result;
use serde::Deserialize;
use tracing::trace;

use crate::identify_catalog::IdentifySource;
use crate::identify_pack::{
    hex_to_bytes, invalid_pack, read_members_with_magic, read_u16, read_u32, read_u64,
    required_member,
};
use crate::identify_pack_v2::{
    PackComponent, PackComponentRole, PackGame, PackProvenance, UpstreamSource,
};

pub(crate) const PACK_V3_MAGIC: &[u8] = b"RWFP3\0\0\0";
const MANIFEST_FORMAT: &str = "rom-weaver-identify-system-pack-v3";
const NONE_ID: u32 = u32::MAX;
const MAX_GAMES: usize = 4_000_000;
const MAX_COMPONENTS_PER_GAME: usize = 10_000;
const MAX_STRING_LEN: usize = 4096;

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

/// A parsed compact RWFP3 artifact pack.
#[derive(Debug)]
pub struct ArtifactPack {
    games: Vec<PackGame>,
    component_refs: Vec<(u32, u16)>,
    hashes: Vec<HashRecord>,
    owners: Vec<Vec<u32>>,
    route: RouteIndex,
    manifest: PackManifest,
    manifest_provenance: serde_json::Value,
}

impl ArtifactPack {
    /// Parse a decompressed RWFP3 pack blob.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let members = read_members_with_magic(bytes, PACK_V3_MAGIC, "RWFP3")?;
        let strings = parse_strings(required_member(&members, "strings.bin")?)?;
        let manifest: PackManifest =
            serde_json::from_slice(required_member(&members, "manifest.json")?)
                .map_err(|error| invalid_pack(format!("manifest.json is invalid JSON: {error}")))?;
        if manifest.format != MANIFEST_FORMAT {
            return Err(invalid_pack(format!(
                "manifest format `{}` is not `{MANIFEST_FORMAT}`",
                manifest.format
            )));
        }
        if manifest.canonicalization_version != 1 {
            return Err(invalid_pack(format!(
                "manifest canonicalization version {} is not supported",
                manifest.canonicalization_version
            )));
        }
        let hashes = parse_hashes(required_member(&members, "hashes.bin")?, &strings)?;
        let components = parse_components(
            required_member(&members, "components.bin")?,
            &strings,
            &hashes,
        )?;
        let owners = parse_owners(
            required_member(&members, "owners.bin")?,
            hashes.len(),
            components.len(),
        )?;
        validate_owners(&owners, &components)?;
        let (provenance_sets, tag_sets) = parse_sets(
            required_member(&members, "sets.bin")?,
            manifest.provenance.len(),
            &strings,
        )?;
        let games = parse_games(
            required_member(&members, "games.bin")?,
            &strings,
            &components,
            &manifest.provenance,
            &provenance_sets,
            &tag_sets,
        )?;
        let route = parse_routes(
            required_member(&members, "routes.bin")?,
            &hashes,
            &owners,
            &components,
        )?;
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
            "parsed RWFP3 pack"
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

    pub fn platform(&self) -> &str {
        &self.manifest.platform
    }
    pub fn source(&self) -> IdentifySource {
        self.manifest.source
    }
    pub fn canonicalization_profile(&self) -> &str {
        &self.manifest.canonicalization_profile
    }
    pub fn provenance(&self) -> &serde_json::Value {
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

    /// Resolve a `(crc32, size)` key to `(game index, component index)` pairs.
    pub fn route(&self, crc32_hex: &str, size: u64) -> Result<Vec<(u32, u16)>> {
        let bytes = hex_to_bytes(&crc32_hex.to_ascii_lowercase())?;
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
        || &bytes[..4] != b"RWS3"
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
    let (count, records) = parse_header(bytes, b"RWH3", 92, "hashes")?;
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
    let (count, records) = parse_header(bytes, b"RWC3", 28, "components")?;
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
        || &bytes[..4] != b"RWO3"
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
    let (count, rows) = parse_header(bytes, b"RWG3", 52, "games")?;
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
    let (count, records) = parse_header(bytes, b"RWR3", 4, "routes")?;
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
    use crate::artifact_match::{ArtifactFingerprint, ArtifactMatchStatus, match_artifact};
    use crate::identify_pack::IdentifyPackFile;

    fn header(magic: &[u8; 4], width: u16, count: u32, records: &[u8]) -> Vec<u8> {
        let mut out = magic.to_vec();
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(records);
        out
    }

    fn fixture() -> Vec<u8> {
        let values = [
            "full_file",
            "Game A",
            "Test",
            "a.bin",
            "Game B",
            "b.bin",
            "b",
        ];
        let mut string_data = Vec::new();
        let mut offsets = vec![0u32];
        for value in values {
            string_data.extend_from_slice(value.as_bytes());
            offsets.push(string_data.len() as u32);
        }
        let mut strings = b"RWS3".to_vec();
        strings.extend_from_slice(&1u16.to_le_bytes());
        strings.extend_from_slice(&0u16.to_le_bytes());
        strings.extend_from_slice(&7u32.to_le_bytes());
        strings.extend_from_slice(&(string_data.len() as u32).to_le_bytes());
        for value in offsets {
            strings.extend_from_slice(&value.to_le_bytes());
        }
        strings.extend_from_slice(&string_data);

        let mut hash = Vec::new();
        hash.extend_from_slice(&4u64.to_le_bytes());
        hash.extend_from_slice(&0u32.to_le_bytes());
        hash.push(1);
        hash.extend_from_slice(&[0; 3]);
        hash.extend_from_slice(&[0xaa, 0xbb, 0xcc, 0xdd]);
        hash.extend_from_slice(&[0; 16 + 20 + 32]);
        hash.extend_from_slice(&0u32.to_le_bytes());
        let hashes = header(b"RWH3", 92, 1, &hash);

        let mut component_rows = Vec::new();
        for filename in [3u32, 5] {
            component_rows.extend_from_slice(&0u32.to_le_bytes());
            component_rows.extend_from_slice(&filename.to_le_bytes());
            component_rows.extend_from_slice(&0u32.to_le_bytes());
            component_rows.extend_from_slice(&NONE_ID.to_le_bytes());
            component_rows.extend_from_slice(&NONE_ID.to_le_bytes());
            component_rows.push(0);
            component_rows.push(3);
            component_rows.extend_from_slice(&0u16.to_le_bytes());
            component_rows.extend_from_slice(&0u32.to_le_bytes());
        }
        let components = header(b"RWC3", 28, 2, &component_rows);

        let mut owners = b"RWO3".to_vec();
        owners.extend_from_slice(&1u16.to_le_bytes());
        owners.extend_from_slice(&0u16.to_le_bytes());
        owners.extend_from_slice(&1u32.to_le_bytes());
        owners.extend_from_slice(&2u32.to_le_bytes());
        owners.extend_from_slice(&0u32.to_le_bytes());
        owners.extend_from_slice(&2u32.to_le_bytes());
        owners.extend_from_slice(&0u32.to_le_bytes());
        owners.extend_from_slice(&1u32.to_le_bytes());
        let routes = header(b"RWR3", 4, 1, &0u32.to_le_bytes());

        let mut sets = b"RWSX".to_vec();
        sets.extend_from_slice(&1u16.to_le_bytes());
        sets.extend_from_slice(&0u16.to_le_bytes());
        for count in [2u32, 3, 2, 1] {
            sets.extend_from_slice(&count.to_le_bytes());
        }
        for offset in [0u32, 1, 3] {
            sets.extend_from_slice(&offset.to_le_bytes());
        }
        for value in [0u32, 0, 1] {
            sets.extend_from_slice(&value.to_le_bytes());
        }
        for offset in [0u32, 0, 1] {
            sets.extend_from_slice(&offset.to_le_bytes());
        }
        sets.extend_from_slice(&6u32.to_le_bytes());

        let mut games_rows = Vec::new();
        for (name, first, provenance_set, tag_set, source, upstream, flags) in [
            (1u32, 0u32, 0u32, 0u32, 0u8, 2u8, 0u8),
            (4, 1, 1, 1, 1, 6, 1),
        ] {
            for id in [
                name,
                2,
                NONE_ID,
                NONE_ID,
                NONE_ID,
                NONE_ID,
                NONE_ID,
                first,
                1,
                provenance_set,
                tag_set,
                NONE_ID,
            ] {
                games_rows.extend_from_slice(&id.to_le_bytes());
            }
            games_rows.extend_from_slice(&[source, upstream, flags, 0]);
        }
        let games = header(b"RWG3", 52, 2, &games_rows);
        let manifest = serde_json::to_vec(&serde_json::json!({
            "format": MANIFEST_FORMAT, "platform": "Test", "source": "libretro",
            "canonicalizationProfile": "full-file-v1", "canonicalizationVersion": 1,
            "generationDate": "2026-08-27", "provenance": [
                {"source":"libretro","license":"CC-BY-SA-4.0"}, {"source":"opengood","license":"CC0-1.0"}
            ]
        })).unwrap();
        let members = [
            ("strings.bin", strings),
            ("hashes.bin", hashes),
            ("components.bin", components),
            ("games.bin", games),
            ("owners.bin", owners),
            ("routes.bin", routes),
            ("sets.bin", sets),
            ("manifest.json", manifest),
        ];
        let mut out = PACK_V3_MAGIC.to_vec();
        out.extend_from_slice(&(members.len() as u32).to_le_bytes());
        for (name, value) in &members {
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&(value.len() as u64).to_le_bytes());
            out.extend_from_slice(name.as_bytes());
        }
        for (_, value) in members {
            out.extend_from_slice(&value);
        }
        out
    }

    #[test]
    fn parses_compact_tables_and_routes_all_hash_owners() {
        let pack = ArtifactPack::parse(&fixture()).expect("RWFP3 fixture parses");
        assert_eq!(pack.games().len(), 2);
        assert_eq!(pack.games()[0].name, "Game A");
        assert_eq!(pack.games()[1].dump_tags, ["b"]);
        assert!(pack.games()[1].legacy_variant);
        assert_eq!(pack.games()[1].provenance.len(), 2);
        assert_eq!(pack.route("AABBCCDD", 4).unwrap(), [(0, 0), (1, 0)]);
        assert!(pack.route("aabbccdd", 5).unwrap().is_empty());
    }

    #[test]
    fn dispatches_rwfp3_without_changing_older_magic() {
        assert!(matches!(
            IdentifyPackFile::parse(&fixture()).unwrap(),
            IdentifyPackFile::V3(_)
        ));
    }

    #[test]
    fn artifact_matcher_accepts_rwfp3() {
        let pack = ArtifactPack::parse(&fixture()).expect("RWFP3 fixture parses");
        let outcome = match_artifact(
            &pack,
            &ArtifactFingerprint::from_single_blob(4, Some("aabbccdd"), None, None),
        )
        .expect("RWFP3 match succeeds");
        assert_eq!(outcome.status, ArtifactMatchStatus::Ambiguous);
        assert_eq!(outcome.matches.len(), 2);
    }

    #[test]
    fn rejects_an_owner_that_disagrees_with_the_component_hash() {
        let mut bytes = fixture();
        let position = bytes.windows(4).position(|part| part == b"RWO3").unwrap();
        bytes[position + 28..position + 32].copy_from_slice(&0u32.to_le_bytes());
        let error = ArtifactPack::parse(&bytes).unwrap_err();
        assert!(error.to_string().contains("exactly one owner"));
    }
}
