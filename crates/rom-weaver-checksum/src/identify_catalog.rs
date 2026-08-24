//! Platform catalog for the identify databases.
//!
//! The builder emits `catalog.json` (`rom-weaver-identify-catalog-v1`) next to
//! the packs; this module parses it, resolves user-supplied platform names to
//! canonical entries via normalized aliases, and carries a built-in catalog of
//! the OpenGood platforms as a fallback when no catalog file is available.

use std::collections::HashMap;
use std::sync::LazyLock;

use rom_weaver_core::{Result, RomWeaverError};
use serde::{Deserialize, Serialize};
use tracing::trace;

const CATALOG_FORMAT: &str = "rom-weaver-identify-catalog-v1";

/// Which database a platform's pack was built from. Sources never mix inside
/// one platform: an OpenGood miss never falls through to Hasheous.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IdentifySource {
    #[serde(rename = "opengood")]
    OpenGood,
    Hasheous,
}

/// One platform's entry in the catalog.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdentifyPlatformCatalogEntry {
    /// The exact existing platform string (stability over prettiness).
    pub canonical_platform: String,
    pub aliases: Vec<String>,
    pub source: IdentifySource,
    pub media_profiles: Vec<String>,
    pub pack_slug: String,
    /// Outer pack magic label: "RWFP1" or "RWFP2".
    pub pack_format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_sha256: Option<String>,
    pub canonicalization_version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogFile {
    format: String,
    platforms: Vec<IdentifyPlatformCatalogEntry>,
}

/// The parsed catalog plus a normalized-alias lookup table.
#[derive(Debug)]
pub struct IdentifyCatalog {
    entries: Vec<IdentifyPlatformCatalogEntry>,
    /// Normalized alias (and canonical name) -> index into `entries`.
    aliases: HashMap<String, usize>,
}

impl IdentifyCatalog {
    /// Parse a `catalog.json` blob, rejecting a wrong format string, an alias
    /// claimed by two platforms, and a duplicate pack slug.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let file: CatalogFile = serde_json::from_slice(bytes).map_err(|error| {
            RomWeaverError::Validation(format!("invalid identify catalog: {error}"))
        })?;
        if file.format != CATALOG_FORMAT {
            return Err(RomWeaverError::Validation(format!(
                "invalid identify catalog: format `{}` is not `{CATALOG_FORMAT}`",
                file.format
            )));
        }
        Self::from_entries(file.platforms)
    }

    fn from_entries(entries: Vec<IdentifyPlatformCatalogEntry>) -> Result<Self> {
        let mut aliases: HashMap<String, usize> = HashMap::new();
        let mut slugs: HashMap<&str, ()> = HashMap::new();
        let mut slug_list = Vec::with_capacity(entries.len());
        for (index, entry) in entries.iter().enumerate() {
            slug_list.push(entry.pack_slug.clone());
            let mut names = vec![entry.canonical_platform.as_str()];
            names.extend(entry.aliases.iter().map(String::as_str));
            for name in names {
                let key = normalize_platform_name(name);
                if key.is_empty() {
                    return Err(RomWeaverError::Validation(format!(
                        "invalid identify catalog: alias `{name}` normalizes to an empty string"
                    )));
                }
                if let Some(&existing) = aliases.get(&key)
                    && existing != index
                {
                    return Err(RomWeaverError::Validation(format!(
                        "invalid identify catalog: alias `{name}` is claimed by both `{}` and `{}`",
                        entries[existing].canonical_platform, entry.canonical_platform
                    )));
                }
                aliases.insert(key, index);
            }
        }
        for entry in &entries {
            if slugs.insert(entry.pack_slug.as_str(), ()).is_some() {
                return Err(RomWeaverError::Validation(format!(
                    "invalid identify catalog: duplicate pack slug `{}`",
                    entry.pack_slug
                )));
            }
        }
        trace!(platforms = entries.len(), "identify catalog loaded");
        Ok(Self { entries, aliases })
    }

    /// Resolve a user-supplied platform name (canonical or alias) to its entry.
    pub fn resolve_platform(&self, name: &str) -> Option<&IdentifyPlatformCatalogEntry> {
        let key = normalize_platform_name(name);
        let entry = self.aliases.get(&key).map(|&index| &self.entries[index]);
        trace!(name, resolved = entry.is_some(), "identify platform lookup");
        entry
    }

    /// All catalog entries, in file order.
    pub fn entries(&self) -> &[IdentifyPlatformCatalogEntry] {
        &self.entries
    }

    /// The built-in OpenGood catalog used when no `catalog.json` is available.
    pub fn builtin() -> &'static IdentifyCatalog {
        static BUILTIN: LazyLock<IdentifyCatalog> = LazyLock::new(|| {
            IdentifyCatalog::from_entries(builtin_entries())
                .expect("built-in identify catalog is valid")
        });
        &BUILTIN
    }
}

/// Normalize a platform name for alias matching: lowercase, collapse every
/// non-alphanumeric run to one space, trim.
pub fn normalize_platform_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending_space = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_space = true;
        }
    }
    out
}

/// The OpenGood platforms (`OPENGOOD_PLATFORMS` in
/// `scripts/build-hasheous-identify-index.mjs`) with curated aliases.
fn builtin_entries() -> Vec<IdentifyPlatformCatalogEntry> {
    fn entry(canonical: &str, aliases: &[&str], slug: &str) -> IdentifyPlatformCatalogEntry {
        IdentifyPlatformCatalogEntry {
            canonical_platform: canonical.to_string(),
            aliases: aliases.iter().map(|alias| alias.to_string()).collect(),
            source: IdentifySource::OpenGood,
            media_profiles: vec!["opengood-cartridge-v1".to_string()],
            pack_slug: slug.to_string(),
            pack_format: "RWFP1".to_string(),
            pack_sha256: None,
            canonicalization_version: 1,
        }
    }
    vec![
        entry("Atari 2600", &["2600", "atari vcs", "vcs"], "atari-2600"),
        entry("Atari 5200", &["5200"], "atari-5200"),
        entry("Atari 7800", &["7800"], "atari-7800"),
        entry("Atari Lynx", &["lynx"], "atari-lynx"),
        entry("Neo Geo Pocket", &["ngp"], "neo-geo-pocket"),
        entry(
            "Neo Geo Pocket Color",
            &["ngpc", "neo geo pocket colour"],
            "neo-geo-pocket-color",
        ),
        entry("Nintendo 64", &["n64"], "nintendo-64"),
        entry(
            "Nintendo Entertainment System",
            &["nes", "famicom", "nintendo famicom"],
            "nintendo-entertainment-system",
        ),
        entry("Nintendo Game Boy", &["gb", "gameboy"], "nintendo-game-boy"),
        entry(
            "Nintendo Game Boy Advance",
            &["gba", "gameboy advance"],
            "nintendo-game-boy-advance",
        ),
        entry(
            "Nintendo Game Boy Color",
            &["gbc", "gameboy color"],
            "nintendo-game-boy-color",
        ),
        entry(
            "Nintendo Super Nintendo Entertainment System",
            &["snes", "super nintendo", "super nes", "super famicom"],
            "nintendo-super-nintendo-entertainment-system",
        ),
        entry("Sega 32X", &["32x", "megadrive 32x"], "sega-32x"),
        entry("Sega Game Gear", &["gg", "game gear"], "sega-game-gear"),
        entry(
            "Sega Master System",
            &["sms", "master system"],
            "sega-master-system",
        ),
        entry(
            "Sega Mega Drive _ Genesis",
            &["genesis", "mega drive", "megadrive", "sega genesis"],
            "sega-mega-drive-genesis",
        ),
        entry(
            "TurboGrafx-16_PC Engine",
            &["tg16", "turbografx", "turbografx 16", "pc engine", "pce"],
            "turbografx-16-pc-engine",
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_json(platforms: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "format": CATALOG_FORMAT,
            "platforms": platforms,
        }))
        .unwrap()
    }

    fn platform_json(canonical: &str, aliases: &[&str], slug: &str) -> serde_json::Value {
        serde_json::json!({
            "canonicalPlatform": canonical,
            "aliases": aliases,
            "source": "opengood",
            "mediaProfiles": ["opengood-cartridge-v1"],
            "packSlug": slug,
            "packFormat": "RWFP1",
            "canonicalizationVersion": 1,
        })
    }

    #[test]
    fn parses_and_resolves_aliases_and_canonical_names() {
        let bytes = catalog_json(serde_json::json!([platform_json(
            "Sony PlayStation",
            &["psx", "ps1"],
            "sony-playstation"
        )]));
        let catalog = IdentifyCatalog::parse(&bytes).expect("catalog parses");
        for name in ["PSX", "ps1", "Sony PlayStation", "sony_playstation!"] {
            let entry = catalog.resolve_platform(name).expect("resolves");
            assert_eq!(entry.canonical_platform, "Sony PlayStation");
        }
        assert!(catalog.resolve_platform("ps2").is_none());
    }

    #[test]
    fn rejects_wrong_format_string() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "format": "rom-weaver-identify-catalog-v2",
            "platforms": [],
        }))
        .unwrap();
        let error = IdentifyCatalog::parse(&bytes).expect_err("wrong format must fail");
        assert!(error.to_string().contains("format"));
    }

    #[test]
    fn rejects_alias_claimed_by_two_platforms() {
        let bytes = catalog_json(serde_json::json!([
            platform_json("A", &["shared"], "a"),
            platform_json("B", &["Shared!"], "b"),
        ]));
        let error = IdentifyCatalog::parse(&bytes).expect_err("duplicate alias must fail");
        assert!(error.to_string().contains("alias"));
    }

    #[test]
    fn rejects_duplicate_pack_slug() {
        let bytes = catalog_json(serde_json::json!([
            platform_json("A", &[], "same"),
            platform_json("B", &[], "same"),
        ]));
        let error = IdentifyCatalog::parse(&bytes).expect_err("duplicate slug must fail");
        assert!(error.to_string().contains("slug"));
    }

    #[test]
    fn builtin_catalog_resolves_common_names() {
        let catalog = IdentifyCatalog::builtin();
        let cases = [
            ("famicom", "Nintendo Entertainment System"),
            (
                "Super Famicom",
                "Nintendo Super Nintendo Entertainment System",
            ),
            ("mega-drive", "Sega Mega Drive _ Genesis"),
            ("genesis", "Sega Mega Drive _ Genesis"),
            ("PC Engine", "TurboGrafx-16_PC Engine"),
            ("gbc", "Nintendo Game Boy Color"),
            ("NGPC", "Neo Geo Pocket Color"),
            ("game gear", "Sega Game Gear"),
            ("Sega Master System", "Sega Master System"),
        ];
        for (alias, canonical) in cases {
            let entry = catalog
                .resolve_platform(alias)
                .unwrap_or_else(|| panic!("`{alias}` must resolve"));
            assert_eq!(entry.canonical_platform, canonical);
        }
        assert!(catalog.resolve_platform("commodore 64").is_none());
    }

    #[test]
    fn normalization_collapses_symbol_runs() {
        assert_eq!(
            normalize_platform_name("  Sega Mega Drive _ Genesis "),
            "sega mega drive genesis"
        );
        assert_eq!(
            normalize_platform_name("TurboGrafx-16_PC Engine"),
            "turbografx 16 pc engine"
        );
    }
}
