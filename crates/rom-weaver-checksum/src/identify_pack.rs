//! Reader for the per-system identify packs produced by
//! `scripts/build-hasheous-identify-index.mjs`.
//!
//! This is the Rust twin of `packages/rom-weaver-react/src/lib/identify/
//! pack-reader.ts`: it parses one decompressed RWFP1 pack (crc32/md5/sha1 hash
//! maps + name/platform tables for a single platform) and resolves a checksum
//! set to the exact dump name(s). The native build embeds the packs and looks
//! up here; the wasm build fetches packs in JS and looks up in the TS twin.
//! Both must stay byte-compatible with the builder's format.

use std::collections::HashMap;

/// Values >= this flag in a hash map are conflict-table indices, not pair ids.
const CONFLICT_VALUE_FLAG: u32 = 0x8000_0000;
const PACK_MAGIC: &[u8] = b"RWFP1\0\0\0";
const HASH_MAGIC: &[u8] = b"RWH1";
const PAIR_MAGIC: &[u8] = b"RWHP";

/// A single resolved identification: exact dump name and its platform.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentifyMatch {
    pub name: String,
    pub platform: String,
}

/// The checksum set looked up against a pack. Lowercase hex; omit unknowns.
#[derive(Clone, Copy, Debug, Default)]
pub struct IdentifyQuery<'a> {
    pub crc32: Option<&'a str>,
    pub md5: Option<&'a str>,
    pub sha1: Option<&'a str>,
}

struct HashLookup {
    bytes: Vec<u8>,
    hash_bytes: usize,
    key_count: usize,
    records_start: usize,
    record_width: usize,
    offsets_start: usize,
    values_start: usize,
}

impl HashLookup {
    fn parse(member: &[u8]) -> Option<Self> {
        if member.len() < 20 || &member[..HASH_MAGIC.len()] != HASH_MAGIC {
            return None;
        }
        let hash_bytes = member[6] as usize;
        let key_count = read_u32(member, 8)? as usize;
        let conflict_entries = read_u32(member, 12)? as usize;
        let record_width = hash_bytes + 4;
        let records_start = 20;
        let offsets_start = records_start + key_count * record_width;
        let values_start = offsets_start + (conflict_entries + 1) * 4;
        Some(Self {
            bytes: member.to_vec(),
            hash_bytes,
            key_count,
            offsets_start,
            record_width,
            records_start,
            values_start,
        })
    }

    /// Binary search for `hex`; return the matching pair id(s), or `None`.
    fn lookup(&self, hex: Option<&str>) -> Option<Vec<u32>> {
        let target = hex_to_bytes(&hex?.to_ascii_lowercase())?;
        if target.len() != self.hash_bytes {
            return None;
        }
        let (mut low, mut high) = (0isize, self.key_count as isize - 1);
        while low <= high {
            let mid = (low + high) / 2;
            let record = self.records_start + mid as usize * self.record_width;
            let stored = self.bytes.get(record..record + self.hash_bytes)?;
            match stored.cmp(target.as_slice()) {
                std::cmp::Ordering::Equal => {
                    let value = read_u32(&self.bytes, record + self.hash_bytes)?;
                    if value < CONFLICT_VALUE_FLAG {
                        return Some(vec![value]);
                    }
                    return self.conflict_pairs(value - CONFLICT_VALUE_FLAG);
                }
                std::cmp::Ordering::Less => low = mid + 1,
                std::cmp::Ordering::Greater => high = mid - 1,
            }
        }
        None
    }

    fn conflict_pairs(&self, conflict_index: u32) -> Option<Vec<u32>> {
        let index = conflict_index as usize;
        let start = read_u32(&self.bytes, self.offsets_start + index * 4)? as usize;
        let end = read_u32(&self.bytes, self.offsets_start + (index + 1) * 4)? as usize;
        let mut ids = Vec::with_capacity(end.saturating_sub(start));
        for slot in start..end {
            ids.push(read_u32(&self.bytes, self.values_start + slot * 4)?);
        }
        Some(ids)
    }
}

/// A parsed per-system identify pack.
pub struct SystemPack {
    names: Vec<String>,
    platforms: Vec<String>,
    pairs: Vec<(u32, u16)>,
    crc32: Option<HashLookup>,
    md5: Option<HashLookup>,
    sha1: Option<HashLookup>,
}

impl SystemPack {
    /// Parse a decompressed RWFP1 pack blob.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let members = read_members(bytes)?;
        Some(Self {
            crc32: members.get("crc32.bin").and_then(|m| HashLookup::parse(m)),
            md5: members.get("md5.bin").and_then(|m| HashLookup::parse(m)),
            sha1: members.get("sha1.bin").and_then(|m| HashLookup::parse(m)),
            names: parse_json_strings(members.get("names.json")),
            platforms: parse_json_strings(members.get("platforms.json")),
            pairs: parse_pairs(members.get("name-platforms.bin")),
        })
    }

    /// Resolve a checksum set to its exact dump name(s), mirroring the builder's
    /// crc-primary → md5 → sha1 fallback: CRC32 names most ROMs in one probe;
    /// the stronger hashes only disambiguate within-system CRC32 collisions.
    pub fn resolve(&self, query: &IdentifyQuery) -> Vec<IdentifyMatch> {
        let crc = self.crc32.as_ref().and_then(|m| m.lookup(query.crc32));
        if let Some(pairs) = &crc
            && pairs.len() == 1
        {
            return self.matches(pairs);
        }
        let md5 = self.md5.as_ref().and_then(|m| m.lookup(query.md5));
        if let Some(pairs) = &md5
            && pairs.len() == 1
        {
            return self.matches(pairs);
        }
        if let Some(pairs) = self.sha1.as_ref().and_then(|m| m.lookup(query.sha1))
            && !pairs.is_empty()
        {
            return self.matches(&pairs);
        }
        if let Some(pairs) = &crc
            && !pairs.is_empty()
        {
            return self.matches(pairs);
        }
        if let Some(pairs) = &md5
            && !pairs.is_empty()
        {
            return self.matches(pairs);
        }
        Vec::new()
    }

    fn matches(&self, pair_ids: &[u32]) -> Vec<IdentifyMatch> {
        let mut out = Vec::with_capacity(pair_ids.len());
        for &pair_id in pair_ids {
            let Some(&(name_id, platform_id)) = self.pairs.get(pair_id as usize) else {
                continue;
            };
            let (Some(name), Some(platform)) = (
                self.names.get(name_id as usize),
                self.platforms.get(platform_id as usize),
            ) else {
                continue;
            };
            out.push(IdentifyMatch {
                name: name.clone(),
                platform: platform.clone(),
            });
        }
        out
    }
}

fn read_members(bytes: &[u8]) -> Option<HashMap<String, &[u8]>> {
    if bytes.len() < PACK_MAGIC.len() + 4 || &bytes[..PACK_MAGIC.len()] != PACK_MAGIC {
        return None;
    }
    let mut cursor = PACK_MAGIC.len();
    let count = read_u32(bytes, cursor)? as usize;
    cursor += 4;
    let mut directory = Vec::with_capacity(count);
    for _ in 0..count {
        let name_len = read_u16(bytes, cursor)? as usize;
        cursor += 2;
        let byte_len = read_u64(bytes, cursor)? as usize;
        cursor += 8;
        let name = std::str::from_utf8(bytes.get(cursor..cursor + name_len)?)
            .ok()?
            .to_string();
        cursor += name_len;
        directory.push((name, byte_len));
    }
    let mut members = HashMap::with_capacity(directory.len());
    for (name, byte_len) in directory {
        members.insert(name, bytes.get(cursor..cursor + byte_len)?);
        cursor += byte_len;
    }
    Some(members)
}

fn parse_pairs(member: Option<&&[u8]>) -> Vec<(u32, u16)> {
    let Some(member) = member else {
        return Vec::new();
    };
    if member.len() < 8 || &member[..PAIR_MAGIC.len()] != PAIR_MAGIC {
        return Vec::new();
    }
    let Some(width) = read_u16(member, 6) else {
        return Vec::new();
    };
    let width = width as usize;
    if width == 0 {
        return Vec::new();
    }
    let count = (member.len() - 8) / width;
    let mut pairs = Vec::with_capacity(count);
    for index in 0..count {
        let offset = 8 + index * width;
        if let (Some(name_id), Some(platform_id)) =
            (read_u32(member, offset), read_u16(member, offset + 4))
        {
            pairs.push((name_id, platform_id));
        }
    }
    pairs
}

fn parse_json_strings(member: Option<&&[u8]>) -> Vec<String> {
    member
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(bytes).ok())
        .unwrap_or_default()
}

fn hex_to_bytes(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len() / 2)
        .map(|index| u8::from_str_radix(hex.get(index * 2..index * 2 + 2)?, 16).ok())
        .collect()
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    let slice = bytes.get(offset..offset + 8)?;
    let mut array = [0u8; 8];
    array.copy_from_slice(slice);
    Some(u64::from_le_bytes(array))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an RWH1 hash map; each entry maps a hash to one-or-more pair ids
    /// (>1 => a conflict). Mirrors the builder's `writeHashMap`.
    fn build_hash_map(hash_bytes: usize, mut entries: Vec<(Vec<u8>, Vec<u32>)>) -> Vec<u8> {
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let mut conflict_offsets = vec![0u32];
        let mut conflict_values: Vec<u32> = Vec::new();
        let mut records = Vec::new();
        for (hash, ids) in &entries {
            records.extend_from_slice(hash);
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
        out.extend_from_slice(HASH_MAGIC);
        out.extend_from_slice(&[0, 0, hash_bytes as u8, 0]);
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

    fn build_pairs(pairs: &[(u32, u16)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(PAIR_MAGIC);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&6u16.to_le_bytes());
        for (name_id, platform_id) in pairs {
            out.extend_from_slice(&name_id.to_le_bytes());
            out.extend_from_slice(&platform_id.to_le_bytes());
        }
        out
    }

    fn build_pack(members: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(PACK_MAGIC);
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

    fn pack_with(
        crc_entries: Vec<(Vec<u8>, Vec<u32>)>,
        pairs: &[(u32, u16)],
        names: &[&str],
    ) -> Vec<u8> {
        build_pack(&[
            ("crc32.bin", build_hash_map(4, crc_entries)),
            ("md5.bin", build_hash_map(16, vec![])),
            ("sha1.bin", build_hash_map(20, vec![])),
            ("name-platforms.bin", build_pairs(pairs)),
            (
                "names.json",
                serde_json::to_vec(&names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
                    .unwrap(),
            ),
            (
                "platforms.json",
                serde_json::to_vec(&["Nintendo Entertainment System"]).unwrap(),
            ),
        ])
    }

    #[test]
    fn resolves_unique_crc_to_exact_name() {
        let zelda = "Legend of Zelda, The (U) (PRG0) [!]";
        let pack_bytes = pack_with(
            vec![(vec![0x3f, 0xe2, 0x72, 0xfb], vec![0])],
            &[(0, 0)],
            &[zelda],
        );
        let pack = SystemPack::parse(&pack_bytes).expect("pack parses");
        let matches = pack.resolve(&IdentifyQuery {
            crc32: Some("3fe272fb"),
            ..Default::default()
        });
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].name, zelda);
        assert_eq!(matches[0].platform, "Nintendo Entertainment System");
    }

    #[test]
    fn returns_all_candidates_for_colliding_crc() {
        let pack_bytes = pack_with(
            vec![(vec![0xaa, 0xaa, 0xaa, 0xaa], vec![0, 1])],
            &[(0, 0), (1, 0)],
            &["Game A (Track 2)", "Game B (Track 2)"],
        );
        let pack = SystemPack::parse(&pack_bytes).expect("pack parses");
        let matches = pack.resolve(&IdentifyQuery {
            crc32: Some("aaaaaaaa"),
            ..Default::default()
        });
        let names: Vec<_> = matches.into_iter().map(|m| m.name).collect();
        assert_eq!(names, vec!["Game A (Track 2)", "Game B (Track 2)"]);
    }

    #[test]
    fn unknown_crc_resolves_to_nothing() {
        let pack_bytes = pack_with(
            vec![(vec![0x00, 0x00, 0x00, 0x01], vec![0])],
            &[(0, 0)],
            &["Only"],
        );
        let pack = SystemPack::parse(&pack_bytes).expect("pack parses");
        assert!(
            pack.resolve(&IdentifyQuery {
                crc32: Some("deadbeef"),
                ..Default::default()
            })
            .is_empty()
        );
    }
}
