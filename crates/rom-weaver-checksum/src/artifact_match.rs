//! Set-aware matching of a hashed artifact against one RWFP2 pack.
//!
//! An artifact fingerprint carries every hashed component of one input (a
//! single blob, a track set, a partition set, ...). The matcher routes each
//! component through the pack's (crc32, size) index, unions the candidate
//! games, then verifies every required pack component against the artifact.

use std::collections::BTreeSet;

use rom_weaver_core::{ComponentRole, Result};
use serde::{Deserialize, Serialize};
use tracing::trace;

use crate::identify_pack_v2::{ArtifactPack, PackComponent, PackGame, PackProvenance};

/// One hashed component of the artifact being identified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FingerprintComponent {
    pub role: ComponentRole,
    pub ordinal: u32,
    pub hash_scope: String,
    pub size: u64,
    pub crc32: Option<String>,
    pub md5: Option<String>,
    pub sha1: Option<String>,
    pub sha256: Option<String>,
    pub filename: Option<String>,
}

/// The full hashed shape of one input artifact.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ArtifactFingerprint {
    pub components: Vec<FingerprintComponent>,
}

impl ArtifactFingerprint {
    /// The single-file case: one primary-payload component.
    pub fn from_single_blob(
        size: u64,
        crc32: Option<&str>,
        md5: Option<&str>,
        sha1: Option<&str>,
    ) -> Self {
        Self {
            components: vec![FingerprintComponent {
                role: ComponentRole::PrimaryPayload,
                ordinal: 0,
                hash_scope: "full_file".to_string(),
                size,
                crc32: crc32.map(str::to_string),
                md5: md5.map(str::to_string),
                sha1: sha1.map(str::to_string),
                sha256: None,
                filename: None,
            }],
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactMatchStatus {
    Matched,
    Ambiguous,
    Unknown,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactMatchQuality {
    Exact,
    Partial,
    MetadataOnly,
}

/// Why one candidate game did or did not match.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct MatchEvidence {
    pub required_components_matched: u32,
    pub required_components_total: u32,
    pub layout_matched: bool,
    /// Names of required pack components the artifact does not supply.
    pub missing: Vec<String>,
    /// Names of artifact components the candidate game does not explain.
    pub unexpected: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactGameMatch {
    pub name: String,
    pub platform: String,
    pub provenance: Vec<PackProvenance>,
    pub legacy_variant: bool,
    pub dump_tags: Vec<String>,
    pub evidence: MatchEvidence,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct ArtifactMatchOutcome {
    pub status: ArtifactMatchStatus,
    pub quality: Option<ArtifactMatchQuality>,
    pub matches: Vec<ArtifactGameMatch>,
}

fn unknown_outcome() -> ArtifactMatchOutcome {
    ArtifactMatchOutcome {
        status: ArtifactMatchStatus::Unknown,
        quality: None,
        matches: Vec::new(),
    }
}

/// True when the artifact component's hashes are consistent with the pack
/// component's. A disagreeing strong hash (md5/sha1/sha256) rejects a (size,
/// crc32) coincidence; at least one shared hash must agree.
fn component_matches(artifact: &FingerprintComponent, pack: &PackComponent) -> bool {
    if artifact.hash_scope != pack.hash_scope {
        return false;
    }
    // A pack size of 0 means the size is unknown upstream and cannot gate.
    if pack.size != 0 && artifact.size != pack.size {
        return false;
    }
    let mut agreements = 0usize;
    for (ours, theirs) in [
        (&artifact.crc32, &pack.crc32),
        (&artifact.md5, &pack.md5),
        (&artifact.sha1, &pack.sha1),
        (&artifact.sha256, &pack.sha256),
    ] {
        if let (Some(ours), Some(theirs)) = (ours, theirs) {
            if !ours.eq_ignore_ascii_case(theirs) {
                return false;
            }
            agreements += 1;
        }
    }
    agreements > 0
}

/// A display name for a component in `missing`/`unexpected` reports.
fn pack_component_name(component: &PackComponent) -> String {
    component
        .filename
        .clone()
        .unwrap_or_else(|| format!("{:?}#{}", component.role, component.ordinal))
}

fn fingerprint_component_name(component: &FingerprintComponent) -> String {
    component
        .filename
        .clone()
        .unwrap_or_else(|| format!("{:?}#{}", component.role, component.ordinal))
}

struct CandidateVerification {
    quality: ArtifactMatchQuality,
    evidence: MatchEvidence,
}

/// Verify one candidate game against the whole artifact. `None` drops the
/// candidate (no discriminating required component matched at all).
fn verify_candidate(
    game: &PackGame,
    fingerprint: &ArtifactFingerprint,
) -> Option<CandidateVerification> {
    let mut consumed = vec![false; fingerprint.components.len()];
    let mut required_total = 0u32;
    let mut required_matched = 0u32;
    let mut discriminating_matched = false;
    let mut missing = Vec::new();

    for pack_component in &game.components {
        let matched_index =
            fingerprint
                .components
                .iter()
                .enumerate()
                .position(|(index, artifact_component)| {
                    !consumed[index] && component_matches(artifact_component, pack_component)
                });
        if let Some(index) = matched_index {
            consumed[index] = true;
        }
        if pack_component.required {
            required_total += 1;
            if matched_index.is_some() {
                required_matched += 1;
                if pack_component.discriminating {
                    discriminating_matched = true;
                }
            } else {
                missing.push(pack_component_name(pack_component));
            }
        }
    }
    if !discriminating_matched {
        trace!(game = %game.name, "candidate dropped: only non-discriminating components matched");
        return None;
    }

    // Any leftover artifact component with a crc32 is unexplained by this
    // game and demotes an exact match to partial.
    let unexpected: Vec<String> = fingerprint
        .components
        .iter()
        .enumerate()
        .filter(|(index, component)| !consumed[*index] && component.crc32.is_some())
        .map(|(_, component)| fingerprint_component_name(component))
        .collect();

    let all_required_matched = required_matched == required_total && required_total > 0;
    let layout_matched = all_required_matched && unexpected.is_empty();
    let quality = if layout_matched {
        ArtifactMatchQuality::Exact
    } else {
        ArtifactMatchQuality::Partial
    };
    trace!(
        game = %game.name,
        required_matched,
        required_total,
        unexpected = unexpected.len(),
        ?quality,
        "candidate verified"
    );
    Some(CandidateVerification {
        quality,
        evidence: MatchEvidence {
            required_components_matched: required_matched,
            required_components_total: required_total,
            layout_matched,
            missing,
            unexpected,
        },
    })
}

/// Match an artifact fingerprint against one pack. Deterministic: candidates
/// come from an ordered set and the result is sorted by (platform, name).
pub fn match_artifact(
    pack: &ArtifactPack,
    fingerprint: &ArtifactFingerprint,
) -> Result<ArtifactMatchOutcome> {
    let mut candidates: BTreeSet<u32> = BTreeSet::new();
    for component in &fingerprint.components {
        let Some(crc32) = component.crc32.as_deref() else {
            continue;
        };
        if component.size == 0 {
            continue;
        }
        for (game_index, component_index) in pack.route(crc32, component.size)? {
            trace!(
                crc32,
                size = component.size,
                game_index,
                component_index,
                "routed artifact component"
            );
            candidates.insert(game_index);
        }
    }
    if candidates.is_empty() {
        trace!("no routed candidates; artifact is unknown to this pack");
        return Ok(unknown_outcome());
    }

    let mut verified: Vec<(ArtifactMatchQuality, ArtifactGameMatch)> = Vec::new();
    for game_index in candidates {
        let Some(game) = pack.game(game_index) else {
            continue;
        };
        if let Some(result) = verify_candidate(game, fingerprint) {
            verified.push((
                result.quality,
                ArtifactGameMatch {
                    name: game.name.clone(),
                    platform: game.platform.clone(),
                    provenance: game.provenance.clone(),
                    legacy_variant: game.legacy_variant,
                    dump_tags: game.dump_tags.clone(),
                    evidence: result.evidence,
                },
            ));
        }
    }
    if verified.is_empty() {
        return Ok(unknown_outcome());
    }

    // Keep only the best quality tier, then sort for a stable report order.
    let best_quality = verified
        .iter()
        .map(|(quality, _)| *quality)
        .min()
        .expect("verified is non-empty");
    let mut matches: Vec<ArtifactGameMatch> = verified
        .into_iter()
        .filter(|(quality, _)| *quality == best_quality)
        .map(|(_, game_match)| game_match)
        .collect();
    matches.sort_by(|a, b| (&a.platform, &a.name).cmp(&(&b.platform, &b.name)));

    let status = if matches.len() > 1 {
        ArtifactMatchStatus::Ambiguous
    } else {
        ArtifactMatchStatus::Matched
    };
    Ok(ArtifactMatchOutcome {
        status,
        quality: Some(best_quality),
        matches,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identify_pack_v2::tests::{
        build_pack_container, build_refs, build_route, component_json, game_json, manifest_json,
    };

    const SHA1_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA1_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn crc_bytes(hex: &str) -> [u8; 4] {
        let mut out = [0u8; 4];
        for index in 0..4 {
            out[index] = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap();
        }
        out
    }

    /// Build a pack from `(name, components)` games, routing every
    /// discriminating component with a crc32 and a size.
    fn pack_from_games(games: Vec<(&str, Vec<serde_json::Value>)>) -> ArtifactPack {
        let mut refs: Vec<(u32, u16)> = Vec::new();
        let mut route_map: std::collections::BTreeMap<([u8; 4], u64), Vec<u32>> =
            Default::default();
        for (game_index, (_, components)) in games.iter().enumerate() {
            for (component_index, component) in components.iter().enumerate() {
                let discriminating = component["discriminating"].as_bool().unwrap();
                let size = component["size"].as_u64().unwrap();
                let crc32 = component["crc32"].as_str();
                if discriminating
                    && size > 0
                    && let Some(crc32) = crc32
                {
                    let ref_id = refs.len() as u32;
                    refs.push((game_index as u32, component_index as u16));
                    route_map
                        .entry((crc_bytes(crc32), size))
                        .or_default()
                        .push(ref_id);
                }
            }
        }
        let games_json = serde_json::to_vec(
            &games
                .iter()
                .map(|(name, components)| game_json(name, "Test Platform", components.clone()))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let bytes = build_pack_container(&[
            ("games.json", games_json),
            ("route.bin", build_route(route_map.into_iter().collect())),
            ("refs.bin", build_refs(&refs)),
            ("manifest.json", manifest_json("Test Platform")),
        ]);
        ArtifactPack::parse(&bytes).expect("test pack parses")
    }

    fn fingerprint(components: Vec<(u64, &str, Option<&str>)>) -> ArtifactFingerprint {
        ArtifactFingerprint {
            components: components
                .into_iter()
                .enumerate()
                .map(|(index, (size, crc32, sha1))| FingerprintComponent {
                    role: ComponentRole::DataTrack,
                    ordinal: index as u32,
                    hash_scope: "full_file".to_string(),
                    size,
                    crc32: Some(crc32.to_string()),
                    md5: None,
                    sha1: sha1.map(str::to_string),
                    sha256: None,
                    filename: None,
                })
                .collect(),
        }
    }

    #[test]
    fn matches_an_exact_single_component_game() {
        let pack = pack_from_games(vec![(
            "Solo",
            vec![component_json(
                "primary_payload",
                0,
                4,
                Some("aabbccdd"),
                None,
                true,
                true,
            )],
        )]);
        let outcome = match_artifact(
            &pack,
            &ArtifactFingerprint::from_single_blob(4, Some("aabbccdd"), None, None),
        )
        .unwrap();
        assert_eq!(outcome.status, ArtifactMatchStatus::Matched);
        assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Exact));
        assert_eq!(outcome.matches.len(), 1);
        assert_eq!(outcome.matches[0].name, "Solo");
        assert!(outcome.matches[0].evidence.layout_matched);
    }

    #[test]
    fn matches_an_exact_multicomponent_game() {
        let pack = pack_from_games(vec![(
            "Disc",
            vec![
                component_json("data_track", 0, 100, Some("11111111"), None, true, true),
                component_json("audio_track", 1, 200, Some("22222222"), None, true, false),
            ],
        )]);
        let outcome = match_artifact(
            &pack,
            &fingerprint(vec![(100, "11111111", None), (200, "22222222", None)]),
        )
        .unwrap();
        assert_eq!(outcome.status, ArtifactMatchStatus::Matched);
        assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Exact));
        assert_eq!(outcome.matches[0].evidence.required_components_matched, 2);
        assert_eq!(outcome.matches[0].evidence.required_components_total, 2);
    }

    #[test]
    fn missing_required_track_is_a_partial_match() {
        let pack = pack_from_games(vec![(
            "Disc",
            vec![
                component_json("data_track", 0, 100, Some("11111111"), None, true, true),
                component_json("audio_track", 1, 200, Some("22222222"), None, true, false),
            ],
        )]);
        let outcome = match_artifact(&pack, &fingerprint(vec![(100, "11111111", None)])).unwrap();
        assert_eq!(outcome.status, ArtifactMatchStatus::Matched);
        assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Partial));
        let evidence = &outcome.matches[0].evidence;
        assert_eq!(evidence.required_components_matched, 1);
        assert_eq!(evidence.missing, vec!["AudioTrack#1".to_string()]);
        assert!(!evidence.layout_matched);
    }

    #[test]
    fn shared_non_discriminating_component_alone_is_unknown() {
        // The shared audio track is non-discriminating, so it is not routed
        // and cannot produce a candidate on its own.
        let pack = pack_from_games(vec![(
            "Disc",
            vec![
                component_json("data_track", 0, 100, Some("11111111"), None, true, true),
                component_json("audio_track", 1, 200, Some("22222222"), None, true, false),
            ],
        )]);
        let outcome = match_artifact(&pack, &fingerprint(vec![(200, "22222222", None)])).unwrap();
        assert_eq!(outcome.status, ArtifactMatchStatus::Unknown);
        assert!(outcome.matches.is_empty());
    }

    #[test]
    fn unexpected_component_demotes_exact_to_partial_and_is_reported() {
        let pack = pack_from_games(vec![(
            "Disc",
            vec![component_json(
                "data_track",
                0,
                100,
                Some("11111111"),
                None,
                true,
                true,
            )],
        )]);
        let outcome = match_artifact(
            &pack,
            &fingerprint(vec![(100, "11111111", None), (999, "deadbeef", None)]),
        )
        .unwrap();
        assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Partial));
        let evidence = &outcome.matches[0].evidence;
        assert_eq!(evidence.unexpected, vec!["DataTrack#1".to_string()]);
        assert!(!evidence.layout_matched);
        assert_eq!(evidence.required_components_matched, 1);
    }

    #[test]
    fn identical_revisions_are_ambiguous_and_sorted() {
        let component = component_json("primary_payload", 0, 4, Some("aabbccdd"), None, true, true);
        let pack = pack_from_games(vec![
            ("Rev B", vec![component.clone()]),
            ("Rev A", vec![component]),
        ]);
        let outcome = match_artifact(
            &pack,
            &ArtifactFingerprint::from_single_blob(4, Some("aabbccdd"), None, None),
        )
        .unwrap();
        assert_eq!(outcome.status, ArtifactMatchStatus::Ambiguous);
        let names: Vec<_> = outcome.matches.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Rev A", "Rev B"]);
    }

    #[test]
    fn strong_hash_mismatch_rejects_a_size_and_crc_match() {
        let pack = pack_from_games(vec![(
            "Solo",
            vec![component_json(
                "primary_payload",
                0,
                4,
                Some("aabbccdd"),
                Some(SHA1_A),
                true,
                true,
            )],
        )]);
        let outcome = match_artifact(
            &pack,
            &ArtifactFingerprint::from_single_blob(4, Some("aabbccdd"), None, Some(SHA1_B)),
        )
        .unwrap();
        assert_eq!(outcome.status, ArtifactMatchStatus::Unknown);

        let agreeing = match_artifact(
            &pack,
            &ArtifactFingerprint::from_single_blob(4, Some("aabbccdd"), None, Some(SHA1_A)),
        )
        .unwrap();
        assert_eq!(agreeing.status, ArtifactMatchStatus::Matched);
        assert_eq!(agreeing.quality, Some(ArtifactMatchQuality::Exact));
    }

    #[test]
    fn hash_scope_mismatch_rejects_a_routed_candidate() {
        let mut component =
            component_json("primary_payload", 0, 4, Some("aabbccdd"), None, true, true);
        component["hashScope"] = serde_json::json!("headerless");
        let pack = pack_from_games(vec![("Headerless", vec![component])]);

        let outcome = match_artifact(
            &pack,
            &ArtifactFingerprint::from_single_blob(4, Some("aabbccdd"), None, None),
        )
        .unwrap();

        assert_eq!(outcome.status, ArtifactMatchStatus::Unknown);
    }

    #[test]
    fn exact_match_wins_over_a_partial_candidate() {
        let shared = component_json("data_track", 0, 100, Some("11111111"), None, true, true);
        let pack = pack_from_games(vec![
            ("Exact", vec![shared.clone()]),
            (
                "Partial",
                vec![
                    shared,
                    component_json("data_track", 1, 300, Some("33333333"), None, true, true),
                ],
            ),
        ]);
        let outcome = match_artifact(&pack, &fingerprint(vec![(100, "11111111", None)])).unwrap();
        assert_eq!(outcome.status, ArtifactMatchStatus::Matched);
        assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Exact));
        assert_eq!(outcome.matches[0].name, "Exact");
    }
}
