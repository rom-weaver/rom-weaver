//! Reader for RWFP2 artifact packs.
//!
//! RWFP2 keeps RWFP1's outer container layout (magic + directory + member
//! payloads) but carries whole games with per-component hashes: `games.json`
//! (game/component records), `route.bin` (RWR2: (crc32, size) -> ref ids),
//! `refs.bin` (RWX2: ref id -> (game index, component index)), and
//! `manifest.json`.

use rom_weaver_core::Result;
use serde::{Deserialize, Serialize};
use tracing::trace;

use crate::identify_catalog::IdentifySource;
use crate::identify_pack::{
    hex_to_bytes, invalid_pack, read_members_with_magic, read_u16, read_u32, read_u64,
    required_member, table_offset,
};

pub(crate) const PACK_V2_MAGIC: &[u8] = b"RWFP2\0\0\0";
const ROUTE_MAGIC: &[u8] = b"RWR2";
const REFS_MAGIC: &[u8] = b"RWX2";
const MANIFEST_FORMAT: &str = "rom-weaver-identify-system-pack-v2";
/// Route values >= this flag are conflict-table indices, not single ref ids.
const CONFLICT_VALUE_FLAG: u32 = 0x8000_0000;

/// Caps reject hostile packs before any large allocation happens.
const MAX_GAMES: usize = 4_000_000;
const MAX_COMPONENTS_PER_GAME: usize = 10_000;
const MAX_STRING_LEN: usize = 4096;

/// Role of one pack component; values mirror `games.json`.
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

/// The dump database a game record came from upstream of the pack source.
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

fn default_hash_scope() -> String {
    "full_file".to_string()
}

/// One hashed component of a pack game.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackComponent {
    pub role: PackComponentRole,
    pub ordinal: u32,
    /// The byte range or normalized representation covered by these hashes.
    #[serde(default = "default_hash_scope")]
    pub hash_scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    /// Decoded payload size in bytes; 0 when unknown upstream.
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
    /// All sources that contributed this lookup record, in priority order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provenance: Vec<PackProvenance>,
    /// True only when this hash exists solely in the legacy fallback source.
    #[serde(default)]
    pub legacy_variant: bool,
    /// Parsed GoodTools status tags such as `!`, `b`, `o`, `h`, and `t`.
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
    /// Source metadata stays schemaless so old Redump manifests remain valid.
    #[serde(default)]
    provenance: serde_json::Value,
    #[serde(default)]
    generation_date: Option<String>,
}

/// The RWR2 routing index: sorted (crc32 bytes, size) keys to ref ids.
#[derive(Debug)]
struct RouteIndex {
    bytes: Vec<u8>,
    key_count: usize,
    conflict_entries: usize,
    conflict_values: usize,
    records_start: usize,
    offsets_start: usize,
    values_start: usize,
}

/// Fixed RWR2 record width: 4 crc bytes + u64 size + u32 value.
const ROUTE_RECORD_WIDTH: usize = 16;

impl RouteIndex {
    fn parse(member: &[u8], ref_count: usize) -> Result<Self> {
        if member.len() < 20 {
            return Err(invalid_pack("route table is shorter than its header"));
        }
        if &member[..ROUTE_MAGIC.len()] != ROUTE_MAGIC {
            return Err(invalid_pack("route table magic does not match RWR2"));
        }
        if read_u16(member, 4)? != 1 || read_u16(member, 6)? != 0 {
            return Err(invalid_pack("route table header is not supported"));
        }
        let key_count = read_u32(member, 8)? as usize;
        let conflict_entries = read_u32(member, 12)? as usize;
        let conflict_values = read_u32(member, 16)? as usize;
        let records_start = 20usize;
        let offsets_start = records_start
            .checked_add(
                key_count
                    .checked_mul(ROUTE_RECORD_WIDTH)
                    .ok_or_else(|| invalid_pack("route record table overflow"))?,
            )
            .ok_or_else(|| invalid_pack("route record offset overflow"))?;
        let offset_bytes = conflict_entries
            .checked_add(1)
            .and_then(|count| count.checked_mul(4))
            .ok_or_else(|| invalid_pack("route conflict offset table overflow"))?;
        let values_start = offsets_start
            .checked_add(offset_bytes)
            .ok_or_else(|| invalid_pack("route conflict value offset overflow"))?;
        let expected_len = values_start
            .checked_add(
                conflict_values
                    .checked_mul(4)
                    .ok_or_else(|| invalid_pack("route conflict value table overflow"))?,
            )
            .ok_or_else(|| invalid_pack("route table length overflow"))?;
        if expected_len != member.len() {
            return Err(invalid_pack("route table length does not match its header"));
        }
        let index = Self {
            bytes: member.to_vec(),
            key_count,
            conflict_entries,
            conflict_values,
            records_start,
            offsets_start,
            values_start,
        };
        index.validate(ref_count)?;
        Ok(index)
    }

    fn record_key(&self, index: usize) -> Result<(&[u8], u64)> {
        let record = table_offset(self.records_start, index, ROUTE_RECORD_WIDTH)?;
        let crc = self
            .bytes
            .get(record..record + 4)
            .ok_or_else(|| invalid_pack("route record is out of bounds"))?;
        let size = read_u64(&self.bytes, record + 4)?;
        Ok((crc, size))
    }

    fn record_value(&self, index: usize) -> Result<u32> {
        let record = table_offset(self.records_start, index, ROUTE_RECORD_WIDTH)?;
        read_u32(&self.bytes, record + 12)
    }

    fn conflict_refs(&self, conflict_index: u32) -> Result<Vec<u32>> {
        let index = conflict_index as usize;
        if index >= self.conflict_entries {
            return Err(invalid_pack("route conflict index is out of range"));
        }
        let start = read_u32(&self.bytes, table_offset(self.offsets_start, index, 4)?)? as usize;
        let end = read_u32(&self.bytes, table_offset(self.offsets_start, index + 1, 4)?)? as usize;
        if end < start || end > self.conflict_values {
            return Err(invalid_pack("route conflict value range is invalid"));
        }
        let mut ids = Vec::with_capacity(end - start);
        for slot in start..end {
            ids.push(read_u32(
                &self.bytes,
                table_offset(self.values_start, slot, 4)?,
            )?);
        }
        Ok(ids)
    }

    fn validate(&self, ref_count: usize) -> Result<()> {
        let mut previous_offset = 0usize;
        for index in 0..=self.conflict_entries {
            let offset =
                read_u32(&self.bytes, table_offset(self.offsets_start, index, 4)?)? as usize;
            if offset < previous_offset || offset > self.conflict_values {
                return Err(invalid_pack("route conflict offsets are not monotonic"));
            }
            previous_offset = offset;
        }
        if previous_offset != self.conflict_values {
            return Err(invalid_pack(
                "route conflict offsets do not cover all values",
            ));
        }
        let mut previous_key: Option<(Vec<u8>, u64)> = None;
        for index in 0..self.key_count {
            let (crc, size) = self.record_key(index)?;
            let key = (crc.to_vec(), size);
            if let Some(previous) = &previous_key {
                if *previous == key {
                    return Err(invalid_pack(
                        "route table has a duplicate (crc32, size) key",
                    ));
                }
                if *previous > key {
                    return Err(invalid_pack("route table keys are not sorted"));
                }
            }
            previous_key = Some(key);
            let value = self.record_value(index)?;
            if value < CONFLICT_VALUE_FLAG {
                validate_ref_id(value, ref_count)?;
                continue;
            }
            for ref_id in self.conflict_refs(value - CONFLICT_VALUE_FLAG)? {
                validate_ref_id(ref_id, ref_count)?;
            }
        }
        Ok(())
    }

    /// Binary search for `(crc32 bytes, size)`; empty vec on a miss.
    fn lookup(&self, crc: &[u8; 4], size: u64) -> Result<Vec<u32>> {
        let target: (&[u8], u64) = (crc.as_slice(), size);
        let (mut low, mut high) = (0isize, self.key_count as isize - 1);
        while low <= high {
            let mid = (low + high) / 2;
            let key = self.record_key(mid as usize)?;
            match key.cmp(&target) {
                std::cmp::Ordering::Equal => {
                    let value = self.record_value(mid as usize)?;
                    if value < CONFLICT_VALUE_FLAG {
                        return Ok(vec![value]);
                    }
                    return self.conflict_refs(value - CONFLICT_VALUE_FLAG);
                }
                std::cmp::Ordering::Less => low = mid + 1,
                std::cmp::Ordering::Greater => high = mid - 1,
            }
        }
        Ok(Vec::new())
    }
}

fn validate_ref_id(ref_id: u32, ref_count: usize) -> Result<()> {
    if ref_id as usize >= ref_count {
        return Err(invalid_pack(format!("ref id {ref_id} is out of range")));
    }
    Ok(())
}

/// A parsed RWFP2 artifact pack.
#[derive(Debug)]
pub struct ArtifactPack {
    games: Vec<PackGame>,
    refs: Vec<(u32, u16)>,
    route: RouteIndex,
    manifest: PackManifest,
}

impl ArtifactPack {
    /// Parse a decompressed RWFP2 pack blob.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let members = read_members_with_magic(bytes, PACK_V2_MAGIC, "RWFP2")?;
        let games: Vec<PackGame> = serde_json::from_slice(required_member(&members, "games.json")?)
            .map_err(|error| invalid_pack(format!("games.json is invalid JSON: {error}")))?;
        if games.len() > MAX_GAMES {
            return Err(invalid_pack(format!(
                "pack has {} games, more than the {MAX_GAMES} cap",
                games.len()
            )));
        }
        for game in &games {
            validate_game(game)?;
        }
        let refs = parse_refs(required_member(&members, "refs.bin")?)?;
        for &(game_index, component_index) in &refs {
            let game = games.get(game_index as usize).ok_or_else(|| {
                invalid_pack(format!("ref game index {game_index} is out of range"))
            })?;
            if game.components.get(component_index as usize).is_none() {
                return Err(invalid_pack(format!(
                    "ref component index {component_index} is out of range for game {game_index}"
                )));
            }
        }
        let route = RouteIndex::parse(required_member(&members, "route.bin")?, refs.len())?;
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
        trace!(
            platform = %manifest.platform,
            games = games.len(),
            refs = refs.len(),
            "parsed RWFP2 pack"
        );
        Ok(Self {
            games,
            refs,
            route,
            manifest,
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
        &self.manifest.provenance
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

    /// Resolve a (crc32, size) key to its `(game index, component index)`
    /// refs; empty vec on a miss.
    pub fn route(&self, crc32_hex: &str, size: u64) -> Result<Vec<(u32, u16)>> {
        let crc_bytes = hex_to_bytes(&crc32_hex.to_ascii_lowercase())?;
        let crc: [u8; 4] = crc_bytes
            .as_slice()
            .try_into()
            .map_err(|_| invalid_pack("route query crc32 is not 8 hex characters"))?;
        let ref_ids = self.route.lookup(&crc, size)?;
        let mut out = Vec::with_capacity(ref_ids.len());
        for ref_id in ref_ids {
            out.push(self.refs[ref_id as usize]);
        }
        trace!(
            crc32 = crc32_hex,
            size,
            refs = out.len(),
            "routed component"
        );
        Ok(out)
    }
}

fn check_string(value: Option<&str>, what: &str) -> Result<()> {
    if let Some(value) = value
        && value.len() > MAX_STRING_LEN
    {
        return Err(invalid_pack(format!(
            "{what} is longer than the {MAX_STRING_LEN}-byte cap"
        )));
    }
    Ok(())
}

fn check_hex(value: Option<&str>, expected_len: usize, what: &str) -> Result<()> {
    if let Some(value) = value
        && (value.len() != expected_len || !value.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(invalid_pack(format!(
            "{what} is not a {expected_len}-character hex string"
        )));
    }
    Ok(())
}

fn validate_game(game: &PackGame) -> Result<()> {
    if game.components.len() > MAX_COMPONENTS_PER_GAME {
        return Err(invalid_pack(format!(
            "game `{}` has {} components, more than the {MAX_COMPONENTS_PER_GAME} cap",
            game.name,
            game.components.len()
        )));
    }
    check_string(Some(&game.name), "game name")?;
    check_string(Some(&game.platform), "game platform")?;
    for field in [
        &game.game_id,
        &game.region,
        &game.language,
        &game.revision,
        &game.parent,
    ] {
        check_string(field.as_deref(), "game field")?;
    }
    for provenance in &game.provenance {
        check_string(Some(&provenance.source), "provenance source")?;
        for field in [
            &provenance.source_name,
            &provenance.source_url,
            &provenance.source_commit,
            &provenance.license,
        ] {
            check_string(field.as_deref(), "provenance field")?;
        }
    }
    for tag in &game.dump_tags {
        check_string(Some(tag), "dump tag")?;
    }
    for component in &game.components {
        check_string(Some(&component.hash_scope), "component hash scope")?;
        check_string(component.filename.as_deref(), "component filename")?;
        check_hex(component.crc32.as_deref(), 8, "component crc32")?;
        check_hex(component.md5.as_deref(), 32, "component md5")?;
        check_hex(component.sha1.as_deref(), 40, "component sha1")?;
        check_hex(component.sha256.as_deref(), 64, "component sha256")?;
    }
    Ok(())
}

fn parse_refs(member: &[u8]) -> Result<Vec<(u32, u16)>> {
    if member.len() < 8 || &member[..REFS_MAGIC.len()] != REFS_MAGIC {
        return Err(invalid_pack("refs table is invalid"));
    }
    let version = read_u16(member, 4)?;
    let width = read_u16(member, 6)? as usize;
    if version != 1 || width != 6 || !(member.len() - 8).is_multiple_of(width) {
        return Err(invalid_pack("refs table layout is not supported"));
    }
    let count = (member.len() - 8) / width;
    let mut refs = Vec::with_capacity(count);
    for index in 0..count {
        let offset = 8 + index * width;
        refs.push((read_u32(member, offset)?, read_u16(member, offset + 4)?));
    }
    Ok(refs)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn build_pack_container(members: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(PACK_V2_MAGIC);
        out.extend_from_slice(&(members.len() as u32).to_le_bytes());
        for (name, bytes) in members {
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
            out.extend_from_slice(name.as_bytes());
        }
        for (_, bytes) in members {
            out.extend_from_slice(bytes);
        }
        out
    }

    pub(crate) fn build_refs(refs: &[(u32, u16)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(REFS_MAGIC);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&6u16.to_le_bytes());
        for (game, component) in refs {
            out.extend_from_slice(&game.to_le_bytes());
            out.extend_from_slice(&component.to_le_bytes());
        }
        out
    }

    pub(crate) type RouteEntry = (([u8; 4], u64), Vec<u32>);

    /// Build an RWR2 route table; each entry maps (crc32 hex, size) to ref ids.
    pub(crate) fn build_route(mut entries: Vec<RouteEntry>) -> Vec<u8> {
        entries.sort_by_key(|entry| entry.0);
        let mut conflict_offsets = vec![0u32];
        let mut conflict_values: Vec<u32> = Vec::new();
        let mut records = Vec::new();
        for ((crc, size), ids) in &entries {
            records.extend_from_slice(crc);
            records.extend_from_slice(&size.to_le_bytes());
            let value = if ids.len() == 1 {
                ids[0]
            } else {
                let index = (conflict_offsets.len() - 1) as u32;
                conflict_values.extend_from_slice(ids);
                conflict_offsets.push(conflict_values.len() as u32);
                CONFLICT_VALUE_FLAG + index
            };
            records.extend_from_slice(&value.to_le_bytes());
        }
        let mut out = Vec::new();
        out.extend_from_slice(ROUTE_MAGIC);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        out.extend_from_slice(&((conflict_offsets.len() - 1) as u32).to_le_bytes());
        out.extend_from_slice(&(conflict_values.len() as u32).to_le_bytes());
        out.extend_from_slice(&records);
        for offset in conflict_offsets {
            out.extend_from_slice(&offset.to_le_bytes());
        }
        for value in conflict_values {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out
    }

    pub(crate) fn manifest_json(platform: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "format": MANIFEST_FORMAT,
            "platform": platform,
            "source": "opengood",
            "canonicalizationProfile": "opengood-cartridge-v1",
            "canonicalizationVersion": 1,
            "counts": { "games": 0, "components": 0, "routedKeys": 0 },
        }))
        .unwrap()
    }

    pub(crate) fn component_json(
        role: &str,
        ordinal: u32,
        size: u64,
        crc32: Option<&str>,
        sha1: Option<&str>,
        required: bool,
        discriminating: bool,
    ) -> serde_json::Value {
        let mut value = serde_json::json!({
            "role": role,
            "ordinal": ordinal,
            "size": size,
            "required": required,
            "discriminating": discriminating,
        });
        if let Some(crc32) = crc32 {
            value["crc32"] = serde_json::json!(crc32);
        }
        if let Some(sha1) = sha1 {
            value["sha1"] = serde_json::json!(sha1);
        }
        value
    }

    pub(crate) fn game_json(
        name: &str,
        platform: &str,
        components: Vec<serde_json::Value>,
    ) -> serde_json::Value {
        serde_json::json!({
            "name": name,
            "platform": platform,
            "source": "opengood",
            "upstreamSource": "no-intro",
            "components": components,
        })
    }

    fn simple_pack_bytes() -> Vec<u8> {
        let games = serde_json::to_vec(&serde_json::json!([game_json(
            "Example Game (U)",
            "Nintendo Entertainment System",
            vec![component_json(
                "primary_payload",
                0,
                4,
                Some("aabbccdd"),
                None,
                true,
                true
            )],
        )]))
        .unwrap();
        build_pack_container(&[
            ("games.json", games),
            (
                "route.bin",
                build_route(vec![(([0xaa, 0xbb, 0xcc, 0xdd], 4), vec![0])]),
            ),
            ("refs.bin", build_refs(&[(0, 0)])),
            (
                "manifest.json",
                manifest_json("Nintendo Entertainment System"),
            ),
        ])
    }

    #[test]
    fn parses_a_valid_pack_and_routes_a_component() {
        let pack = ArtifactPack::parse(&simple_pack_bytes()).expect("pack parses");
        assert_eq!(pack.platform(), "Nintendo Entertainment System");
        assert_eq!(pack.source(), IdentifySource::OpenGood);
        assert_eq!(pack.canonicalization_profile(), "opengood-cartridge-v1");
        assert!(pack.provenance().is_null());
        assert_eq!(pack.generation_date(), None);
        assert_eq!(pack.games().len(), 1);
        assert_eq!(pack.games()[0].upstream_source, UpstreamSource::NoIntro);
        assert_eq!(pack.games()[0].components[0].hash_scope, "full_file");
        assert!(pack.games()[0].provenance.is_empty());
        assert!(!pack.games()[0].legacy_variant);
        assert!(pack.games()[0].dump_tags.is_empty());
        assert_eq!(pack.route("AABBCCDD", 4).unwrap(), vec![(0, 0)]);
        assert!(pack.route("aabbccdd", 5).unwrap().is_empty());
        assert!(pack.route("00000000", 4).unwrap().is_empty());
    }

    #[test]
    fn parses_merged_provenance_and_legacy_metadata() {
        let mut game = game_json(
            "Legacy Game [b]",
            "Test Platform",
            vec![component_json(
                "primary_payload",
                0,
                4,
                Some("aabbccdd"),
                None,
                true,
                true,
            )],
        );
        game["provenance"] = serde_json::json!([{
            "source": "opengood",
            "sourceName": "OpenGood",
            "sourceUrl": "https://github.com/SnowflakePowered/opengood",
            "sourceCommit": "abc123",
            "license": "CC0-1.0"
        }]);
        game["legacyVariant"] = serde_json::json!(true);
        game["dumpTags"] = serde_json::json!(["b"]);
        game["components"][0]["hashScope"] = serde_json::json!("headerless");
        let bytes = build_pack_container(&[
            (
                "games.json",
                serde_json::to_vec(&serde_json::json!([game])).unwrap(),
            ),
            (
                "route.bin",
                build_route(vec![(([0xaa, 0xbb, 0xcc, 0xdd], 4), vec![0])]),
            ),
            ("refs.bin", build_refs(&[(0, 0)])),
            ("manifest.json", manifest_json("Test Platform")),
        ]);

        let pack = ArtifactPack::parse(&bytes).expect("merged pack parses");
        let game = &pack.games()[0];
        assert!(game.legacy_variant);
        assert_eq!(game.dump_tags, ["b"]);
        assert_eq!(game.provenance[0].source, "opengood");
        assert_eq!(game.components[0].hash_scope, "headerless");
    }

    #[test]
    fn rejects_bad_magic() {
        let mut bytes = simple_pack_bytes();
        bytes[4] = b'9';
        let error = ArtifactPack::parse(&bytes).expect_err("bad magic must fail");
        assert!(error.to_string().contains("RWFP2"));
    }

    #[test]
    fn rejects_truncated_pack() {
        let mut bytes = simple_pack_bytes();
        bytes.pop();
        let error = ArtifactPack::parse(&bytes).expect_err("truncated pack must fail");
        assert!(error.to_string().contains("out of bounds"));
    }

    #[test]
    fn rejects_trailing_data() {
        let mut bytes = simple_pack_bytes();
        bytes.push(0);
        let error = ArtifactPack::parse(&bytes).expect_err("trailing data must fail");
        assert!(error.to_string().contains("trailing"));
    }

    #[test]
    fn rejects_out_of_range_game_index_in_refs() {
        let games = serde_json::to_vec(&serde_json::json!([game_json(
            "Only",
            "P",
            vec![component_json(
                "primary_payload",
                0,
                4,
                Some("aabbccdd"),
                None,
                true,
                true
            )],
        )]))
        .unwrap();
        let bytes = build_pack_container(&[
            ("games.json", games),
            (
                "route.bin",
                build_route(vec![(([0xaa, 0xbb, 0xcc, 0xdd], 4), vec![0])]),
            ),
            ("refs.bin", build_refs(&[(1, 0)])),
            ("manifest.json", manifest_json("P")),
        ]);
        let error = ArtifactPack::parse(&bytes).expect_err("bad game index must fail");
        assert!(error.to_string().contains("game index 1 is out of range"));
    }

    #[test]
    fn rejects_out_of_range_component_index_in_refs() {
        let games = serde_json::to_vec(&serde_json::json!([game_json(
            "Only",
            "P",
            vec![component_json(
                "primary_payload",
                0,
                4,
                Some("aabbccdd"),
                None,
                true,
                true
            )],
        )]))
        .unwrap();
        let bytes = build_pack_container(&[
            ("games.json", games),
            (
                "route.bin",
                build_route(vec![(([0xaa, 0xbb, 0xcc, 0xdd], 4), vec![0])]),
            ),
            ("refs.bin", build_refs(&[(0, 7)])),
            ("manifest.json", manifest_json("P")),
        ]);
        let error = ArtifactPack::parse(&bytes).expect_err("bad component index must fail");
        assert!(error.to_string().contains("component index 7"));
    }

    #[test]
    fn rejects_out_of_range_ref_id_in_route() {
        let games = serde_json::to_vec(&serde_json::json!([game_json(
            "Only",
            "P",
            vec![component_json(
                "primary_payload",
                0,
                4,
                Some("aabbccdd"),
                None,
                true,
                true
            )],
        )]))
        .unwrap();
        let bytes = build_pack_container(&[
            ("games.json", games),
            (
                "route.bin",
                build_route(vec![(([0xaa, 0xbb, 0xcc, 0xdd], 4), vec![5])]),
            ),
            ("refs.bin", build_refs(&[(0, 0)])),
            ("manifest.json", manifest_json("P")),
        ]);
        let error = ArtifactPack::parse(&bytes).expect_err("bad ref id must fail");
        assert!(error.to_string().contains("ref id 5 is out of range"));
    }

    #[test]
    fn rejects_duplicate_route_key() {
        let games = serde_json::to_vec(&serde_json::json!([game_json(
            "Only",
            "P",
            vec![component_json(
                "primary_payload",
                0,
                4,
                Some("aabbccdd"),
                None,
                true,
                true
            )],
        )]))
        .unwrap();
        // Two identical (crc32, size) keys; the helper emits them adjacent, which
        // the parser must reject as duplicates.
        let bytes = build_pack_container(&[
            ("games.json", games),
            (
                "route.bin",
                build_route(vec![
                    (([0xaa, 0xbb, 0xcc, 0xdd], 4), vec![0]),
                    (([0xaa, 0xbb, 0xcc, 0xdd], 4), vec![0]),
                ]),
            ),
            ("refs.bin", build_refs(&[(0, 0)])),
            ("manifest.json", manifest_json("P")),
        ]);
        let error = ArtifactPack::parse(&bytes).expect_err("duplicate key must fail");
        assert!(error.to_string().contains("duplicate"));
    }

    #[test]
    fn rejects_non_monotonic_conflict_offsets() {
        let games = serde_json::to_vec(&serde_json::json!([game_json(
            "Only",
            "P",
            vec![component_json(
                "primary_payload",
                0,
                4,
                Some("aabbccdd"),
                None,
                true,
                true
            )],
        )]))
        .unwrap();
        let mut route = build_route(vec![(([0xaa, 0xbb, 0xcc, 0xdd], 4), vec![0, 0])]);
        // The conflict offset table starts after the header and one record;
        // corrupt its first offset above its second.
        let offsets_start = 20 + ROUTE_RECORD_WIDTH;
        route[offsets_start..offsets_start + 4].copy_from_slice(&9u32.to_le_bytes());
        let bytes = build_pack_container(&[
            ("games.json", games),
            ("route.bin", route),
            ("refs.bin", build_refs(&[(0, 0)])),
            ("manifest.json", manifest_json("P")),
        ]);
        let error = ArtifactPack::parse(&bytes).expect_err("bad offsets must fail");
        assert!(error.to_string().contains("monotonic") || error.to_string().contains("cover"));
    }

    #[test]
    fn rejects_oversized_component_count() {
        let component = component_json("primary_payload", 0, 4, Some("aabbccdd"), None, true, true);
        let components: Vec<_> = (0..MAX_COMPONENTS_PER_GAME + 1)
            .map(|_| component.clone())
            .collect();
        let games =
            serde_json::to_vec(&serde_json::json!([game_json("Only", "P", components)])).unwrap();
        let bytes = build_pack_container(&[
            ("games.json", games),
            ("route.bin", build_route(vec![])),
            ("refs.bin", build_refs(&[])),
            ("manifest.json", manifest_json("P")),
        ]);
        let error = ArtifactPack::parse(&bytes).expect_err("too many components must fail");
        assert!(error.to_string().contains("cap"));
    }

    #[test]
    fn rejects_invalid_utf8_member_name() {
        let mut out = Vec::new();
        out.extend_from_slice(PACK_V2_MAGIC);
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&0u64.to_le_bytes());
        out.extend_from_slice(&[0xff, 0xfe]);
        let error = ArtifactPack::parse(&out).expect_err("non-UTF-8 name must fail");
        assert!(error.to_string().contains("UTF-8"));
    }

    #[test]
    fn rejects_invalid_component_hash_strings() {
        let games = serde_json::to_vec(&serde_json::json!([game_json(
            "Only",
            "P",
            vec![component_json(
                "primary_payload",
                0,
                4,
                Some("zzzzzzzz"),
                None,
                true,
                true
            )],
        )]))
        .unwrap();
        let bytes = build_pack_container(&[
            ("games.json", games),
            ("route.bin", build_route(vec![])),
            ("refs.bin", build_refs(&[])),
            ("manifest.json", manifest_json("P")),
        ]);
        let error = ArtifactPack::parse(&bytes).expect_err("bad crc32 string must fail");
        assert!(error.to_string().contains("crc32"));
    }

    #[test]
    fn identify_pack_file_dispatches_on_magic() {
        use crate::identify_pack::IdentifyPackFile;
        let parsed = IdentifyPackFile::parse(&simple_pack_bytes()).expect("v2 parses");
        assert!(matches!(parsed, IdentifyPackFile::V2(_)));
        let error = IdentifyPackFile::parse(b"RWFP9\0\0\0rest").expect_err("unknown magic fails");
        assert!(error.to_string().contains("RWFP1") && error.to_string().contains("RWFP2"));
    }
}
