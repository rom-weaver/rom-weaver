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

#[derive(Deserialize)]
struct PlatformNames {
    aliases: HashMap<String, Vec<String>>,
    #[serde(rename = "importAliases")]
    import_aliases: HashMap<String, Vec<String>>,
}

/// Curated names shared with the identify builder, native imports, and browser labels.
pub fn platform_aliases(name: &str) -> Vec<String> {
    static ALIASES: LazyLock<HashMap<String, Vec<String>>> = LazyLock::new(|| {
        let names: PlatformNames = serde_json::from_str(include_str!("platform-names.json"))
            .expect("shared platform names are valid");
        let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
        for (name, values) in names.aliases {
            let entry = aliases.entry(normalize_platform_name(&name)).or_default();
            for value in values {
                if !entry.contains(&value) {
                    entry.push(value);
                }
            }
        }
        for values in aliases.values_mut() {
            values.sort();
        }
        aliases
    });
    ALIASES
        .get(&normalize_platform_name(name))
        .cloned()
        .unwrap_or_default()
}

/// Exact alias order used when the native CLI imports a DAT.
pub fn import_platform_aliases(name: &str) -> Vec<String> {
    static ALIASES: LazyLock<HashMap<String, Vec<String>>> = LazyLock::new(|| {
        let names: PlatformNames = serde_json::from_str(include_str!("platform-names.json"))
            .expect("shared platform names are valid");
        names.import_aliases
    });
    ALIASES
        .get(&normalize_platform_name(name))
        .cloned()
        .unwrap_or_default()
}

/// The primary metadata source for a platform pack.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IdentifySource {
    Libretro,
    #[serde(rename = "opengood")]
    OpenGood,
    Redump,
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
    /// Outer pack magic label. The current value is "RWFP1".
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
            // The slug becomes a filesystem path (`<dir>/<slug>.pack`) that read
            // and remove use, so it MUST NOT carry separators or dots.
            if entry.pack_slug.is_empty()
                || !entry
                    .pack_slug
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
            {
                return Err(RomWeaverError::Validation(format!(
                    "invalid identify catalog: pack slug `{}` must be lowercase \
                     letters, digits, and hyphens",
                    entry.pack_slug
                )));
            }
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

/// Redump systems with downloadable DAT files. The CLI owns the matching
/// endpoint names because network access is native-only.
#[allow(dead_code)]
fn redump_entries() -> Vec<IdentifyPlatformCatalogEntry> {
    fn entry(canonical: &str) -> IdentifyPlatformCatalogEntry {
        IdentifyPlatformCatalogEntry {
            canonical_platform: canonical.to_string(),
            aliases: platform_aliases(canonical),
            source: IdentifySource::Redump,
            media_profiles: vec!["redump-disc-track-v1".to_string()],
            pack_slug: normalize_platform_name(canonical).replace(' ', "-"),
            pack_format: "RWFP1".to_string(),
            pack_sha256: None,
            canonicalization_version: 1,
        }
    }
    vec![
        entry("Acorn Archimedes"),
        entry("Apple Macintosh"),
        entry("Atari Jaguar CD Interactive Multimedia System"),
        entry("Bandai Pippin"),
        entry("Bandai Playdia Quick Interactive System"),
        entry("Commodore Amiga CD"),
        entry("Commodore Amiga CD32"),
        entry("Commodore Amiga CDTV"),
        entry("Fujitsu FM Towns series"),
        entry("funworld Photo Play"),
        entry("IBM PC compatible"),
        entry("Incredible Technologies Eagle"),
        entry("Konami e-Amusement"),
        entry("Konami FireBeat"),
        entry("Konami System 573"),
        entry("Konami System GV"),
        entry("Mattel Fisher-Price iXL"),
        entry("Mattel HyperScan"),
        entry("Memorex Visual Information System"),
        entry("Microsoft Xbox"),
        entry("Microsoft Xbox 360"),
        entry("Namco - Sega - Nintendo Triforce"),
        entry("Namco System 246"),
        entry("NEC PC Engine CD & TurboGrafx CD"),
        entry("NEC PC-88 series"),
        entry("NEC PC-98 series"),
        entry("NEC PC-FX & PC-FXGA"),
        entry("Neo Geo CD"),
        entry("Nintendo GameCube"),
        entry("Nintendo Wii"),
        entry("Palm OS"),
        entry("Panasonic 3DO Interactive Multiplayer"),
        entry("Philips CD-i"),
        entry("Photo CD"),
        entry("PlayStation GameShark Updates"),
        entry("Pocket PC"),
        entry("Sega Chihiro"),
        entry("Sega Dreamcast"),
        entry("Sega Lindbergh"),
        entry("Sega Mega CD & Sega CD"),
        entry("Sega Naomi"),
        entry("Sega Naomi 2"),
        entry("Sega Prologue 21 Multimedia Karaoke System"),
        entry("Sega RingEdge"),
        entry("Sega RingEdge 2"),
        entry("Sega Saturn"),
        entry("Sharp X68000"),
        entry("Sony PlayStation"),
        entry("Sony PlayStation 2"),
        entry("Sony PlayStation 3"),
        entry("Sony PlayStation Portable"),
        entry("TAB-Austria Quizard"),
        entry("Tomy Kiss-Site"),
        entry("VM Labs NUON"),
        entry("VTech V.Flash & V.Smile Pro"),
        entry("ZAPiT Games Game Wave Family Entertainment System"),
    ]
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

/// The compiled OpenGood platforms with curated aliases.
fn builtin_entries() -> Vec<IdentifyPlatformCatalogEntry> {
    fn entry(canonical: &str, slug: &str) -> IdentifyPlatformCatalogEntry {
        IdentifyPlatformCatalogEntry {
            canonical_platform: canonical.to_string(),
            aliases: platform_aliases(canonical),
            source: IdentifySource::OpenGood,
            media_profiles: vec!["opengood-cartridge-v1".to_string()],
            pack_slug: slug.to_string(),
            pack_format: "RWFP1".to_string(),
            pack_sha256: None,
            canonicalization_version: 1,
        }
    }
    vec![
        entry("Atari 2600", "atari-2600"),
        entry("Atari 5200", "atari-5200"),
        entry("Atari 7800", "atari-7800"),
        entry("Atari Lynx", "atari-lynx"),
        entry("Neo Geo Pocket", "neo-geo-pocket"),
        entry("Neo Geo Pocket Color", "neo-geo-pocket-color"),
        entry("Nintendo 64", "nintendo-64"),
        entry(
            "Nintendo Entertainment System",
            "nintendo-entertainment-system",
        ),
        entry("Nintendo Game Boy", "nintendo-game-boy"),
        entry("Nintendo Game Boy Advance", "nintendo-game-boy-advance"),
        entry("Nintendo Game Boy Color", "nintendo-game-boy-color"),
        entry(
            "Nintendo Super Nintendo Entertainment System",
            "nintendo-super-nintendo-entertainment-system",
        ),
        entry("Sega 32X", "sega-32x"),
        entry("Sega Game Gear", "sega-game-gear"),
        entry("Sega Master System", "sega-master-system"),
        entry("Sega Mega Drive _ Genesis", "sega-mega-drive-genesis"),
        entry("TurboGrafx-16_PC Engine", "turbografx-16-pc-engine"),
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
            &["psx", "ps1", "ps"],
            "sony-playstation"
        )]));
        let catalog = IdentifyCatalog::parse(&bytes).expect("catalog parses");
        for name in ["PSX", "ps1", "PS", "Sony PlayStation", "sony_playstation!"] {
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
    fn rejects_pack_slug_with_path_characters() {
        for slug in ["../escape", "a/b", "a.b", "A-B", ""] {
            let bytes = catalog_json(serde_json::json!([platform_json("A", &[], slug)]));
            let error = IdentifyCatalog::parse(&bytes)
                .map(|_| ())
                .expect_err("slug with path characters must fail");
            assert!(error.to_string().contains("slug"), "slug `{slug}`: {error}");
        }
    }

    #[test]
    fn builtin_catalog_resolves_common_names() {
        let catalog = IdentifyCatalog::builtin();
        let cases = [
            ("atari2600", "Atari 2600"),
            ("famicom", "Nintendo Entertainment System"),
            ("fc", "Nintendo Entertainment System"),
            ("n64dd", "Nintendo 64"),
            ("64dd", "Nintendo 64"),
            (
                "Super Famicom",
                "Nintendo Super Nintendo Entertainment System",
            ),
            ("sfc", "Nintendo Super Nintendo Entertainment System"),
            ("sfam", "Nintendo Super Nintendo Entertainment System"),
            ("mega-drive", "Sega Mega Drive _ Genesis"),
            ("genesis", "Sega Mega Drive _ Genesis"),
            ("megadrivejp", "Sega Mega Drive _ Genesis"),
            ("md", "Sega Mega Drive _ Genesis"),
            ("smd", "Sega Mega Drive _ Genesis"),
            ("PC Engine", "TurboGrafx-16_PC Engine"),
            ("pcengine", "TurboGrafx-16_PC Engine"),
            ("supergrafx", "TurboGrafx-16_PC Engine"),
            ("sgb", "Nintendo Game Boy"),
            ("ereader", "Nintendo Game Boy Advance"),
            ("gbc", "Nintendo Game Boy Color"),
            ("gba", "Nintendo Game Boy Advance"),
            ("NGPC", "Neo Geo Pocket Color"),
            ("game gear", "Sega Game Gear"),
            ("Sega Master System", "Sega Master System"),
            ("ms", "Sega Master System"),
            ("sufami", "Nintendo Super Nintendo Entertainment System"),
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

    #[test]
    fn rejects_bytes_that_are_not_catalog_json() {
        for bytes in [b"{not json".as_slice(), b"[]".as_slice(), b"{}".as_slice()] {
            let error = IdentifyCatalog::parse(bytes).expect_err("malformed catalog must fail");
            assert!(
                error
                    .to_string()
                    .starts_with("validation failed: invalid identify catalog: "),
                "{error}"
            );
        }
    }

    #[test]
    fn rejects_alias_that_normalizes_to_an_empty_string() {
        let bytes = catalog_json(serde_json::json!([platform_json("A", &["***"], "a")]));
        let error = IdentifyCatalog::parse(&bytes).expect_err("empty alias must fail");
        assert!(
            error.to_string().contains("normalizes to an empty string"),
            "{error}"
        );
    }

    #[test]
    fn entries_are_returned_in_file_order() {
        let bytes = catalog_json(serde_json::json!([
            platform_json("Second", &[], "second"),
            platform_json("First", &[], "first"),
        ]));
        let catalog = IdentifyCatalog::parse(&bytes).expect("catalog parses");
        let order = catalog
            .entries()
            .iter()
            .map(|entry| entry.canonical_platform.as_str())
            .collect::<Vec<_>>();
        assert_eq!(order, ["Second", "First"]);
    }

    #[test]
    fn redump_entries_form_a_valid_catalog_with_resolvable_aliases() {
        let entries = redump_entries();
        assert!(!entries.is_empty());
        for entry in &entries {
            assert_eq!(entry.source, IdentifySource::Redump);
            assert_eq!(entry.pack_format, "RWFP1");
            assert_eq!(entry.media_profiles, ["redump-disc-track-v1"]);
            assert_eq!(entry.canonicalization_version, 1);
            assert_eq!(entry.pack_sha256, None);
        }

        // `from_entries` is the same gate `parse` applies, so this proves the
        // built-in Redump table has no colliding alias, no duplicate slug, and no
        // slug that would escape `<dir>/<slug>.pack`.
        let catalog = IdentifyCatalog::from_entries(entries.clone())
            .expect("redump entries must pass catalog validation");
        assert_eq!(catalog.entries().len(), entries.len());

        let cases = [
            ("PSX", "Sony PlayStation"),
            ("ps1", "Sony PlayStation"),
            ("PS", "Sony PlayStation"),
            ("ps2", "Sony PlayStation 2"),
            ("play station 2", "Sony PlayStation 2"),
            ("dreamcast", "Sega Dreamcast"),
            ("Xbox 360", "Microsoft Xbox 360"),
            ("xbox360", "Microsoft Xbox 360"),
            ("pc engine cd", "NEC PC Engine CD & TurboGrafx CD"),
            ("pcenginecd", "NEC PC Engine CD & TurboGrafx CD"),
            ("pcecd", "NEC PC Engine CD & TurboGrafx CD"),
            (
                "atari jaguar cd",
                "Atari Jaguar CD Interactive Multimedia System",
            ),
            ("neogeocd", "Neo Geo CD"),
            ("neocd", "Neo Geo CD"),
            ("megacd", "Sega Mega CD & Sega CD"),
            ("scd", "Sega Mega CD & Sega CD"),
            ("saturnjp", "Sega Saturn"),
            ("3DO", "Panasonic 3DO Interactive Multiplayer"),
            ("Nintendo GameCube", "Nintendo GameCube"),
        ];
        for (alias, canonical) in cases {
            let entry = catalog
                .resolve_platform(alias)
                .unwrap_or_else(|| panic!("`{alias}` must resolve"));
            assert_eq!(entry.canonical_platform, canonical);
        }
        assert!(catalog.resolve_platform("atari 2600").is_none());
    }

    #[test]
    fn redump_pack_slugs_are_derived_from_the_canonical_name() {
        let entries = redump_entries();
        let slugs = entries
            .iter()
            .map(|entry| (entry.canonical_platform.as_str(), entry.pack_slug.as_str()))
            .collect::<HashMap<_, _>>();
        assert_eq!(slugs.get("Sony PlayStation"), Some(&"sony-playstation"));
        assert_eq!(slugs.get("Philips CD-i"), Some(&"philips-cd-i"));
        assert_eq!(
            slugs.get("NEC PC Engine CD & TurboGrafx CD"),
            Some(&"nec-pc-engine-cd-turbografx-cd")
        );
    }
}
