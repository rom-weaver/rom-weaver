use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use rom_weaver_checksum::artifact_match::{
    ArtifactFingerprint, ArtifactMatchOutcome, ArtifactMatchQuality, ArtifactMatchStatus,
    ArtifactPackReader, match_artifact,
};
use rom_weaver_checksum::identify_catalog::{
    IdentifyCatalog, IdentifyPlatformCatalogEntry, IdentifySource,
};
use rom_weaver_checksum::identify_pack::{IdentifyPackFile, IdentifyQuery, SystemPack};
use rom_weaver_checksum::platform_detection::platform as platform_names;
use rom_weaver_core::{
    ComponentRole, DetectionConfidence, DetectionEvidence, MediaKind, PlatformCandidate,
};

use super::identify_database::{IdentifyPackProvider, LoadedPack};
use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript-types", ts(rename_all = "snake_case"))]
pub enum IdentifyStatus {
    Matched,
    Ambiguous,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyTitleMatch {
    pub name: String,
    pub platform: String,
    pub algorithm: String,
    pub variant: String,
    pub database: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub provenance: Vec<IdentifyProvenance>,
    #[serde(default, skip_serializing_if = "is_false")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub legacy_variant: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub dump_tags: Vec<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// One upstream database that contributed metadata to an identify record.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyProvenance {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub source_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub source_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub license: Option<String>,
}

/// The compact title lookup attached to ingest assets and patch source hints.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyLookupResult {
    pub status: IdentifyStatus,
    pub matches: Vec<IdentifyTitleMatch>,
}

/// The medium the identified payload came from, as far as identify can tell.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyMedia {
    pub kind: MediaKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub container: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub sessions: Option<u32>,
}

/// One hashed component of the identified input.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyComponent {
    pub role: ComponentRole,
    pub ordinal: u32,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub crc32: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub md5: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub sha1: Option<String>,
}

/// Which database produced the match.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyDatabaseInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub upstream_sources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub revision: Option<String>,
    pub pack_format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub canonicalization_profile: Option<String>,
}

/// Component-level evidence behind a set-aware artifact-pack match.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyEvidence {
    pub required_components_matched: u32,
    pub required_components_total: u32,
    pub layout_matched: bool,
    /// Names of required pack components the input does not supply. Sorted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub missing_components: Vec<String>,
    /// Names of input components the matched game does not explain. Sorted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub unexpected_components: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyResult {
    pub status: IdentifyStatus,
    pub input: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub detected_platform: Option<String>,
    pub checksums: BTreeMap<String, String>,
    pub checksum_variants: Vec<Value>,
    pub matches: Vec<IdentifyTitleMatch>,
    /// Match quality of a set-aware artifact-pack match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub quality: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub platform_candidates: Vec<PlatformCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub media: Option<IdentifyMedia>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub components: Vec<IdentifyComponent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub database: Option<IdentifyDatabaseInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub evidence: Option<IdentifyEvidence>,
    /// `database_required` or `unsupported_media_profile`; status stays
    /// matched/ambiguous/unknown for compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub condition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub hint: Option<String>,
}

/// Resolve one checksum query against a V1 pack, appending unseen titles.
fn resolve_query_in_pack(
    database_name: &str,
    pack: &SystemPack,
    query: &IdentifyQuery<'_>,
    variant: &str,
    seen: &mut BTreeSet<(String, String)>,
    output: &mut Vec<IdentifyTitleMatch>,
) -> Result<()> {
    let lookup = pack.resolve(query)?;
    trace!(
        database = database_name,
        algorithm = lookup.algorithm.unwrap_or("none"),
        variant,
        match_count = lookup.matches.len(),
        "resolved ROM identify lookup"
    );
    let Some(algorithm) = lookup.algorithm else {
        return Ok(());
    };
    for title in lookup.matches {
        let key = (title.name.clone(), title.platform.clone());
        if !seen.insert(key) {
            continue;
        }
        output.push(IdentifyTitleMatch {
            name: title.name,
            platform: title.platform,
            algorithm: algorithm.to_string(),
            variant: variant.to_string(),
            database: database_name.to_string(),
            provenance: Vec::new(),
            legacy_variant: false,
            dump_tags: Vec::new(),
        });
    }
    Ok(())
}

/// Parsed identify packs shared by one command invocation (ingest and patch
/// hints). Packs are parsed once, then reused for every ROM asset and patch
/// descriptor produced by that invocation.
pub(super) struct IdentifyDatabaseSet {
    packs: Vec<(String, IdentifyPackFile)>,
}

impl IdentifyDatabaseSet {
    pub(super) fn load(databases: &[PathBuf]) -> Result<Option<Self>> {
        if databases.is_empty() {
            #[cfg(target_arch = "wasm32")]
            return Ok(None);
            #[cfg(not(target_arch = "wasm32"))]
            return Self::from_builtin_packs().map(Some);
        }

        let mut packs = Vec::with_capacity(databases.len());
        for database in databases {
            trace!(database = %database.display(), "loading ROM identify pack");
            let bytes = fs::read(database).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read ROM identify pack `{}`: {error}",
                    database.display()
                ))
            })?;
            let pack = IdentifyPackFile::parse(&bytes).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "invalid ROM identify pack `{}`: {error}",
                    database.display()
                ))
            })?;
            let database_name = database
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| database.to_string_lossy().into_owned());
            packs.push((database_name, pack));
        }
        Ok(Some(Self { packs }))
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn from_builtin_packs() -> Result<Self> {
        let database_dir = super::identify_database::default_database_dir()?;
        let slugs = super::identify_builtin::pack_slugs(&database_dir)?;
        let mut packs = Vec::with_capacity(slugs.len());
        for slug in slugs {
            let Some(path) = super::identify_builtin::pack_path(&database_dir, &slug) else {
                continue;
            };
            let database_name = format!("{slug}.pack");
            trace!(
                database = database_name,
                path = %path.display(),
                "loading packaged ROM identify pack"
            );
            let bytes = super::identify_builtin::decompress(&path)?;
            packs.push((database_name, IdentifyPackFile::parse(&bytes)?));
        }
        Ok(Self { packs })
    }

    /// `raw_size` is the size of the raw payload behind the `raw` checksum
    /// variant. Artifact packs (RWFP2+) route by (crc32, size) and are only
    /// searched when it is known.
    pub(super) fn resolve_variants(
        &self,
        variants: &[Value],
        raw_size: Option<u64>,
    ) -> Result<IdentifyLookupResult> {
        let mut output = Vec::new();
        let mut seen = BTreeSet::new();
        for variant in variants {
            let variant_id = variant.get("id").and_then(Value::as_str).unwrap_or("raw");
            let values = checksum_map(variant.get("checksums"));
            self.resolve_query(
                &IdentifyQuery {
                    crc32: values.get("crc32").map(String::as_str),
                    md5: values.get("md5").map(String::as_str),
                    sha1: values.get("sha1").map(String::as_str),
                },
                variant_id,
                &mut seen,
                &mut output,
            )?;
        }
        for variant in variants {
            let variant_id = variant.get("id").and_then(Value::as_str).unwrap_or("raw");
            let Some(variant_size) = variant_payload_size(variant, raw_size) else {
                continue;
            };
            let checksums = checksum_map(variant.get("checksums"));
            self.resolve_artifact_packs(
                variant_id,
                Some(variant_size),
                &checksums,
                &mut seen,
                &mut output,
            )?;
        }
        Ok(identify_lookup_result(output))
    }

    /// Search the artifact packs with a single-blob fingerprint built from one
    /// checksum variant's payload size and checksums.
    fn resolve_artifact_packs(
        &self,
        variant: &str,
        raw_size: Option<u64>,
        raw_checksums: &BTreeMap<String, String>,
        seen: &mut BTreeSet<(String, String)>,
        output: &mut Vec<IdentifyTitleMatch>,
    ) -> Result<()> {
        for (database_name, pack) in &self.packs {
            let outcome = match pack {
                IdentifyPackFile::V1(_) => continue,
                IdentifyPackFile::V2(pack) => {
                    match_single_blob(database_name, pack, raw_size, raw_checksums)?
                }
                IdentifyPackFile::V3(pack) => {
                    match_single_blob(database_name, pack, raw_size, raw_checksums)?
                }
                IdentifyPackFile::V4(pack) => {
                    match_single_blob(database_name, pack, raw_size, raw_checksums)?
                }
            };
            let Some(outcome) = outcome else {
                trace!(
                    database = database_name,
                    "skipping artifact pack: the raw payload size is unknown"
                );
                continue;
            };
            push_artifact_matches(database_name, variant, outcome, seen, output);
        }
        Ok(())
    }

    /// Search the artifact packs with a multi-component fingerprint (one
    /// component per disc track). Used by ingest for `.cue`/`.gdi`/CHD track
    /// sets, whose packs store per-track hashes that a single-blob query can
    /// never satisfy.
    pub(super) fn resolve_fingerprint(
        &self,
        fingerprint: &ArtifactFingerprint,
        variant: &str,
    ) -> Result<IdentifyLookupResult> {
        let mut output = Vec::new();
        let mut seen = BTreeSet::new();
        for (database_name, pack) in &self.packs {
            let outcome = match pack {
                IdentifyPackFile::V1(_) => continue,
                IdentifyPackFile::V2(pack) => match_fingerprint(database_name, pack, fingerprint)?,
                IdentifyPackFile::V3(pack) => match_fingerprint(database_name, pack, fingerprint)?,
                IdentifyPackFile::V4(pack) => match_fingerprint(database_name, pack, fingerprint)?,
            };
            push_artifact_matches(database_name, variant, outcome, &mut seen, &mut output);
        }
        Ok(identify_lookup_result(output))
    }

    pub(super) fn resolve_source(
        &self,
        source_crc32: Option<u32>,
        source_checksum_variants: &[BTreeMap<String, String>],
        filename_checksums: &BTreeMap<String, String>,
    ) -> Result<Option<IdentifyLookupResult>> {
        let mut embedded = source_checksum_variants.to_vec();
        if let Some(crc32) = source_crc32 {
            let crc32 = format!("{crc32:08x}");
            if !embedded
                .iter()
                .any(|checksums| checksums.get("crc32") == Some(&crc32))
            {
                embedded.push(BTreeMap::from([(String::from("crc32"), crc32)]));
            }
        }
        if embedded.is_empty() && filename_checksums.is_empty() {
            return Ok(None);
        }
        let mut output = Vec::new();
        let mut seen = BTreeSet::new();
        if !embedded.is_empty() {
            for (index, checksums) in embedded.iter().enumerate() {
                let variant = if index == 0 {
                    "source".to_string()
                } else {
                    format!("source-{}", index + 1)
                };
                self.resolve_query(
                    &IdentifyQuery {
                        crc32: checksums.get("crc32").map(String::as_str),
                        md5: checksums.get("md5").map(String::as_str),
                        sha1: checksums.get("sha1").map(String::as_str),
                    },
                    &variant,
                    &mut seen,
                    &mut output,
                )?;
            }
        } else {
            self.resolve_query(
                &IdentifyQuery {
                    crc32: filename_checksums.get("crc32").map(String::as_str),
                    md5: filename_checksums.get("md5").map(String::as_str),
                    sha1: filename_checksums.get("sha1").map(String::as_str),
                },
                "filename",
                &mut seen,
                &mut output,
            )?;
        }
        Ok(Some(identify_lookup_result(output)))
    }

    fn resolve_query(
        &self,
        query: &IdentifyQuery<'_>,
        variant: &str,
        seen: &mut BTreeSet<(String, String)>,
        output: &mut Vec<IdentifyTitleMatch>,
    ) -> Result<()> {
        for (database_name, pack) in &self.packs {
            match pack {
                IdentifyPackFile::V1(pack) => {
                    resolve_query_in_pack(database_name, pack, query, variant, seen, output)?;
                }
                IdentifyPackFile::V2(_) | IdentifyPackFile::V3(_) | IdentifyPackFile::V4(_) => {
                    // Artifact packs route by (crc32, size); this hash-only
                    // query has no size, so they cannot answer it.
                    trace!(
                        database = database_name,
                        variant, "skipping artifact pack for a size-less checksum query"
                    );
                }
            }
        }
        Ok(())
    }
}

fn identify_lookup_result(mut matches: Vec<IdentifyTitleMatch>) -> IdentifyLookupResult {
    matches.sort_by(|left, right| {
        (&left.platform, &left.name, &left.variant).cmp(&(
            &right.platform,
            &right.name,
            &right.variant,
        ))
    });
    let status = match matches.len() {
        0 => IdentifyStatus::Unknown,
        1 => IdentifyStatus::Matched,
        _ => IdentifyStatus::Ambiguous,
    };
    IdentifyLookupResult { status, matches }
}

/// Plausible platforms for a detected platform string. The ambiguous cartridge
/// families share one header layout, so the color/handheld twin is added; disc
/// signatures are unambiguous.
fn detected_platform_candidates(detected: Option<&str>, is_disc: bool) -> Vec<PlatformCandidate> {
    let Some(platform) = detected else {
        return Vec::new();
    };
    let evidence = || {
        if is_disc {
            DetectionEvidence::SystemAreaMagic
        } else {
            DetectionEvidence::HeaderMagic
        }
    };
    let mut platforms = vec![platform];
    match platform {
        p if p == platform_names::GAME_BOY => platforms.push(platform_names::GAME_BOY_COLOR),
        p if p == platform_names::MASTER_SYSTEM => platforms.push(platform_names::GAME_GEAR),
        p if p == platform_names::NEO_GEO_POCKET => {
            platforms.push(platform_names::NEO_GEO_POCKET_COLOR)
        }
        _ => {}
    }
    platforms
        .into_iter()
        .map(|platform| PlatformCandidate {
            platform: platform.to_string(),
            confidence: DetectionConfidence::Strong,
            evidence: evidence(),
        })
        .collect()
}

/// One pack picked for this identify run, with its catalog entry when routed
/// through the catalog.
struct SelectedPack {
    pack: Rc<LoadedPack>,
    entry: Option<IdentifyPlatformCatalogEntry>,
}

fn source_label(source: IdentifySource) -> &'static str {
    match source {
        IdentifySource::Libretro => "libretro",
        IdentifySource::OpenGood => "opengood",
        IdentifySource::Redump => "redump",
    }
}

fn quality_label(quality: ArtifactMatchQuality) -> &'static str {
    match quality {
        ArtifactMatchQuality::Exact => "exact",
        ArtifactMatchQuality::Partial => "partial",
        ArtifactMatchQuality::MetadataOnly => "metadata_only",
    }
}

fn database_info_for(
    pack: &LoadedPack,
    entry: Option<&IdentifyPlatformCatalogEntry>,
) -> IdentifyDatabaseInfo {
    match &pack.file {
        IdentifyPackFile::V2(artifact) => IdentifyDatabaseInfo {
            source: Some(source_label(artifact.source()).to_string()),
            upstream_sources: Vec::new(),
            revision: None,
            pack_format: "RWFP2".to_string(),
            canonicalization_profile: Some(artifact.canonicalization_profile().to_string()),
        },
        IdentifyPackFile::V3(artifact) => IdentifyDatabaseInfo {
            source: Some(source_label(artifact.source()).to_string()),
            upstream_sources: Vec::new(),
            revision: None,
            pack_format: "RWFP3".to_string(),
            canonicalization_profile: Some(artifact.canonicalization_profile().to_string()),
        },
        IdentifyPackFile::V4(artifact) => IdentifyDatabaseInfo {
            source: Some(source_label(artifact.source()).to_string()),
            upstream_sources: Vec::new(),
            revision: None,
            pack_format: "RWFP4".to_string(),
            canonicalization_profile: Some(artifact.canonicalization_profile().to_string()),
        },
        IdentifyPackFile::V1(_) => IdentifyDatabaseInfo {
            source: entry.map(|entry| source_label(entry.source).to_string()),
            upstream_sources: Vec::new(),
            revision: None,
            pack_format: "RWFP1".to_string(),
            canonicalization_profile: entry.and_then(|entry| entry.media_profiles.first().cloned()),
        },
    }
}

/// The upstream dump sources of the matched games in one V2 pack, deduped and
/// sorted; "unknown" is omitted. Empty when no matched game states one.
fn matched_upstream_sources(
    games: &[rom_weaver_checksum::identify_pack_v2::PackGame],
    matched: &[(String, String)],
) -> Vec<String> {
    use rom_weaver_checksum::identify_pack_v2::UpstreamSource;
    let mut sources: BTreeSet<&'static str> = BTreeSet::new();
    for game in games {
        if !matched
            .iter()
            .any(|(name, platform)| *name == game.name && *platform == game.platform)
        {
            continue;
        }
        let label = match game.upstream_source {
            UpstreamSource::Libretro => "libretro",
            UpstreamSource::Redump => "redump",
            UpstreamSource::NoIntro => "no-intro",
            UpstreamSource::Tosec => "tosec",
            UpstreamSource::Mame => "mame",
            UpstreamSource::Fbneo => "fbneo",
            UpstreamSource::OpenGood => "opengood",
            UpstreamSource::Unknown => continue,
        };
        sources.insert(label);
    }
    sources.into_iter().map(str::to_string).collect()
}

/// Media profiles identify cannot canonicalize yet: they need per-track
/// hashes, and this command fingerprints one payload.
fn profile_needs_tracks(profile: &str) -> bool {
    matches!(profile, "redump-cd-track-v1" | "redump-gdrom-track-v1")
}

fn match_single_blob<P: ArtifactPackReader + ?Sized>(
    database_name: &str,
    pack: &P,
    raw_size: Option<u64>,
    raw_checksums: &BTreeMap<String, String>,
) -> Result<Option<ArtifactMatchOutcome>> {
    let Some(size) = raw_size.filter(|size| *size > 0) else {
        return Ok(None);
    };
    let fingerprint = ArtifactFingerprint::from_single_blob(
        size,
        raw_checksums.get("crc32").map(String::as_str),
        raw_checksums.get("md5").map(String::as_str),
        raw_checksums.get("sha1").map(String::as_str),
    );
    Ok(Some(match_fingerprint(database_name, pack, &fingerprint)?))
}

/// A checksum variant's payload size: the raw length minus a header strip's
/// removed bytes (`transforms.removeHeader.strippedBytes`); every other
/// transform keeps the length.
fn variant_payload_size(variant: &Value, raw_size: Option<u64>) -> Option<u64> {
    let stripped = variant
        .pointer("/transforms/removeHeader/strippedBytes")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    raw_size
        .and_then(|size| size.checked_sub(stripped))
        .filter(|size| *size > 0)
}

/// Query one artifact pack with a single-blob fingerprint per checksum
/// variant (raw, remove-header, ...), falling back to the raw checksums when
/// no variant rows exist. Empty when the raw payload size is unknown.
fn match_variant_blobs<P: ArtifactPackReader + ?Sized>(
    database_name: &str,
    pack: &P,
    checksum_variants: &[Value],
    raw_size: Option<u64>,
    raw_checksums: &BTreeMap<String, String>,
) -> Result<Vec<(String, ArtifactMatchOutcome)>> {
    if raw_size.filter(|size| *size > 0).is_none() {
        return Ok(Vec::new());
    }
    let mut outcomes = Vec::new();
    if checksum_variants.is_empty() {
        if let Some(outcome) = match_single_blob(database_name, pack, raw_size, raw_checksums)? {
            outcomes.push(("raw".to_string(), outcome));
        }
        return Ok(outcomes);
    }
    for variant in checksum_variants {
        let variant_id = variant.get("id").and_then(Value::as_str).unwrap_or("raw");
        let Some(variant_size) = variant_payload_size(variant, raw_size) else {
            continue;
        };
        let checksums = checksum_map(variant.get("checksums"));
        let fingerprint = ArtifactFingerprint::from_single_blob(
            variant_size,
            checksums.get("crc32").map(String::as_str),
            checksums.get("md5").map(String::as_str),
            checksums.get("sha1").map(String::as_str),
        );
        outcomes.push((
            variant_id.to_string(),
            match_fingerprint(database_name, pack, &fingerprint)?,
        ));
    }
    Ok(outcomes)
}

fn match_fingerprint<P: ArtifactPackReader + ?Sized>(
    database_name: &str,
    pack: &P,
    fingerprint: &ArtifactFingerprint,
) -> Result<ArtifactMatchOutcome> {
    let outcome = match_artifact(pack, fingerprint)?;
    trace!(
        database = database_name,
        components = fingerprint.components.len(),
        status = ?outcome.status,
        quality = ?outcome.quality,
        matches = outcome.matches.len(),
        "artifact pack lookup"
    );
    Ok(outcome)
}

/// Fold one pack's artifact match outcome into the deduped title-match list.
fn push_artifact_matches(
    database_name: &str,
    variant: &str,
    outcome: ArtifactMatchOutcome,
    seen: &mut BTreeSet<(String, String)>,
    output: &mut Vec<IdentifyTitleMatch>,
) {
    if outcome.status == ArtifactMatchStatus::Unknown {
        return;
    }
    for game_match in outcome.matches {
        let key = (game_match.name.clone(), game_match.platform.clone());
        if !seen.insert(key) {
            continue;
        }
        output.push(IdentifyTitleMatch {
            name: game_match.name,
            platform: game_match.platform,
            algorithm: "components".to_string(),
            variant: variant.to_string(),
            database: database_name.to_string(),
            provenance: game_match
                .provenance
                .into_iter()
                .map(|item| IdentifyProvenance {
                    source: item.source,
                    source_name: item.source_name,
                    source_url: item.source_url,
                    source_commit: item.source_commit,
                    license: item.license,
                })
                .collect(),
            legacy_variant: game_match.legacy_variant,
            dump_tags: game_match.dump_tags,
        });
    }
}

impl CliApp {
    pub(super) fn run_identify(&self, mut args: IdentifyCommand) -> AppRunOutcome {
        if let Some(IdentifySubcommands::Database(command)) = args.subcommand.take() {
            return self.run_identify_database(command);
        }
        let identify_failed = |message: String, thread_execution| {
            OperationReport::failed(
                OperationFamily::Command,
                Some("identify".to_string()),
                "identify",
                message,
                thread_execution,
            )
        };
        if args.input.is_some() == args.hash.is_some() {
            return self.finish(
                "identify",
                identify_failed("provide exactly one of --input or --hash".to_string(), None),
            );
        }
        if let Some(hash) = args.hash.take() {
            let databases = match IdentifyDatabaseSet::load(&args.database) {
                Ok(Some(databases)) => databases,
                Ok(None) => {
                    return self.finish(
                        "identify",
                        identify_failed(
                            "the browser identify command requires a staged --database pack"
                                .to_string(),
                            None,
                        ),
                    );
                }
                Err(error) => {
                    return self.finish("identify", identify_failed(error.to_string(), None));
                }
            };
            return self.run_identify_hash(&hash, &databases);
        }
        let Some(mut input) = args.input.take() else {
            return self.finish(
                "identify",
                identify_failed("identify needs --input <ROM>".to_string(), None),
            );
        };
        let _stdin_guard = match crate::stdin_input::spool_stdin_if_dash(&mut input) {
            Ok(guard) => guard,
            Err(error) => {
                return self.finish(
                    "identify",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("identify".to_string()),
                        "read",
                        format!("failed to read stdin input: {error}"),
                        None,
                    ),
                );
            }
        };
        if args.offline {
            // Identify is offline by construction natively; the flag only
            // records the guarantee in the log.
            debug!("offline: identify performs no network access");
        }
        trace!(
            source = %input.display(),
            databases = args.database.len(),
            system = ?args.system,
            database_dir = ?args.database_dir,
            exhaustive = args.exhaustive_database_search,
            selections = args.select.len(),
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            no_trim_fix = args.no_trim_fix,
            threads = %args.threads,
            "starting identify command"
        );
        let IdentifyCommand {
            input: _,
            hash: _,
            database,
            system,
            offline: _,
            database_dir,
            exhaustive_database_search,
            subcommand: _,
            select,
            filter,
            no_extract,
            no_ignore,
            no_trim_fix,
            threads,
        } = args;

        #[cfg(not(target_arch = "wasm32"))]
        let provider = match IdentifyPackProvider::new(database_dir) {
            Ok(provider) => Some(provider),
            Err(error) => return self.finish("identify", identify_failed(error.to_string(), None)),
        };
        #[cfg(target_arch = "wasm32")]
        let provider: Option<IdentifyPackProvider> = {
            let _ = database_dir;
            None
        };

        // Resolve the explicit --system override before hashing anything.
        let override_entry: Option<IdentifyPlatformCatalogEntry> = match &system {
            Some(name) => {
                let resolved = provider
                    .as_ref()
                    .and_then(|provider| provider.resolve_entry(name))
                    .or_else(|| IdentifyCatalog::builtin().resolve_platform(name).cloned());
                match resolved {
                    Some(entry) => {
                        trace!(
                            system = name,
                            platform = %entry.canonical_platform,
                            "resolved --system override"
                        );
                        Some(entry)
                    }
                    None => {
                        return self.finish(
                            "identify",
                            identify_failed(
                                format!(
                                    "unknown system `{name}`: it is not in the identify catalog. \
                                     Run `rom-weaver identify database list` to see the known \
                                     platform names and aliases"
                                ),
                                None,
                            ),
                        );
                    }
                }
            }
            None => None,
        };

        if database.is_empty() && provider.is_none() {
            return self.finish(
                "identify",
                identify_failed(
                    "the browser identify command requires a staged --database pack".to_string(),
                    None,
                ),
            );
        }

        let mut checksum_report = self.run_checksum_inner_for_identify(ChecksumCommand {
            input: input.clone(),
            algo: vec!["crc32".to_string(), "md5".to_string(), "sha1".to_string()],
            select,
            filter,
            no_extract,
            no_ignore,
            no_trim_fix,
            start: None,
            length: None,
            probe: false,
            threads,
        });
        if checksum_report.status != OperationStatus::Succeeded {
            checksum_report.stage = "identify".to_string();
            return self.finish("identify", checksum_report);
        }

        let details = checksum_report.details.take().unwrap_or(Value::Null);
        let checksums = checksum_map(details.get("checksums"));
        let checksum_variants = details
            .get("checksum_variants")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| {
                vec![json!({
                    "id": "raw",
                    "label": "Raw",
                    "checksums": checksums,
                })]
            });
        let detected_platform = details
            .get("platform")
            .and_then(Value::as_str)
            .map(str::to_string);
        let is_disc = details.get("disc_format").is_some();
        let raw_size = details.get("size").and_then(Value::as_u64);

        let platform_candidates: Vec<PlatformCandidate> = match &override_entry {
            Some(entry) => vec![PlatformCandidate {
                platform: entry.canonical_platform.clone(),
                confidence: DetectionConfidence::Certain,
                evidence: DetectionEvidence::UserOverride,
            }],
            None => detected_platform_candidates(detected_platform.as_deref(), is_disc),
        };
        trace!(
            candidates = ?platform_candidates
                .iter()
                .map(|candidate| candidate.platform.as_str())
                .collect::<Vec<_>>(),
            detected_platform = ?detected_platform,
            is_disc,
            raw_size = ?raw_size,
            crc32 = ?checksums.get("crc32"),
            "identify platform candidates"
        );

        // Select the packs to search, and remember catalog platforms whose
        // pack is not installed (for the database_required condition).
        let mut selected: Vec<SelectedPack> = Vec::new();
        let mut missing_platforms: Vec<String> = Vec::new();
        if !database.is_empty() {
            let loaded = match Self::load_explicit_packs(&database) {
                Ok(loaded) => loaded,
                Err(error) => {
                    return self.finish(
                        "identify",
                        identify_failed(error.to_string(), checksum_report.thread_execution),
                    );
                }
            };
            selected.extend(loaded);
        } else if let Some(provider) = &provider {
            let selection = Self::select_catalog_packs(
                provider,
                &platform_candidates,
                exhaustive_database_search,
            );
            match selection {
                Ok((packs, missing)) => {
                    selected = packs;
                    missing_platforms = missing;
                }
                Err(error) => {
                    return self.finish(
                        "identify",
                        identify_failed(error.to_string(), checksum_report.thread_execution),
                    );
                }
            }
        }

        trace!(
            selected = ?selected
                .iter()
                .map(|selected| selected.pack.name.as_str())
                .collect::<Vec<_>>(),
            missing = ?missing_platforms,
            "identify pack selection"
        );
        let resolved =
            Self::resolve_against_selected(&selected, &checksum_variants, raw_size, &checksums);
        let resolved = match resolved {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish(
                    "identify",
                    identify_failed(error.to_string(), checksum_report.thread_execution),
                );
            }
        };
        let ResolvedIdentify {
            matches,
            quality,
            evidence,
            database: database_info,
        } = resolved;

        let status = match matches.len() {
            0 => IdentifyStatus::Unknown,
            1 => IdentifyStatus::Matched,
            _ => IdentifyStatus::Ambiguous,
        };

        let mut condition = None;
        let mut hint = None;
        if status == IdentifyStatus::Unknown {
            if let Some(platform) = missing_platforms.first() {
                condition = Some("database_required".to_string());
                hint = Some(format!(
                    "no identify pack is installed for {platform}; run `rom-weaver identify \
                     database install-all` or pass `--database-dir` with an existing user database"
                ));
            } else if let Some(selected) = selected.iter().find(|selected| {
                let profile = match &selected.pack.file {
                    IdentifyPackFile::V2(pack) => Some(pack.canonicalization_profile().to_string()),
                    IdentifyPackFile::V3(pack) => Some(pack.canonicalization_profile().to_string()),
                    IdentifyPackFile::V4(pack) => Some(pack.canonicalization_profile().to_string()),
                    IdentifyPackFile::V1(_) => selected
                        .entry
                        .as_ref()
                        .and_then(|entry| entry.media_profiles.first().cloned()),
                };
                profile.as_deref().is_some_and(profile_needs_tracks)
            }) {
                let profile = match &selected.pack.file {
                    IdentifyPackFile::V2(pack) => pack.canonicalization_profile().to_string(),
                    IdentifyPackFile::V3(pack) => pack.canonicalization_profile().to_string(),
                    IdentifyPackFile::V4(pack) => pack.canonicalization_profile().to_string(),
                    IdentifyPackFile::V1(_) => selected
                        .entry
                        .as_ref()
                        .and_then(|entry| entry.media_profiles.first().cloned())
                        .unwrap_or_default(),
                };
                condition = Some("unsupported_media_profile".to_string());
                hint = Some(format!(
                    "this system's pack ({profile}) stores CD dumps as per-track hashes, but \
                     the input was hashed as one payload; for a CD image, extract the disc's \
                     track files and identify the data track"
                ));
            }
        }

        let label = match status {
            IdentifyStatus::Matched => format!("identified {}", matches[0].name),
            IdentifyStatus::Ambiguous => format!("found {} possible titles", matches.len()),
            IdentifyStatus::Unknown => match condition.as_deref() {
                Some("database_required") => format!(
                    "no identify pack installed for {}",
                    missing_platforms.first().map(String::as_str).unwrap_or("?")
                ),
                Some("unsupported_media_profile") => {
                    "this input's media profile is not supported yet".to_string()
                }
                _ => "no title matched the supplied database".to_string(),
            },
        };

        let components = match raw_size {
            Some(size) => vec![IdentifyComponent {
                role: ComponentRole::PrimaryPayload,
                ordinal: 0,
                size,
                crc32: checksums.get("crc32").cloned(),
                md5: checksums.get("md5").cloned(),
                sha1: checksums.get("sha1").cloned(),
            }],
            None => Vec::new(),
        };
        let media = if is_disc {
            Some(IdentifyMedia {
                kind: MediaKind::OpticalDisc,
                container: None,
                sessions: None,
            })
        } else {
            None
        };
        let detected_platform = detected_platform.or_else(|| {
            override_entry
                .as_ref()
                .map(|entry| entry.canonical_platform.clone())
        });

        let result = IdentifyResult {
            status,
            input: input.to_string_lossy().replace('\\', "/"),
            detected_platform,
            checksums,
            checksum_variants,
            matches,
            quality,
            platform_candidates,
            media,
            components,
            database: database_info,
            evidence,
            condition,
            hint,
        };
        let mut report = OperationReport::succeeded(
            OperationFamily::Command,
            Some("identify".to_string()),
            "identify",
            label,
            Some(100.0),
            checksum_report.thread_execution,
        );
        report.details = Some(json!({ "identify": result }));
        self.finish("identify", report)
    }

    fn run_identify_hash(&self, hash: &str, databases: &IdentifyDatabaseSet) -> AppRunOutcome {
        let hash = hash.trim().to_ascii_lowercase();
        let algorithm = match hash.len() {
            _ if !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) => None,
            8 => Some("crc32"),
            32 => Some("md5"),
            40 => Some("sha1"),
            _ => None,
        };
        let Some(algorithm) = algorithm else {
            return self.finish(
                "identify",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("identify".to_string()),
                    "identify",
                    "--hash must be hex: 8 chars for crc32, 32 for md5, or 40 for sha1",
                    None,
                ),
            );
        };
        let checksum_variants = vec![json!({
            "id": "manual",
            "label": "Manual",
            "checksums": { algorithm: hash },
        })];
        let lookup = match databases.resolve_variants(&checksum_variants, None) {
            Ok(lookup) => lookup,
            Err(error) => {
                return self.finish(
                    "identify",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("identify".to_string()),
                        "identify",
                        error.to_string(),
                        None,
                    ),
                );
            }
        };
        let label = match lookup.status {
            IdentifyStatus::Matched => format!("identified {}", lookup.matches[0].name),
            IdentifyStatus::Ambiguous => format!("found {} possible titles", lookup.matches.len()),
            IdentifyStatus::Unknown => "no title matched the supplied database".to_string(),
        };
        let result = IdentifyResult {
            status: lookup.status,
            input: hash.clone(),
            detected_platform: None,
            checksums: BTreeMap::from([(algorithm.to_string(), hash)]),
            checksum_variants,
            matches: lookup.matches,
            quality: None,
            platform_candidates: Vec::new(),
            media: None,
            components: Vec::new(),
            database: None,
            evidence: None,
            condition: None,
            hint: None,
        };
        let mut report = OperationReport::succeeded(
            OperationFamily::Command,
            Some("identify".to_string()),
            "identify",
            label,
            Some(100.0),
            None,
        );
        report.details = Some(json!({ "identify": result }));
        self.finish("identify", report)
    }

    /// Parse the packs named by `--database`. Any parse failure fails the
    /// command with the pack path in the message.
    fn load_explicit_packs(databases: &[PathBuf]) -> Result<Vec<SelectedPack>> {
        let mut selected = Vec::with_capacity(databases.len());
        for database in databases {
            trace!(database = %database.display(), "loading ROM identify pack");
            let bytes = fs::read(database).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read ROM identify pack `{}`: {error}",
                    database.display()
                ))
            })?;
            let file = IdentifyPackFile::parse(&bytes).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "invalid ROM identify pack `{}`: {error}",
                    database.display()
                ))
            })?;
            let name = database
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| database.to_string_lossy().into_owned());
            selected.push(SelectedPack {
                pack: Rc::new(LoadedPack { name, file }),
                entry: None,
            });
        }
        Ok(selected)
    }

    /// Route platform candidates through the catalog. Returns the loadable
    /// packs plus the platforms whose pack is not installed. With no
    /// candidates the builtin packs are searched; `exhaustive` searches every
    /// available pack instead.
    fn select_catalog_packs(
        provider: &IdentifyPackProvider,
        candidates: &[PlatformCandidate],
        exhaustive: bool,
    ) -> Result<(Vec<SelectedPack>, Vec<String>)> {
        if exhaustive {
            trace!("exhaustive database search requested");
            let packs = provider
                .all_packs()?
                .into_iter()
                .map(|pack| SelectedPack { pack, entry: None })
                .collect();
            return Ok((packs, Vec::new()));
        }
        let mut selected: Vec<SelectedPack> = Vec::new();
        let mut missing = Vec::new();
        for candidate in candidates {
            match provider.resolve_entry(&candidate.platform) {
                Some(entry) => match provider.pack_for_slug(&entry.pack_slug)? {
                    Some(pack) => {
                        if !selected
                            .iter()
                            .any(|existing| Rc::ptr_eq(&existing.pack, &pack))
                        {
                            selected.push(SelectedPack {
                                pack,
                                entry: Some(entry),
                            });
                        }
                    }
                    None => missing.push(entry.canonical_platform.clone()),
                },
                None => {
                    trace!(
                        platform = %candidate.platform,
                        "platform candidate has no catalog entry"
                    );
                    missing.push(candidate.platform.clone());
                }
            }
        }
        if selected.is_empty() && candidates.is_empty() {
            // No detection signal at all: search the builtin packs, matching
            // the pre-routing behavior.
            for entry in IdentifyCatalog::builtin().entries() {
                if let Some(pack) = provider.pack_for_slug(&entry.pack_slug)? {
                    selected.push(SelectedPack {
                        pack,
                        entry: Some(entry.clone()),
                    });
                }
            }
        }
        Ok((selected, missing))
    }

    /// Run the V1 variant lookups and the V2 single-blob fingerprint match
    /// over the selected packs, merging into one ordered match list.
    fn resolve_against_selected(
        selected: &[SelectedPack],
        checksum_variants: &[Value],
        raw_size: Option<u64>,
        raw_checksums: &BTreeMap<String, String>,
    ) -> Result<ResolvedIdentify> {
        let mut merged = MergedMatches::default();

        for selected_pack in selected {
            match &selected_pack.pack.file {
                IdentifyPackFile::V1(pack) => {
                    let before = merged.matches.len();
                    for variant in checksum_variants {
                        let variant_id = variant.get("id").and_then(Value::as_str).unwrap_or("raw");
                        let values = checksum_map(variant.get("checksums"));
                        resolve_query_in_pack(
                            &selected_pack.pack.name,
                            pack,
                            &IdentifyQuery {
                                crc32: values.get("crc32").map(String::as_str),
                                md5: values.get("md5").map(String::as_str),
                                sha1: values.get("sha1").map(String::as_str),
                            },
                            variant_id,
                            &mut merged.seen,
                            &mut merged.matches,
                        )?;
                    }
                    if merged.matches.len() > before && merged.database.is_none() {
                        merged.database = Some(database_info_for(
                            &selected_pack.pack,
                            selected_pack.entry.as_ref(),
                        ));
                    }
                }
                IdentifyPackFile::V2(pack) => {
                    let outcomes = match_variant_blobs(
                        &selected_pack.pack.name,
                        pack,
                        checksum_variants,
                        raw_size,
                        raw_checksums,
                    )?;
                    if outcomes.is_empty() {
                        trace!(
                            database = %selected_pack.pack.name,
                            "skipping RWFP2 pack: the raw payload size is unknown"
                        );
                        continue;
                    }
                    for (variant, outcome) in outcomes {
                        merged.merge_artifact_outcome(
                            &selected_pack.pack,
                            selected_pack.entry.as_ref(),
                            &variant,
                            outcome,
                        );
                    }
                }
                IdentifyPackFile::V3(pack) => {
                    let outcomes = match_variant_blobs(
                        &selected_pack.pack.name,
                        pack,
                        checksum_variants,
                        raw_size,
                        raw_checksums,
                    )?;
                    if outcomes.is_empty() {
                        trace!(
                            database = %selected_pack.pack.name,
                            "skipping RWFP3 pack: the raw payload size is unknown"
                        );
                        continue;
                    }
                    for (variant, outcome) in outcomes {
                        merged.merge_artifact_outcome(
                            &selected_pack.pack,
                            selected_pack.entry.as_ref(),
                            &variant,
                            outcome,
                        );
                    }
                }
                IdentifyPackFile::V4(pack) => {
                    let outcomes = match_variant_blobs(
                        &selected_pack.pack.name,
                        pack,
                        checksum_variants,
                        raw_size,
                        raw_checksums,
                    )?;
                    if outcomes.is_empty() {
                        trace!(
                            database = %selected_pack.pack.name,
                            "skipping RWFP4 pack: the raw payload size is unknown"
                        );
                        continue;
                    }
                    for (variant, outcome) in outcomes {
                        merged.merge_artifact_outcome(
                            &selected_pack.pack,
                            selected_pack.entry.as_ref(),
                            &variant,
                            outcome,
                        );
                    }
                }
            }
        }
        let MergedMatches {
            seen: _,
            mut matches,
            quality,
            evidence,
            database,
        } = merged;
        matches.sort_by(|left, right| {
            (&left.platform, &left.name, &left.variant).cmp(&(
                &right.platform,
                &right.name,
                &right.variant,
            ))
        });
        Ok(ResolvedIdentify {
            matches,
            quality: quality.map(|quality| quality_label(quality).to_string()),
            evidence,
            database,
        })
    }
}

/// Match accumulator shared by the V1 and V2 lookup paths of one identify run.
#[derive(Default)]
struct MergedMatches {
    seen: BTreeSet<(String, String)>,
    matches: Vec<IdentifyTitleMatch>,
    quality: Option<ArtifactMatchQuality>,
    evidence: Option<IdentifyEvidence>,
    database: Option<IdentifyDatabaseInfo>,
}

impl MergedMatches {
    fn merge_artifact_outcome(
        &mut self,
        pack: &LoadedPack,
        entry: Option<&IdentifyPlatformCatalogEntry>,
        variant: &str,
        outcome: ArtifactMatchOutcome,
    ) {
        if outcome.status == ArtifactMatchStatus::Unknown {
            return;
        }
        if let Some(outcome_quality) = outcome.quality {
            self.quality = Some(match self.quality {
                Some(existing) => existing.min(outcome_quality),
                None => outcome_quality,
            });
        }
        let mut added: Vec<(String, String)> = Vec::new();
        for game_match in outcome.matches {
            let key = (game_match.name.clone(), game_match.platform.clone());
            if !self.seen.insert(key.clone()) {
                if let Some(existing) = self
                    .matches
                    .iter_mut()
                    .find(|item| item.name == key.0 && item.platform == key.1)
                {
                    for item in game_match.provenance {
                        let item = IdentifyProvenance {
                            source: item.source,
                            source_name: item.source_name,
                            source_url: item.source_url,
                            source_commit: item.source_commit,
                            license: item.license,
                        };
                        if !existing.provenance.contains(&item) {
                            existing.provenance.push(item);
                        }
                    }
                    existing.provenance.sort();
                    for tag in game_match.dump_tags {
                        if !existing.dump_tags.contains(&tag) {
                            existing.dump_tags.push(tag);
                        }
                    }
                    existing.dump_tags.sort();
                    existing.legacy_variant &= game_match.legacy_variant;
                }
                continue;
            }
            added.push(key);
            if self.evidence.is_none() {
                let mut missing_components = game_match.evidence.missing.clone();
                missing_components.sort();
                let mut unexpected_components = game_match.evidence.unexpected.clone();
                unexpected_components.sort();
                self.evidence = Some(IdentifyEvidence {
                    required_components_matched: game_match.evidence.required_components_matched,
                    required_components_total: game_match.evidence.required_components_total,
                    layout_matched: game_match.evidence.layout_matched,
                    missing_components,
                    unexpected_components,
                });
            }
            self.matches.push(IdentifyTitleMatch {
                name: game_match.name,
                platform: game_match.platform,
                algorithm: "components".to_string(),
                variant: variant.to_string(),
                database: pack.name.clone(),
                provenance: game_match
                    .provenance
                    .into_iter()
                    .map(|item| IdentifyProvenance {
                        source: item.source,
                        source_name: item.source_name,
                        source_url: item.source_url,
                        source_commit: item.source_commit,
                        license: item.license,
                    })
                    .collect(),
                legacy_variant: game_match.legacy_variant,
                dump_tags: game_match.dump_tags,
            });
        }
        if self.database.is_none() && !added.is_empty() {
            let mut info = database_info_for(pack, entry);
            info.upstream_sources = match &pack.file {
                IdentifyPackFile::V2(artifact) => {
                    matched_upstream_sources(artifact.games(), &added)
                }
                IdentifyPackFile::V3(artifact) => {
                    matched_upstream_sources(artifact.games(), &added)
                }
                IdentifyPackFile::V4(artifact) => {
                    matched_upstream_sources(artifact.games(), &added)
                }
                IdentifyPackFile::V1(_) => Vec::new(),
            };
            self.database = Some(info);
        }
    }
}

/// The merged outcome of searching the selected packs.
struct ResolvedIdentify {
    matches: Vec<IdentifyTitleMatch>,
    quality: Option<String>,
    evidence: Option<IdentifyEvidence>,
    database: Option<IdentifyDatabaseInfo>,
}

fn checksum_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .map(|value| (key.to_ascii_lowercase(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}
