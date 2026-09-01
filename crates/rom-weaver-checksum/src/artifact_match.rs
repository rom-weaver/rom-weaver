//! Set-aware matching of a hashed artifact against one artifact pack.
//!
//! An artifact fingerprint carries every hashed component of one input (a
//! single blob, a track set, a partition set, ...). The matcher routes each
//! component through the pack's (crc32, size) index, unions the candidate
//! games, then verifies every required pack component against the artifact.

use std::collections::BTreeSet;

use rom_weaver_core::{ComponentRole, Result};
use serde::{Deserialize, Serialize};
use tracing::trace;

use crate::identify_pack_types::{PackComponent, PackGame, PackProvenance};

/// The read-only pack operations needed by the artifact matcher.
pub trait ArtifactPackReader {
    fn game(&self, index: u32) -> Option<&PackGame>;
    fn route(&self, crc32_hex: &str, size: u64) -> Result<Vec<(u32, u16)>>;
}
impl ArtifactPackReader for crate::identify_pack_v1::ArtifactPack {
    fn game(&self, index: u32) -> Option<&PackGame> {
        self.game(index)
    }

    fn route(&self, crc32_hex: &str, size: u64) -> Result<Vec<(u32, u16)>> {
        self.route(crc32_hex, size)
    }
}

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
    // A bare file hashed whole IS a track file when its bytes are that track -
    // size and hashes gate below exactly as they would for a matching scope -
    // so a `full_file` artifact may satisfy a `track_file` pack component. This
    // lets a lone dropped track resolve to its disc's title. Every other scope
    // pairing must agree exactly.
    let scope_compatible = artifact.hash_scope == pack.hash_scope
        || (artifact.hash_scope == "full_file" && pack.hash_scope == "track_file");
    if !scope_compatible {
        trace!(
            artifact_scope = %artifact.hash_scope,
            pack_scope = %pack.hash_scope,
            pack_component = %pack_component_name(pack),
            "component rejected: hash scope mismatch"
        );
        return false;
    }
    // A pack size of 0 means the size is unknown upstream and cannot gate.
    if pack.size != 0 && artifact.size != pack.size {
        trace!(
            artifact_size = artifact.size,
            pack_size = pack.size,
            pack_component = %pack_component_name(pack),
            "component rejected: size mismatch"
        );
        return false;
    }
    let mut agreements = 0usize;
    for (name, ours, theirs) in [
        ("crc32", &artifact.crc32, &pack.crc32),
        ("md5", &artifact.md5, &pack.md5),
        ("sha1", &artifact.sha1, &pack.sha1),
        ("sha256", &artifact.sha256, &pack.sha256),
    ] {
        if let (Some(ours), Some(theirs)) = (ours, theirs) {
            if !ours.eq_ignore_ascii_case(theirs) {
                trace!(
                    algorithm = name,
                    artifact_hash = %ours,
                    pack_hash = %theirs,
                    pack_component = %pack_component_name(pack),
                    "component rejected: hash disagreement"
                );
                return false;
            }
            agreements += 1;
        }
    }
    if agreements == 0 {
        trace!(
            pack_component = %pack_component_name(pack),
            "component rejected: the artifact and the pack share no hash algorithm"
        );
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
        trace!(
            game = %game.name,
            required_matched,
            required_total,
            "candidate dropped: no discriminating required component matched"
        );
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
pub fn match_artifact<P: ArtifactPackReader + ?Sized>(
    pack: &P,
    fingerprint: &ArtifactFingerprint,
) -> Result<ArtifactMatchOutcome> {
    let mut candidates: BTreeSet<u32> = BTreeSet::new();
    let mut queried: Vec<String> = Vec::new();
    for component in &fingerprint.components {
        let Some(crc32) = component.crc32.as_deref() else {
            trace!(
                component = %fingerprint_component_name(component),
                size = component.size,
                "component not routed: it has no crc32"
            );
            continue;
        };
        if component.size == 0 {
            trace!(
                component = %fingerprint_component_name(component),
                crc32,
                "component not routed: its size is 0"
            );
            continue;
        }
        queried.push(format!("{crc32}/{}", component.size));
        let routed = pack.route(crc32, component.size)?;
        trace!(
            crc32,
            size = component.size,
            routed = routed.len(),
            "routed artifact component"
        );
        for (game_index, component_index) in routed {
            trace!(crc32, game_index, component_index, "route hit");
            candidates.insert(game_index);
        }
    }
    if candidates.is_empty() {
        trace!(
            queried = queried.join(","),
            "no routed candidates; artifact is unknown to this pack"
        );
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
#[path = "../tests/unit/artifact_match.rs"]
mod tests;
