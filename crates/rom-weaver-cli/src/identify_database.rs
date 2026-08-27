//! The installed identify database: the per-user pack directory, the platform
//! catalog over it, lazy pack loading, and the `identify database`
//! subcommands (list/status/path/remove/import-redump/install/update).

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
/// One XML entry in a Redump DAT ZIP: (archive index, entry name, size).
#[cfg(not(target_arch = "wasm32"))]
type DumpEntry = (usize, String, u64);

/// One dump JSON object larger than this is rejected as hostile.
#[cfg(not(target_arch = "wasm32"))]
const MAX_DUMP_ENTRY_BYTES: u64 = 256 * 1024 * 1024;

#[cfg(not(target_arch = "wasm32"))]
const REDUMP_SYSTEMS: &[(&str, &str)] = &[
    ("Acorn Archimedes", "arch"),
    ("Apple Macintosh", "mac"),
    ("Atari Jaguar CD Interactive Multimedia System", "ajcd"),
    ("Bandai Pippin", "pippin"),
    ("Bandai Playdia Quick Interactive System", "qis"),
    ("Commodore Amiga CD", "acd"),
    ("Commodore Amiga CD32", "cd32"),
    ("Commodore Amiga CDTV", "cdtv"),
    ("Fujitsu FM Towns series", "fmt"),
    ("funworld Photo Play", "fpp"),
    ("IBM PC compatible", "pc"),
    ("Incredible Technologies Eagle", "ite"),
    ("Konami e-Amusement", "kea"),
    ("Konami FireBeat", "kfb"),
    ("Konami System 573", "ks573"),
    ("Konami System GV", "ksgv"),
    ("Mattel Fisher-Price iXL", "ixl"),
    ("Mattel HyperScan", "hs"),
    ("Memorex Visual Information System", "vis"),
    ("Microsoft Xbox", "xbox"),
    ("Microsoft Xbox 360", "xbox360"),
    ("Namco - Sega - Nintendo Triforce", "trf"),
    ("Namco System 246", "ns246"),
    ("NEC PC Engine CD & TurboGrafx CD", "pce"),
    ("NEC PC-88 series", "pc-88"),
    ("NEC PC-98 series", "pc-98"),
    ("NEC PC-FX & PC-FXGA", "pc-fx"),
    ("Neo Geo CD", "ngcd"),
    ("Nintendo GameCube", "gc"),
    ("Nintendo Wii", "wii"),
    ("Palm OS", "palm"),
    ("Panasonic 3DO Interactive Multiplayer", "3do"),
    ("Philips CD-i", "cdi"),
    ("Photo CD", "photo-cd"),
    ("PlayStation GameShark Updates", "psxgs"),
    ("Pocket PC", "ppc"),
    ("Sega Chihiro", "chihiro"),
    ("Sega Dreamcast", "dc"),
    ("Sega Lindbergh", "lindbergh"),
    ("Sega Mega CD & Sega CD", "mcd"),
    ("Sega Naomi", "naomi"),
    ("Sega Naomi 2", "naomi2"),
    ("Sega Prologue 21 Multimedia Karaoke System", "sp21"),
    ("Sega RingEdge", "sre"),
    ("Sega RingEdge 2", "sre2"),
    ("Sega Saturn", "ss"),
    ("Sharp X68000", "x68k"),
    ("Sony PlayStation", "psx"),
    ("Sony PlayStation 2", "ps2"),
    ("Sony PlayStation 3", "ps3"),
    ("Sony PlayStation Portable", "psp"),
    ("TAB-Austria Quizard", "quizard"),
    ("Tomy Kiss-Site", "ksite"),
    ("VM Labs NUON", "nuon"),
    ("VTech V.Flash & V.Smile Pro", "vflash"),
    (
        "ZAPiT Games Game Wave Family Entertainment System",
        "gamewave",
    ),
];

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

/// Convert a platform name to its stable pack file slug.
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

/// Select the canonical byte profile for known platform names.
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
        _ if redump_endpoint(platform).is_some() => "redump-cd-track-v1",
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

    /// Whether the slug's pack is available (installed in the dir, or builtin).
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn pack_installed(&self, slug: &str) -> bool {
        self.database_dir.join(format!("{slug}.pack")).is_file()
            || super::identify_builtin::pack_path(&self.database_dir, slug).is_some()
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
        } else if let Some(packaged) = super::identify_builtin::pack_path(&self.database_dir, slug)
        {
            trace!(slug, path = %packaged.display(), "identify pack cache miss; decompressing packaged pack");
            (
                format!("{slug}.pack"),
                super::identify_builtin::decompress(&packaged)?,
            )
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
        for slug in super::identify_builtin::pack_slugs(&self.database_dir)? {
            if !slugs.iter().any(|existing| existing == &slug) {
                slugs.push(slug);
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
// Redump DAT parsing
// ---------------------------------------------------------------------------

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, serde::Deserialize)]
struct RedumpDatafile {
    header: RedumpHeader,
    #[serde(default, rename = "game", alias = "machine")]
    games: Vec<RedumpGame>,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, serde::Deserialize)]
struct RedumpHeader {
    name: String,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, serde::Deserialize)]
struct RedumpGame {
    #[serde(rename = "@name")]
    name: String,
    #[serde(default, rename = "rom")]
    roms: Vec<RedumpRom>,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, serde::Deserialize)]
struct RedumpRom {
    #[serde(rename = "@name")]
    name: Option<String>,
    #[serde(rename = "@size")]
    size: u64,
    #[serde(rename = "@crc")]
    crc32: Option<String>,
    #[serde(rename = "@md5")]
    md5: Option<String>,
    #[serde(rename = "@sha1")]
    sha1: Option<String>,
}

#[cfg(not(target_arch = "wasm32"))]
fn normalize_hash(value: Option<String>, expected_len: usize) -> Option<String> {
    let value = value?.trim().to_ascii_lowercase();
    (value.len() == expected_len && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(value)
}

#[cfg(not(target_arch = "wasm32"))]
fn redump_game_record(game: RedumpGame, platform: &str) -> Option<PackGame> {
    if game.name.trim().is_empty() || game.roms.is_empty() {
        return None;
    }
    let components = game
        .roms
        .into_iter()
        .enumerate()
        .map(|(ordinal, rom)| PackComponent {
            role: PackComponentRole::PrimaryPayload,
            ordinal: ordinal as u32,
            hash_scope: "full_file".to_string(),
            filename: rom.name.filter(|name| !name.trim().is_empty()),
            size: rom.size,
            crc32: normalize_hash(rom.crc32, 8),
            md5: normalize_hash(rom.md5, 32),
            sha1: normalize_hash(rom.sha1, 40),
            sha256: None,
            required: true,
            discriminating: true,
            track: Some((ordinal + 1) as u32),
            session: None,
        })
        .collect();
    Some(PackGame {
        name: game.name,
        platform: platform.to_string(),
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
        components,
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn canonical_redump_platform(name: &str) -> Option<&'static str> {
    let normalized = normalize_platform_name(name);
    REDUMP_SYSTEMS
        .iter()
        .find(|(canonical, _)| normalize_platform_name(canonical) == normalized)
        .map(|(canonical, _)| *canonical)
}

#[cfg(not(target_arch = "wasm32"))]
fn redump_endpoint(platform: &str) -> Option<&'static str> {
    REDUMP_SYSTEMS
        .iter()
        .find(|(canonical, _)| *canonical == platform)
        .map(|(_, endpoint)| *endpoint)
}

#[cfg(not(target_arch = "wasm32"))]
fn download_redump_dat(platform: &str, database_dir: &Path) -> Result<PathBuf> {
    use std::io::Read;
    let endpoint = redump_endpoint(platform).ok_or_else(|| {
        RomWeaverError::Validation(format!("Redump has no DAT download for `{platform}`"))
    })?;
    fs::create_dir_all(database_dir)?;
    let url = format!("http://redump.org/datfile/{endpoint}/");
    trace!(platform, url, "downloading Redump DAT");
    let mut response = ureq::get(&url).call().map_err(|error| {
        RomWeaverError::Validation(format!(
            "Redump DAT download failed for `{platform}`: {error}"
        ))
    })?;
    let mut reader = response
        .body_mut()
        .with_config()
        .limit(MAX_DUMP_ENTRY_BYTES * 2)
        .reader();
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(|error| {
        RomWeaverError::Validation(format!(
            "Redump DAT download failed for `{platform}`: {error}"
        ))
    })?;
    let path = database_dir.join(format!(".{endpoint}-redump-dat.zip"));
    write_atomic(&path, &bytes)?;
    Ok(path)
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
        "source": "redump",
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

/// Import each Redump XML DAT in a ZIP as one RWFP2 system pack.
#[cfg(not(target_arch = "wasm32"))]
fn import_redump_dat(
    dump: &Path,
    database_dir: &Path,
    only_platform: Option<&str>,
) -> Result<(Vec<ImportedSystem>, Vec<String>, usize)> {
    if !dump.is_file() {
        return Err(RomWeaverError::Validation(format!(
            "Redump DAT ZIP `{}` is not a file",
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
    let mut dat_entries: Vec<DumpEntry> = Vec::new();
    for entry in &entries {
        if !entry.name.to_ascii_lowercase().ends_with(".dat")
            && !entry.name.to_ascii_lowercase().ends_with(".xml")
        {
            continue;
        }
        let size = entry.size.unwrap_or(0);
        if size > MAX_DUMP_ENTRY_BYTES {
            return Err(RomWeaverError::Validation(format!(
                "dump entry `{}` is larger than the {MAX_DUMP_ENTRY_BYTES}-byte cap",
                entry.name
            )));
        }
        dat_entries.push((entry.index, entry.name.clone(), size));
    }
    if dat_entries.is_empty() {
        return Err(RomWeaverError::Validation(
            "Redump DAT ZIP contains no .dat or .xml file".to_string(),
        ));
    }
    let dump_name = dump
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| dump.to_string_lossy().into_owned());
    let dump_len = fs::metadata(dump).map(|meta| meta.len()).unwrap_or(0);
    let provenance = json!({
        "redumpDat": { "fileName": dump_name, "sizeBytes": dump_len },
    });

    let mut imported = Vec::new();
    let mut skipped_over_caps = 0usize;
    for (index, name, _) in dat_entries {
        let datafile: RedumpDatafile =
            with_regular_archive_file_entry_reader(dump, "zip", index, &name, |reader| {
                let capped = std::io::Read::take(reader, MAX_DUMP_ENTRY_BYTES + 1);
                quick_xml::de::from_reader(std::io::BufReader::new(capped)).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "Redump DAT entry `{name}` is not valid XML: {error}"
                    ))
                })
            })?;
        let platform = canonical_redump_platform(&datafile.header.name)
            .unwrap_or(datafile.header.name.trim())
            .to_string();
        if only_platform.is_some_and(|only| only != platform) {
            continue;
        }
        let mut games = Vec::new();
        for game in datafile.games {
            let Some(game) = redump_game_record(game, &platform) else {
                continue;
            };
            if !game_within_pack_caps(&game) {
                skipped_over_caps += 1;
                continue;
            }
            games.push(game);
        }
        if games.is_empty() {
            debug!(platform, "Redump DAT has no game records; skipping it");
            continue;
        }
        let (pack, game_count, component_count, routed_keys, shared_components) =
            build_pack_v2(&platform, games, &provenance)?;
        let slug = slugify_platform(&platform);
        let file = format!("{slug}.pack");
        let path = database_dir.join(&file);
        write_atomic(&path, &pack)?;
        let sha256 = sha256_hex(&pack);
        imported.push(ImportedSystem {
            platform,
            slug,
            file,
            sha256,
            games: game_count,
            components: component_count,
            routed_keys,
            shared_components,
        });
    }
    if !imported.is_empty() {
        write_merged_catalog(database_dir, &imported, &provenance)?;
    } else if let Some(platform) = only_platform {
        return Err(RomWeaverError::Validation(format!(
            "Redump DAT ZIP does not contain the `{platform}` system"
        )));
    }
    Ok((imported, Vec::new(), skipped_over_caps))
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
            source: IdentifySource::Redump,
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
                            Ok(IdentifyPackFile::V3(_)) => "RWFP3",
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
            IdentifyDatabaseCommands::ImportRedump(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let (imported, skipped, over_caps) =
                    import_redump_dat(&args.input, provider.database_dir(), None)?;
                Ok(import_report(
                    provider.database_dir(),
                    &imported,
                    &skipped,
                    over_caps,
                ))
            }
            IdentifyDatabaseCommands::InstallAll(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let count = super::identify_builtin::install_all(provider.database_dir())?;
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "install-all",
                    format!("installed {count} identify pack(s)"),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({
                    "database_dir": provider.database_dir().to_string_lossy(),
                    "packs": count,
                    "version": env!("CARGO_PKG_VERSION"),
                }));
                Ok(report)
            }
            IdentifyDatabaseCommands::InstallGroup(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let count = super::identify_builtin::install_group(
                    provider.database_dir(),
                    &args.group,
                    args.from.as_deref(),
                )?;
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "install-group",
                    format!(
                        "installed {count} identify pack(s) from group `{}`",
                        args.group
                    ),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({
                    "database_dir": provider.database_dir().to_string_lossy(),
                    "group": args.group,
                    "packs": count,
                    "version": env!("CARGO_PKG_VERSION"),
                }));
                Ok(report)
            }
            IdentifyDatabaseCommands::Install(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                if let Some(from) = args.from {
                    let only_platform = if args.all {
                        None
                    } else if let Some(system) = args.system.as_deref() {
                        Some(resolve_install_platform(&provider, system)?)
                    } else {
                        return Err(RomWeaverError::Validation(
                            "pass a system name or --all to `identify database install`"
                                .to_string(),
                        ));
                    };
                    let (imported, skipped, over_caps) = import_redump_dat(
                        &from,
                        provider.database_dir(),
                        only_platform.as_deref(),
                    )?;
                    return Ok(import_report(
                        provider.database_dir(),
                        &imported,
                        &skipped,
                        over_caps,
                    ));
                }
                let platforms: Vec<String> = if args.all {
                    REDUMP_SYSTEMS
                        .iter()
                        .map(|(name, _)| (*name).to_string())
                        .collect()
                } else if let Some(system) = args.system {
                    vec![resolve_install_platform(&provider, &system)?]
                } else {
                    return Err(RomWeaverError::Validation(
                        "pass a system name or --all to `identify database install`".to_string(),
                    ));
                };
                let (imported, skipped, over_caps) =
                    download_and_import_redump(&platforms, provider.database_dir())?;
                Ok(import_report(
                    provider.database_dir(),
                    &imported,
                    &skipped,
                    over_caps,
                ))
            }
            IdentifyDatabaseCommands::Update(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                if let Some(from) = args.from {
                    let only_platform = args
                        .system
                        .as_deref()
                        .map(|system| resolve_install_platform(&provider, system))
                        .transpose()?;
                    let (imported, skipped, over_caps) = import_redump_dat(
                        &from,
                        provider.database_dir(),
                        only_platform.as_deref(),
                    )?;
                    return Ok(import_report(
                        provider.database_dir(),
                        &imported,
                        &skipped,
                        over_caps,
                    ));
                }
                let platforms = match args.system {
                    Some(system) => vec![resolve_install_platform(&provider, &system)?],
                    None => provider
                        .catalog_entries()
                        .into_iter()
                        .filter(|entry| {
                            entry.source == IdentifySource::Redump
                                && provider.pack_installed(&entry.pack_slug)
                        })
                        .map(|entry| entry.canonical_platform)
                        .collect(),
                };
                if platforms.is_empty() {
                    return Err(RomWeaverError::Validation(
                        "no installed Redump packs to update".to_string(),
                    ));
                }
                let (imported, skipped, over_caps) =
                    download_and_import_redump(&platforms, provider.database_dir())?;
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

/// Resolve an install or update target to a downloadable Redump platform.
#[cfg(not(target_arch = "wasm32"))]
fn resolve_install_platform(provider: &IdentifyPackProvider, system: &str) -> Result<String> {
    if let Some(platform) = canonical_redump_platform(system) {
        return Ok(platform.to_string());
    }
    if let Some(entry) = provider.resolve_entry(system) {
        if entry.source == IdentifySource::OpenGood {
            return Err(RomWeaverError::Validation(format!(
                "`{}` is an OpenGood platform; its pack is built in and never installed from Redump",
                entry.canonical_platform
            )));
        }
        return Ok(entry.canonical_platform);
    }
    Err(RomWeaverError::Validation(format!(
        "unknown Redump system `{system}`; run `rom-weaver identify database list`"
    )))
}

#[cfg(not(target_arch = "wasm32"))]
fn download_and_import_redump(
    platforms: &[String],
    database_dir: &Path,
) -> Result<(Vec<ImportedSystem>, Vec<String>, usize)> {
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    let mut over_caps = 0;
    for platform in platforms {
        let path = download_redump_dat(platform, database_dir)?;
        let result = import_redump_dat(&path, database_dir, Some(platform));
        let _ = fs::remove_file(&path);
        let (mut next, mut next_skipped, next_over_caps) = result?;
        if !next.iter().any(|system| system.platform == *platform) {
            return Err(RomWeaverError::Validation(format!(
                "Redump DAT for `{platform}` reported a different system"
            )));
        }
        imported.append(&mut next);
        skipped.append(&mut next_skipped);
        over_caps += next_over_caps;
    }
    Ok((imported, skipped, over_caps))
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
            hash_scope: "full_file".to_string(),
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
            source: IdentifySource::Redump,
            upstream_source: UpstreamSource::Unknown,
            provenance: Vec::new(),
            legacy_variant: false,
            dump_tags: Vec::new(),
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
