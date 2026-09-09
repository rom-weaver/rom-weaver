//! Local cheat-database directory: shard loading, ROM-to-game matching, and
//! selector resolution for the native `cheat`, `patch apply`, and
//! `patch create` commands.
//!
//! The directory is the `cheats` directory `rom-weaver setup` installs beside
//! the identify packs: one Brotli `<platform slug>.json.br` shard per system,
//! optionally beside a `manifest.json`. A plain `<platform slug>.json` and the
//! `cheats-<platform slug>.json` spelling the data build writes are read too.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use rom_weaver_core::{Result, RomWeaverError, ValidationCodeError};
use serde::Deserialize;
use tracing::{debug, trace};

use crate::cheats::{CheatRecord, CheatResolution, CheatSystem, ClassifiedCheatRecord};

/// Overrides the cheat-database directory. `--cheat-database` wins over it.
pub(crate) const CHEAT_DATABASE_ENV: &str = "ROM_WEAVER_CHEAT_DATABASE";

/// Printed once per `cheat list` run. The shards are a derived work of the
/// libretro cheat database, which is CC-BY-SA-4.0.
const ATTRIBUTION: &str = "Cheat data from libretro/libretro-database, licensed CC-BY-SA-4.0.";

/// The CC-BY-SA attribution line, naming the imported revision when the
/// directory's manifest records one.
pub(crate) fn attribution(directory: Option<&Path>) -> String {
    let Some(manifest) = directory.and_then(load_manifest) else {
        return ATTRIBUTION.to_string();
    };
    let source = manifest
        .source
        .unwrap_or_else(|| "libretro/libretro-database".to_string());
    let license = manifest
        .license
        .unwrap_or_else(|| "CC-BY-SA-4.0".to_string());
    let revision = manifest
        .source_revision
        .map(|revision| format!(" at {revision}"))
        .unwrap_or_default();
    let url = manifest
        .source_url
        .map(|url| format!(" ({url})"))
        .unwrap_or_default();
    format!("Cheat data from {source}{revision}{url}, licensed {license}.")
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheatGameChecksums {
    #[serde(default)]
    pub crc32: Option<String>,
    #[serde(default)]
    pub md5: Option<String>,
    #[serde(default)]
    pub sha1: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheatGame {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub normalized_title: String,
    #[serde(default)]
    pub checksums: Vec<CheatGameChecksums>,
    #[serde(default)]
    pub cheats: Vec<CheatRecord>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheatShard {
    pub system: CheatSystem,
    pub games: Vec<CheatGame>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheatDatabaseManifest {
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub source_revision: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
}

/// How a ROM was tied to a database game.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GameMatchKind {
    /// A release checksum in the shard equals one of the ROM's checksums.
    Checksum,
    /// No checksum matched; the normalized file name equals a game title.
    Title,
    /// The caller named the game with `--game`.
    Manual,
}

impl GameMatchKind {
    pub(crate) const fn id(self) -> &'static str {
        match self {
            Self::Checksum => "exact",
            Self::Title => "title",
            Self::Manual => "manual",
        }
    }
}

/// The identify platform slug a system's cheat shard is named after. `setup`
/// installs `cheats/<slug>.json.br`, keyed by the same `CHEAT_PLATFORMS` slug
/// the data build uses (`scripts/import-libretro-cheats.mjs`).
pub(crate) fn shard_slug(system: CheatSystem) -> Option<&'static str> {
    match system {
        CheatSystem::Nes => Some("nintendo-nintendo-entertainment-system"),
        CheatSystem::Snes => Some("nintendo-super-nintendo-entertainment-system"),
        CheatSystem::Genesis => Some("sega-mega-drive-genesis"),
        CheatSystem::GameBoy => Some("nintendo-game-boy"),
        CheatSystem::GameBoyColor => Some("nintendo-game-boy-color"),
        CheatSystem::GameBoyAdvance => Some("nintendo-game-boy-advance"),
        CheatSystem::MasterSystem => Some("sega-master-system-mark-iii"),
        CheatSystem::GameGear => Some("sega-game-gear"),
        CheatSystem::Sega32x => Some("sega-32x"),
        // libretro ships no PlayStation or SG-1000 cheat shard.
        CheatSystem::PlayStation | CheatSystem::Sg1000 => None,
    }
}

/// Every file name a shard may carry, most preferred first: the compressed form
/// `setup` installs, then the plain form, then the `cheats-` prefixed spelling
/// the repository's own data directory uses.
fn shard_candidates(slug: &str) -> [String; 4] {
    [
        format!("{slug}.json.br"),
        format!("{slug}.json"),
        format!("cheats-{slug}.json.br"),
        format!("cheats-{slug}.json"),
    ]
}

/// The directory holding the shards: `--cheat-database`, else
/// `$ROM_WEAVER_CHEAT_DATABASE`, else `cheats` inside the identify database
/// directory that `rom-weaver setup` installs into.
pub(crate) fn resolve_directory(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(directory) = explicit {
        trace!(directory = %directory.display(), "cheat database directory from --cheat-database");
        return Ok(directory.to_path_buf());
    }
    if let Some(value) = std::env::var_os(CHEAT_DATABASE_ENV).filter(|value| !value.is_empty()) {
        let directory = PathBuf::from(value);
        trace!(directory = %directory.display(), "cheat database directory from environment");
        return Ok(directory);
    }
    let directory = default_directory()?;
    trace!(directory = %directory.display(), "cheat database directory from the identify database directory");
    Ok(directory)
}

/// `<identify database directory>/cheats`, which is where `rom-weaver setup`
/// unpacks the cheat shards that travel in the identify archive.
pub(crate) fn default_directory() -> Result<PathBuf> {
    Ok(crate::identify_database::default_database_dir()?.join("cheats"))
}

/// Read the manifest when it is present. A missing manifest is not fatal: the
/// shards carry every field the CLI needs.
fn load_manifest(directory: &Path) -> Option<CheatDatabaseManifest> {
    let path = directory.join("manifest.json");
    let bytes = fs::read(&path).ok()?;
    match serde_json::from_slice::<CheatDatabaseManifest>(&bytes) {
        Ok(manifest) => Some(manifest),
        Err(error) => {
            debug!(path = %path.display(), %error, "ignoring an unreadable cheat database manifest");
            None
        }
    }
}

/// Load one system's shard out of `directory`. A Brotli `<slug>.json.br` wins
/// over a plain `<slug>.json`, because that is the form `setup` installs.
pub(crate) fn load_shard(directory: &Path, system: CheatSystem) -> Result<CheatShard> {
    let Some(slug) = shard_slug(system) else {
        return Err(RomWeaverError::Validation(format!(
            "the cheat database has no shard for {}; supported systems are nes, snes, genesis, \
             32x, sms, gamegear, gameboy, gameboy-color, and gba",
            system.id()
        )));
    };
    let candidates = shard_candidates(slug);
    let Some(path) = candidates
        .iter()
        .map(|name| directory.join(name))
        .find(|path| path.is_file())
    else {
        return Err(shard_missing_error(directory, slug));
    };
    let compressed = path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("br"));
    trace!(path = %path.display(), system = system.id(), compressed, "loading cheat database shard");
    // Check the file's size before reading it, the way the identify packs do:
    // a hostile shard must not reach memory to be rejected.
    let limit = if compressed {
        MAX_COMPRESSED_SHARD_BYTES
    } else {
        MAX_SHARD_BYTES
    };
    check_shard_file_size(&path, limit)?;
    let raw = fs::read(&path).map_err(|error| {
        RomWeaverError::Validation(format!(
            "could not read the cheat database shard `{}`: {error}",
            path.display()
        ))
    })?;
    let bytes = if compressed {
        decompress_shard(&raw, &path, MAX_SHARD_BYTES)?
    } else {
        raw
    };
    let shard: CheatShard = serde_json::from_slice(&bytes).map_err(|error| {
        RomWeaverError::Validation(format!(
            "the cheat database shard `{}` is not valid: {error}",
            path.display()
        ))
    })?;
    debug!(
        path = %path.display(),
        system = shard.system.id(),
        games = shard.games.len(),
        "loaded cheat database shard"
    );
    Ok(shard)
}

/// A missing shard names the file it looked for and the command that installs
/// it, so the user does not have to find the layout first.
fn shard_missing_error(directory: &Path, slug: &str) -> RomWeaverError {
    RomWeaverError::Validation(format!(
        "the cheat database has no shard `{slug}.json.br` in `{}`; install it with \
         `rom-weaver setup`, or regenerate the shards with \
         `node scripts/import-libretro-cheats.mjs --output-dir {}`",
        directory.display(),
        directory.display()
    ))
}

/// The largest shard the CLI will read, before and after decompression. The
/// biggest shipped shard is under 40 MiB raw and under 2 MiB compressed.
const MAX_SHARD_BYTES: u64 = 256 * 1024 * 1024;
const MAX_COMPRESSED_SHARD_BYTES: u64 = 64 * 1024 * 1024;

/// Reject an oversized shard from its directory entry, before any read.
fn check_shard_file_size(path: &Path, limit: u64) -> Result<()> {
    let size = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if size > limit {
        return Err(RomWeaverError::Validation(format!(
            "the cheat database shard `{}` is {size} bytes, over the {limit}-byte limit",
            path.display()
        )));
    }
    Ok(())
}

/// Brotli shards are bounded: a hostile file must not expand without limit.
fn decompress_shard(raw: &[u8], path: &Path, limit: u64) -> Result<Vec<u8>> {
    let mut decompressed = Vec::new();
    brotli::Decompressor::new(raw, 4096)
        .take(limit + 1)
        .read_to_end(&mut decompressed)
        .map_err(|error| {
            RomWeaverError::Validation(format!(
                "could not decompress the cheat database shard `{}`: {error}",
                path.display()
            ))
        })?;
    if decompressed.len() as u64 > limit {
        return Err(RomWeaverError::Validation(format!(
            "the cheat database shard `{}` exceeds the {limit}-byte limit",
            path.display()
        )));
    }
    Ok(decompressed)
}

/// Fold a title or file name into the comparison form the webapp uses:
/// lower-case, extension dropped, bracketed region/revision tags dropped, and
/// every run of non-alphanumerics collapsed to a single space.
pub(crate) fn normalize_text(value: &str) -> String {
    let mut without_extension = value.to_ascii_lowercase();
    if let Some(dot) = without_extension.rfind('.') {
        let extension = &without_extension[dot + 1..];
        if (1..=8).contains(&extension.len())
            && extension.chars().all(|c| c.is_ascii_alphanumeric())
        {
            without_extension.truncate(dot);
        }
    }
    let mut stripped = String::with_capacity(without_extension.len());
    let mut depth = 0_usize;
    for character in without_extension.chars() {
        match character {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                depth = depth.saturating_sub(1);
                stripped.push(' ');
            }
            _ if depth == 0 => stripped.push(character),
            _ => {}
        }
    }
    let mut out = String::with_capacity(stripped.len());
    let mut pending_space = false;
    for character in stripped.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(character);
        } else {
            pending_space = true;
        }
    }
    out
}

/// Match a ROM to a shard game: any checksum hit first, then the normalized
/// title. Mirrors `matchCheatGame` in the webapp's `lib/cheats/catalog.ts`.
pub(crate) fn match_game<'a>(
    shard: &'a CheatShard,
    checksums: &BTreeMap<String, String>,
    title_source: &str,
) -> Option<(GameMatchKind, &'a CheatGame)> {
    let wanted = checksums
        .iter()
        .map(|(algorithm, value)| (algorithm.to_ascii_lowercase(), value.to_ascii_lowercase()))
        .collect::<BTreeMap<_, _>>();
    for game in &shard.games {
        for release in &game.checksums {
            for (algorithm, value) in [
                ("crc32", release.crc32.as_deref()),
                ("md5", release.md5.as_deref()),
                ("sha1", release.sha1.as_deref()),
            ] {
                let Some(value) = value else { continue };
                if wanted.get(algorithm) == Some(&value.to_ascii_lowercase()) {
                    debug!(game = %game.id, algorithm, "matched a cheat database game by checksum");
                    return Some((GameMatchKind::Checksum, game));
                }
            }
        }
    }
    let title = normalize_text(title_source);
    if title.is_empty() {
        return None;
    }
    let matched = shard.games.iter().find(|game| {
        normalize_text(&game.title) == title || normalize_text(&game.normalized_title) == title
    })?;
    debug!(game = %matched.id, %title, "matched a cheat database game by title");
    Some((GameMatchKind::Title, matched))
}

/// Find a game by its database ID (`--game`).
pub(crate) fn game_by_id<'a>(shard: &'a CheatShard, id: &str) -> Result<&'a CheatGame> {
    shard
        .games
        .iter()
        .find(|game| game.id == id)
        .ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "no game with ID `{id}` exists in the {} cheat shard",
                shard.system.id()
            ))
        })
}

/// Resolve `--cheat` selectors against a candidate list. A selector is either
/// an exact record ID or a case-insensitive description. A description that
/// names more than one record is an error, because silently taking the first
/// would bake an arbitrary code.
pub(crate) fn resolve_selectors(
    candidates: &[CheatRecord],
    selectors: &[String],
) -> Result<Vec<CheatRecord>> {
    let mut resolved = Vec::with_capacity(selectors.len());
    let mut seen = BTreeSet::new();
    for selector in selectors {
        let needle = selector.trim();
        if needle.is_empty() {
            continue;
        }
        let record = if let Some(record) = candidates.iter().find(|record| record.id == needle) {
            record
        } else {
            let matches = candidates
                .iter()
                .filter(|record| record.description.eq_ignore_ascii_case(needle))
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [single] => *single,
                [] => {
                    return Err(RomWeaverError::ValidationCode(
                        ValidationCodeError::new("cheat_selector_unknown")
                            .with_message("no cheat matches the selector")
                            .with_field("selector", needle.to_owned()),
                    ));
                }
                many => {
                    let ids = many
                        .iter()
                        .map(|record| record.id.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    return Err(RomWeaverError::ValidationCode(
                        ValidationCodeError::new("cheat_selector_ambiguous")
                            .with_message(
                                "the description matches more than one cheat; select by ID instead",
                            )
                            .with_field("selector", needle.to_owned())
                            .with_field("matches", ids),
                    ));
                }
            }
        };
        if seen.insert(record.id.clone()) {
            resolved.push(record.clone());
        }
    }
    Ok(resolved)
}

/// The single word `cheat list` prints for a classified record, and the word
/// the JSON details repeat.
pub(crate) fn delivery_label(resolution: &CheatResolution) -> &'static str {
    match resolution {
        CheatResolution::RomBakeable { .. } => "rom",
        CheatResolution::Unsupported { .. } => "unsupported",
    }
}

/// True when the entry can be baked into ROM bytes.
pub(crate) fn is_rom_bakeable(entry: &ClassifiedCheatRecord) -> bool {
    matches!(entry.resolution, CheatResolution::RomBakeable { .. })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, description: &str) -> CheatRecord {
        CheatRecord {
            id: id.to_owned(),
            system: CheatSystem::Nes,
            game_id: "game".to_owned(),
            description: description.to_owned(),
            raw_code: Some("AKE-LVS".to_owned()),
            code_kind: None,
            raw_fields: BTreeMap::new(),
            source_file: "test.cht".to_owned(),
            source_index: 0,
            source_revision: "test".to_owned(),
        }
    }

    #[test]
    fn normalize_text_drops_extension_and_region_tags() {
        assert_eq!(
            normalize_text("10-Yard Fight (USA, Europe).nes"),
            "10 yard fight"
        );
        assert_eq!(
            normalize_text("Super Mario Bros. [!].nes"),
            "super mario bros"
        );
    }

    #[test]
    fn resolve_selectors_takes_ids_and_unique_descriptions() {
        let candidates = vec![
            record("cheat_a", "Infinite lives"),
            record("cheat_b", "Max HP"),
        ];
        let resolved = resolve_selectors(
            &candidates,
            &[
                "cheat_a".to_owned(),
                "max hp".to_owned(),
                "cheat_a".to_owned(),
            ],
        )
        .expect("resolves");
        assert_eq!(
            resolved.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["cheat_a", "cheat_b"]
        );
    }

    #[test]
    fn resolve_selectors_rejects_an_ambiguous_description() {
        let candidates = vec![
            record("cheat_a", "Infinite lives"),
            record("cheat_b", "infinite LIVES"),
        ];
        let error = resolve_selectors(&candidates, &["Infinite lives".to_owned()]).unwrap_err();
        let RomWeaverError::ValidationCode(coded) = error else {
            panic!("expected a coded validation error");
        };
        assert_eq!(coded.code(), "cheat_selector_ambiguous");
    }

    #[test]
    fn resolve_selectors_rejects_an_unknown_selector() {
        let candidates = vec![record("cheat_a", "Infinite lives")];
        let error = resolve_selectors(&candidates, &["nope".to_owned()]).unwrap_err();
        let RomWeaverError::ValidationCode(coded) = error else {
            panic!("expected a coded validation error");
        };
        assert_eq!(coded.code(), "cheat_selector_unknown");
    }

    #[test]
    fn load_shard_prefers_the_brotli_copy_and_bounds_it() {
        let directory = std::env::temp_dir().join(format!("rw-cheat-shard-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("directory");
        let slug = shard_slug(CheatSystem::Nes).expect("slug");
        let shard = serde_json::json!({
            "schemaVersion": 1,
            "system": "nes",
            "sourceRevision": "test",
            "games": [],
        });
        // A plain copy that would fail to parse proves the `.br` copy wins.
        fs::write(directory.join(format!("{slug}.json")), b"not json").expect("plain");
        let raw = serde_json::to_vec(&shard).expect("shard json");
        let mut compressed = Vec::new();
        brotli::BrotliCompress(
            &mut raw.as_slice(),
            &mut compressed,
            &brotli::enc::BrotliEncoderParams::default(),
        )
        .expect("compress");
        fs::write(directory.join(format!("{slug}.json.br")), &compressed).expect("brotli");
        let loaded = load_shard(&directory, CheatSystem::Nes).expect("shard loads");
        assert_eq!(loaded.system, CheatSystem::Nes);

        // The decompression bound rejects a shard that expands past the limit.
        let error = decompress_shard(&compressed, Path::new("shard.json.br"), 4)
            .expect_err("the bound rejects it");
        assert!(error.to_string().contains("limit"), "{error}");
        let _ = fs::remove_dir_all(&directory);
    }
}
