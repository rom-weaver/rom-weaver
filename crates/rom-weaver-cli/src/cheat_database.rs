//! Local cheat-database directory: shard loading, ROM-to-game matching, and
//! selector resolution for the native `cheat`, `patch apply`, and
//! `patch create` commands.
//!
//! The directory holds the same files the webapp serves from
//! `packages/rom-weaver-webapp/public/cheats`: one `manifest.json` plus one
//! uncompressed `<system>.json` shard per system. Only the uncompressed shards
//! are read - the CLI carries no brotli decoder.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
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

/// The file name a system's shard uses, in both the webapp's public directory
/// and the CLI's database directory.
pub(crate) fn shard_file_name(system: CheatSystem) -> Option<&'static str> {
    match system {
        CheatSystem::Nes => Some("nes.json"),
        CheatSystem::Snes => Some("snes.json"),
        CheatSystem::Genesis => Some("genesis.json"),
        CheatSystem::GameBoy => Some("gameboy.json"),
        CheatSystem::GameBoyColor => Some("gameboy-color.json"),
        CheatSystem::GameBoyAdvance => Some("gameboyadvance.json"),
        CheatSystem::MasterSystem => Some("mastersystem.json"),
        CheatSystem::GameGear => Some("gamegear.json"),
        CheatSystem::Sega32x => Some("sega32x.json"),
        // libretro ships no PlayStation or SG-1000 cheat shard.
        CheatSystem::PlayStation | CheatSystem::Sg1000 => None,
    }
}

/// The directory holding `manifest.json` and the `<system>.json` shards:
/// `--cheat-database`, else `$ROM_WEAVER_CHEAT_DATABASE`, else the per-user
/// data directory.
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
    let directory = default_data_directory()?.join("rom-weaver").join("cheats");
    trace!(directory = %directory.display(), "cheat database directory from the default data directory");
    Ok(directory)
}

fn default_data_directory() -> Result<PathBuf> {
    let missing = || {
        RomWeaverError::Validation(
            "could not find a per-user data directory; pass --cheat-database DIR or set \
             ROM_WEAVER_CHEAT_DATABASE"
                .to_string(),
        )
    };
    if cfg!(target_os = "windows") {
        return std::env::var_os("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(missing);
    }
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if cfg!(target_os = "macos") {
        return home
            .map(|home| home.join("Library").join("Application Support"))
            .ok_or_else(missing);
    }
    if let Some(value) = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(value));
    }
    home.map(|home| home.join(".local").join("share"))
        .ok_or_else(missing)
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

/// Load one system's shard out of `directory`.
pub(crate) fn load_shard(directory: &Path, system: CheatSystem) -> Result<CheatShard> {
    let Some(file_name) = shard_file_name(system) else {
        return Err(RomWeaverError::Validation(format!(
            "the cheat database has no shard for {}; supported systems are nes, snes, genesis, \
             gameboy, gameboy-color, and gba",
            system.id()
        )));
    };
    let path = directory.join(file_name);
    trace!(path = %path.display(), system = system.id(), "loading cheat database shard");
    let bytes = fs::read(&path).map_err(|error| {
        RomWeaverError::Validation(format!(
            "could not read the cheat database shard `{}` ({error}); the shards ship in the \
             webapp's packages/rom-weaver-webapp/public/cheats directory - copy the \
             uncompressed `{file_name}` and `manifest.json` there, or regenerate them with \
             `node scripts/import-libretro-cheats.mjs --output-dir {}`",
            path.display(),
            directory.display()
        ))
    })?;
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
}
