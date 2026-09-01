use std::sync::Arc;

use rom_weaver_checksum::artifact_match::{
    ArtifactGameMatch, ArtifactMatchOutcome, ArtifactMatchQuality, ArtifactMatchStatus,
    MatchEvidence,
};
use rom_weaver_checksum::identify_pack_types::{
    PackComponent, PackComponentRole, PackGame, PackProvenance, UpstreamSource,
};
use rom_weaver_core::RecordingProgressSink;

use super::*;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

struct SilentPrompter;

impl SelectionPrompter for SilentPrompter {
    fn select(&self, _heading: &str, _candidates: &[PromptCandidate]) -> Selection {
        Selection::Cancelled
    }

    fn select_many(&self, _heading: &str, _candidates: &[PromptCandidate]) -> SelectionList {
        SelectionList::Cancelled
    }

    fn confirm(&self, _heading: &str, _details: &[String]) -> bool {
        false
    }
}

/// A CliApp plus the sink that captures the terminal report of each command.
fn recording_app() -> (CliApp, Arc<RecordingProgressSink>) {
    let sink = Arc::new(RecordingProgressSink::default());
    let app = CliApp::new(
        Arc::clone(&sink) as Arc<dyn ProgressSink>,
        Arc::new(SilentPrompter),
        false,
        false,
        false,
    );
    (app, sink)
}

/// The `identify` detail object of the last emitted report.
fn identify_details(sink: &RecordingProgressSink) -> Value {
    let event = sink
        .snapshot()
        .into_iter()
        .next_back()
        .expect("a terminal report was emitted");
    event
        .details
        .expect("the identify report carries details")
        .get("identify")
        .cloned()
        .expect("the details carry an identify object")
}

fn last_label(sink: &RecordingProgressSink) -> String {
    sink.snapshot()
        .into_iter()
        .next_back()
        .expect("a terminal report was emitted")
        .label
}

fn crc32_hex(bytes: &[u8]) -> String {
    let mut crc = flate2::Crc::new();
    crc.update(bytes);
    format!("{:08x}", crc.sum())
}

fn component(size: u64, crc32: &str) -> PackComponent {
    PackComponent {
        role: PackComponentRole::PrimaryPayload,
        ordinal: 0,
        hash_scope: "full_file".to_string(),
        filename: None,
        size,
        crc32: Some(crc32.to_string()),
        md5: None,
        sha1: None,
        sha256: None,
        required: true,
        discriminating: true,
        track: None,
        session: None,
    }
}

fn game(name: &str, platform: &str, components: Vec<PackComponent>) -> PackGame {
    PackGame {
        name: name.to_string(),
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
    }
}

fn pack_bytes(platform: &str, profile: &str, games: Vec<PackGame>) -> Vec<u8> {
    rom_weaver_checksum::identify_pack_v1::encode(
        platform,
        IdentifySource::Redump,
        profile,
        &json!([]),
        games,
    )
    .expect("RWFP1 pack")
}

fn parsed_pack(platform: &str, profile: &str, games: Vec<PackGame>) -> IdentifyPackFile {
    IdentifyPackFile::parse(&pack_bytes(platform, profile, games)).expect("parsed RWFP1 pack")
}

fn loaded_pack(name: &str, platform: &str, profile: &str, games: Vec<PackGame>) -> Rc<LoadedPack> {
    Rc::new(LoadedPack {
        name: name.to_string(),
        file: parsed_pack(platform, profile, games),
    })
}

fn artifact_match(name: &str, platform: &str) -> ArtifactGameMatch {
    ArtifactGameMatch {
        name: name.to_string(),
        platform: platform.to_string(),
        provenance: Vec::new(),
        legacy_variant: false,
        dump_tags: Vec::new(),
        evidence: MatchEvidence {
            required_components_matched: 1,
            required_components_total: 1,
            layout_matched: true,
            missing: Vec::new(),
            unexpected: Vec::new(),
        },
    }
}

fn outcome(matches: Vec<ArtifactGameMatch>) -> ArtifactMatchOutcome {
    ArtifactMatchOutcome {
        status: if matches.len() == 1 {
            ArtifactMatchStatus::Matched
        } else {
            ArtifactMatchStatus::Ambiguous
        },
        quality: Some(ArtifactMatchQuality::Exact),
        matches,
    }
}

fn identify_args(input: Option<PathBuf>, database: Vec<PathBuf>) -> IdentifyCommand {
    IdentifyCommand {
        input,
        hash: None,
        database,
        system: None,
        offline: false,
        database_dir: None,
        exhaustive_database_search: false,
        subcommand: None,
        select: Vec::new(),
        filter: Vec::new(),
        no_extract: false,
        no_ignore: false,
        no_trim_fix: false,
        threads: ThreadBudget::Fixed(1),
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

#[test]
fn checksum_map_lowercases_keys_and_drops_non_strings() {
    let map = checksum_map(Some(
        &json!({ "CRC32": "aabbccdd", "size": 12, "MD5": "ff" }),
    ));
    assert_eq!(
        map,
        BTreeMap::from([
            ("crc32".to_string(), "aabbccdd".to_string()),
            ("md5".to_string(), "ff".to_string()),
        ])
    );
    assert!(checksum_map(None).is_empty());
    assert!(checksum_map(Some(&json!([1, 2]))).is_empty());
}

#[test]
fn lookup_result_status_follows_the_match_count() {
    assert_eq!(
        identify_lookup_result(Vec::new()).status,
        IdentifyStatus::Unknown
    );
    let one = identify_lookup_result(vec![title_match("A", "P", "raw")]);
    assert_eq!(one.status, IdentifyStatus::Matched);
    let two = identify_lookup_result(vec![
        title_match("B", "P", "raw"),
        title_match("A", "P", "raw"),
    ]);
    assert_eq!(two.status, IdentifyStatus::Ambiguous);
    // Sorted by (platform, name, variant).
    assert_eq!(two.matches[0].name, "A");
}

fn title_match(name: &str, platform: &str, variant: &str) -> IdentifyTitleMatch {
    IdentifyTitleMatch {
        name: name.to_string(),
        platform: platform.to_string(),
        algorithm: "components".to_string(),
        variant: variant.to_string(),
        database: "test.pack".to_string(),
        provenance: Vec::new(),
        legacy_variant: false,
        dump_tags: Vec::new(),
    }
}

#[test]
fn detected_platform_candidates_add_the_ambiguous_cartridge_twin() {
    assert!(detected_platform_candidates(None, false).is_empty());

    let game_boy = detected_platform_candidates(Some(platform_names::GAME_BOY), false);
    assert_eq!(
        game_boy
            .iter()
            .map(|candidate| candidate.platform.as_str())
            .collect::<Vec<_>>(),
        vec![platform_names::GAME_BOY, platform_names::GAME_BOY_COLOR]
    );
    assert_eq!(game_boy[0].evidence, DetectionEvidence::HeaderMagic);

    let master_system = detected_platform_candidates(Some(platform_names::MASTER_SYSTEM), false);
    assert_eq!(master_system[1].platform, platform_names::GAME_GEAR);

    let neo_geo = detected_platform_candidates(Some(platform_names::NEO_GEO_POCKET), false);
    assert_eq!(neo_geo[1].platform, platform_names::NEO_GEO_POCKET_COLOR);

    let disc = detected_platform_candidates(Some("Sony PlayStation"), true);
    assert_eq!(disc.len(), 1);
    assert_eq!(disc[0].evidence, DetectionEvidence::SystemAreaMagic);
    assert_eq!(disc[0].confidence, DetectionConfidence::Strong);
}

#[test]
fn source_and_quality_labels_cover_every_variant() {
    assert_eq!(source_label(IdentifySource::Libretro), "libretro");
    assert_eq!(source_label(IdentifySource::OpenGood), "opengood");
    assert_eq!(source_label(IdentifySource::Redump), "redump");
    assert_eq!(quality_label(ArtifactMatchQuality::Exact), "exact");
    assert_eq!(quality_label(ArtifactMatchQuality::Partial), "partial");
    assert_eq!(
        quality_label(ArtifactMatchQuality::MetadataOnly),
        "metadata_only"
    );
}

#[test]
fn profile_needs_tracks_only_for_per_track_cd_profiles() {
    assert!(profile_needs_tracks("redump-cd-track-v1"));
    assert!(profile_needs_tracks("redump-gdrom-track-v1"));
    assert!(!profile_needs_tracks("nointro-single-image-v1"));
}

#[test]
fn database_info_reports_the_pack_source_and_profile() {
    let pack = loaded_pack(
        "psx.pack",
        "Sony PlayStation",
        "nointro-single-image-v1",
        vec![game(
            "A",
            "Sony PlayStation",
            vec![component(16, "aabbccdd")],
        )],
    );
    let info = database_info_for(&pack, None);
    assert_eq!(info.source.as_deref(), Some("redump"));
    assert_eq!(info.pack_format, "RWFP1");
    assert_eq!(
        info.canonicalization_profile.as_deref(),
        Some("nointro-single-image-v1")
    );
    assert!(info.upstream_sources.is_empty());
    assert!(info.revision.is_none());
}

#[test]
fn matched_upstream_sources_labels_every_known_source_and_skips_unknown() {
    let sources = [
        (UpstreamSource::Libretro, "libretro"),
        (UpstreamSource::Redump, "redump"),
        (UpstreamSource::NoIntro, "no-intro"),
        (UpstreamSource::Tosec, "tosec"),
        (UpstreamSource::Mame, "mame"),
        (UpstreamSource::Fbneo, "fbneo"),
        (UpstreamSource::OpenGood, "opengood"),
    ];
    let games: Vec<PackGame> = sources
        .iter()
        .enumerate()
        .map(|(index, (source, _))| {
            let mut record = game(
                &format!("Game {index}"),
                "P",
                vec![component(16, "aabbccdd")],
            );
            record.upstream_source = *source;
            record
        })
        .chain(std::iter::once({
            let mut unknown = game("Unknown", "P", vec![component(16, "aabbccdd")]);
            unknown.upstream_source = UpstreamSource::Unknown;
            unknown
        }))
        .collect();
    let matched: Vec<(String, String)> = games
        .iter()
        .map(|game| (game.name.clone(), game.platform.clone()))
        .collect();

    let mut expected: Vec<&str> = sources.iter().map(|(_, label)| *label).collect();
    expected.sort_unstable();
    assert_eq!(matched_upstream_sources(&games, &matched), expected);

    // A game the match list does not name contributes nothing.
    assert!(
        matched_upstream_sources(&games, &[("absent".to_string(), "P".to_string())]).is_empty()
    );
}

#[test]
fn variant_payload_size_subtracts_only_a_header_strip() {
    let raw = json!({ "id": "raw" });
    assert_eq!(variant_payload_size(&raw, Some(512)), Some(512));
    let stripped = json!({
        "id": "remove-header",
        "transforms": { "removeHeader": { "strippedBytes": 512 } },
    });
    assert_eq!(variant_payload_size(&stripped, Some(1024)), Some(512));
    // A strip that consumes the whole payload, and one larger than it, yield nothing.
    assert_eq!(variant_payload_size(&stripped, Some(512)), None);
    assert_eq!(variant_payload_size(&stripped, Some(16)), None);
    assert_eq!(variant_payload_size(&raw, None), None);
}

#[test]
fn single_blob_match_needs_a_positive_payload_size() {
    let pack = parsed_pack(
        "P",
        "nointro-single-image-v1",
        vec![game("A", "P", vec![component(16, "aabbccdd")])],
    );
    let IdentifyPackFile::V1(artifact) = &pack;
    let checksums = BTreeMap::from([("crc32".to_string(), "aabbccdd".to_string())]);
    assert!(
        match_single_blob("test.pack", artifact, None, &checksums)
            .expect("lookup")
            .is_none()
    );
    assert!(
        match_single_blob("test.pack", artifact, Some(0), &checksums)
            .expect("lookup")
            .is_none()
    );
    let hit = match_single_blob("test.pack", artifact, Some(16), &checksums)
        .expect("lookup")
        .expect("a positive size produces an outcome");
    assert_eq!(hit.status, ArtifactMatchStatus::Matched);
    assert_eq!(hit.matches[0].name, "A");
}

#[test]
fn variant_blob_matching_falls_back_to_the_raw_checksums() {
    let pack = parsed_pack(
        "P",
        "nointro-single-image-v1",
        vec![game("A", "P", vec![component(16, "aabbccdd")])],
    );
    let IdentifyPackFile::V1(artifact) = &pack;
    let checksums = BTreeMap::from([("crc32".to_string(), "aabbccdd".to_string())]);

    assert!(
        match_variant_blobs("test.pack", artifact, &[], None, &checksums)
            .expect("lookup")
            .is_empty()
    );

    let fallback = match_variant_blobs("test.pack", artifact, &[], Some(16), &checksums)
        .expect("lookup with no variant rows");
    assert_eq!(fallback.len(), 1);
    assert_eq!(fallback[0].0, "raw");

    // The over-large header strip is skipped; the raw variant still matches.
    let variants = vec![
        json!({ "id": "raw", "checksums": { "crc32": "aabbccdd" } }),
        json!({
            "id": "remove-header",
            "checksums": { "crc32": "deadbeef" },
            "transforms": { "removeHeader": { "strippedBytes": 4096 } },
        }),
    ];
    let outcomes = match_variant_blobs("test.pack", artifact, &variants, Some(16), &checksums)
        .expect("lookup with variant rows");
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].0, "raw");
    assert_eq!(outcomes[0].1.matches[0].name, "A");
}

#[test]
fn push_artifact_matches_skips_unknown_outcomes_and_dedupes() {
    let mut seen = BTreeSet::new();
    let mut output = Vec::new();
    push_artifact_matches(
        "test.pack",
        "raw",
        ArtifactMatchOutcome {
            status: ArtifactMatchStatus::Unknown,
            quality: None,
            matches: vec![artifact_match("A", "P")],
        },
        &mut seen,
        &mut output,
    );
    assert!(output.is_empty());

    let mut hit = artifact_match("A", "P");
    hit.legacy_variant = true;
    hit.dump_tags = vec!["verified".to_string()];
    hit.provenance = vec![PackProvenance {
        source: "redump".to_string(),
        source_name: Some("Redump".to_string()),
        source_url: None,
        source_commit: None,
        license: None,
    }];
    push_artifact_matches(
        "test.pack",
        "raw",
        outcome(vec![hit]),
        &mut seen,
        &mut output,
    );
    assert_eq!(output.len(), 1);
    assert!(output[0].legacy_variant);
    assert_eq!(output[0].dump_tags, ["verified"]);
    assert_eq!(output[0].provenance[0].source, "redump");
    assert_eq!(
        output[0].provenance[0].source_name.as_deref(),
        Some("Redump")
    );

    push_artifact_matches(
        "other.pack",
        "raw",
        outcome(vec![artifact_match("A", "P")]),
        &mut seen,
        &mut output,
    );
    assert_eq!(output.len(), 1);
}

#[test]
fn is_false_drives_the_legacy_variant_skip() {
    assert!(is_false(&false));
    assert!(!is_false(&true));
    let value = serde_json::to_value(title_match("A", "P", "raw")).expect("serialized match");
    assert!(value.get("legacy_variant").is_none());
    assert!(value.get("dump_tags").is_none());
}

// ---------------------------------------------------------------------------
// MergedMatches
// ---------------------------------------------------------------------------

#[test]
fn merged_matches_ignores_unknown_outcomes() {
    let pack = loaded_pack(
        "test.pack",
        "P",
        "nointro-single-image-v1",
        vec![game("A", "P", vec![component(16, "aabbccdd")])],
    );
    let mut merged = MergedMatches::default();
    merged.merge_artifact_outcome(
        &pack,
        None,
        "raw",
        ArtifactMatchOutcome {
            status: ArtifactMatchStatus::Unknown,
            quality: Some(ArtifactMatchQuality::Exact),
            matches: vec![artifact_match("A", "P")],
        },
    );
    assert!(merged.matches.is_empty());
    assert!(merged.quality.is_none());
    assert!(merged.database.is_none());
}

#[test]
fn merged_matches_keeps_the_best_quality_and_merges_repeat_hits() {
    let pack = loaded_pack(
        "test.pack",
        "P",
        "nointro-single-image-v1",
        vec![game("A", "P", vec![component(16, "aabbccdd")])],
    );
    let mut merged = MergedMatches::default();

    let mut first = artifact_match("A", "P");
    first.legacy_variant = true;
    first.dump_tags = vec!["verified".to_string()];
    first.provenance = vec![PackProvenance {
        source: "redump".to_string(),
        source_name: None,
        source_url: None,
        source_commit: None,
        license: None,
    }];
    first.evidence.missing = vec!["track 02".to_string(), "track 01".to_string()];
    first.evidence.unexpected = vec!["b.bin".to_string(), "a.bin".to_string()];
    merged.merge_artifact_outcome(&pack, None, "raw", outcome(vec![first]));

    let mut repeat = artifact_match("A", "P");
    repeat.legacy_variant = false;
    repeat.dump_tags = vec!["alt".to_string(), "verified".to_string()];
    repeat.provenance = vec![PackProvenance {
        source: "no-intro".to_string(),
        source_name: None,
        source_url: None,
        source_commit: None,
        license: None,
    }];
    merged.merge_artifact_outcome(
        &pack,
        None,
        "remove-header",
        ArtifactMatchOutcome {
            status: ArtifactMatchStatus::Matched,
            quality: Some(ArtifactMatchQuality::Partial),
            matches: vec![repeat],
        },
    );

    assert_eq!(merged.matches.len(), 1);
    let entry = &merged.matches[0];
    assert_eq!(entry.variant, "raw");
    assert!(!entry.legacy_variant, "a non-legacy repeat clears the flag");
    assert_eq!(entry.dump_tags, ["alt", "verified"]);
    assert_eq!(
        entry
            .provenance
            .iter()
            .map(|item| item.source.as_str())
            .collect::<Vec<_>>(),
        vec!["no-intro", "redump"]
    );
    // `Ord` ranks Exact below Partial below MetadataOnly, so the merged
    // quality is the best any pack reported, not the last one.
    assert_eq!(merged.quality, Some(ArtifactMatchQuality::Exact));

    let evidence = merged.evidence.expect("first match records evidence");
    assert_eq!(evidence.missing_components, ["track 01", "track 02"]);
    assert_eq!(evidence.unexpected_components, ["a.bin", "b.bin"]);
    assert!(evidence.layout_matched);

    let database = merged.database.expect("first match records the database");
    assert_eq!(database.upstream_sources, ["redump"]);
}

// ---------------------------------------------------------------------------
// IdentifyDatabaseSet
// ---------------------------------------------------------------------------

fn load_error(paths: &[PathBuf]) -> String {
    match IdentifyDatabaseSet::load(paths) {
        Ok(_) => panic!("the pack list was expected to fail loading"),
        Err(error) => error.to_string(),
    }
}

#[test]
fn database_set_load_reports_the_failing_pack_path() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let error = load_error(&[temp.path().join("absent.pack")]);
    assert!(error.contains("failed to read ROM identify"));
    assert!(error.contains("absent.pack"));

    let invalid = temp.path().join("invalid.pack");
    fs::write(&invalid, b"not a pack").expect("invalid pack fixture");
    assert!(load_error(&[invalid]).contains("invalid ROM identify pack"));
}

#[test]
fn database_set_resolves_variants_and_routes_a_sizeless_lookup() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let path = temp.path().join("p.pack");
    fs::write(
        &path,
        pack_bytes(
            "P",
            "nointro-single-image-v1",
            vec![game("A", "P", vec![component(16, "aabbccdd")])],
        ),
    )
    .expect("pack fixture");
    let set = IdentifyDatabaseSet::load(&[path])
        .expect("pack loads")
        .expect("an explicit pack list is never empty");

    let variants = vec![json!({ "id": "raw", "checksums": { "crc32": "aabbccdd" } })];
    let with_size = set.resolve_variants(&variants, Some(16)).expect("lookup");
    assert_eq!(with_size.status, IdentifyStatus::Matched);
    assert_eq!(with_size.matches[0].database, "p.pack");
    assert_eq!(with_size.matches[0].variant, "raw");

    // No size: the pack's crc32 route supplies it.
    let routed = set
        .resolve_variants(&variants, None)
        .expect("routed lookup");
    assert_eq!(routed.status, IdentifyStatus::Matched);
    assert_eq!(routed.matches[0].name, "A");

    let miss = set
        .resolve_variants(
            &[json!({ "id": "raw", "checksums": { "crc32": "00000000" } })],
            Some(16),
        )
        .expect("lookup");
    assert_eq!(miss.status, IdentifyStatus::Unknown);
}

#[test]
fn database_set_resolves_a_multi_component_fingerprint() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let path = temp.path().join("p.pack");
    fs::write(
        &path,
        pack_bytes(
            "P",
            "nointro-single-image-v1",
            vec![game("A", "P", vec![component(16, "aabbccdd")])],
        ),
    )
    .expect("pack fixture");
    let set = IdentifyDatabaseSet::load(&[path])
        .expect("pack loads")
        .expect("an explicit pack list is never empty");
    let fingerprint = ArtifactFingerprint::from_single_blob(16, Some("aabbccdd"), None, None);
    let result = set
        .resolve_fingerprint(&fingerprint, "tracks")
        .expect("lookup");
    assert_eq!(result.status, IdentifyStatus::Matched);
    assert_eq!(result.matches[0].variant, "tracks");
}

#[test]
fn database_set_resolve_source_uses_the_embedded_crc_and_filename_hashes() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let path = temp.path().join("p.pack");
    fs::write(
        &path,
        pack_bytes(
            "P",
            "nointro-single-image-v1",
            vec![game("A", "P", vec![component(16, "aabbccdd")])],
        ),
    )
    .expect("pack fixture");
    let set = IdentifyDatabaseSet::load(&[path])
        .expect("pack loads")
        .expect("an explicit pack list is never empty");

    assert!(
        set.resolve_source(None, &[], &BTreeMap::new())
            .expect("lookup")
            .is_none(),
        "no checksum source at all yields no lookup"
    );

    let from_crc = set
        .resolve_source(Some(0xaabb_ccdd), &[], &BTreeMap::new())
        .expect("lookup")
        .expect("an embedded crc32 produces a lookup");
    assert_eq!(from_crc.status, IdentifyStatus::Matched);

    let from_filename = set
        .resolve_source(
            None,
            &[],
            &BTreeMap::from([("crc32".to_string(), "aabbccdd".to_string())]),
        )
        .expect("lookup")
        .expect("filename checksums produce a lookup");
    assert_eq!(from_filename.status, IdentifyStatus::Matched);

    // An embedded variant that already carries the crc32 is not duplicated.
    let from_variant = set
        .resolve_source(
            Some(0xaabb_ccdd),
            &[BTreeMap::from([(
                "crc32".to_string(),
                "aabbccdd".to_string(),
            )])],
            &BTreeMap::new(),
        )
        .expect("lookup")
        .expect("an embedded variant produces a lookup");
    assert_eq!(from_variant.matches.len(), 1);
}

// ---------------------------------------------------------------------------
// Pack selection
// ---------------------------------------------------------------------------

#[test]
fn explicit_packs_keep_the_file_name_and_reject_bad_input() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let path = temp.path().join("psx.pack");
    fs::write(
        &path,
        pack_bytes(
            "Sony PlayStation",
            "nointro-single-image-v1",
            vec![game(
                "A",
                "Sony PlayStation",
                vec![component(16, "aabbccdd")],
            )],
        ),
    )
    .expect("pack fixture");
    let selected = CliApp::load_explicit_packs(std::slice::from_ref(&path)).expect("packs load");
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].pack.name, "psx.pack");
    assert!(selected[0].entry.is_none());

    let broken = temp.path().join("broken.pack");
    fs::write(&broken, b"nope").expect("broken pack fixture");
    assert!(CliApp::load_explicit_packs(&[broken]).is_err());
}

/// A database dir with one catalog platform and its pack.
fn catalog_database(dir: &Path, canonical: &str, alias: &str, slug: &str, profile: &str) {
    fs::create_dir_all(dir).expect("database dir");
    fs::write(
        dir.join("catalog.json"),
        serde_json::to_vec(&json!({
            "format": "rom-weaver-identify-catalog-v1",
            "platforms": [{
                "canonicalPlatform": canonical,
                "aliases": [alias],
                "source": "redump",
                "mediaProfiles": [profile],
                "packSlug": slug,
                "packFormat": "RWFP1",
                "canonicalizationVersion": 1,
            }],
        }))
        .expect("catalog JSON"),
    )
    .expect("catalog fixture");
}

#[test]
fn catalog_pack_selection_routes_candidates_and_reports_missing_packs() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let dir = temp.path().join("db");
    catalog_database(
        &dir,
        "Sony PlayStation",
        "psx",
        "sony-playstation",
        "nointro-single-image-v1",
    );
    let provider = IdentifyPackProvider::new(Some(dir.clone())).expect("provider");

    let candidate = |platform: &str| PlatformCandidate {
        platform: platform.to_string(),
        confidence: DetectionConfidence::Strong,
        evidence: DetectionEvidence::HeaderMagic,
    };

    // The catalog knows the platform but its pack is not installed yet.
    let (packs, missing) =
        CliApp::select_catalog_packs(&provider, &[candidate("psx")], false).expect("selection");
    assert!(packs.is_empty());
    assert_eq!(missing, ["Sony PlayStation"]);

    // A platform with no catalog entry at all is reported by its own name.
    let (_, missing) =
        CliApp::select_catalog_packs(&provider, &[candidate("Made Up")], false).expect("selection");
    assert_eq!(missing, ["Made Up"]);

    fs::write(
        dir.join("sony-playstation.pack"),
        pack_bytes(
            "Sony PlayStation",
            "nointro-single-image-v1",
            vec![game(
                "A",
                "Sony PlayStation",
                vec![component(16, "aabbccdd")],
            )],
        ),
    )
    .expect("pack fixture");
    let provider = IdentifyPackProvider::new(Some(dir.clone())).expect("provider");
    // The same pack routed twice is selected once.
    let (packs, missing) = CliApp::select_catalog_packs(
        &provider,
        &[candidate("psx"), candidate("Sony PlayStation")],
        false,
    )
    .expect("selection");
    assert_eq!(packs.len(), 1);
    assert!(missing.is_empty());
    assert_eq!(
        packs[0]
            .entry
            .as_ref()
            .expect("a routed pack carries its catalog entry")
            .canonical_platform,
        "Sony PlayStation"
    );

    let (packs, missing) = CliApp::select_catalog_packs(&provider, &[], true).expect("selection");
    assert_eq!(packs.len(), 1);
    assert!(packs[0].entry.is_none(), "exhaustive search skips routing");
    assert!(missing.is_empty());
}

#[test]
fn resolve_against_selected_merges_every_pack() {
    let first = loaded_pack(
        "a.pack",
        "P",
        "nointro-single-image-v1",
        vec![game("A", "P", vec![component(16, "aabbccdd")])],
    );
    let second = loaded_pack(
        "b.pack",
        "Q",
        "nointro-single-image-v1",
        vec![game("B", "Q", vec![component(16, "aabbccdd")])],
    );
    let selected = vec![
        SelectedPack {
            pack: first,
            entry: None,
        },
        SelectedPack {
            pack: second,
            entry: None,
        },
    ];
    let checksums = BTreeMap::from([("crc32".to_string(), "aabbccdd".to_string())]);
    let resolved =
        CliApp::resolve_against_selected(&selected, &[], Some(16), &checksums).expect("resolution");
    assert_eq!(
        resolved
            .matches
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>(),
        vec!["A", "B"]
    );
    assert_eq!(resolved.quality.as_deref(), Some("exact"));
    assert!(resolved.evidence.is_some());
    assert_eq!(
        resolved
            .database
            .expect("the first matching pack supplies the database info")
            .pack_format,
        "RWFP1"
    );

    // An unknown payload size skips every pack.
    let empty =
        CliApp::resolve_against_selected(&selected, &[], None, &checksums).expect("resolution");
    assert!(empty.matches.is_empty());
    assert!(empty.database.is_none());
}

// ---------------------------------------------------------------------------
// run_identify
// ---------------------------------------------------------------------------

#[test]
fn identify_requires_exactly_one_of_input_or_hash() {
    let (app, sink) = recording_app();
    let outcome = app.run_identify(identify_args(None, Vec::new()));
    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(last_label(&sink).contains("exactly one of --input or --hash"));

    let (app, sink) = recording_app();
    let mut args = identify_args(Some(PathBuf::from("rom.sfc")), Vec::new());
    args.hash = Some("aabbccdd".to_string());
    assert_eq!(
        app.run_identify(args).status,
        OperationStatus::Failed,
        "both --input and --hash is rejected"
    );
    assert!(last_label(&sink).contains("exactly one of --input or --hash"));
}

#[test]
fn identify_by_hash_rejects_lengths_that_name_no_algorithm() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let path = temp.path().join("p.pack");
    fs::write(
        &path,
        pack_bytes(
            "P",
            "nointro-single-image-v1",
            vec![game("A", "P", vec![component(16, "aabbccdd")])],
        ),
    )
    .expect("pack fixture");

    for hash in ["zzzzzzzz", "aabb", ""] {
        let (app, sink) = recording_app();
        let mut args = identify_args(None, vec![path.clone()]);
        args.hash = Some(hash.to_string());
        assert_eq!(app.run_identify(args).status, OperationStatus::Failed);
        assert!(last_label(&sink).contains("--hash must be hex"));
    }
}

#[test]
fn identify_by_hash_matches_through_the_pack_routes() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let path = temp.path().join("p.pack");
    let mut with_md5 = component(16, "aabbccdd");
    with_md5.md5 = Some("d41d8cd98f00b204e9800998ecf8427e".to_string());
    fs::write(
        &path,
        pack_bytes(
            "P",
            "nointro-single-image-v1",
            vec![game("A", "P", vec![with_md5])],
        ),
    )
    .expect("pack fixture");

    let (app, sink) = recording_app();
    let mut args = identify_args(None, vec![path.clone()]);
    args.hash = Some("AABBCCDD".to_string());
    assert_eq!(app.run_identify(args).status, OperationStatus::Succeeded);
    let details = identify_details(&sink);
    assert_eq!(details["status"], json!("matched"));
    assert_eq!(details["input"], json!("aabbccdd"));
    assert_eq!(details["checksums"]["crc32"], json!("aabbccdd"));
    assert_eq!(details["matches"][0]["name"], json!("A"));
    assert_eq!(last_label(&sink), "identified A");

    let (app, sink) = recording_app();
    let mut args = identify_args(None, vec![path.clone()]);
    args.hash = Some("d41d8cd98f00b204e9800998ecf8427e".to_string());
    assert_eq!(app.run_identify(args).status, OperationStatus::Succeeded);
    assert_eq!(identify_details(&sink)["matches"][0]["name"], json!("A"));

    let (app, sink) = recording_app();
    let mut args = identify_args(None, vec![path]);
    args.hash = Some("0".repeat(40));
    assert_eq!(app.run_identify(args).status, OperationStatus::Succeeded);
    assert_eq!(identify_details(&sink)["status"], json!("unknown"));
    assert_eq!(last_label(&sink), "no title matched the supplied database");
}

#[test]
fn identify_by_hash_reports_ambiguity_across_titles() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let path = temp.path().join("p.pack");
    fs::write(
        &path,
        pack_bytes(
            "P",
            "nointro-single-image-v1",
            vec![
                game("A", "P", vec![component(16, "aabbccdd")]),
                game("B", "P", vec![component(16, "aabbccdd")]),
            ],
        ),
    )
    .expect("pack fixture");

    let (app, sink) = recording_app();
    let mut args = identify_args(None, vec![path]);
    args.hash = Some("aabbccdd".to_string());
    assert_eq!(app.run_identify(args).status, OperationStatus::Succeeded);
    assert_eq!(identify_details(&sink)["status"], json!("ambiguous"));
    assert_eq!(last_label(&sink), "found 2 possible titles");
}

#[test]
fn identify_by_hash_reports_an_unreadable_pack() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let (app, sink) = recording_app();
    let mut args = identify_args(None, vec![temp.path().join("absent.pack")]);
    args.hash = Some("aabbccdd".to_string());
    assert_eq!(app.run_identify(args).status, OperationStatus::Failed);
    assert!(last_label(&sink).contains("failed to read ROM identify pack"));
}

#[test]
fn identify_rejects_a_system_that_is_not_in_the_catalog() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let rom = temp.path().join("rom.bin");
    fs::write(&rom, vec![0_u8; 32]).expect("rom fixture");

    let (app, sink) = recording_app();
    let mut args = identify_args(Some(rom), Vec::new());
    args.database_dir = Some(temp.path().join("db"));
    args.system = Some("not-a-system".to_string());
    assert_eq!(app.run_identify(args).status, OperationStatus::Failed);
    assert!(last_label(&sink).contains("not in the identify catalog"));
}

#[test]
fn identify_reports_a_missing_input_file_through_the_checksum_stage() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let (app, sink) = recording_app();
    let mut args = identify_args(Some(temp.path().join("absent.bin")), Vec::new());
    args.database_dir = Some(temp.path().join("db"));
    assert_eq!(app.run_identify(args).status, OperationStatus::Failed);
    let event = sink
        .snapshot()
        .into_iter()
        .next_back()
        .expect("a terminal report was emitted");
    assert_eq!(event.stage, "identify");
}

#[test]
fn identify_matches_a_file_against_an_explicit_pack() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let payload = vec![0x42_u8; 64];
    let rom = temp.path().join("rom.bin");
    fs::write(&rom, &payload).expect("rom fixture");
    let pack = temp.path().join("p.pack");
    fs::write(
        &pack,
        pack_bytes(
            "P",
            "nointro-single-image-v1",
            vec![game(
                "Test Title",
                "P",
                vec![component(payload.len() as u64, &crc32_hex(&payload))],
            )],
        ),
    )
    .expect("pack fixture");

    let (app, sink) = recording_app();
    let mut args = identify_args(Some(rom), vec![pack]);
    args.database_dir = Some(temp.path().join("db"));
    args.offline = true;
    assert_eq!(app.run_identify(args).status, OperationStatus::Succeeded);

    let details = identify_details(&sink);
    assert_eq!(details["status"], json!("matched"));
    assert_eq!(details["matches"][0]["name"], json!("Test Title"));
    assert_eq!(details["quality"], json!("exact"));
    assert_eq!(details["database"]["pack_format"], json!("RWFP1"));
    assert_eq!(details["components"][0]["size"], json!(payload.len()));
    assert_eq!(details["input"], json!(rom_display(&details)));
    assert!(details.get("media").is_none(), "a plain blob is not a disc");
    assert_eq!(last_label(&sink), "identified Test Title");
}

fn rom_display(details: &Value) -> String {
    details["input"].as_str().expect("input path").to_string()
}

#[test]
fn identify_hints_at_the_missing_pack_for_a_routed_platform() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let dir = temp.path().join("db");
    catalog_database(
        &dir,
        "Sony PlayStation",
        "psx",
        "sony-playstation",
        "nointro-single-image-v1",
    );
    let rom = temp.path().join("rom.bin");
    fs::write(&rom, vec![0x11_u8; 48]).expect("rom fixture");

    let (app, sink) = recording_app();
    let mut args = identify_args(Some(rom), Vec::new());
    args.database_dir = Some(dir);
    args.system = Some("psx".to_string());
    assert_eq!(app.run_identify(args).status, OperationStatus::Succeeded);

    let details = identify_details(&sink);
    assert_eq!(details["status"], json!("unknown"));
    assert_eq!(details["condition"], json!("database_required"));
    assert!(
        details["hint"]
            .as_str()
            .expect("a hint accompanies the condition")
            .contains("identify database install-all")
    );
    assert_eq!(details["detected_platform"], json!("Sony PlayStation"));
    assert_eq!(
        details["platform_candidates"][0]["evidence"]["kind"],
        json!("user_override")
    );
    assert_eq!(
        last_label(&sink),
        "no identify pack installed for Sony PlayStation"
    );
}

#[test]
fn identify_flags_a_per_track_pack_as_an_unsupported_media_profile() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let dir = temp.path().join("db");
    catalog_database(
        &dir,
        "Sony PlayStation",
        "psx",
        "sony-playstation",
        "redump-cd-track-v1",
    );
    fs::write(
        dir.join("sony-playstation.pack"),
        pack_bytes(
            "Sony PlayStation",
            "redump-cd-track-v1",
            vec![game(
                "A",
                "Sony PlayStation",
                vec![component(16, "aabbccdd")],
            )],
        ),
    )
    .expect("pack fixture");
    let rom = temp.path().join("rom.bin");
    fs::write(&rom, vec![0x22_u8; 48]).expect("rom fixture");

    let (app, sink) = recording_app();
    let mut args = identify_args(Some(rom), Vec::new());
    args.database_dir = Some(dir);
    args.system = Some("psx".to_string());
    assert_eq!(app.run_identify(args).status, OperationStatus::Succeeded);

    let details = identify_details(&sink);
    assert_eq!(details["condition"], json!("unsupported_media_profile"));
    assert!(
        details["hint"]
            .as_str()
            .expect("a hint accompanies the condition")
            .contains("per-track hashes")
    );
    assert_eq!(
        last_label(&sink),
        "this input's media profile is not supported yet"
    );
}

#[test]
fn identify_reports_an_unreadable_explicit_pack_after_hashing() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let rom = temp.path().join("rom.bin");
    fs::write(&rom, vec![0x33_u8; 32]).expect("rom fixture");
    let pack = temp.path().join("broken.pack");
    fs::write(&pack, b"not a pack").expect("broken pack fixture");

    let (app, sink) = recording_app();
    let mut args = identify_args(Some(rom), vec![pack]);
    args.database_dir = Some(temp.path().join("db"));
    assert_eq!(app.run_identify(args).status, OperationStatus::Failed);
    assert!(last_label(&sink).contains("invalid ROM identify pack"));
}

#[test]
fn identify_database_subcommand_is_dispatched_from_the_identify_command() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let (app, sink) = recording_app();
    let mut args = identify_args(None, Vec::new());
    args.subcommand = Some(IdentifySubcommands::Database(
        IdentifyDatabaseCommands::Path(Box::new(IdentifyDatabaseDirCommand {
            database_dir: Some(temp.path().to_path_buf()),
        })),
    ));
    assert_eq!(app.run_identify(args).status, OperationStatus::Succeeded);
    assert_eq!(last_label(&sink), temp.path().to_string_lossy());
}
