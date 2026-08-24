//! The installed identify database: the per-user pack directory, the platform
//! catalog over it, lazy pack loading, and the `identify database`
//! subcommands (list/status/path/remove/import-hasheous/install/update).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use rom_weaver_checksum::identify_catalog::{IdentifyCatalog, IdentifyPlatformCatalogEntry};
#[cfg(not(target_arch = "wasm32"))]
use rom_weaver_checksum::identify_catalog::{IdentifySource, normalize_platform_name};
use rom_weaver_checksum::identify_pack::IdentifyPackFile;
#[cfg(not(target_arch = "wasm32"))]
use rom_weaver_checksum::identify_pack_v2::{
    ArtifactPack, PackComponent, PackComponentRole, PackGame, UpstreamSource,
};

use super::*;

#[cfg(not(target_arch = "wasm32"))]
const CATALOG_FORMAT: &str = "rom-weaver-identify-catalog-v1";
#[cfg(not(target_arch = "wasm32"))]
const MANIFEST_FORMAT_V2: &str = "rom-weaver-identify-system-pack-v2";
/// Route values >= this flag are conflict-table indices (same scheme as RWFP1).
#[cfg(not(target_arch = "wasm32"))]
const CONFLICT_VALUE_FLAG: u32 = 0x8000_0000;
/// One zip entry of a Hasheous dump: (archive index, entry name, size).
#[cfg(not(target_arch = "wasm32"))]
type DumpEntry = (usize, String, u64);

/// One dump JSON object larger than this is rejected as hostile.
#[cfg(not(target_arch = "wasm32"))]
const MAX_DUMP_ENTRY_BYTES: u64 = 256 * 1024 * 1024;

/// A parsed identify pack of either generation, tagged with its display name.
pub(super) struct LoadedPack {
    pub(super) name: String,
    pub(super) file: IdentifyPackFile,
}

/// The identify database directory: env override, then the platform data dir.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn default_database_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("ROM_WEAVER_DATA_DIR") {
        return Ok(PathBuf::from(dir).join("identify"));
    }
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
            })
    };
    let base = base.ok_or_else(|| {
        RomWeaverError::Validation(
            "cannot resolve the identify database directory: no home directory; pass --database-dir"
                .to_string(),
        )
    })?;
    Ok(base.join("rom-weaver").join("identify"))
}

/// Mirror of `slugifyPlatform` in `scripts/build-hasheous-identify-index.mjs`.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn slugify_platform(platform: &str) -> String {
    let mut out = String::with_capacity(platform.len());
    let mut pending_dash = false;
    for ch in platform.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    out
}

/// Mirror of `KNOWN_PLATFORM_PROFILES`/`DEFAULT_MEDIA_PROFILE` in the builder
/// script: profile hints for known Hasheous platform names.
#[cfg(not(target_arch = "wasm32"))]
fn media_profile_for(platform: &str) -> &'static str {
    match platform {
        "NEC PC-Engine CD & TurboGrafx-16 CD"
        | "Neo Geo CD"
        | "Sega Mega CD _ Sega CD"
        | "Sega Saturn"
        | "Sony PlayStation"
        | "Sony PlayStation 2" => "redump-cd-track-v1",
        "Nintendo 3DS" | "Nintendo New 3DS" => "3ds-decoded-card-v1",
        "Nintendo GameCube" => "gamecube-decoded-iso-v1",
        "Nintendo Wii" => "wii-decoded-iso-v1",
        "Playstation minis" | "Sony Playstation Portable" => "psp-decoded-iso-v1",
        "Sega Dreamcast" => "redump-gdrom-track-v1",
        _ => "nointro-single-image-v1",
    }
}

/// Mirror of `CURATED_ALIASES` in the builder script, for imported platforms.
#[cfg(not(target_arch = "wasm32"))]
fn curated_aliases(platform: &str) -> &'static [&'static str] {
    match platform {
        "Family Computer Disk System" => &["fds", "famicom disk system"],
        "Nintendo 3DS" => &["3ds"],
        "Nintendo DS" => &["nds", "ds"],
        "Nintendo Famicom Disk System" => &["nintendo fds"],
        "Nintendo GameCube" => &["gamecube", "gc", "ngc"],
        "Nintendo Wii" => &["wii"],
        "Sega Dreamcast" => &["dreamcast", "dc"],
        "Sega Saturn" => &["saturn"],
        "Sony PlayStation" => &["playstation", "psx", "ps1"],
        "Sony PlayStation 2" => &["ps2", "playstation 2"],
        "Sony Playstation Portable" => &["psp", "playstation portable"],
        _ => &[],
    }
}

/// Provider over one command invocation's identify databases: the builtin
/// OpenGood packs, plus a database directory of installed packs with an
/// optional `catalog.json`. Packs parse once, lazily, cached by slug.
pub(super) struct IdentifyPackProvider {
    database_dir: PathBuf,
    dir_catalog: Option<IdentifyCatalog>,
    cache: RefCell<HashMap<String, Rc<LoadedPack>>>,
}

impl IdentifyPackProvider {
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn new(database_dir: Option<PathBuf>) -> Result<Self> {
        let database_dir = match database_dir {
            Some(dir) => dir,
            None => default_database_dir()?,
        };
        let catalog_path = database_dir.join("catalog.json");
        let dir_catalog = if catalog_path.is_file() {
            let bytes = fs::read(&catalog_path).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read identify catalog `{}`: {error}",
                    catalog_path.display()
                ))
            })?;
            Some(IdentifyCatalog::parse(&bytes)?)
        } else {
            None
        };
        trace!(
            database_dir = %database_dir.display(),
            has_catalog = dir_catalog.is_some(),
            "identify pack provider initialized"
        );
        Ok(Self {
            database_dir,
            dir_catalog,
            cache: RefCell::new(HashMap::new()),
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn database_dir(&self) -> &Path {
        &self.database_dir
    }

    /// Resolve a platform name or alias: the database dir's catalog first,
    /// then the builtin OpenGood catalog.
    pub(super) fn resolve_entry(&self, name: &str) -> Option<IdentifyPlatformCatalogEntry> {
        if let Some(catalog) = &self.dir_catalog
            && let Some(entry) = catalog.resolve_platform(name)
        {
            return Some(entry.clone());
        }
        IdentifyCatalog::builtin().resolve_platform(name).cloned()
    }

    /// Every catalog entry: the database dir's entries plus builtin entries it
    /// does not override, sorted by canonical platform.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn catalog_entries(&self) -> Vec<IdentifyPlatformCatalogEntry> {
        let mut entries: Vec<IdentifyPlatformCatalogEntry> = self
            .dir_catalog
            .as_ref()
            .map(|catalog| catalog.entries().to_vec())
            .unwrap_or_default();
        for builtin in IdentifyCatalog::builtin().entries() {
            if !entries
                .iter()
                .any(|entry| entry.canonical_platform == builtin.canonical_platform)
            {
                entries.push(builtin.clone());
            }
        }
        entries.sort_by(|a, b| a.canonical_platform.cmp(&b.canonical_platform));
        entries
    }

    fn builtin_pack_bytes(slug: &str) -> Option<&'static [u8]> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let file = format!("{slug}.pack");
            super::identify_builtin::PACKS
                .iter()
                .find(|(name, _)| *name == file)
                .map(|(_, bytes)| *bytes)
        }
        #[cfg(target_arch = "wasm32")]
        {
            let _ = slug;
            None
        }
    }

    /// Whether the slug's pack is available (installed in the dir, or builtin).
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn pack_installed(&self, slug: &str) -> bool {
        self.database_dir.join(format!("{slug}.pack")).is_file()
            || Self::builtin_pack_bytes(slug).is_some()
    }

    /// Load one slug's pack, cached. `Ok(None)` when no such pack exists; a
    /// present pack that fails to parse is an error naming the pack path.
    pub(super) fn pack_for_slug(&self, slug: &str) -> Result<Option<Rc<LoadedPack>>> {
        if let Some(cached) = self.cache.borrow().get(slug) {
            trace!(slug, "identify pack cache hit");
            return Ok(Some(Rc::clone(cached)));
        }
        let path = self.database_dir.join(format!("{slug}.pack"));
        let (name, bytes) = if path.is_file() {
            trace!(slug, path = %path.display(), "identify pack cache miss; loading from database dir");
            let bytes = fs::read(&path).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read ROM identify pack `{}`: {error}",
                    path.display()
                ))
            })?;
            // The dir catalog records each pack's sha256 at import time; a pack
            // that no longer matches it MUST fail loading, not parse silently.
            #[cfg(not(target_arch = "wasm32"))]
            if let Some(catalog) = &self.dir_catalog
                && let Some(expected) = catalog
                    .entries()
                    .iter()
                    .find(|entry| entry.pack_slug == slug)
                    .and_then(|entry| entry.pack_sha256.as_deref())
            {
                let actual = sha256_hex(&bytes);
                if actual != expected {
                    return Err(RomWeaverError::Validation(format!(
                        "ROM identify pack `{}` does not match its catalog sha256 \
                         (expected {expected}, found {actual}); re-import or remove it",
                        path.display()
                    )));
                }
            }
            (format!("{slug}.pack"), bytes)
        } else if let Some(builtin) = Self::builtin_pack_bytes(slug) {
            trace!(slug, "identify pack cache miss; loading builtin pack");
            (format!("{slug}.pack"), builtin.to_vec())
        } else {
            trace!(slug, "identify pack not installed");
            return Ok(None);
        };
        let file = IdentifyPackFile::parse(&bytes).map_err(|error| {
            RomWeaverError::Validation(format!("invalid ROM identify pack `{name}`: {error}"))
        })?;
        let pack = Rc::new(LoadedPack { name, file });
        self.cache
            .borrow_mut()
            .insert(slug.to_string(), Rc::clone(&pack));
        Ok(Some(pack))
    }

    /// Every available pack: each installed `*.pack` in the database dir plus
    /// every builtin pack whose slug the dir does not shadow. Sorted by name.
    pub(super) fn all_packs(&self) -> Result<Vec<Rc<LoadedPack>>> {
        let mut slugs: Vec<String> = Vec::new();
        if self.database_dir.is_dir() {
            for entry in fs::read_dir(&self.database_dir).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read identify database dir `{}`: {error}",
                    self.database_dir.display()
                ))
            })? {
                let entry = entry.map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to read identify database dir `{}`: {error}",
                        self.database_dir.display()
                    ))
                })?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(slug) = name.strip_suffix(".pack") {
                    slugs.push(slug.to_string());
                }
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        for (name, _) in super::identify_builtin::PACKS {
            let slug = name.trim_end_matches(".pack");
            if !slugs.iter().any(|existing| existing == slug) {
                slugs.push(slug.to_string());
            }
        }
        slugs.sort();
        let mut packs = Vec::with_capacity(slugs.len());
        for slug in slugs {
            if let Some(pack) = self.pack_for_slug(&slug)? {
                packs.push(pack);
            }
        }
        Ok(packs)
    }
}

// ---------------------------------------------------------------------------
// RWFP2 pack writing (mirror of the builder script's byte layout)
// ---------------------------------------------------------------------------

#[cfg(not(target_arch = "wasm32"))]
fn write_pack_container(magic: &[u8], members: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(magic);
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

#[cfg(not(target_arch = "wasm32"))]
fn crc_hex_to_bytes(hex: &str) -> Option<[u8; 4]> {
    if hex.len() != 8 {
        return None;
    }
    let mut out = [0u8; 4];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Build `route.bin` (RWR2) and `refs.bin` (RWX2) for a sorted game list.
/// Only discriminating components with a crc32 and size > 0 get routed.
#[cfg(not(target_arch = "wasm32"))]
fn build_route_and_refs(games: &[PackGame]) -> Result<(Vec<u8>, Vec<u8>, usize, usize)> {
    let mut refs: Vec<(u32, u16)> = Vec::new();
    let mut by_key: std::collections::BTreeMap<([u8; 4], u64), Vec<u32>> = Default::default();
    for (game_index, game) in games.iter().enumerate() {
        for (component_index, component) in game.components.iter().enumerate() {
            if component_index > u16::MAX as usize {
                return Err(RomWeaverError::Validation(format!(
                    "game `{}` has too many components for the RWX2 format",
                    game.name
                )));
            }
            if !component.discriminating || component.size == 0 {
                continue;
            }
            let Some(crc32) = component.crc32.as_deref().and_then(crc_hex_to_bytes) else {
                continue;
            };
            let ref_id = refs.len() as u32;
            refs.push((game_index as u32, component_index as u16));
            by_key
                .entry((crc32, component.size))
                .or_default()
                .push(ref_id);
        }
    }

    let mut conflict_offsets = vec![0u32];
    let mut conflict_values: Vec<u32> = Vec::new();
    let mut records = Vec::new();
    for ((crc, size), ids) in &by_key {
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
    let mut route = Vec::new();
    route.extend_from_slice(b"RWR2");
    route.extend_from_slice(&1u16.to_le_bytes());
    route.extend_from_slice(&0u16.to_le_bytes());
    route.extend_from_slice(&(by_key.len() as u32).to_le_bytes());
    route.extend_from_slice(&((conflict_offsets.len() - 1) as u32).to_le_bytes());
    route.extend_from_slice(&(conflict_values.len() as u32).to_le_bytes());
    route.extend_from_slice(&records);
    for offset in &conflict_offsets {
        route.extend_from_slice(&offset.to_le_bytes());
    }
    for value in &conflict_values {
        route.extend_from_slice(&value.to_le_bytes());
    }

    let mut refs_bytes = Vec::new();
    refs_bytes.extend_from_slice(b"RWX2");
    refs_bytes.extend_from_slice(&1u16.to_le_bytes());
    refs_bytes.extend_from_slice(&6u16.to_le_bytes());
    for (game, component) in &refs {
        refs_bytes.extend_from_slice(&game.to_le_bytes());
        refs_bytes.extend_from_slice(&component.to_le_bytes());
    }
    Ok((route, refs_bytes, by_key.len(), refs.len()))
}

/// Mark components byte-identical across more than one game (same size plus
/// the same md5 or the same sha1) as non-discriminating.
#[cfg(not(target_arch = "wasm32"))]
fn mark_shared_components(games: &mut [PackGame]) -> usize {
    let mut owners: HashMap<String, isize> = HashMap::new();
    let keys_of = |component: &PackComponent| -> Vec<String> {
        let mut keys = Vec::new();
        if let Some(md5) = &component.md5 {
            keys.push(format!("{}|m|{md5}", component.size));
        }
        if let Some(sha1) = &component.sha1 {
            keys.push(format!("{}|s|{sha1}", component.size));
        }
        keys
    };
    for (game_index, game) in games.iter().enumerate() {
        for component in &game.components {
            for key in keys_of(component) {
                match owners.get(&key) {
                    None => {
                        owners.insert(key, game_index as isize);
                    }
                    Some(&owner) if owner != game_index as isize => {
                        owners.insert(key, -1);
                    }
                    Some(_) => {}
                }
            }
        }
    }
    let mut shared = 0usize;
    for game in games.iter_mut() {
        for component in game.components.iter_mut() {
            component.discriminating = !keys_of(component)
                .iter()
                .any(|key| owners.get(key) == Some(&-1));
            if !component.discriminating {
                shared += 1;
            }
        }
    }
    shared
}

// ---------------------------------------------------------------------------
// Hasheous dump parsing
// ---------------------------------------------------------------------------

#[cfg(not(target_arch = "wasm32"))]
fn json_string(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn normalize_hex(value: Option<&Value>, expected_len: usize) -> Option<String> {
    let text = value?.as_str()?.trim().to_ascii_lowercase();
    if text.len() == expected_len && text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(text)
    } else {
        None
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn map_upstream_source(value: Option<&Value>) -> Option<UpstreamSource> {
    match value?.as_str()?.to_ascii_lowercase().as_str() {
        "fbneo" => Some(UpstreamSource::Fbneo),
        "mamearcade" => Some(UpstreamSource::Mame),
        "mameredump" | "redump" => Some(UpstreamSource::Redump),
        "nointro" | "nointros" => Some(UpstreamSource::NoIntro),
        "tosec" => Some(UpstreamSource::Tosec),
        _ => None,
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn find_game_attribute<'a>(attributes: &'a [Value], name: &str) -> Option<&'a Value> {
    attributes
        .iter()
        .find(|attribute| attribute.get("attributeName").and_then(Value::as_str) == Some(name))
}

/// Convert one Hasheous dump game object into a grouped `PackGame`, or `None`
/// when the object is not a game with ROMs (mirrors `hasheousGameRecord`).
#[cfg(not(target_arch = "wasm32"))]
fn hasheous_game_record(game: &Value, platform: &str) -> Option<PackGame> {
    let name = json_string(game.get("Name"))?;
    if game.get("ObjectType").and_then(Value::as_str) != Some("Game") {
        return None;
    }
    let attributes = game.get("Attributes")?.as_array()?;
    let roms = find_game_attribute(attributes, "ROMs")?
        .get("Value")?
        .as_array()?;
    if roms.is_empty() {
        return None;
    }

    let mut components = Vec::with_capacity(roms.len());
    let mut upstream_sources: Vec<UpstreamSource> = Vec::new();
    for rom in roms {
        let size = rom.get("Size").and_then(Value::as_u64).unwrap_or(0);
        let component = PackComponent {
            role: PackComponentRole::PrimaryPayload,
            ordinal: components.len() as u32,
            filename: json_string(rom.get("Name")),
            size,
            crc32: normalize_hex(rom.get("Crc"), 8),
            md5: normalize_hex(rom.get("Md5"), 32),
            sha1: normalize_hex(rom.get("Sha1"), 40),
            sha256: normalize_hex(rom.get("Sha256"), 64),
            required: true,
            discriminating: true,
            track: None,
            session: None,
        };
        let source =
            map_upstream_source(rom.get("SignatureSource")).unwrap_or(UpstreamSource::Unknown);
        if !upstream_sources.contains(&source) {
            upstream_sources.push(source);
        }
        components.push(component);
    }
    let upstream_source = if upstream_sources.len() == 1 {
        upstream_sources[0]
    } else {
        UpstreamSource::Unknown
    };
    let game_id = match game.get("Id") {
        Some(Value::String(id)) if !id.is_empty() => Some(id.clone()),
        Some(Value::Number(id)) => Some(id.to_string()),
        _ => None,
    };
    Some(PackGame {
        name,
        platform: platform.to_string(),
        source: IdentifySource::Hasheous,
        upstream_source,
        game_id,
        region: json_string(
            find_game_attribute(attributes, "Country").and_then(|a| a.get("Value")),
        ),
        language: json_string(
            find_game_attribute(attributes, "Language").and_then(|a| a.get("Value")),
        ),
        disc_number: None,
        revision: None,
        parent: None,
        components,
    })
}

/// The RWFP2 reader rejects a whole pack when any record exceeds its caps, so
/// the writer MUST drop an oversized record instead of emitting an unreadable pack.
#[cfg(not(target_arch = "wasm32"))]
fn game_within_pack_caps(game: &PackGame) -> bool {
    const MAX_STRING_BYTES: usize = 4096;
    const MAX_COMPONENTS_PER_GAME: usize = 10_000;
    let string_ok = |value: Option<&str>| value.is_none_or(|value| value.len() <= MAX_STRING_BYTES);
    game.name.len() <= MAX_STRING_BYTES
        && game.platform.len() <= MAX_STRING_BYTES
        && string_ok(game.game_id.as_deref())
        && string_ok(game.region.as_deref())
        && string_ok(game.language.as_deref())
        && game.components.len() <= MAX_COMPONENTS_PER_GAME
        && game
            .components
            .iter()
            .all(|component| string_ok(component.filename.as_deref()))
}

#[cfg(not(target_arch = "wasm32"))]
struct ImportedSystem {
    platform: String,
    slug: String,
    file: String,
    sha256: String,
    games: usize,
    components: usize,
    routed_keys: usize,
    shared_components: usize,
}

/// Write `bytes` to `path` atomically (`.part` + rename).
#[cfg(not(target_arch = "wasm32"))]
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let part = path.with_extension("part");
    fs::write(&part, bytes).map_err(|error| {
        RomWeaverError::Validation(format!("failed to write `{}`: {error}", part.display()))
    })?;
    fs::rename(&part, path).map_err(|error| {
        RomWeaverError::Validation(format!("failed to finalize `{}`: {error}", path.display()))
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn sha256_hex(bytes: &[u8]) -> String {
    let mut stream = rom_weaver_checksum::StreamingChecksum::new(&["sha256".to_string()])
        .ok()
        .flatten()
        .expect("sha256 is a supported algorithm");
    stream.update(bytes).expect("sha256 update never fails");
    stream
        .finalize()
        .expect("sha256 finalize never fails")
        .remove("sha256")
        .expect("sha256 value present")
}

/// Build one platform's RWFP2 pack bytes from its (unsorted) game records.
#[cfg(not(target_arch = "wasm32"))]
fn build_pack_v2(
    platform: &str,
    mut games: Vec<PackGame>,
    provenance: &Value,
) -> Result<(Vec<u8>, usize, usize, usize, usize)> {
    // Deterministic order: (platform, name, gameId, input order); Rust's
    // stable sort keeps the input order for full ties.
    games.sort_by(|a, b| {
        (&a.platform, &a.name, a.game_id.as_deref().unwrap_or("")).cmp(&(
            &b.platform,
            &b.name,
            b.game_id.as_deref().unwrap_or(""),
        ))
    });
    let shared_components = mark_shared_components(&mut games);
    let component_count: usize = games.iter().map(|game| game.components.len()).sum();
    let games_bytes = serde_json::to_vec(&games).map_err(|error| {
        RomWeaverError::Validation(format!("failed to serialize games.json: {error}"))
    })?;
    let (route, refs, routed_keys, _refs_count) = build_route_and_refs(&games)?;
    let manifest = serde_json::to_vec(&json!({
        "format": MANIFEST_FORMAT_V2,
        "platform": platform,
        "source": "hasheous",
        "canonicalizationProfile": media_profile_for(platform),
        "canonicalizationVersion": 1,
        "provenance": provenance,
        "counts": {
            "games": games.len(),
            "components": component_count,
            "routedKeys": routed_keys,
        },
    }))
    .map_err(|error| {
        RomWeaverError::Validation(format!("failed to serialize manifest.json: {error}"))
    })?;
    let game_count = games.len();
    let pack = write_pack_container(
        b"RWFP2\0\0\0",
        &[
            ("games.json", games_bytes),
            ("route.bin", route),
            ("refs.bin", refs),
            ("manifest.json", manifest),
        ],
    );
    // Self-check: a pack this build cannot read back is a bug, not data.
    ArtifactPack::parse(&pack).map_err(|error| {
        RomWeaverError::Validation(format!(
            "internal error: built pack for `{platform}` does not parse: {error}"
        ))
    })?;
    Ok((
        pack,
        game_count,
        component_count,
        routed_keys,
        shared_components,
    ))
}

/// Import Hasheous platforms from a local MetadataMap.zip: one RWFP2 pack per
/// non-OpenGood top-level platform directory, plus a merged catalog.json.
/// `only` limits the import to those canonical platform names.
#[cfg(not(target_arch = "wasm32"))]
fn import_hasheous_dump(
    dump: &Path,
    database_dir: &Path,
    only: Option<&[String]>,
) -> Result<(Vec<ImportedSystem>, Vec<String>, usize)> {
    if !dump.is_file() {
        return Err(RomWeaverError::Validation(format!(
            "Hasheous dump `{}` is not a file",
            dump.display()
        )));
    }
    fs::create_dir_all(database_dir).map_err(|error| {
        RomWeaverError::Validation(format!(
            "failed to create identify database dir `{}`: {error}",
            database_dir.display()
        ))
    })?;
    let entries = list_regular_archive_file_entries(dump, "zip")?;
    // Group JSON entries by top-level platform directory, keeping zip order.
    let mut platforms: Vec<(String, Vec<DumpEntry>)> = Vec::new();
    for entry in &entries {
        let Some((platform, rest)) = entry.name.split_once('/') else {
            continue;
        };
        if platform.is_empty() || rest.is_empty() || !rest.ends_with(".json") {
            continue;
        }
        let size = entry.size.unwrap_or(0);
        if size > MAX_DUMP_ENTRY_BYTES {
            return Err(RomWeaverError::Validation(format!(
                "dump entry `{}` is larger than the {MAX_DUMP_ENTRY_BYTES}-byte cap",
                entry.name
            )));
        }
        match platforms.iter_mut().find(|(name, _)| name == platform) {
            Some((_, list)) => list.push((entry.index, entry.name.clone(), size)),
            None => platforms.push((
                platform.to_string(),
                vec![(entry.index, entry.name.clone(), size)],
            )),
        }
    }
    platforms.sort_by(|a, b| a.0.cmp(&b.0));

    let opengood: HashSet<String> = IdentifyCatalog::builtin()
        .entries()
        .iter()
        .map(|entry| entry.canonical_platform.clone())
        .collect();
    let dump_name = dump
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| dump.to_string_lossy().into_owned());
    let dump_len = fs::metadata(dump).map(|meta| meta.len()).unwrap_or(0);
    let provenance = json!({
        "hasheousDump": { "fileName": dump_name, "sizeBytes": dump_len },
    });

    let mut imported = Vec::new();
    let mut skipped_opengood = Vec::new();
    let mut skipped_over_caps = 0usize;
    let mut selected: Vec<&(String, Vec<DumpEntry>)> = Vec::new();
    for entry in &platforms {
        let platform = &entry.0;
        if opengood.contains(platform) {
            debug!(
                platform,
                "skipping OpenGood-covered platform; it stays built-in"
            );
            skipped_opengood.push(platform.clone());
            continue;
        }
        if let Some(only) = only
            && !only.iter().any(|name| name == platform)
        {
            continue;
        }
        selected.push(entry);
    }
    // Slugs MUST be validated before any pack is written: an empty or colliding
    // slug would otherwise overwrite another platform's pack mid-import.
    let mut slugs: HashMap<String, &str> = HashMap::new();
    for (platform, _) in selected.iter().copied() {
        let slug = slugify_platform(platform);
        if slug.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "dump platform `{platform}` produces an empty pack slug"
            )));
        }
        if let Some(existing) = slugs.insert(slug.clone(), platform) {
            return Err(RomWeaverError::Validation(format!(
                "dump platforms `{existing}` and `{platform}` collide on pack slug `{slug}`"
            )));
        }
    }
    for (platform, files) in selected {
        trace!(
            platform,
            entries = files.len(),
            "importing Hasheous platform"
        );
        // One platform at a time: only this platform's game records are in
        // memory while its pack is built.
        let mut games = Vec::new();
        for (index, name, _) in files {
            // The declared entry size is attacker-controlled zip metadata, so the
            // decompressed stream itself MUST be capped, not just the header value.
            let value: Value = with_regular_archive_file_entry_reader(
                dump,
                "zip",
                *index,
                name,
                |reader| {
                    let mut capped = std::io::Read::take(reader, MAX_DUMP_ENTRY_BYTES + 1);
                    let value: Value = serde_json::from_reader(&mut capped).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "dump entry `{name}` is not valid JSON: {error}"
                        ))
                    })?;
                    if capped.limit() == 0 {
                        return Err(RomWeaverError::Validation(format!(
                            "dump entry `{name}` decompresses past the {MAX_DUMP_ENTRY_BYTES}-byte cap"
                        )));
                    }
                    Ok(value)
                },
            )?;
            if let Some(game) = hasheous_game_record(&value, platform) {
                if !game_within_pack_caps(&game) {
                    warn!(
                        platform,
                        game = %game.name.chars().take(80).collect::<String>(),
                        "skipping game record that exceeds RWFP2 pack caps"
                    );
                    skipped_over_caps += 1;
                    continue;
                }
                if games.len() >= 4_000_000 {
                    warn!(
                        platform,
                        "platform exceeds the 4,000,000-game pack cap; skipping the rest"
                    );
                    skipped_over_caps += 1;
                    continue;
                }
                games.push(game);
            }
        }
        if games.is_empty() {
            debug!(platform, "no game records; skipping platform");
            continue;
        }
        let (pack, game_count, component_count, routed_keys, shared_components) =
            build_pack_v2(platform, games, &provenance)?;
        let slug = slugify_platform(platform);
        let file = format!("{slug}.pack");
        let path = database_dir.join(&file);
        write_atomic(&path, &pack)?;
        let sha256 = sha256_hex(&pack);
        imported.push(ImportedSystem {
            platform: platform.clone(),
            slug,
            file,
            sha256,
            games: game_count,
            components: component_count,
            routed_keys,
            shared_components,
        });
    }
    if let Some(only) = only {
        for requested in only {
            if !imported.iter().any(|system| &system.platform == requested) {
                return Err(RomWeaverError::Validation(format!(
                    "platform `{requested}` was not found in the dump (or is OpenGood-covered and stays built-in)"
                )));
            }
        }
    }
    if !imported.is_empty() {
        write_merged_catalog(database_dir, &imported, &provenance)?;
    }
    Ok((imported, skipped_opengood, skipped_over_caps))
}

/// Merge the imported platforms into the database dir's catalog.json,
/// keeping entries for platforms this import did not touch.
#[cfg(not(target_arch = "wasm32"))]
fn write_merged_catalog(
    database_dir: &Path,
    imported: &[ImportedSystem],
    provenance: &Value,
) -> Result<()> {
    let catalog_path = database_dir.join("catalog.json");
    let mut entries: Vec<IdentifyPlatformCatalogEntry> = if catalog_path.is_file() {
        let bytes = fs::read(&catalog_path).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to read identify catalog `{}`: {error}",
                catalog_path.display()
            ))
        })?;
        IdentifyCatalog::parse(&bytes)?.entries().to_vec()
    } else {
        Vec::new()
    };
    entries.retain(|entry| {
        !imported
            .iter()
            .any(|system| system.platform == entry.canonical_platform)
    });
    for system in imported {
        let mut aliases: Vec<String> = vec![normalize_platform_name(&system.platform)];
        for alias in curated_aliases(&system.platform) {
            let normalized = normalize_platform_name(alias);
            if !aliases.contains(&normalized) {
                aliases.push(normalized);
            }
        }
        aliases.sort();
        entries.push(IdentifyPlatformCatalogEntry {
            canonical_platform: system.platform.clone(),
            aliases,
            source: IdentifySource::Hasheous,
            media_profiles: vec![media_profile_for(&system.platform).to_string()],
            pack_slug: system.slug.clone(),
            pack_format: "RWFP2".to_string(),
            pack_sha256: Some(system.sha256.clone()),
            canonicalization_version: 1,
        });
    }
    entries.sort_by(|a, b| a.canonical_platform.cmp(&b.canonical_platform));
    let bytes = serde_json::to_vec_pretty(&json!({
        "format": CATALOG_FORMAT,
        "generated": provenance,
        "platforms": entries,
    }))
    .map_err(|error| {
        RomWeaverError::Validation(format!("failed to serialize catalog.json: {error}"))
    })?;
    // Self-check the merged catalog before it replaces the previous one.
    IdentifyCatalog::parse(&bytes)?;
    write_atomic(&catalog_path, &bytes)
}

// ---------------------------------------------------------------------------
// Subcommand runners
// ---------------------------------------------------------------------------

impl CliApp {
    pub(super) fn run_identify_database(&self, command: IdentifyDatabaseCommands) -> AppRunOutcome {
        #[cfg(target_arch = "wasm32")]
        {
            let _ = command;
            return self.finish(
                "identify",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "identify-database",
                    "identify database commands are not supported in the browser build",
                    None,
                ),
            );
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let report = self
                .run_identify_database_inner(command)
                .unwrap_or_else(|error| {
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("identify-database".to_string()),
                        "identify-database",
                        error.to_string(),
                        None,
                    )
                });
            self.finish("identify", report)
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn run_identify_database_inner(
        &self,
        command: IdentifyDatabaseCommands,
    ) -> Result<OperationReport> {
        match command {
            IdentifyDatabaseCommands::List(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let entries: Vec<Value> = provider
                    .catalog_entries()
                    .iter()
                    .map(|entry| {
                        json!({
                            "platform": entry.canonical_platform,
                            "source": entry.source,
                            "installed": provider.pack_installed(&entry.pack_slug),
                            "pack_format": entry.pack_format,
                            "pack_slug": entry.pack_slug,
                        })
                    })
                    .collect();
                let installed = entries
                    .iter()
                    .filter(|entry| entry["installed"] == json!(true))
                    .count();
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "list",
                    format!("{} platform(s), {installed} installed", entries.len()),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({
                    "database_dir": provider.database_dir().to_string_lossy(),
                    "platforms": entries,
                }));
                Ok(report)
            }
            IdentifyDatabaseCommands::Status(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let mut packs = Vec::new();
                let dir = provider.database_dir();
                if dir.is_dir() {
                    let mut names: Vec<String> = fs::read_dir(dir)
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "failed to read identify database dir `{}`: {error}",
                                dir.display()
                            ))
                        })?
                        .filter_map(|entry| entry.ok())
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .filter(|name| name.ends_with(".pack"))
                        .collect();
                    names.sort();
                    for name in names {
                        let path = dir.join(&name);
                        let bytes = fs::read(&path).map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "failed to read ROM identify pack `{}`: {error}",
                                path.display()
                            ))
                        })?;
                        let format = match IdentifyPackFile::parse(&bytes) {
                            Ok(IdentifyPackFile::V1(_)) => "RWFP1",
                            Ok(IdentifyPackFile::V2(_)) => "RWFP2",
                            Err(_) => "invalid",
                        };
                        packs.push(json!({
                            "slug": name.trim_end_matches(".pack"),
                            "format": format,
                            "bytes": bytes.len(),
                            "sha256": sha256_hex(&bytes),
                        }));
                    }
                }
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "status",
                    format!("{} installed pack(s)", packs.len()),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({
                    "database_dir": dir.to_string_lossy(),
                    "packs": packs,
                }));
                Ok(report)
            }
            IdentifyDatabaseCommands::Path(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let dir = provider.database_dir().to_string_lossy().into_owned();
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "path",
                    dir.clone(),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({ "database_dir": dir }));
                Ok(report)
            }
            IdentifyDatabaseCommands::Remove(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let entry = provider.resolve_entry(&args.system).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "unknown system `{}`; run `rom-weaver identify database list` for the catalog",
                        args.system
                    ))
                })?;
                let path = provider
                    .database_dir()
                    .join(format!("{}.pack", entry.pack_slug));
                if !path.is_file() {
                    return Err(RomWeaverError::Validation(format!(
                        "no installed pack for `{}` at `{}`",
                        entry.canonical_platform,
                        path.display()
                    )));
                }
                fs::remove_file(&path).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to remove `{}`: {error}",
                        path.display()
                    ))
                })?;
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "remove",
                    format!("removed the {} pack", entry.canonical_platform),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({
                    "platform": entry.canonical_platform,
                    "removed": path.to_string_lossy(),
                }));
                Ok(report)
            }
            IdentifyDatabaseCommands::ImportHasheous(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let (imported, skipped, over_caps) =
                    import_hasheous_dump(&args.input, provider.database_dir(), None)?;
                Ok(import_report(
                    provider.database_dir(),
                    &imported,
                    &skipped,
                    over_caps,
                ))
            }
            IdentifyDatabaseCommands::Install(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let Some(from) = args.from else {
                    return Err(network_install_unavailable_error());
                };
                if args.all {
                    let (imported, skipped, over_caps) =
                        import_hasheous_dump(&from, provider.database_dir(), None)?;
                    return Ok(import_report(
                        provider.database_dir(),
                        &imported,
                        &skipped,
                        over_caps,
                    ));
                }
                let Some(system) = args.system else {
                    return Err(RomWeaverError::Validation(
                        "pass a system name or --all to `identify database install`".to_string(),
                    ));
                };
                let platform = resolve_install_platform(&provider, &system)?;
                let (imported, skipped, over_caps) =
                    import_hasheous_dump(&from, provider.database_dir(), Some(&[platform]))?;
                Ok(import_report(
                    provider.database_dir(),
                    &imported,
                    &skipped,
                    over_caps,
                ))
            }
            IdentifyDatabaseCommands::Update(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let Some(from) = args.from else {
                    return Err(network_install_unavailable_error());
                };
                let only = match args.system {
                    Some(system) => Some(vec![resolve_install_platform(&provider, &system)?]),
                    None => None,
                };
                let (imported, skipped, over_caps) =
                    import_hasheous_dump(&from, provider.database_dir(), only.as_deref())?;
                Ok(import_report(
                    provider.database_dir(),
                    &imported,
                    &skipped,
                    over_caps,
                ))
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn network_install_unavailable_error() -> RomWeaverError {
    RomWeaverError::Validation(
        "network download is not yet enabled; pass --from <MetadataMap.zip> with a locally \
         downloaded Hasheous dump, or run `identify database import-hasheous <MetadataMap.zip>`"
            .to_string(),
    )
}

/// Resolve an install/update target to its canonical Hasheous platform name.
/// A name the catalog does not know passes through verbatim so a fresh dump
/// directory can be installed before any catalog exists for it.
#[cfg(not(target_arch = "wasm32"))]
fn resolve_install_platform(provider: &IdentifyPackProvider, system: &str) -> Result<String> {
    if let Some(entry) = provider.resolve_entry(system) {
        if entry.source == IdentifySource::OpenGood {
            return Err(RomWeaverError::Validation(format!(
                "`{}` is an OpenGood platform; its pack is built in and never installed from Hasheous",
                entry.canonical_platform
            )));
        }
        return Ok(entry.canonical_platform);
    }
    Ok(system.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
fn import_report(
    database_dir: &Path,
    imported: &[ImportedSystem],
    skipped_opengood: &[String],
    skipped_over_caps: usize,
) -> OperationReport {
    let systems: Vec<Value> = imported
        .iter()
        .map(|system| {
            json!({
                "platform": system.platform,
                "slug": system.slug,
                "file": system.file,
                "sha256": system.sha256,
                "games": system.games,
                "components": system.components,
                "routed_keys": system.routed_keys,
                "shared_components": system.shared_components,
            })
        })
        .collect();
    let mut report = OperationReport::succeeded(
        OperationFamily::Command,
        Some("identify-database".to_string()),
        "import",
        format!(
            "imported {} platform pack(s); {} OpenGood platform(s) stay built-in",
            imported.len(),
            skipped_opengood.len()
        ),
        Some(100.0),
        None,
    );
    report.details = Some(json!({
        "database_dir": database_dir.to_string_lossy(),
        "imported": systems,
        "skipped_opengood": skipped_opengood,
        "skipped_over_caps": skipped_over_caps,
    }));
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_matches_the_builder_script() {
        assert_eq!(
            slugify_platform("Sega Mega Drive _ Genesis"),
            "sega-mega-drive-genesis"
        );
        assert_eq!(
            slugify_platform("TurboGrafx-16_PC Engine"),
            "turbografx-16-pc-engine"
        );
        assert_eq!(slugify_platform("Sony PlayStation"), "sony-playstation");
    }

    #[test]
    fn shared_components_are_marked_non_discriminating() {
        let component = |md5: &str| PackComponent {
            role: PackComponentRole::PrimaryPayload,
            ordinal: 0,
            filename: None,
            size: 10,
            crc32: Some("aabbccdd".to_string()),
            md5: Some(md5.to_string()),
            sha1: None,
            sha256: None,
            required: true,
            discriminating: true,
            track: None,
            session: None,
        };
        let game = |name: &str, md5: &str| PackGame {
            name: name.to_string(),
            platform: "P".to_string(),
            source: IdentifySource::Hasheous,
            upstream_source: UpstreamSource::Unknown,
            game_id: None,
            region: None,
            language: None,
            disc_number: None,
            revision: None,
            parent: None,
            components: vec![component(md5)],
        };
        let shared_md5 = "d41d8cd98f00b204e9800998ecf8427e";
        let mut games = vec![
            game("A", shared_md5),
            game("B", shared_md5),
            game("C", "00000000000000000000000000000001"),
        ];
        let shared = mark_shared_components(&mut games);
        assert_eq!(shared, 2);
        assert!(!games[0].components[0].discriminating);
        assert!(!games[1].components[0].discriminating);
        assert!(games[2].components[0].discriminating);
    }
}
