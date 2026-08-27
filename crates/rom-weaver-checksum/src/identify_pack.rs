//! Reader for the per-system identify packs produced by
//! the identify pack builders.
//!
//! It parses one decompressed RWFP1 pack. Each pack has crc32, md5, and sha1
//! maps plus name and platform tables. Native and WASM commands use this same
//! reader, so the lookup result stays byte-compatible across both targets.

use std::collections::HashMap;

use rom_weaver_core::{Result, RomWeaverError};

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

/// The selected hash lookup and all names it resolved.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentifyLookup {
    pub algorithm: Option<&'static str>,
    pub matches: Vec<IdentifyMatch>,
}

/// The checksum set looked up against a pack. Lowercase hex; omit unknowns.
#[derive(Clone, Copy, Debug, Default)]
pub struct IdentifyQuery<'a> {
    pub crc32: Option<&'a str>,
    pub md5: Option<&'a str>,
    pub sha1: Option<&'a str>,
}

#[derive(Debug)]
struct HashLookup {
    bytes: Vec<u8>,
    conflict_entries: usize,
    conflict_values: usize,
    hash_bytes: usize,
    key_count: usize,
    records_start: usize,
    record_width: usize,
    offsets_start: usize,
    values_start: usize,
}

impl HashLookup {
    fn parse(member: &[u8], expected_algorithm: u8, expected_hash_bytes: usize) -> Result<Self> {
        if member.len() < 20 {
            return Err(invalid_pack("hash table is shorter than its header"));
        }
        if &member[..HASH_MAGIC.len()] != HASH_MAGIC {
            return Err(invalid_pack("hash table magic does not match RWH1"));
        }
        if member[4] != expected_algorithm || member[5] != 0 || member[7] != 0 {
            return Err(invalid_pack("hash table header is not supported"));
        }
        let hash_bytes = member[6] as usize;
        if hash_bytes != expected_hash_bytes {
            return Err(invalid_pack("hash table uses an unexpected hash width"));
        }
        let key_count = read_u32(member, 8)? as usize;
        let conflict_entries = read_u32(member, 12)? as usize;
        let conflict_values = read_u32(member, 16)? as usize;
        let record_width = hash_bytes
            .checked_add(4)
            .ok_or_else(|| invalid_pack("hash record width overflow"))?;
        let records_start = 20usize;
        let offsets_start = records_start
            .checked_add(
                key_count
                    .checked_mul(record_width)
                    .ok_or_else(|| invalid_pack("hash record table overflow"))?,
            )
            .ok_or_else(|| invalid_pack("hash record offset overflow"))?;
        let offset_bytes = conflict_entries
            .checked_add(1)
            .and_then(|count| count.checked_mul(4))
            .ok_or_else(|| invalid_pack("conflict offset table overflow"))?;
        let values_start = offsets_start
            .checked_add(offset_bytes)
            .ok_or_else(|| invalid_pack("conflict value offset overflow"))?;
        let expected_len = values_start
            .checked_add(
                conflict_values
                    .checked_mul(4)
                    .ok_or_else(|| invalid_pack("conflict value table overflow"))?,
            )
            .ok_or_else(|| invalid_pack("hash table length overflow"))?;
        if expected_len != member.len() {
            return Err(invalid_pack("hash table length does not match its header"));
        }
        let lookup = Self {
            bytes: member.to_vec(),
            conflict_entries,
            conflict_values,
            hash_bytes,
            key_count,
            offsets_start,
            record_width,
            records_start,
            values_start,
        };
        lookup.validate_conflicts()?;
        Ok(lookup)
    }

    /// Binary search for `hex`; return the matching pair ids.
    fn lookup(&self, hex: Option<&str>) -> Result<Option<Vec<u32>>> {
        let Some(hex) = hex else {
            return Ok(None);
        };
        let target = hex_to_bytes(&hex.to_ascii_lowercase())?;
        if target.len() != self.hash_bytes {
            return Err(invalid_pack("identify query has an unexpected hash width"));
        }
        let (mut low, mut high) = (0isize, self.key_count as isize - 1);
        while low <= high {
            let mid = (low + high) / 2;
            let record = self.records_start + mid as usize * self.record_width;
            let stored = self
                .bytes
                .get(record..record + self.hash_bytes)
                .ok_or_else(|| invalid_pack("hash record is out of bounds"))?;
            match stored.cmp(target.as_slice()) {
                std::cmp::Ordering::Equal => {
                    let value = read_u32(&self.bytes, record + self.hash_bytes)?;
                    if value < CONFLICT_VALUE_FLAG {
                        return Ok(Some(vec![value]));
                    }
                    return self.conflict_pairs(value - CONFLICT_VALUE_FLAG).map(Some);
                }
                std::cmp::Ordering::Less => low = mid + 1,
                std::cmp::Ordering::Greater => high = mid - 1,
            }
        }
        Ok(None)
    }

    fn conflict_pairs(&self, conflict_index: u32) -> Result<Vec<u32>> {
        let index = conflict_index as usize;
        if index >= self.conflict_entries {
            return Err(invalid_pack("conflict index is out of range"));
        }
        let start = read_u32(&self.bytes, table_offset(self.offsets_start, index, 4)?)? as usize;
        let end = read_u32(&self.bytes, table_offset(self.offsets_start, index + 1, 4)?)? as usize;
        if end < start {
            return Err(invalid_pack("conflict offsets are not monotonic"));
        }
        if end > self.conflict_values {
            return Err(invalid_pack("conflict value range is out of bounds"));
        }
        let mut ids = Vec::with_capacity(end.saturating_sub(start));
        for slot in start..end {
            ids.push(read_u32(
                &self.bytes,
                table_offset(self.values_start, slot, 4)?,
            )?);
        }
        Ok(ids)
    }

    fn validate_conflicts(&self) -> Result<()> {
        let mut previous = 0usize;
        for index in 0..=self.conflict_entries {
            let offset =
                read_u32(&self.bytes, table_offset(self.offsets_start, index, 4)?)? as usize;
            if offset < previous || offset > self.conflict_values {
                return Err(invalid_pack("conflict offsets are invalid"));
            }
            previous = offset;
        }
        if previous != self.conflict_values {
            return Err(invalid_pack("conflict offsets do not cover all values"));
        }

        for index in 0..self.key_count {
            let record = table_offset(self.records_start, index, self.record_width)?;
            let value = read_u32(&self.bytes, record + self.hash_bytes)?;
            if value >= CONFLICT_VALUE_FLAG
                && (value - CONFLICT_VALUE_FLAG) as usize >= self.conflict_entries
            {
                return Err(invalid_pack("hash record conflict index is out of range"));
            }
        }
        Ok(())
    }

    fn validate_pair_ids(&self, pair_count: usize) -> Result<()> {
        for index in 0..self.key_count {
            let record = table_offset(self.records_start, index, self.record_width)?;
            let value = read_u32(&self.bytes, record + self.hash_bytes)?;
            if value < CONFLICT_VALUE_FLAG {
                validate_pair_id(value, pair_count)?;
                continue;
            }
            for pair_id in self.conflict_pairs(value - CONFLICT_VALUE_FLAG)? {
                validate_pair_id(pair_id, pair_count)?;
            }
        }
        Ok(())
    }
}

/// A parsed per-system identify pack.
#[derive(Debug)]
pub struct SystemPack {
    names: Vec<String>,
    platforms: Vec<String>,
    pairs: Vec<(u32, u16)>,
    crc32: HashLookup,
    md5: HashLookup,
    sha1: HashLookup,
}

impl SystemPack {
    /// Parse a decompressed RWFP1 pack blob.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let members = read_members(bytes)?;
        let crc32 = HashLookup::parse(required_member(&members, "crc32.bin")?, 0, 4)?;
        let md5 = HashLookup::parse(required_member(&members, "md5.bin")?, 1, 16)?;
        let sha1 = HashLookup::parse(required_member(&members, "sha1.bin")?, 2, 20)?;
        let names = parse_json_strings(required_member(&members, "names.json")?, "names.json")?;
        let platforms = parse_json_strings(
            required_member(&members, "platforms.json")?,
            "platforms.json",
        )?;
        let pairs = parse_pairs(required_member(&members, "name-platforms.bin")?)?;
        for &(name_id, platform_id) in &pairs {
            if name_id as usize >= names.len() {
                return Err(invalid_pack(format!("name id {name_id} is out of range")));
            }
            if platform_id as usize >= platforms.len() {
                return Err(invalid_pack(format!(
                    "platform id {platform_id} is out of range"
                )));
            }
        }
        for lookup in [&crc32, &md5, &sha1] {
            lookup.validate_pair_ids(pairs.len())?;
        }
        Ok(Self {
            crc32,
            md5,
            names,
            pairs,
            platforms,
            sha1,
        })
    }

    /// Resolve a checksum set to its exact dump name(s), mirroring the builder's
    /// crc-primary → md5 → sha1 fallback: CRC32 names most ROMs in one probe;
    /// the stronger hashes only disambiguate within-system CRC32 collisions.
    pub fn resolve(&self, query: &IdentifyQuery) -> Result<IdentifyLookup> {
        let crc = self.crc32.lookup(query.crc32)?;
        if let Some(pairs) = &crc
            && pairs.len() == 1
        {
            return Ok(IdentifyLookup {
                algorithm: Some("crc32"),
                matches: self.matches(pairs)?,
            });
        }
        let md5 = self.md5.lookup(query.md5)?;
        if let Some(pairs) = &md5
            && pairs.len() == 1
        {
            return Ok(IdentifyLookup {
                algorithm: Some("md5"),
                matches: self.matches(pairs)?,
            });
        }
        if let Some(pairs) = self.sha1.lookup(query.sha1)?
            && !pairs.is_empty()
        {
            return Ok(IdentifyLookup {
                algorithm: Some("sha1"),
                matches: self.matches(&pairs)?,
            });
        }
        if let Some(pairs) = &crc
            && !pairs.is_empty()
        {
            return Ok(IdentifyLookup {
                algorithm: Some("crc32"),
                matches: self.matches(pairs)?,
            });
        }
        if let Some(pairs) = &md5
            && !pairs.is_empty()
        {
            return Ok(IdentifyLookup {
                algorithm: Some("md5"),
                matches: self.matches(pairs)?,
            });
        }
        Ok(IdentifyLookup {
            algorithm: None,
            matches: Vec::new(),
        })
    }

    fn matches(&self, pair_ids: &[u32]) -> Result<Vec<IdentifyMatch>> {
        let mut out = Vec::with_capacity(pair_ids.len());
        for &pair_id in pair_ids {
            let &(name_id, platform_id) = self
                .pairs
                .get(pair_id as usize)
                .ok_or_else(|| invalid_pack(format!("pair id {pair_id} is out of range")))?;
            let name = self
                .names
                .get(name_id as usize)
                .ok_or_else(|| invalid_pack(format!("name id {name_id} is out of range")))?;
            let platform = self.platforms.get(platform_id as usize).ok_or_else(|| {
                invalid_pack(format!("platform id {platform_id} is out of range"))
            })?;
            out.push(IdentifyMatch {
                name: name.clone(),
                platform: platform.clone(),
            });
        }
        Ok(out)
    }
}

fn read_members(bytes: &[u8]) -> Result<HashMap<String, &[u8]>> {
    read_members_with_magic(bytes, PACK_MAGIC, "RWFP1")
}

/// Parse the shared outer container (magic + directory + member payloads).
/// RWFP1 and RWFP2 share this byte layout and differ only in the magic.
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
        cursor += name_len;
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

fn parse_pairs(member: &[u8]) -> Result<Vec<(u32, u16)>> {
    if member.len() < 8 || &member[..PAIR_MAGIC.len()] != PAIR_MAGIC {
        return Err(invalid_pack("name/platform pair table is invalid"));
    }
    let version = read_u16(member, 4)?;
    let width = read_u16(member, 6)? as usize;
    if version != 1 || width != 6 || !(member.len() - 8).is_multiple_of(width) {
        return Err(invalid_pack("name/platform pair layout is not supported"));
    }
    let count = (member.len() - 8) / width;
    let mut pairs = Vec::with_capacity(count);
    for index in 0..count {
        let offset = 8 + index * width;
        pairs.push((read_u32(member, offset)?, read_u16(member, offset + 4)?));
    }
    Ok(pairs)
}

fn parse_json_strings(member: &[u8], name: &str) -> Result<Vec<String>> {
    serde_json::from_slice(member)
        .map_err(|error| invalid_pack(format!("{name} is invalid JSON: {error}")))
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

pub(crate) fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let end = offset
        .checked_add(2)
        .ok_or_else(|| invalid_pack("u16 read offset overflow"))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| invalid_pack("u16 read is out of bounds"))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

pub(crate) fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| invalid_pack("u32 read offset overflow"))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| invalid_pack("u32 read is out of bounds"))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

pub(crate) fn read_u64(bytes: &[u8], offset: usize) -> Result<u64> {
    let end = offset
        .checked_add(8)
        .ok_or_else(|| invalid_pack("u64 read offset overflow"))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| invalid_pack("u64 read is out of bounds"))?;
    let mut array = [0u8; 8];
    array.copy_from_slice(slice);
    Ok(u64::from_le_bytes(array))
}

/// A parsed identify pack of either supported generation, chosen by magic.
#[derive(Debug)]
pub enum IdentifyPackFile {
    V1(SystemPack),
    V2(crate::identify_pack_v2::ArtifactPack),
    V3(crate::identify_pack_v3::ArtifactPack),
    V4(crate::identify_pack_v4::ArtifactPack),
}

impl IdentifyPackFile {
    /// Parse a decompressed pack blob, dispatching on the 8-byte magic.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() >= PACK_MAGIC.len() && &bytes[..PACK_MAGIC.len()] == PACK_MAGIC {
            return Ok(Self::V1(SystemPack::parse(bytes)?));
        }
        if bytes.len() >= crate::identify_pack_v2::PACK_V2_MAGIC.len()
            && &bytes[..crate::identify_pack_v2::PACK_V2_MAGIC.len()]
                == crate::identify_pack_v2::PACK_V2_MAGIC
        {
            return Ok(Self::V2(crate::identify_pack_v2::ArtifactPack::parse(
                bytes,
            )?));
        }
        if bytes.len() >= crate::identify_pack_v3::PACK_V3_MAGIC.len()
            && &bytes[..crate::identify_pack_v3::PACK_V3_MAGIC.len()]
                == crate::identify_pack_v3::PACK_V3_MAGIC
        {
            return Ok(Self::V3(crate::identify_pack_v3::ArtifactPack::parse(
                bytes,
            )?));
        }
        if bytes.len() >= crate::identify_pack_v4::PACK_V4_MAGIC.len()
            && &bytes[..crate::identify_pack_v4::PACK_V4_MAGIC.len()]
                == crate::identify_pack_v4::PACK_V4_MAGIC
        {
            return Ok(Self::V4(crate::identify_pack_v4::ArtifactPack::parse(
                bytes,
            )?));
        }
        Err(invalid_pack(
            "pack magic is not a supported version (expected RWFP1, RWFP2, RWFP3, or RWFP4)",
        ))
    }
}

pub(crate) fn invalid_pack(message: impl Into<String>) -> RomWeaverError {
    RomWeaverError::Validation(format!("invalid ROM identify pack: {}", message.into()))
}

pub(crate) fn table_offset(start: usize, index: usize, width: usize) -> Result<usize> {
    index
        .checked_mul(width)
        .and_then(|offset| start.checked_add(offset))
        .ok_or_else(|| invalid_pack("table offset overflow"))
}

fn validate_pair_id(pair_id: u32, pair_count: usize) -> Result<()> {
    if pair_id as usize >= pair_count {
        return Err(invalid_pack(format!("pair id {pair_id} is out of range")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an RWH1 hash map; each entry maps a hash to one-or-more pair ids
    /// (>1 => a conflict). Mirrors the builder's `writeHashMap`.
    fn build_hash_map(
        algorithm: u8,
        hash_bytes: usize,
        mut entries: Vec<(Vec<u8>, Vec<u32>)>,
    ) -> Vec<u8> {
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
        out.extend_from_slice(&[algorithm, 0, hash_bytes as u8, 0]);
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
            ("crc32.bin", build_hash_map(0, 4, crc_entries)),
            ("md5.bin", build_hash_map(1, 16, vec![])),
            ("sha1.bin", build_hash_map(2, 20, vec![])),
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
        let matches = pack
            .resolve(&IdentifyQuery {
                crc32: Some("3fe272fb"),
                ..Default::default()
            })
            .expect("lookup succeeds");
        assert_eq!(matches.algorithm, Some("crc32"));
        let matches = matches.matches;
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
        let matches = pack
            .resolve(&IdentifyQuery {
                crc32: Some("aaaaaaaa"),
                ..Default::default()
            })
            .expect("lookup succeeds");
        let names: Vec<_> = matches.matches.into_iter().map(|m| m.name).collect();
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
            .expect("lookup succeeds")
            .matches
            .is_empty()
        );
    }

    #[test]
    fn rejects_truncated_pack() {
        let mut pack_bytes = pack_with(
            vec![(vec![0x00, 0x00, 0x00, 0x01], vec![0])],
            &[(0, 0)],
            &["Only"],
        );
        pack_bytes.pop();
        let error = SystemPack::parse(&pack_bytes).expect_err("truncated pack must fail");
        assert!(error.to_string().contains("out of bounds"));
    }

    #[test]
    fn rejects_an_out_of_range_pair_id_during_parse() {
        let pack_bytes = pack_with(
            vec![(vec![0x00, 0x00, 0x00, 0x01], vec![1])],
            &[(0, 0)],
            &["Only"],
        );
        let error = SystemPack::parse(&pack_bytes).expect_err("invalid pair id must fail");
        assert!(error.to_string().contains("pair id 1 is out of range"));
    }

    #[test]
    fn rejects_an_impossible_directory_count_before_allocation() {
        let mut pack_bytes = PACK_MAGIC.to_vec();
        pack_bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        let error = SystemPack::parse(&pack_bytes).expect_err("invalid directory count must fail");
        assert!(error.to_string().contains("directory entry count"));
    }
}
