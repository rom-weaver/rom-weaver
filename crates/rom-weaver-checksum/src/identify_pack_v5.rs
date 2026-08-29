//! Reader for RWFP5 artifact packs.

use rom_weaver_core::Result;
use serde::Deserialize;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

use crate::identify_catalog::IdentifySource;
use crate::identify_pack::{invalid_pack, read_members_with_magic, required_member};
use crate::identify_pack_types::{
    PackComponent, PackComponentRole, PackGame, PackProvenance, UpstreamSource,
};

pub(crate) const PACK_V5_MAGIC: &[u8] = b"RWFP5\0\0\0";
const MAX_COUNT: usize = 4_000_000;
const MAX_STRING: usize = 4096;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
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
struct Hash {
    size: u64,
    scope: String,
    crc32: Option<String>,
    md5: Option<String>,
    sha1: Option<String>,
    sha256: Option<String>,
}
type HashKey = (
    u64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);
type HashIds = BTreeMap<HashKey, u32>;

#[derive(Debug)]
pub struct ArtifactPack {
    games: Vec<PackGame>,
    hashes: Vec<Hash>,
    owners: Vec<Vec<u32>>,
    routes: Vec<u32>,
    manifest: Manifest,
    provenance: serde_json::Value,
}

impl ArtifactPack {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let members = read_members_with_magic(bytes, PACK_V5_MAGIC, "RWFP5")?;
        let strings = Strings::parse(required_member(&members, "strings.bin")?)?;
        let hashes = parse_hashes(required_member(&members, "hashes.bin")?, &strings)?;
        let components = parse_components(
            required_member(&members, "components.bin")?,
            &hashes,
            &strings,
        )?;
        let manifest: Manifest =
            serde_json::from_slice(required_member(&members, "manifest.json")?)
                .map_err(|e| invalid_pack(format!("manifest.json is invalid JSON: {e}")))?;
        if manifest.format != "rom-weaver-identify-system-pack-v5" {
            return Err(invalid_pack("manifest format is not RWFP5"));
        }
        if manifest.canonicalization_version != 1 {
            return Err(invalid_pack(
                "manifest canonicalization version is not supported",
            ));
        }
        let (provenance_sets, tag_sets) = parse_sets(
            required_member(&members, "sets.bin")?,
            &strings,
            manifest.provenance.len(),
        )?;
        let owners = parse_owners(
            required_member(&members, "owners.bin")?,
            hashes.len(),
            components.len(),
        )?;
        validate_owners(&owners, &components, &hashes)?;
        let routes = parse_routes(
            required_member(&members, "routes.bin")?,
            &hashes,
            &owners,
            &components,
        )?;
        let games = parse_games(
            required_member(&members, "games.bin")?,
            &strings,
            &components,
            &manifest,
            &provenance_sets,
            &tag_sets,
        )?;
        let provenance =
            serde_json::to_value(&manifest.provenance).map_err(|e| invalid_pack(e.to_string()))?;
        Ok(Self {
            games,
            hashes,
            owners,
            routes,
            manifest,
            provenance,
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
        &self.provenance
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
    pub fn route(&self, crc: &str, size: u64) -> Result<Vec<(u32, u16)>> {
        let raw = crate::identify_pack::hex_to_bytes(&crc.to_ascii_lowercase())?;
        let crc: [u8; 4] = raw
            .as_slice()
            .try_into()
            .map_err(|_| invalid_pack("route query crc32 is not 8 hex characters"))?;
        let mut out = Vec::new();
        for &id in &self.routes {
            let h = self
                .hashes
                .get(id as usize)
                .ok_or_else(|| invalid_pack("route hash id is out of range"))?;
            if h.size != size || h.crc32.as_deref().map(hex_crc) != Some(crc) {
                continue;
            }
            for &component in self
                .owners
                .get(id as usize)
                .ok_or_else(|| invalid_pack("route owner hash id is out of range"))?
            {
                let mut base = 0usize;
                for (game, g) in self.games.iter().enumerate() {
                    if (component as usize) < base + g.components.len() {
                        out.push((game as u32, (component as usize - base) as u16));
                        break;
                    }
                    base += g.components.len();
                }
            }
        }
        Ok(out)
    }

    pub fn matching_routes(
        &self,
        crc32: Option<&str>,
        md5: Option<&str>,
        sha1: Option<&str>,
    ) -> Vec<(u64, String)> {
        let crc32 = crc32.map(str::to_ascii_lowercase);
        let md5 = md5.map(str::to_ascii_lowercase);
        let sha1 = sha1.map(str::to_ascii_lowercase);
        let mut sizes = self
            .hashes
            .iter()
            .filter(|hash| {
                crc32
                    .as_deref()
                    .is_some_and(|value| hash.crc32.as_deref() == Some(value))
                    || md5
                        .as_deref()
                        .is_some_and(|value| hash.md5.as_deref() == Some(value))
                    || sha1
                        .as_deref()
                        .is_some_and(|value| hash.sha1.as_deref() == Some(value))
            })
            .filter_map(|hash| hash.crc32.clone().map(|crc32| (hash.size, crc32)))
            .collect::<Vec<_>>();
        sizes.sort_unstable();
        sizes.dedup();
        sizes
    }
}

/// Encode a deterministic RWFP5 pack. The input games are sorted by platform,
/// name, and game id; all table ids are assigned from sorted keys.
pub fn encode(
    platform: &str,
    source: IdentifySource,
    profile: &str,
    provenance: &serde_json::Value,
    mut games: Vec<PackGame>,
) -> Result<Vec<u8>> {
    (|| {
        games.sort_by(|a, b| {
            (&a.platform, &a.name, a.game_id.as_deref().unwrap_or("")).cmp(&(
                &b.platform,
                &b.name,
                b.game_id.as_deref().unwrap_or(""),
            ))
        });
        let mut strings = BTreeMap::<String, u32>::new();
        let mut intern = |s: String| {
            let n = strings.len() as u32;
            *strings.entry(s).or_insert(n)
        };
        (|| -> Result<()> {
            for g in &games {
                if g.platform != platform || g.source != source {
                    return Err(invalid_pack(
                        "RWFP5 game platform or source does not match the pack",
                    ));
                }
                intern(g.name.clone());
                for x in [&g.game_id, &g.region, &g.language, &g.revision, &g.parent]
                    .into_iter()
                    .flatten()
                {
                    intern(x.clone());
                }
                for c in &g.components {
                    if let Some(x) = &c.filename {
                        intern(x.clone());
                    }
                    intern(c.hash_scope.clone());
                }
                for x in &g.dump_tags {
                    intern(x.clone());
                }
            }
            Ok(())
        })()?;
        for (id, value) in strings.values_mut().enumerate() {
            *value = u32::try_from(id).map_err(|_| invalid_pack("RWFP5 string count overflows"))?;
        }
        let mut hashes = HashIds::new();
        let mut components = Vec::new();
        let mut owners = Vec::<Vec<u32>>::new();
        for game in &games {
            for c in &game.components {
                let key = (
                    c.size,
                    c.hash_scope.clone(),
                    c.crc32.clone(),
                    c.md5.clone(),
                    c.sha1.clone(),
                    c.sha256.clone(),
                );
                let next = hashes.len() as u32;
                hashes.entry(key).or_insert(next);
            }
        }
        for (id, value) in hashes.values_mut().enumerate() {
            *value = u32::try_from(id).map_err(|_| invalid_pack("RWFP5 hash count overflows"))?;
        }
        owners.resize_with(hashes.len(), Vec::new);
        for game in &games {
            for component in &game.components {
                let key = (
                    component.size,
                    component.hash_scope.clone(),
                    component.crc32.clone(),
                    component.md5.clone(),
                    component.sha1.clone(),
                    component.sha256.clone(),
                );
                let id = hashes[&key];
                let component_id = u32::try_from(components.len())
                    .map_err(|_| invalid_pack("RWFP5 component count overflows"))?;
                owners[id as usize].push(component_id);
                components.push((id, component.clone()));
            }
        }
        let mut out = Vec::new();
        let mut strings_bytes = b"RWS5\x01".to_vec();
        strings_bytes.extend(enc(strings.len() as u64));
        for s in strings.keys() {
            strings_bytes.extend(enc(s.len() as u64));
            strings_bytes.extend(s.as_bytes());
        }
        let hb = encode_hashes(&hashes, &strings);
        let (cb, ob) = encode_component_tables(&components, &owners, &strings, hashes.len());
        let mut route_ids = hashes
            .iter()
            .filter(|((size, _, crc, _, _, _), id)| {
                *size > 0
                    && crc.is_some()
                    && owners[**id as usize]
                        .iter()
                        .any(|owner| components[*owner as usize].1.discriminating)
            })
            .map(|((size, scope, crc, _, _, _), id)| {
                (
                    crc.clone().expect("filtered crc"),
                    *size,
                    scope.clone(),
                    *id,
                )
            })
            .collect::<Vec<_>>();
        route_ids.sort();
        let mut rb = b"RWR5\x01".to_vec();
        rb.extend(enc(route_ids.len() as u64));
        for (_, _, _, id) in route_ids {
            rb.extend(enc(id as u64));
        }
        let manifest_provenance: Vec<PackProvenance> = if provenance.is_array() {
            serde_json::from_value(provenance.clone())
                .map_err(|error| invalid_pack(format!("RWFP5 provenance is invalid: {error}")))?
        } else {
            Vec::new()
        };
        let provenance_ids = manifest_provenance
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, value)| (value, index as u32))
            .collect::<BTreeMap<_, _>>();
        let mut provenance_sets = BTreeSet::from([Vec::<u32>::new()]);
        let mut tag_sets = BTreeSet::from([Vec::<u32>::new()]);
        let mut game_sets = Vec::with_capacity(games.len());
        for game in &games {
            let mut game_provenance =
                game.provenance
                    .iter()
                    .map(|value| {
                        provenance_ids.get(value).copied().ok_or_else(|| {
                            invalid_pack("RWFP5 game provenance is not in the manifest")
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
            game_provenance.sort_unstable();
            game_provenance.dedup();
            let mut game_tags = game
                .dump_tags
                .iter()
                .map(|value| *strings.get(value).expect("dump tag was interned"))
                .collect::<Vec<_>>();
            game_tags.sort_unstable();
            game_tags.dedup();
            provenance_sets.insert(game_provenance.clone());
            tag_sets.insert(game_tags.clone());
            game_sets.push((game_provenance, game_tags));
        }
        let provenance_set_ids = provenance_sets
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, value)| (value, index as u32))
            .collect::<BTreeMap<_, _>>();
        let tag_set_ids = tag_sets
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, value)| (value, index as u32))
            .collect::<BTreeMap<_, _>>();
        let mut sets = b"RWX5\x01".to_vec();
        for values in [&provenance_sets, &tag_sets] {
            sets.extend(enc(values.len() as u64));
            for set in values {
                sets.extend(enc(set.len() as u64));
                for &id in set {
                    sets.extend(enc(id as u64));
                }
            }
        }
        let mut gb = b"RWG5\x01".to_vec();
        gb.extend(enc(games.len() as u64));
        for (g, (game_provenance, game_tags)) in games.into_iter().zip(game_sets) {
            gb.extend(enc(*strings.get(&g.name).unwrap() as u64));
            let mut bits = 0;
            for (b, x) in [
                (1, &g.game_id),
                (2, &g.region),
                (4, &g.language),
                (8, &g.revision),
                (16, &g.parent),
            ] {
                if x.is_some() {
                    bits |= b
                }
            }
            if g.disc_number.is_some() {
                bits |= 32
            }
            if g.upstream_source != UpstreamSource::Unknown {
                bits |= 64
            }
            if g.legacy_variant {
                bits |= 128
            }
            gb.push(bits);
            for x in [&g.game_id, &g.region, &g.language, &g.revision, &g.parent]
                .into_iter()
                .flatten()
            {
                gb.extend(enc(*strings.get(x).unwrap() as u64))
            }
            gb.extend(enc(g.components.len() as u64));
            gb.extend(enc(provenance_set_ids[&game_provenance] as u64));
            gb.extend(enc(tag_set_ids[&game_tags] as u64));
            if let Some(x) = g.disc_number {
                gb.extend(enc(x as u64))
            }
            if g.upstream_source != UpstreamSource::Unknown {
                gb.push(upstream(g.upstream_source));
            }
        }
        let manifest=serde_json::to_vec(&json!({"format":"rom-weaver-identify-system-pack-v5","platform":platform,"source":source,"canonicalizationProfile":profile,"canonicalizationVersion":1,"provenance":manifest_provenance})).map_err(|e|invalid_pack(e.to_string()))?;
        let members = [
            ("strings.bin", strings_bytes),
            ("hashes.bin", hb),
            ("components.bin", cb),
            ("games.bin", gb),
            ("owners.bin", ob),
            ("routes.bin", rb),
            ("sets.bin", sets),
            ("manifest.json", manifest),
        ];
        out.extend_from_slice(PACK_V5_MAGIC);
        out.extend_from_slice(&(members.len() as u32).to_le_bytes());
        for (n, b) in &members {
            out.extend_from_slice(&(n.len() as u16).to_le_bytes());
            out.extend_from_slice(&(b.len() as u64).to_le_bytes());
            out.extend_from_slice(n.as_bytes())
        }
        for (_, b) in members {
            out.extend(b)
        }
        Ok(out)
    })()
}
fn encode_component_tables(
    components: &[(u32, PackComponent)],
    owners: &[Vec<u32>],
    strings: &BTreeMap<String, u32>,
    hash_count: usize,
) -> (Vec<u8>, Vec<u8>) {
    let mut component_bytes = b"RWC5\x01".to_vec();
    component_bytes.extend(enc(components.len() as u64));
    for (hash_id, component) in components {
        component_bytes.extend(enc(*hash_id as u64));
        let presence = u8::from(component.filename.is_some())
            | (u8::from(component.track.is_some()) << 1)
            | (u8::from(component.session.is_some()) << 2);
        component_bytes.push(presence);
        if let Some(filename) = &component.filename {
            component_bytes.extend(enc(strings[filename] as u64));
        }
        if let Some(track) = component.track {
            component_bytes.extend(enc(track as u64));
        }
        if let Some(session) = component.session {
            component_bytes.extend(enc(session as u64));
        }
        component_bytes.push(role(component.role));
        component_bytes.push((component.required as u8) | ((component.discriminating as u8) << 1));
    }
    let mut owner_bytes = b"RWO5\x01".to_vec();
    owner_bytes.extend(enc(hash_count as u64));
    for ids in owners {
        owner_bytes.extend(enc(ids.len() as u64));
        let mut previous = 0;
        for &id in ids {
            owner_bytes.extend(enc((id - previous) as u64));
            previous = id;
        }
    }
    (component_bytes, owner_bytes)
}

fn encode_hashes(hashes: &HashIds, strings: &BTreeMap<String, u32>) -> Vec<u8> {
    let mut bytes = b"RWH5\x01".to_vec();
    bytes.extend(enc(hashes.len() as u64));
    let mut previous_size = 0;
    for (size, scope, crc, md5, sha1, sha256) in hashes.keys() {
        bytes.extend(enc(size - previous_size));
        previous_size = *size;
        bytes.push(if scope == "full_file" {
            0
        } else if scope == "track_file" {
            1
        } else {
            255
        });
        if scope != "full_file" && scope != "track_file" {
            bytes.extend(enc(
                *strings.get(scope).expect("hash scope was interned") as u64
            ));
        }
        let mut mask = 0;
        for (bit, value) in [(1, crc), (2, md5), (4, sha1), (8, sha256)] {
            if value.is_some() {
                mask |= bit;
            }
        }
        bytes.push(mask);
        for value in [crc, md5, sha1, sha256].into_iter().flatten() {
            for pair in value.as_bytes().chunks(2) {
                bytes.push(
                    u8::from_str_radix(std::str::from_utf8(pair).expect("ASCII hex"), 16)
                        .expect("validated hash hex"),
                );
            }
        }
    }
    bytes
}
fn enc(mut n: u64) -> Vec<u8> {
    let mut o = Vec::new();
    loop {
        let mut b = (n & 127) as u8;
        n >>= 7;
        if n > 0 {
            b |= 128
        }
        o.push(b);
        if n == 0 {
            return o;
        }
    }
}
fn role(r: PackComponentRole) -> u8 {
    match r {
        PackComponentRole::PrimaryPayload => 0,
        PackComponentRole::DataTrack => 1,
        PackComponentRole::AudioTrack => 2,
        PackComponentRole::ArcadeRom => 3,
        PackComponentRole::Partition => 4,
        PackComponentRole::ContentFile => 5,
        PackComponentRole::DiskSide => 6,
        PackComponentRole::ChildDisc => 7,
    }
}
fn upstream(r: UpstreamSource) -> u8 {
    match r {
        UpstreamSource::Libretro => 0,
        UpstreamSource::Redump => 1,
        UpstreamSource::NoIntro => 2,
        UpstreamSource::Tosec => 3,
        UpstreamSource::Mame => 4,
        UpstreamSource::Fbneo => 5,
        UpstreamSource::OpenGood => 6,
        UpstreamSource::Unknown => 255,
    }
}

struct Cursor<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> Cursor<'a> {
    fn new(b: &'a [u8], magic: &[u8; 4]) -> Result<Self> {
        if b.len() < 5 || &b[..4] != magic || b[4] != 1 {
            return Err(invalid_pack("RWFP5 table header is invalid"));
        }
        Ok(Self { b, p: 5 })
    }
    fn var(&mut self) -> Result<u64> {
        let start = self.p;
        let mut v = 0u64;
        for shift in (0..=63).step_by(7) {
            let x = *self
                .b
                .get(self.p)
                .ok_or_else(|| invalid_pack("RWFP5 variable integer is truncated"))?;
            self.p += 1;
            if shift == 63 && x > 1 {
                return Err(invalid_pack("RWFP5 variable integer overflows u64"));
            }
            v |= u64::from(x & 127) << shift;
            if x & 128 == 0 {
                if self.p - start > 1 && x == 0 {
                    return Err(invalid_pack("RWFP5 variable integer is not canonical"));
                }
                return Ok(v);
            }
        }
        Err(invalid_pack("RWFP5 variable integer is too long"))
    }
    fn u32(&mut self) -> Result<u32> {
        u32::try_from(self.var()?).map_err(|_| invalid_pack("RWFP5 integer overflows u32"))
    }
    fn count(&mut self) -> Result<usize> {
        let n = usize::try_from(self.var()?)
            .map_err(|_| invalid_pack("RWFP5 count overflows platform"))?;
        if n > MAX_COUNT {
            return Err(invalid_pack("RWFP5 count exceeds limit"));
        }
        Ok(n)
    }
    fn byte(&mut self) -> Result<u8> {
        let x = *self
            .b
            .get(self.p)
            .ok_or_else(|| invalid_pack("RWFP5 record is truncated"))?;
        self.p += 1;
        Ok(x)
    }
    fn finish(&self) -> Result<()> {
        if self.p != self.b.len() {
            Err(invalid_pack("RWFP5 table has trailing bytes"))
        } else {
            Ok(())
        }
    }
}

struct Strings {
    values: Vec<String>,
}
impl Strings {
    fn parse(b: &[u8]) -> Result<Self> {
        let mut c = Cursor::new(b, b"RWS5")?;
        let n = c.count()?;
        let mut v = Vec::with_capacity(n);
        for _ in 0..n {
            let l = usize::try_from(c.var()?)
                .map_err(|_| invalid_pack("RWFP5 string length overflows"))?;
            if l > MAX_STRING {
                return Err(invalid_pack("RWFP5 string is too long"));
            }
            let end =
                c.p.checked_add(l)
                    .ok_or_else(|| invalid_pack("RWFP5 string offset overflows"))?;
            let s = std::str::from_utf8(
                c.b.get(c.p..end)
                    .ok_or_else(|| invalid_pack("RWFP5 string is truncated"))?,
            )
            .map_err(|e| invalid_pack(format!("RWFP5 string is not UTF-8: {e}")))?
            .to_string();
            c.p = end;
            v.push(s)
        }
        c.finish()?;
        Ok(Self { values: v })
    }
    fn get(&self, id: u32) -> Result<String> {
        self.values
            .get(id as usize)
            .cloned()
            .ok_or_else(|| invalid_pack("RWFP5 string id is out of range"))
    }
}

fn parse_hashes(b: &[u8], s: &Strings) -> Result<Vec<Hash>> {
    let mut c = Cursor::new(b, b"RWH5")?;
    let n = c.count()?;
    let mut out = Vec::with_capacity(n);
    let mut size = 0u64;
    for i in 0..n {
        let d = c.var()?;
        size = if i == 0 {
            d
        } else {
            size.checked_add(d)
                .ok_or_else(|| invalid_pack("RWFP5 hash size overflows"))?
        };
        let scope = match c.byte()? {
            0 => "full_file".into(),
            1 => "track_file".into(),
            255 => s.get(c.u32()?)?,
            x => return Err(invalid_pack(format!("RWFP5 hash scope {x} is invalid"))),
        };
        let mask = c.byte()?;
        if mask & !15 != 0 {
            return Err(invalid_pack("RWFP5 hash mask is invalid"));
        }
        let mut next = |width: usize| -> Result<String> {
            let end =
                c.p.checked_add(width)
                    .ok_or_else(|| invalid_pack("RWFP5 hash offset overflows"))?;
            let x =
                c.b.get(c.p..end)
                    .ok_or_else(|| invalid_pack("RWFP5 hash is truncated"))?;
            c.p = end;
            Ok(x.iter().map(|b| format!("{b:02x}")).collect())
        };
        let crc = if mask & 1 != 0 { Some(next(4)?) } else { None };
        let md5 = if mask & 2 != 0 { Some(next(16)?) } else { None };
        let sha1 = if mask & 4 != 0 { Some(next(20)?) } else { None };
        let sha256 = if mask & 8 != 0 { Some(next(32)?) } else { None };
        out.push(Hash {
            size,
            scope,
            crc32: crc,
            md5,
            sha1,
            sha256,
        })
    }
    c.finish()?;
    Ok(out)
}

fn parse_components(b: &[u8], hashes: &[Hash], s: &Strings) -> Result<Vec<PackComponent>> {
    let mut c = Cursor::new(b, b"RWC5")?;
    let n = c.count()?;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let h = c.u32()?;
        if h as usize >= hashes.len() {
            return Err(invalid_pack("RWFP5 component hash id is out of range"));
        }
        let presence = c.byte()?;
        if presence & !7 != 0 {
            return Err(invalid_pack("RWFP5 component presence mask is invalid"));
        }
        let filename = if presence & 1 != 0 {
            Some(s.get(c.u32()?)?)
        } else {
            None
        };
        let track = if presence & 2 != 0 {
            Some(c.u32()?)
        } else {
            None
        };
        let session = if presence & 4 != 0 {
            Some(c.u32()?)
        } else {
            None
        };
        let role = match c.byte()? {
            0 => PackComponentRole::PrimaryPayload,
            1 => PackComponentRole::DataTrack,
            2 => PackComponentRole::AudioTrack,
            3 => PackComponentRole::ArcadeRom,
            4 => PackComponentRole::Partition,
            5 => PackComponentRole::ContentFile,
            6 => PackComponentRole::DiskSide,
            7 => PackComponentRole::ChildDisc,
            x => return Err(invalid_pack(format!("RWFP5 component role {x} is invalid"))),
        };
        let flags = c.byte()?;
        if flags & !3 != 0 {
            return Err(invalid_pack("RWFP5 component flags are invalid"));
        }
        let x = &hashes[h as usize];
        out.push(PackComponent {
            role,
            ordinal: 0,
            hash_scope: x.scope.clone(),
            filename,
            size: x.size,
            crc32: x.crc32.clone(),
            md5: x.md5.clone(),
            sha1: x.sha1.clone(),
            sha256: x.sha256.clone(),
            required: flags & 1 != 0,
            discriminating: flags & 2 != 0,
            track,
            session,
        });
    }
    c.finish()?;
    Ok(out)
}

fn parse_owners(b: &[u8], hashes: usize, components: usize) -> Result<Vec<Vec<u32>>> {
    let mut c = Cursor::new(b, b"RWO5")?;
    let n = c.count()?;
    if n != hashes {
        return Err(invalid_pack("RWFP5 owner hash count does not match hashes"));
    }
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let count = c.count()?;
        let mut ids = Vec::with_capacity(count);
        let mut last = 0u32;
        for i in 0..count {
            let d = c.u32()?;
            let id = if i == 0 {
                d
            } else {
                last.checked_add(d)
                    .ok_or_else(|| invalid_pack("RWFP5 owner id overflows"))?
            };
            if id as usize >= components || i > 0 && id <= last {
                return Err(invalid_pack("RWFP5 owner ids are not ascending"));
            }
            last = id;
            ids.push(id)
        }
        out.push(ids)
    }
    c.finish()?;
    Ok(out)
}

fn validate_owners(
    owners: &[Vec<u32>],
    components: &[PackComponent],
    hashes: &[Hash],
) -> Result<()> {
    let mut seen = vec![false; components.len()];
    for (hash_id, component_ids) in owners.iter().enumerate() {
        let hash = &hashes[hash_id];
        for &component_id in component_ids {
            let component = &components[component_id as usize];
            if seen[component_id as usize]
                || component.size != hash.size
                || component.hash_scope != hash.scope
                || component.crc32 != hash.crc32
                || component.md5 != hash.md5
                || component.sha1 != hash.sha1
                || component.sha256 != hash.sha256
            {
                return Err(invalid_pack("RWFP5 owner mapping is invalid"));
            }
            seen[component_id as usize] = true;
        }
    }
    if seen.iter().any(|value| !value) {
        return Err(invalid_pack("RWFP5 owners do not cover all components"));
    }
    Ok(())
}

fn parse_routes(
    b: &[u8],
    hashes: &[Hash],
    owners: &[Vec<u32>],
    components: &[PackComponent],
) -> Result<Vec<u32>> {
    let mut c = Cursor::new(b, b"RWR5")?;
    let n = c.count()?;
    let mut out = Vec::with_capacity(n);
    let mut previous: Option<([u8; 4], u64, &str, u32)> = None;
    for _ in 0..n {
        let id = c.u32()?;
        let hash = hashes
            .get(id as usize)
            .ok_or_else(|| invalid_pack("RWFP5 route hash id is out of range"))?;
        let crc = hash
            .crc32
            .as_deref()
            .map(hex_crc)
            .ok_or_else(|| invalid_pack("RWFP5 routed hash has no crc32"))?;
        if hash.size == 0
            || !owners[id as usize]
                .iter()
                .any(|owner| components[*owner as usize].discriminating)
        {
            return Err(invalid_pack("RWFP5 route references an ineligible hash"));
        }
        let key = (crc, hash.size, hash.scope.as_str(), id);
        if previous.as_ref().is_some_and(|prior| prior >= &key) {
            return Err(invalid_pack("RWFP5 route ids are not in key order"));
        }
        previous = Some(key);
        if id as usize >= hashes.len() {
            return Err(invalid_pack("RWFP5 route hash id is out of range"));
        }
        out.push(id)
    }
    c.finish()?;
    let mut expected = hashes
        .iter()
        .enumerate()
        .filter(|(id, hash)| {
            hash.size > 0
                && hash.crc32.is_some()
                && owners[*id]
                    .iter()
                    .any(|owner| components[*owner as usize].discriminating)
        })
        .map(|(id, hash)| {
            (
                hex_crc(hash.crc32.as_deref().expect("filtered crc32")),
                hash.size,
                hash.scope.as_str(),
                id as u32,
            )
        })
        .collect::<Vec<_>>();
    expected.sort_unstable();
    let expected = expected
        .into_iter()
        .map(|(_, _, _, id)| id)
        .collect::<Vec<_>>();
    if out != expected {
        return Err(invalid_pack(
            "RWFP5 routes do not cover all eligible hashes",
        ));
    }
    Ok(out)
}

type Sets = (Vec<Vec<u32>>, Vec<Vec<u32>>);
fn parse_sets(b: &[u8], s: &Strings, provenance: usize) -> Result<Sets> {
    let mut c = Cursor::new(b, b"RWX5")?;
    let pn = c.count()?;
    let mut ps = Vec::with_capacity(pn);
    for _ in 0..pn {
        let n = c.count()?;
        let mut x = Vec::with_capacity(n);
        for _ in 0..n {
            let id = c.u32()?;
            if id as usize >= provenance {
                return Err(invalid_pack("RWFP5 provenance id is out of range"));
            }
            x.push(id);
        }
        ps.push(x)
    }
    let tn = c.count()?;
    let mut ts = Vec::with_capacity(tn);
    for _ in 0..tn {
        let n = c.count()?;
        let mut x = Vec::with_capacity(n);
        for _ in 0..n {
            let id = c.u32()?;
            x.push(id);
            if x.last().copied().unwrap() as usize >= s.values.len() {
                return Err(invalid_pack("RWFP5 tag string id is out of range"));
            }
        }
        ts.push(x)
    }
    c.finish()?;
    Ok((ps, ts))
}

fn parse_games(
    b: &[u8],
    s: &Strings,
    all: &[PackComponent],
    m: &Manifest,
    ps: &[Vec<u32>],
    ts: &[Vec<u32>],
) -> Result<Vec<PackGame>> {
    let mut c = Cursor::new(b, b"RWG5")?;
    let n = c.count()?;
    let mut out = Vec::with_capacity(n);
    let mut component = 0usize;
    for _ in 0..n {
        let name = s.get(c.u32()?)?;
        let bits = c.byte()?;
        let get = |c: &mut Cursor<'_>, bit: u8, s: &Strings, bits: u8| -> Result<Option<String>> {
            if bits & bit != 0 {
                Ok(Some(s.get(c.u32()?)?))
            } else {
                Ok(None)
            }
        };
        let game_id = get(&mut c, 1, s, bits)?;
        let region = get(&mut c, 2, s, bits)?;
        let language = get(&mut c, 4, s, bits)?;
        let revision = get(&mut c, 8, s, bits)?;
        let parent = get(&mut c, 16, s, bits)?;
        let count = c.count()?;
        let pset = c.u32()?;
        let tset = c.u32()?;
        if pset as usize >= ps.len() || tset as usize >= ts.len() {
            return Err(invalid_pack("RWFP5 set id is out of range"));
        }
        let disc = if bits & 32 != 0 { Some(c.u32()?) } else { None };
        let upstream = if bits & 64 != 0 {
            match c.byte()? {
                0 => UpstreamSource::Libretro,
                1 => UpstreamSource::Redump,
                2 => UpstreamSource::NoIntro,
                3 => UpstreamSource::Tosec,
                4 => UpstreamSource::Mame,
                5 => UpstreamSource::Fbneo,
                6 => UpstreamSource::OpenGood,
                x => {
                    return Err(invalid_pack(format!(
                        "RWFP5 upstream source {x} is invalid"
                    )));
                }
            }
        } else {
            UpstreamSource::Unknown
        };
        let end = component
            .checked_add(count)
            .ok_or_else(|| invalid_pack("RWFP5 component range overflows"))?;
        if end > all.len() {
            return Err(invalid_pack("RWFP5 game component range is out of bounds"));
        }
        let mut components = all[component..end].to_vec();
        for (i, x) in components.iter_mut().enumerate() {
            x.ordinal = i as u32;
        }
        component = end;
        let provenance = ps[pset as usize]
            .iter()
            .map(|&id| m.provenance[id as usize].clone())
            .collect();
        let dump_tags = ts[tset as usize]
            .iter()
            .map(|&id| s.values[id as usize].clone())
            .collect();
        out.push(PackGame {
            name,
            platform: m.platform.clone(),
            source: m.source,
            upstream_source: upstream,
            provenance,
            legacy_variant: bits & 128 != 0,
            dump_tags,
            game_id,
            region,
            language,
            disc_number: disc,
            revision,
            parent,
            components,
        });
    }
    c.finish()?;
    if component != all.len() {
        return Err(invalid_pack("RWFP5 unused components remain"));
    }
    Ok(out)
}
fn hex_crc(s: &str) -> [u8; 4] {
    let mut out = [0; 4];
    for (i, x) in out.iter_mut().enumerate() {
        *x = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap_or(0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game() -> PackGame {
        PackGame {
            name: "Example".to_string(),
            platform: "Test".to_string(),
            source: IdentifySource::Redump,
            upstream_source: UpstreamSource::Redump,
            provenance: Vec::new(),
            legacy_variant: false,
            dump_tags: Vec::new(),
            game_id: None,
            region: None,
            language: None,
            disc_number: None,
            revision: None,
            parent: None,
            components: vec![PackComponent {
                role: PackComponentRole::PrimaryPayload,
                ordinal: 99,
                hash_scope: "full_file".to_string(),
                filename: Some("example.bin".to_string()),
                size: 4,
                crc32: Some("aabbccdd".to_string()),
                md5: None,
                sha1: None,
                sha256: None,
                required: true,
                discriminating: true,
                track: None,
                session: None,
            }],
        }
    }

    #[test]
    fn encode_is_deterministic_and_round_trips() {
        let provenance = PackProvenance {
            source: "redump".to_string(),
            source_name: Some("Redump".to_string()),
            source_url: None,
            source_commit: None,
            license: None,
        };
        let mut input_game = game();
        input_game.provenance.push(provenance.clone());
        input_game.dump_tags.push("verified".to_string());
        let first = encode(
            "Test",
            IdentifySource::Redump,
            "test-v1",
            &json!([provenance]),
            vec![input_game.clone()],
        )
        .expect("pack encodes");
        let second = encode(
            "Test",
            IdentifySource::Redump,
            "test-v1",
            &json!([input_game.provenance[0].clone()]),
            vec![input_game.clone()],
        )
        .expect("pack encodes again");
        assert_eq!(first, second);
        let pack = ArtifactPack::parse(&first).expect("pack parses");
        assert_eq!(pack.games()[0].components[0].ordinal, 0);
        assert_eq!(pack.games()[0].provenance, input_game.provenance);
        assert_eq!(pack.games()[0].dump_tags, input_game.dump_tags);
        assert_eq!(pack.route("aabbccdd", 4).unwrap(), vec![(0, 0)]);
    }

    #[test]
    fn rejects_wrong_pack_invariants_and_truncation() {
        let mut wrong = game();
        wrong.platform = "Other".to_string();
        assert!(
            encode(
                "Test",
                IdentifySource::Redump,
                "test-v1",
                &json!([]),
                vec![wrong]
            )
            .unwrap_err()
            .to_string()
            .contains("does not match")
        );

        let mut bytes = encode(
            "Test",
            IdentifySource::Redump,
            "test-v1",
            &json!([]),
            vec![game()],
        )
        .expect("pack encodes");
        bytes.pop();
        assert!(
            ArtifactPack::parse(&bytes)
                .unwrap_err()
                .to_string()
                .contains("bounds")
        );
    }

    #[test]
    fn rejects_missing_eligible_routes() {
        let bytes = encode(
            "Test",
            IdentifySource::Redump,
            "test-v1",
            &json!([]),
            vec![game()],
        )
        .expect("pack encodes");
        let members = read_members_with_magic(&bytes, PACK_V5_MAGIC, "RWFP5").unwrap();
        let mut members = members.into_iter().collect::<Vec<_>>();
        members.sort_by(|left, right| left.0.cmp(&right.0));
        let mut corrupt = PACK_V5_MAGIC.to_vec();
        corrupt.extend_from_slice(&(members.len() as u32).to_le_bytes());
        for (name, value) in &members {
            let value = if name == "routes.bin" {
                b"RWR5\x01\x00".as_slice()
            } else {
                value
            };
            corrupt.extend_from_slice(&(name.len() as u16).to_le_bytes());
            corrupt.extend_from_slice(&(value.len() as u64).to_le_bytes());
            corrupt.extend_from_slice(name.as_bytes());
        }
        for (name, value) in members {
            corrupt.extend_from_slice(if name == "routes.bin" {
                b"RWR5\x01\x00"
            } else {
                value
            });
        }
        assert!(
            ArtifactPack::parse(&corrupt)
                .unwrap_err()
                .to_string()
                .contains("do not cover")
        );
    }

    #[test]
    fn rejects_noncanonical_and_overflowing_varints() {
        assert!(
            Cursor::new(b"RWS5\x01\x80\x00", b"RWS5")
                .unwrap()
                .var()
                .unwrap_err()
                .to_string()
                .contains("not canonical")
        );
        assert!(
            Cursor::new(b"RWS5\x01\xff\xff\xff\xff\xff\xff\xff\xff\xff\x02", b"RWS5")
                .unwrap()
                .var()
                .unwrap_err()
                .to_string()
                .contains("overflows")
        );
    }
}
