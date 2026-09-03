use rom_weaver_core::{ComponentRole, Result};

use super::{
    ArtifactFingerprint, ArtifactMatchQuality, ArtifactMatchStatus, ArtifactPackReader,
    FingerprintComponent, match_artifact,
};
use crate::identify_catalog::IdentifySource;
use crate::identify_pack_types::{
    PackComponent, PackComponentRole, PackGame, PackProvenance, UpstreamSource,
};
use crate::identify_pack_v1::{ArtifactPack, encode};

fn pack_component(
    ordinal: u32,
    filename: Option<&str>,
    size: u64,
    crc32: Option<&str>,
    required: bool,
    discriminating: bool,
) -> PackComponent {
    PackComponent {
        role: PackComponentRole::PrimaryPayload,
        ordinal,
        hash_scope: "full_file".to_string(),
        filename: filename.map(str::to_string),
        size,
        crc32: crc32.map(str::to_string),
        md5: None,
        sha1: None,
        sha256: None,
        required,
        discriminating,
        track: None,
        session: None,
    }
}

fn pack_game(name: &str, platform: &str, components: Vec<PackComponent>) -> PackGame {
    PackGame {
        name: name.to_string(),
        platform: platform.to_string(),
        source: IdentifySource::OpenGood,
        upstream_source: UpstreamSource::NoIntro,
        provenance: vec![PackProvenance {
            source: "no-intro".to_string(),
            source_name: None,
            source_url: None,
            source_commit: None,
            license: None,
        }],
        legacy_variant: false,
        dump_tags: vec!["verified".to_string()],
        alternate_names: Vec::new(),
        game_id: None,
        region: None,
        language: None,
        disc_number: None,
        revision: None,
        parent: None,
        components,
    }
}

fn artifact_component(
    ordinal: u32,
    filename: Option<&str>,
    size: u64,
    crc32: Option<&str>,
) -> FingerprintComponent {
    FingerprintComponent {
        role: ComponentRole::PrimaryPayload,
        ordinal,
        hash_scope: "full_file".to_string(),
        size,
        crc32: crc32.map(str::to_string),
        md5: None,
        sha1: None,
        sha256: None,
        filename: filename.map(str::to_string),
    }
}

/// An in-memory pack: `routes` maps a `(crc32, size)` key to the (game, component)
/// pairs the real pack's index would return.
#[derive(Default)]
struct FakePack {
    games: Vec<PackGame>,
    routes: Vec<(RouteKey, Vec<RouteHit>)>,
    route_error: Option<&'static str>,
}

impl FakePack {
    fn with_game(mut self, game: PackGame) -> Self {
        self.games.push(game);
        self
    }

    fn route_to(mut self, crc32: &str, size: u64, hits: &[(u32, u16)]) -> Self {
        self.routes.push(((crc32.to_string(), size), hits.to_vec()));
        self
    }
}

impl ArtifactPackReader for FakePack {
    fn game(&self, index: u32) -> Option<&PackGame> {
        self.games.get(index as usize)
    }

    fn route(&self, crc32_hex: &str, size: u64) -> Result<Vec<(u32, u16)>> {
        if let Some(message) = self.route_error {
            return Err(rom_weaver_core::RomWeaverError::Validation(
                message.to_string(),
            ));
        }
        // The real pack lowercases the query before looking it up.
        let query = crc32_hex.to_ascii_lowercase();
        Ok(self
            .routes
            .iter()
            .find(|((crc, len), _)| *crc == query && *len == size)
            .map(|(_, hits)| hits.clone())
            .unwrap_or_default())
    }
}

#[test]
fn from_single_blob_builds_one_primary_payload_component() {
    let fingerprint =
        ArtifactFingerprint::from_single_blob(2048, Some("aabbccdd"), Some("md5"), Some("sha1"));
    assert_eq!(fingerprint.components.len(), 1);
    let component = &fingerprint.components[0];
    assert_eq!(component.role, ComponentRole::PrimaryPayload);
    assert_eq!(component.ordinal, 0);
    assert_eq!(component.hash_scope, "full_file");
    assert_eq!(component.size, 2048);
    assert_eq!(component.crc32.as_deref(), Some("aabbccdd"));
    assert_eq!(component.md5.as_deref(), Some("md5"));
    assert_eq!(component.sha1.as_deref(), Some("sha1"));
    assert_eq!(component.sha256, None);
    assert_eq!(component.filename, None);

    assert_eq!(ArtifactFingerprint::default().components, Vec::new());
}

#[test]
fn a_single_blob_that_routes_and_verifies_is_an_exact_match() {
    let pack = FakePack::default()
        .with_game(pack_game(
            "Sonic",
            "Sega Mega Drive _ Genesis",
            vec![pack_component(
                0,
                Some("sonic.md"),
                1024,
                Some("aabbccdd"),
                true,
                true,
            )],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("AABBCCDD"), None, None),
    )
    .expect("match");

    assert_eq!(outcome.status, ArtifactMatchStatus::Matched);
    assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Exact));
    assert_eq!(outcome.matches.len(), 1);
    let hit = &outcome.matches[0];
    assert_eq!(hit.name, "Sonic");
    assert_eq!(hit.platform, "Sega Mega Drive _ Genesis");
    assert_eq!(hit.dump_tags, ["verified"]);
    assert!(!hit.legacy_variant);
    assert_eq!(hit.provenance.len(), 1);
    assert!(hit.evidence.layout_matched);
    assert_eq!(hit.evidence.required_components_matched, 1);
    assert_eq!(hit.evidence.required_components_total, 1);
    assert!(hit.evidence.missing.is_empty());
    assert!(hit.evidence.unexpected.is_empty());
}

#[test]
fn real_pack_reader_routes_and_returns_games_through_the_matcher() {
    let encoded = encode(
        "Genesis",
        IdentifySource::OpenGood,
        "test-profile",
        &serde_json::json!([{"source": "no-intro"}]),
        vec![pack_game(
            "Sonic",
            "Genesis",
            vec![pack_component(
                0,
                Some("sonic.md"),
                1024,
                Some("aabbccdd"),
                true,
                true,
            )],
        )],
    )
    .expect("encode pack");
    let pack = ArtifactPack::parse(&encoded).expect("parse pack");

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("AABBCCDD"), None, None),
    )
    .expect("match");

    assert_eq!(outcome.status, ArtifactMatchStatus::Matched);
    assert_eq!(outcome.matches[0].name, "Sonic");
}

#[test]
fn an_artifact_that_routes_nowhere_is_unknown() {
    let pack = FakePack::default().with_game(pack_game(
        "Sonic",
        "Genesis",
        vec![pack_component(0, None, 1024, Some("aabbccdd"), true, true)],
    ));

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("00000000"), None, None),
    )
    .expect("match");
    assert_eq!(outcome.status, ArtifactMatchStatus::Unknown);
    assert_eq!(outcome.quality, None);
    assert!(outcome.matches.is_empty());
}

#[test]
fn components_without_a_crc32_or_with_a_zero_size_are_never_routed() {
    let pack = FakePack::default()
        .with_game(pack_game(
            "Sonic",
            "Genesis",
            vec![pack_component(0, None, 1024, Some("aabbccdd"), true, true)],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    // No crc32 at all: nothing to look up.
    let no_crc = ArtifactFingerprint {
        components: vec![artifact_component(0, None, 1024, None)],
    };
    assert_eq!(
        match_artifact(&pack, &no_crc).expect("match").status,
        ArtifactMatchStatus::Unknown
    );

    // A zero size cannot discriminate, so it is not routed even with a crc32.
    let zero_size = ArtifactFingerprint {
        components: vec![artifact_component(0, None, 0, Some("aabbccdd"))],
    };
    assert_eq!(
        match_artifact(&pack, &zero_size).expect("match").status,
        ArtifactMatchStatus::Unknown
    );
}

#[test]
fn a_route_failure_is_propagated_rather_than_reported_as_unknown() {
    let pack = FakePack {
        route_error: Some("index is corrupt"),
        ..FakePack::default()
    };
    let error = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
    )
    .map(|_| ())
    .expect_err("a broken index must surface");
    assert_eq!(error.to_string(), "validation failed: index is corrupt");
}

#[test]
fn a_route_hit_whose_game_index_is_absent_is_skipped() {
    // The index points at game 9, which the pack does not hold.
    let pack = FakePack::default().route_to("aabbccdd", 1024, &[(9, 0)]);
    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
    )
    .expect("match");
    assert_eq!(outcome.status, ArtifactMatchStatus::Unknown);
}

#[test]
fn a_candidate_with_no_discriminating_match_is_dropped() {
    // The routed component is required but not discriminating, so it cannot by
    // itself identify the game.
    let pack = FakePack::default()
        .with_game(pack_game(
            "Sonic",
            "Genesis",
            vec![pack_component(
                0,
                Some("shared.bin"),
                1024,
                Some("aabbccdd"),
                true,
                false,
            )],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
    )
    .expect("match");
    assert_eq!(outcome.status, ArtifactMatchStatus::Unknown);
    assert!(outcome.matches.is_empty());
}

#[test]
fn a_missing_required_component_demotes_the_match_to_partial() {
    let pack = FakePack::default()
        .with_game(pack_game(
            "Two Disc Game",
            "PlayStation",
            vec![
                pack_component(0, Some("disc1.bin"), 1024, Some("aabbccdd"), true, true),
                pack_component(1, Some("disc2.bin"), 2048, Some("11223344"), true, true),
            ],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
    )
    .expect("match");

    assert_eq!(outcome.status, ArtifactMatchStatus::Matched);
    assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Partial));
    let evidence = &outcome.matches[0].evidence;
    assert!(!evidence.layout_matched);
    assert_eq!(evidence.required_components_matched, 1);
    assert_eq!(evidence.required_components_total, 2);
    assert_eq!(evidence.missing, ["disc2.bin"]);
    assert!(evidence.unexpected.is_empty());
}

#[test]
fn an_unexplained_extra_component_demotes_the_match_and_is_named() {
    let pack = FakePack::default()
        .with_game(pack_game(
            "Sonic",
            "Genesis",
            vec![pack_component(
                0,
                Some("sonic.md"),
                1024,
                Some("aabbccdd"),
                true,
                true,
            )],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let fingerprint = ArtifactFingerprint {
        components: vec![
            artifact_component(0, Some("sonic.md"), 1024, Some("aabbccdd")),
            artifact_component(1, Some("bonus.bin"), 512, Some("deadbeef")),
        ],
    };
    let outcome = match_artifact(&pack, &fingerprint).expect("match");

    assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Partial));
    let evidence = &outcome.matches[0].evidence;
    assert!(!evidence.layout_matched);
    assert_eq!(evidence.required_components_matched, 1);
    assert_eq!(evidence.unexpected, ["bonus.bin"]);
}

#[test]
fn an_unnamed_component_falls_back_to_its_role_and_ordinal() {
    let pack = FakePack::default()
        .with_game(pack_game(
            "Sonic",
            "Genesis",
            vec![
                pack_component(0, None, 1024, Some("aabbccdd"), true, true),
                pack_component(3, None, 4096, Some("cafebabe"), true, true),
            ],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let fingerprint = ArtifactFingerprint {
        components: vec![
            artifact_component(0, None, 1024, Some("aabbccdd")),
            artifact_component(5, None, 512, Some("deadbeef")),
        ],
    };
    let evidence = &match_artifact(&pack, &fingerprint).expect("match").matches[0].evidence;
    assert_eq!(evidence.missing, ["PrimaryPayload#3"]);
    assert_eq!(evidence.unexpected, ["PrimaryPayload#5"]);
}

#[test]
fn two_games_matching_at_the_same_quality_are_ambiguous_and_sorted() {
    let component = |crc: &str| pack_component(0, Some("rom.bin"), 1024, Some(crc), true, true);
    let pack = FakePack::default()
        .with_game(pack_game("Zeta", "SNES", vec![component("aabbccdd")]))
        .with_game(pack_game("Alpha", "SNES", vec![component("aabbccdd")]))
        .with_game(pack_game("Alpha", "NES", vec![component("aabbccdd")]))
        .route_to("aabbccdd", 1024, &[(0, 0), (1, 0), (2, 0)]);

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
    )
    .expect("match");

    assert_eq!(outcome.status, ArtifactMatchStatus::Ambiguous);
    assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Exact));
    // Sorted by (platform, name) so the report order never depends on index order.
    let order = outcome
        .matches
        .iter()
        .map(|hit| (hit.platform.as_str(), hit.name.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        order,
        [("NES", "Alpha"), ("SNES", "Alpha"), ("SNES", "Zeta")]
    );
}

#[test]
fn only_the_best_quality_tier_survives() {
    let pack = FakePack::default()
        .with_game(pack_game(
            "Exact",
            "SNES",
            vec![pack_component(
                0,
                Some("rom.bin"),
                1024,
                Some("aabbccdd"),
                true,
                true,
            )],
        ))
        .with_game(pack_game(
            "Partial",
            "SNES",
            vec![
                pack_component(0, Some("rom.bin"), 1024, Some("aabbccdd"), true, true),
                pack_component(1, Some("extra.bin"), 2048, Some("11223344"), true, true),
            ],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0), (1, 0)]);

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
    )
    .expect("match");

    assert_eq!(outcome.status, ArtifactMatchStatus::Matched);
    assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Exact));
    assert_eq!(outcome.matches.len(), 1);
    assert_eq!(outcome.matches[0].name, "Exact");
}

#[test]
fn a_disagreeing_strong_hash_rejects_a_size_and_crc32_coincidence() {
    let mut component = pack_component(0, Some("rom.bin"), 1024, Some("aabbccdd"), true, true);
    component.sha1 = Some("1111111111111111111111111111111111111111".to_string());
    let pack = FakePack::default()
        .with_game(pack_game("Sonic", "Genesis", vec![component]))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(
            1024,
            Some("aabbccdd"),
            None,
            Some("2222222222222222222222222222222222222222"),
        ),
    )
    .expect("match");
    assert_eq!(outcome.status, ArtifactMatchStatus::Unknown);

    // The same routing succeeds once the strong hash agrees, case-insensitively.
    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(
            1024,
            Some("aabbccdd"),
            None,
            Some("1111111111111111111111111111111111111111"),
        ),
    )
    .expect("match");
    assert_eq!(outcome.status, ArtifactMatchStatus::Matched);
}

#[test]
fn a_component_pair_sharing_no_hash_algorithm_cannot_match() {
    // The pack knows only an sha1; the artifact supplies only a crc32, so there
    // is no shared algorithm to agree on and (size, crc32) alone is not enough.
    let mut component = pack_component(0, Some("rom.bin"), 1024, None, true, true);
    component.sha1 = Some("1111111111111111111111111111111111111111".to_string());
    let pack = FakePack::default()
        .with_game(pack_game("Sonic", "Genesis", vec![component]))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
    )
    .expect("match");
    assert_eq!(outcome.status, ArtifactMatchStatus::Unknown);
}

#[test]
fn a_zero_pack_size_does_not_gate_the_match() {
    // Size 0 in the pack means "unknown upstream", so it must not reject an
    // artifact whose size is known.
    let pack = FakePack::default()
        .with_game(pack_game(
            "Sonic",
            "Genesis",
            vec![pack_component(
                0,
                Some("rom.bin"),
                0,
                Some("aabbccdd"),
                true,
                true,
            )],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
    )
    .expect("match");
    assert_eq!(outcome.status, ArtifactMatchStatus::Matched);

    // A non-zero pack size still gates.
    let strict = FakePack::default()
        .with_game(pack_game(
            "Sonic",
            "Genesis",
            vec![pack_component(
                0,
                Some("rom.bin"),
                4096,
                Some("aabbccdd"),
                true,
                true,
            )],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0)]);
    assert_eq!(
        match_artifact(
            &strict,
            &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None)
        )
        .expect("match")
        .status,
        ArtifactMatchStatus::Unknown
    );
}

#[test]
fn a_whole_file_artifact_may_satisfy_a_track_file_pack_component() {
    // A lone dropped track hashed whole IS that track, so it must resolve to its
    // disc's title; every other scope pairing must agree exactly.
    let mut track = pack_component(
        0,
        Some("disc (Track 1).bin"),
        1024,
        Some("aabbccdd"),
        true,
        true,
    );
    track.hash_scope = "track_file".to_string();
    let pack = FakePack::default()
        .with_game(pack_game("Disc Game", "PlayStation", vec![track]))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
    )
    .expect("match");
    assert_eq!(outcome.status, ArtifactMatchStatus::Matched);

    // The reverse pairing is not allowed.
    let mut disc_scope = pack_component(0, Some("disc.bin"), 1024, Some("aabbccdd"), true, true);
    disc_scope.hash_scope = "disc_image".to_string();
    let strict = FakePack::default()
        .with_game(pack_game("Disc Game", "PlayStation", vec![disc_scope]))
        .route_to("aabbccdd", 1024, &[(0, 0)]);
    assert_eq!(
        match_artifact(
            &strict,
            &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None)
        )
        .expect("match")
        .status,
        ArtifactMatchStatus::Unknown
    );
}

#[test]
fn each_pack_component_consumes_at_most_one_artifact_component() {
    // Two identical artifact components must not both be satisfied by the same
    // single pack component; the leftover shows up as unexpected.
    let pack = FakePack::default()
        .with_game(pack_game(
            "Sonic",
            "Genesis",
            vec![pack_component(
                0,
                Some("rom.bin"),
                1024,
                Some("aabbccdd"),
                true,
                true,
            )],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let fingerprint = ArtifactFingerprint {
        components: vec![
            artifact_component(0, Some("copy-a.bin"), 1024, Some("aabbccdd")),
            artifact_component(1, Some("copy-b.bin"), 1024, Some("aabbccdd")),
        ],
    };
    let outcome = match_artifact(&pack, &fingerprint).expect("match");
    assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Partial));
    assert_eq!(outcome.matches[0].evidence.unexpected, ["copy-b.bin"]);
}

#[test]
fn an_optional_pack_component_is_never_counted_as_required() {
    let pack = FakePack::default()
        .with_game(pack_game(
            "Sonic",
            "Genesis",
            vec![
                pack_component(0, Some("rom.bin"), 1024, Some("aabbccdd"), true, true),
                pack_component(1, Some("manual.pdf"), 2048, Some("11223344"), false, false),
            ],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let outcome = match_artifact(
        &pack,
        &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
    )
    .expect("match");
    let evidence = &outcome.matches[0].evidence;
    assert_eq!(evidence.required_components_total, 1);
    assert_eq!(evidence.required_components_matched, 1);
    assert!(evidence.missing.is_empty());
    assert_eq!(outcome.quality, Some(ArtifactMatchQuality::Exact));
}

#[test]
fn match_outcome_types_round_trip_through_serde() {
    let outcome = match_artifact(
        &FakePack::default()
            .with_game(pack_game(
                "Sonic",
                "Genesis",
                vec![pack_component(
                    0,
                    Some("rom.bin"),
                    1024,
                    Some("aabbccdd"),
                    true,
                    true,
                )],
            ))
            .route_to("aabbccdd", 1024, &[(0, 0)]),
        &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
    )
    .expect("match");

    let json = serde_json::to_string(&outcome).expect("serialize");
    assert!(json.contains("\"status\":\"matched\""), "{json}");
    assert!(json.contains("\"quality\":\"exact\""), "{json}");
    let round_tripped: super::ArtifactMatchOutcome =
        serde_json::from_str(&json).expect("deserialize");
    assert_eq!(round_tripped, outcome);
}

#[test]
fn match_quality_orders_exact_before_partial_before_metadata_only() {
    assert!(ArtifactMatchQuality::Exact < ArtifactMatchQuality::Partial);
    assert!(ArtifactMatchQuality::Partial < ArtifactMatchQuality::MetadataOnly);
}

use crate::trace_capture::TraceCapture;

/// Name plus size of the artifact a route is keyed on.
type RouteKey = (String, u64);
/// One (crc32, crc16) pair a route resolves to.
type RouteHit = (u32, u16);

#[test]
fn the_matcher_explains_every_rejection_through_trace_breadcrumbs() {
    let mut scope_mismatch =
        pack_component(0, Some("scope.bin"), 1024, Some("aabbccdd"), true, true);
    scope_mismatch.hash_scope = "disc_image".to_string();
    let mut hash_disagreement =
        pack_component(0, Some("hash.bin"), 1024, Some("aabbccdd"), true, true);
    hash_disagreement.sha1 = Some("1111111111111111111111111111111111111111".to_string());
    // Only an md5, which this artifact does not carry, so there is no shared
    // algorithm to agree on.
    let mut no_shared_algorithm = pack_component(0, Some("lonely.bin"), 1024, None, true, true);
    no_shared_algorithm.md5 = Some("22222222222222222222222222222222".to_string());

    let pack = FakePack::default()
        .with_game(pack_game("Scope", "SNES", vec![scope_mismatch]))
        .with_game(pack_game(
            "Size",
            "SNES",
            vec![pack_component(
                0,
                Some("size.bin"),
                4096,
                Some("aabbccdd"),
                true,
                true,
            )],
        ))
        .with_game(pack_game("Hash", "SNES", vec![hash_disagreement]))
        .with_game(pack_game("Shared", "SNES", vec![no_shared_algorithm]))
        .route_to("aabbccdd", 1024, &[(0, 0), (1, 0), (2, 0), (3, 0)]);

    let fingerprint = ArtifactFingerprint::from_single_blob(
        1024,
        Some("aabbccdd"),
        None,
        Some("3333333333333333333333333333333333333333"),
    );

    let capture = TraceCapture::default();
    let outcome = capture.record(|| match_artifact(&pack, &fingerprint).expect("match"));
    assert_eq!(outcome.status, ArtifactMatchStatus::Unknown);

    capture.assert_contains_all(&[
        "routed artifact component",
        "route hit",
        "component rejected: hash scope mismatch",
        "component rejected: size mismatch",
        "component rejected: hash disagreement",
        "component rejected: the artifact and the pack share no hash algorithm",
        "candidate dropped: no discriminating required component matched",
    ]);
}

#[test]
fn unrouted_and_verified_components_are_both_traced() {
    let pack = FakePack::default()
        .with_game(pack_game(
            "Sonic",
            "Genesis",
            vec![pack_component(
                0,
                Some("rom.bin"),
                1024,
                Some("aabbccdd"),
                true,
                true,
            )],
        ))
        .route_to("aabbccdd", 1024, &[(0, 0)]);

    let fingerprint = ArtifactFingerprint {
        components: vec![
            artifact_component(0, Some("rom.bin"), 1024, Some("aabbccdd")),
            artifact_component(1, Some("no-crc.bin"), 512, None),
            artifact_component(2, Some("zero.bin"), 0, Some("deadbeef")),
        ],
    };

    let capture = TraceCapture::default();
    let outcome = capture.record(|| match_artifact(&pack, &fingerprint).expect("match"));
    assert_eq!(outcome.status, ArtifactMatchStatus::Matched);

    capture.assert_contains_all(&[
        "component not routed: it has no crc32",
        "component not routed: its size is 0",
        "candidate verified",
    ]);
}

#[test]
fn an_artifact_unknown_to_the_pack_traces_what_it_queried() {
    let capture = TraceCapture::default();
    let outcome = capture.record(|| {
        match_artifact(
            &FakePack::default(),
            &ArtifactFingerprint::from_single_blob(1024, Some("aabbccdd"), None, None),
        )
        .expect("match")
    });
    assert_eq!(outcome.status, ArtifactMatchStatus::Unknown);
    capture.assert_contains_all(&[
        "no routed candidates; artifact is unknown to this pack",
        "queried=aabbccdd/1024",
    ]);
}
