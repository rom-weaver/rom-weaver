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

/// The packaged catalog names the slugs the packaged packs use; the built-in
/// fallback catalog disagrees for several platforms, including NES.
#[test]
fn packaged_catalog_wins_over_the_builtin_catalog() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let data_dir = temp.path().join("full-v1");
    fs::create_dir_all(&data_dir).expect("data dir");
    fs::write(
        data_dir.join("catalog.json"),
        serde_json::to_vec(&serde_json::json!({
            "format": "rom-weaver-identify-catalog-v1",
            "platforms": [{
                "canonicalPlatform": "Nintendo - Nintendo Entertainment System",
                "aliases": ["nes"],
                "source": "libretro",
                "mediaProfiles": ["opengood-cartridge-v1"],
                "packSlug": "nintendo-nintendo-entertainment-system",
                "packFormat": "RWFP1",
                "canonicalizationVersion": 1,
            }],
        }))
        .expect("catalog json"),
    )
    .expect("catalog file");

    let provider = IdentifyPackProvider::new(Some(temp.path().to_path_buf())).expect("provider");
    let entry = provider.resolve_entry("nes").expect("nes entry");

    assert_eq!(entry.pack_slug, "nintendo-nintendo-entertainment-system");
    let listed: Vec<String> = provider
        .catalog_entries()
        .into_iter()
        .map(|entry| entry.canonical_platform)
        .filter(|platform| platform.ends_with("Nintendo Entertainment System"))
        .filter(|platform| !platform.contains("Super"))
        .collect();
    assert_eq!(
        listed,
        ["Nintendo - Nintendo Entertainment System"],
        "the builtin NES entry must not be listed beside the packaged one"
    );
    let error = resolve_install_platform(&provider, "nes").expect_err("install is refused");
    assert!(
        error.to_string().contains("never installed from Redump"),
        "unexpected error: {error}"
    );
    assert_eq!(
        IdentifyCatalog::builtin()
            .resolve_platform("nes")
            .expect("builtin nes entry")
            .pack_slug,
        "nintendo-entertainment-system",
        "the built-in fallback still names the slug this test guards against"
    );
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
        alternate_names: Vec::new(),
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

fn recording_app() -> (
    CliApp,
    std::sync::Arc<rom_weaver_core::RecordingProgressSink>,
) {
    let sink = std::sync::Arc::new(rom_weaver_core::RecordingProgressSink::default());
    let app = CliApp::new(
        std::sync::Arc::clone(&sink) as Arc<dyn ProgressSink>,
        Arc::new(SilentPrompter),
        false,
        false,
        false,
    );
    (app, sink)
}

/// The last emitted report's (label, status, details).
fn last_report(sink: &rom_weaver_core::RecordingProgressSink) -> (String, OperationStatus, Value) {
    let event = sink
        .snapshot()
        .into_iter()
        .next_back()
        .expect("a terminal report was emitted");
    (
        event.label,
        event.status,
        event.details.unwrap_or(Value::Null),
    )
}

/// The message of a call that must fail; the crate's result types are not `Debug`.
fn error_text<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("the call was expected to fail"),
        Err(error) => error.to_string(),
    }
}

fn pack_component(size: u64, crc32: &str) -> PackComponent {
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

fn pack_game(name: &str, platform: &str, components: Vec<PackComponent>) -> PackGame {
    PackGame {
        name: name.to_string(),
        platform: platform.to_string(),
        source: IdentifySource::Redump,
        upstream_source: UpstreamSource::Redump,
        provenance: Vec::new(),
        legacy_variant: false,
        dump_tags: Vec::new(),
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

fn encoded_pack(platform: &str, games: Vec<PackGame>) -> Vec<u8> {
    rom_weaver_checksum::identify_pack_v1::encode(
        platform,
        IdentifySource::Redump,
        media_profile_for(platform),
        &json!([]),
        games,
    )
    .expect("RWFP1 pack")
}

fn catalog_bytes(platforms: &[(&str, &str, Option<&str>)]) -> Vec<u8> {
    let entries: Vec<Value> = platforms
        .iter()
        .map(|(canonical, slug, sha256)| {
            let mut entry = json!({
                "canonicalPlatform": canonical,
                "aliases": [slug],
                "source": "redump",
                "mediaProfiles": ["nointro-single-image-v1"],
                "packSlug": slug,
                "packFormat": "RWFP1",
                "canonicalizationVersion": 1,
            });
            if let Some(sha256) = sha256 {
                entry["packSha256"] = json!(sha256);
            }
            entry
        })
        .collect();
    serde_json::to_vec(&json!({
        "format": CATALOG_FORMAT,
        "platforms": entries,
    }))
    .expect("catalog JSON")
}

/// One DAT `<rom>` row: (file name, size, crc32).
type DatRom<'a> = (&'a str, u64, &'a str);
/// One DAT `<game>` element: (game name, its rom rows).
type DatGame<'a> = (&'a str, Vec<DatRom<'a>>);

/// A minimal Redump XML DAT for `system` with one game per `(name, roms)`.
fn redump_dat(system: &str, games: &[DatGame<'_>]) -> Vec<u8> {
    let mut xml = format!("<datafile><header><name>{system}</name></header>");
    for (name, roms) in games {
        xml.push_str(&format!("<game name=\"{name}\">"));
        for (rom_name, size, crc) in roms {
            xml.push_str(&format!(
                "<rom name=\"{rom_name}\" size=\"{size}\" crc=\"{crc}\" \
                 md5=\"d41d8cd98f00b204e9800998ecf8427e\" \
                 sha1=\"da39a3ee5e6b4b0d3255bfef95601890afd80709\"/>"
            ));
        }
        xml.push_str("</game>");
    }
    xml.push_str("</datafile>");
    xml.into_bytes()
}

/// A STORE-only ZIP, the shape `import_redump_dat` reads DAT entries from.
fn store_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let crc = crc.sum();
        let offset = out.len() as u32;
        out.extend_from_slice(b"PK\x03\x04");
        for value in [20u16, 0, 0, 0, 0] {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);

        central.extend_from_slice(b"PK\x01\x02");
        for value in [20u16, 20, 0, 0, 0, 0] {
            central.extend_from_slice(&value.to_le_bytes());
        }
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        for value in [0u16, 0, 0, 0] {
            central.extend_from_slice(&value.to_le_bytes());
        }
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(b"PK\x05\x06");
    for value in [0u16, 0, entries.len() as u16, entries.len() as u16] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn dat_zip(dir: &Path, name: &str, system: &str, games: &[DatGame<'_>]) -> PathBuf {
    let path = dir.join(name);
    fs::write(
        &path,
        store_zip(&[("system.dat", &redump_dat(system, games))]),
    )
    .expect("dump fixture");
    path
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

#[test]
fn media_profiles_follow_the_platform_family() {
    assert_eq!(media_profile_for("Sony PlayStation"), "redump-cd-track-v1");
    assert_eq!(media_profile_for("Sega Saturn"), "redump-cd-track-v1");
    assert_eq!(media_profile_for("Neo Geo CD"), "redump-cd-track-v1");
    assert_eq!(media_profile_for("Nintendo 3DS"), "3ds-decoded-card-v1");
    assert_eq!(media_profile_for("Nintendo New 3DS"), "3ds-decoded-card-v1");
    assert_eq!(
        media_profile_for("Nintendo GameCube"),
        "gamecube-decoded-iso-v1"
    );
    assert_eq!(media_profile_for("Nintendo Wii"), "wii-decoded-iso-v1");
    assert_eq!(media_profile_for("Playstation minis"), "psp-decoded-iso-v1");
    assert_eq!(
        media_profile_for("Sony Playstation Portable"),
        "psp-decoded-iso-v1"
    );
    assert_eq!(media_profile_for("Sega Dreamcast"), "redump-gdrom-track-v1");
    // A Redump endpoint the explicit list does not name still gets the CD profile.
    assert_eq!(media_profile_for("Microsoft Xbox"), "redump-cd-track-v1");
    assert_eq!(
        media_profile_for("Nintendo Entertainment System"),
        "nointro-single-image-v1"
    );
}

#[test]
fn curated_aliases_cover_the_mirrored_platforms() {
    assert_eq!(
        curated_aliases("Family Computer Disk System"),
        ["fds", "famicom disk system"]
    );
    assert_eq!(curated_aliases("Nintendo 3DS"), ["3ds"]);
    assert_eq!(curated_aliases("Nintendo DS"), ["nds", "ds"]);
    assert_eq!(
        curated_aliases("Nintendo Famicom Disk System"),
        ["nintendo fds"]
    );
    assert_eq!(
        curated_aliases("Nintendo GameCube"),
        ["gamecube", "gc", "ngc"]
    );
    assert_eq!(curated_aliases("Nintendo Wii"), ["wii"]);
    assert_eq!(curated_aliases("Sega Dreamcast"), ["dreamcast", "dc"]);
    assert_eq!(curated_aliases("Sega Saturn"), ["saturn"]);
    assert_eq!(
        curated_aliases("Sony PlayStation"),
        ["playstation", "psx", "ps1"]
    );
    assert_eq!(
        curated_aliases("Sony PlayStation 2"),
        ["ps2", "playstation 2"]
    );
    assert_eq!(
        curated_aliases("Sony Playstation Portable"),
        ["psp", "playstation portable"]
    );
    assert!(curated_aliases("Some Other System").is_empty());
}

#[test]
fn hash_normalization_keeps_only_well_formed_hex_of_the_right_length() {
    assert_eq!(
        normalize_hash(Some("  AABBCCDD  ".to_string()), 8).as_deref(),
        Some("aabbccdd")
    );
    assert_eq!(normalize_hash(None, 8), None);
    assert_eq!(normalize_hash(Some("aabbcc".to_string()), 8), None);
    assert_eq!(normalize_hash(Some("zzzzzzzz".to_string()), 8), None);
}

#[test]
fn redump_game_records_drop_empty_games_and_number_their_tracks() {
    let empty_name = RedumpGame {
        name: "   ".to_string(),
        roms: vec![RedumpRom {
            name: Some("a.bin".to_string()),
            size: 16,
            crc32: Some("aabbccdd".to_string()),
            md5: None,
            sha1: None,
        }],
    };
    assert!(redump_game_record(empty_name, "P").is_none());

    let no_roms = RedumpGame {
        name: "A".to_string(),
        roms: Vec::new(),
    };
    assert!(redump_game_record(no_roms, "P").is_none());

    let two_tracks = RedumpGame {
        name: "A".to_string(),
        roms: vec![
            RedumpRom {
                name: Some("a (Track 1).bin".to_string()),
                size: 16,
                crc32: Some("AABBCCDD".to_string()),
                md5: Some("bad".to_string()),
                sha1: None,
            },
            RedumpRom {
                name: Some("  ".to_string()),
                size: 32,
                crc32: None,
                md5: None,
                sha1: Some("da39a3ee5e6b4b0d3255bfef95601890afd80709".to_string()),
            },
        ],
    };
    let record = redump_game_record(two_tracks, "Sony PlayStation").expect("game record");
    assert_eq!(record.platform, "Sony PlayStation");
    assert_eq!(record.source, IdentifySource::Redump);
    assert_eq!(record.components.len(), 2);
    assert_eq!(record.components[0].ordinal, 0);
    assert_eq!(record.components[0].track, Some(1));
    assert_eq!(record.components[0].crc32.as_deref(), Some("aabbccdd"));
    assert_eq!(record.components[0].md5, None, "a malformed md5 is dropped");
    assert_eq!(record.components[1].track, Some(2));
    assert_eq!(
        record.components[1].filename, None,
        "a blank rom name is dropped"
    );
    assert!(record.components[1].sha1.is_some());
}

#[test]
fn redump_platform_and_endpoint_lookups_normalize_the_system_name() {
    assert_eq!(
        canonical_redump_platform("sony - playstation"),
        Some("Sony PlayStation")
    );
    assert_eq!(
        canonical_redump_platform("Nintendo GameCube"),
        Some("Nintendo GameCube")
    );
    assert_eq!(canonical_redump_platform("Not A System"), None);
    assert_eq!(redump_endpoint("Sony PlayStation"), Some("psx"));
    assert_eq!(redump_endpoint("Nintendo Wii"), Some("wii"));
    assert_eq!(redump_endpoint("sony playstation"), None);
}

#[test]
fn pack_caps_reject_records_the_reader_would_refuse() {
    let long = "x".repeat(4097);
    let base = pack_game("A", "P", vec![pack_component(16, "aabbccdd")]);
    assert!(game_within_pack_caps(&base));

    let mut long_name = base.clone();
    long_name.name = long.clone();
    assert!(!game_within_pack_caps(&long_name));

    let mut long_platform = base.clone();
    long_platform.platform = long.clone();
    assert!(!game_within_pack_caps(&long_platform));

    for field in [0usize, 1, 2] {
        let mut game = base.clone();
        match field {
            0 => game.game_id = Some(long.clone()),
            1 => game.region = Some(long.clone()),
            _ => game.language = Some(long.clone()),
        }
        assert!(!game_within_pack_caps(&game));
    }

    let mut long_filename = base.clone();
    long_filename.components[0].filename = Some(long);
    assert!(!game_within_pack_caps(&long_filename));

    let mut many = base;
    many.components = vec![pack_component(16, "aabbccdd"); 10_001];
    assert!(!game_within_pack_caps(&many));
}

#[test]
fn sha256_hex_matches_the_known_vectors() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn write_atomic_leaves_no_part_file_and_names_the_failing_path() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let path = temp.path().join("pack.bin");
    write_atomic(&path, b"payload").expect("atomic write");
    assert_eq!(fs::read(&path).expect("written file"), b"payload");
    assert!(!temp.path().join("pack.part").exists());

    // Overwriting an existing file is the update path.
    write_atomic(&path, b"next").expect("atomic overwrite");
    assert_eq!(fs::read(&path).expect("written file"), b"next");

    let error = write_atomic(&temp.path().join("absent-dir").join("x.bin"), b"payload")
        .expect_err("a missing parent directory fails the write");
    assert!(error.to_string().contains("failed to write"));
}

#[test]
fn build_pack_v1_counts_games_components_routes_and_shared_parts() {
    // `mark_shared_components` keys on md5/sha1, so only a hashed component can
    // be recognized as byte-identical across games.
    let mut shared = pack_component(16, "aabbccdd");
    shared.md5 = Some("d41d8cd98f00b204e9800998ecf8427e".to_string());
    let mut unique = pack_component(32, "11223344");
    unique.md5 = Some("0f4d8cd98f00b204e9800998ecf84271".to_string());
    let mut zero_size = pack_component(0, "55667788");
    zero_size.ordinal = 1;
    let games = vec![
        pack_game("A", "P", vec![shared.clone(), zero_size]),
        pack_game("B", "P", vec![shared, unique]),
    ];
    let (bytes, game_count, components, routed_keys, shared_components) =
        build_pack_v1("P", games, &json!({})).expect("pack build");
    assert_eq!(game_count, 2);
    assert_eq!(components, 4);
    // Only the unique 32-byte component is discriminating, sized, and routed.
    assert_eq!(routed_keys, 1);
    assert_eq!(shared_components, 2);
    let IdentifyPackFile::V1(pack) =
        IdentifyPackFile::parse(&bytes).expect("the built pack parses");
    assert_eq!(pack.platform(), "P");
    assert_eq!(pack.games().len(), 2);
}

// ---------------------------------------------------------------------------
// IdentifyPackProvider
// ---------------------------------------------------------------------------

#[test]
fn provider_rejects_an_unparsable_catalog() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    fs::write(temp.path().join("catalog.json"), b"{ not json").expect("catalog fixture");
    assert!(IdentifyPackProvider::new(Some(temp.path().to_path_buf())).is_err());
}

#[test]
fn provider_merges_dir_entries_over_the_builtin_catalog() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    fs::write(
        temp.path().join("catalog.json"),
        catalog_bytes(&[("Sony PlayStation", "sony-playstation", None)]),
    )
    .expect("catalog fixture");
    let provider = IdentifyPackProvider::new(Some(temp.path().to_path_buf())).expect("provider");
    assert_eq!(provider.database_dir(), temp.path());

    let entries = provider.catalog_entries();
    let playstation: Vec<_> = entries
        .iter()
        .filter(|entry| entry.canonical_platform == "Sony PlayStation")
        .collect();
    assert_eq!(
        playstation.len(),
        1,
        "the dir entry shadows the builtin one"
    );
    assert_eq!(playstation[0].source, IdentifySource::Redump);
    assert!(
        entries.len() > 1,
        "the builtin catalog supplies the other platforms"
    );
    assert!(
        entries
            .windows(2)
            .all(|pair| pair[0].canonical_platform <= pair[1].canonical_platform),
        "entries are sorted by canonical platform"
    );

    assert!(provider.resolve_entry("sony-playstation").is_some());
    assert!(provider.resolve_entry("not-a-system").is_none());
    assert!(!provider.pack_installed("sony-playstation"));
}

#[test]
fn provider_loads_caches_and_lists_packs() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let pack = encoded_pack(
        "P",
        vec![pack_game("A", "P", vec![pack_component(16, "aabbccdd")])],
    );
    fs::write(temp.path().join("p.pack"), &pack).expect("pack fixture");
    fs::write(temp.path().join("notes.txt"), b"ignored").expect("stray file");
    let provider = IdentifyPackProvider::new(Some(temp.path().to_path_buf())).expect("provider");

    assert!(provider.pack_installed("p"));
    let first = provider.pack_for_slug("p").expect("load").expect("pack");
    assert_eq!(first.name, "p.pack");
    let second = provider
        .pack_for_slug("p")
        .expect("cached load")
        .expect("pack");
    assert!(Rc::ptr_eq(&first, &second), "a second load hits the cache");
    assert!(provider.pack_for_slug("absent").expect("load").is_none());

    let packs = provider.all_packs().expect("pack listing");
    assert_eq!(packs.len(), 1);
    assert_eq!(packs[0].name, "p.pack");
}

#[test]
fn provider_refuses_a_pack_that_drifted_from_its_catalog_sha256() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let pack = encoded_pack(
        "P",
        vec![pack_game("A", "P", vec![pack_component(16, "aabbccdd")])],
    );
    fs::write(temp.path().join("p.pack"), &pack).expect("pack fixture");
    fs::write(
        temp.path().join("catalog.json"),
        catalog_bytes(&[("P", "p", Some(&sha256_hex(&pack)))]),
    )
    .expect("catalog fixture");
    IdentifyPackProvider::new(Some(temp.path().to_path_buf()))
        .expect("provider")
        .pack_for_slug("p")
        .expect("a matching sha256 loads")
        .expect("pack");

    fs::write(
        temp.path().join("catalog.json"),
        catalog_bytes(&[("P", "p", Some(&"0".repeat(64)))]),
    )
    .expect("catalog fixture");
    let provider = IdentifyPackProvider::new(Some(temp.path().to_path_buf())).expect("provider");
    assert!(error_text(provider.pack_for_slug("p")).contains("does not match its catalog sha256"));
}

#[test]
fn provider_names_the_pack_that_fails_to_parse() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    fs::write(temp.path().join("p.pack"), b"not a pack").expect("pack fixture");
    let provider = IdentifyPackProvider::new(Some(temp.path().to_path_buf())).expect("provider");
    assert!(error_text(provider.pack_for_slug("p")).contains("invalid ROM identify pack `p.pack`"));
}

// ---------------------------------------------------------------------------
// Redump DAT import
// ---------------------------------------------------------------------------

#[test]
fn importing_a_dat_writes_the_pack_and_merges_the_catalog() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    let dump = dat_zip(
        temp.path(),
        "psx.zip",
        "Sony - PlayStation",
        &[("Game A", vec![("a.bin", 16, "aabbccdd")])],
    );

    let (imported, skipped, over_caps) = import_redump_dat(&dump, &database, None).expect("import");
    assert_eq!(imported.len(), 1);
    assert!(skipped.is_empty());
    assert_eq!(over_caps, 0);
    let system = &imported[0];
    assert_eq!(system.platform, "Sony PlayStation");
    assert_eq!(system.slug, "sony-playstation");
    assert_eq!(system.file, "sony-playstation.pack");
    assert_eq!(system.games, 1);
    assert_eq!(system.components, 1);
    assert_eq!(system.routed_keys, 1);
    assert_eq!(system.shared_components, 0);

    let pack = fs::read(database.join("sony-playstation.pack")).expect("written pack");
    assert_eq!(sha256_hex(&pack), system.sha256);

    let catalog =
        IdentifyCatalog::parse(&fs::read(database.join("catalog.json")).expect("catalog"))
            .expect("parsed catalog");
    let entry = catalog
        .resolve_platform("psx")
        .expect("the curated aliases are written into the catalog");
    assert_eq!(entry.canonical_platform, "Sony PlayStation");
    assert_eq!(entry.pack_format, "RWFP1");
    assert_eq!(entry.media_profiles, ["redump-cd-track-v1"]);
    assert_eq!(entry.pack_sha256.as_deref(), Some(system.sha256.as_str()));

    // A second import of another platform keeps the first entry.
    let second = dat_zip(
        temp.path(),
        "saturn.zip",
        "Sega Saturn",
        &[("Game B", vec![("b.bin", 32, "11223344")])],
    );
    import_redump_dat(&second, &database, None).expect("second import");
    let catalog =
        IdentifyCatalog::parse(&fs::read(database.join("catalog.json")).expect("catalog"))
            .expect("parsed catalog");
    assert_eq!(catalog.entries().len(), 2);
    assert!(catalog.resolve_platform("Sony PlayStation").is_some());
    assert!(catalog.resolve_platform("saturn").is_some());
}

#[test]
fn importing_uses_the_dat_header_name_when_redump_does_not_know_it() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    let dump = dat_zip(
        temp.path(),
        "custom.zip",
        "  Homebrew Machine  ",
        &[("Game A", vec![("a.bin", 16, "aabbccdd")])],
    );
    let (imported, _, _) = import_redump_dat(&dump, &database, None).expect("import");
    assert_eq!(imported[0].platform, "Homebrew Machine");
    assert_eq!(imported[0].slug, "homebrew-machine");
    let catalog =
        IdentifyCatalog::parse(&fs::read(database.join("catalog.json")).expect("catalog"))
            .expect("parsed catalog");
    assert_eq!(
        catalog.entries()[0].media_profiles,
        ["nointro-single-image-v1"]
    );
}

#[test]
fn importing_skips_records_over_the_pack_caps() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    let long = "x".repeat(4097);
    let dump = dat_zip(
        temp.path(),
        "caps.zip",
        "Sony - PlayStation",
        &[
            (long.as_str(), vec![("a.bin", 16, "aabbccdd")]),
            ("Game A", vec![("b.bin", 32, "11223344")]),
        ],
    );
    let (imported, _, over_caps) = import_redump_dat(&dump, &database, None).expect("import");
    assert_eq!(over_caps, 1);
    assert_eq!(imported[0].games, 1);
}

#[test]
fn importing_a_dat_with_no_usable_game_writes_nothing() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    let dump = temp.path().join("empty.zip");
    fs::write(
        &dump,
        store_zip(&[(
            "system.dat",
            b"<datafile><header><name>Sony - PlayStation</name></header></datafile>",
        )]),
    )
    .expect("dump fixture");
    let (imported, _, _) = import_redump_dat(&dump, &database, None).expect("import");
    assert!(imported.is_empty());
    assert!(!database.join("catalog.json").exists());
}

#[test]
fn importing_rejects_a_missing_zip_and_one_with_no_dat() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    assert!(
        error_text(import_redump_dat(
            &temp.path().join("absent.zip"),
            &database,
            None
        ))
        .contains("is not a file")
    );

    let no_dat = temp.path().join("no-dat.zip");
    fs::write(&no_dat, store_zip(&[("readme.txt", b"nothing here")])).expect("dump fixture");
    assert!(
        error_text(import_redump_dat(&no_dat, &database, None)).contains("no .dat or .xml file")
    );
}

#[test]
fn importing_rejects_a_dat_that_is_not_xml() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    let dump = temp.path().join("broken.zip");
    fs::write(&dump, store_zip(&[("system.dat", b"not xml at all")])).expect("dump fixture");
    assert!(error_text(import_redump_dat(&dump, &database, None)).contains("is not valid XML"));
}

#[test]
fn importing_only_one_platform_skips_the_others_and_reports_a_miss() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    let dump = temp.path().join("two.zip");
    fs::write(
        &dump,
        store_zip(&[
            (
                "psx.dat",
                &redump_dat(
                    "Sony - PlayStation",
                    &[("A", vec![("a.bin", 16, "aabbccdd")])],
                ),
            ),
            (
                "saturn.xml",
                &redump_dat("Sega Saturn", &[("B", vec![("b.bin", 32, "11223344")])]),
            ),
        ]),
    )
    .expect("dump fixture");

    let (imported, _, _) =
        import_redump_dat(&dump, &database, Some("Sega Saturn")).expect("single-platform import");
    assert_eq!(imported.len(), 1);
    assert_eq!(imported[0].platform, "Sega Saturn");

    assert!(
        error_text(import_redump_dat(&dump, &database, Some("Nintendo Wii")))
            .contains("does not contain the `Nintendo Wii` system")
    );
}

#[test]
fn merged_catalog_writing_keeps_untouched_platforms() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    fs::create_dir_all(&database).expect("database dir");
    fs::write(
        database.join("catalog.json"),
        catalog_bytes(&[("Sega Saturn", "sega-saturn", None)]),
    )
    .expect("catalog fixture");

    let imported = vec![ImportedSystem {
        platform: "Sony PlayStation".to_string(),
        slug: "sony-playstation".to_string(),
        file: "sony-playstation.pack".to_string(),
        sha256: "0".repeat(64),
        games: 1,
        components: 1,
        routed_keys: 1,
        shared_components: 0,
    }];
    write_merged_catalog(&database, &imported, &json!({})).expect("merged catalog");

    let catalog =
        IdentifyCatalog::parse(&fs::read(database.join("catalog.json")).expect("catalog"))
            .expect("parsed catalog");
    assert_eq!(catalog.entries().len(), 2);
    assert_eq!(catalog.entries()[0].canonical_platform, "Sega Saturn");
    assert_eq!(catalog.entries()[1].canonical_platform, "Sony PlayStation");

    // Re-importing the same platform replaces its entry instead of duplicating it.
    write_merged_catalog(&database, &imported, &json!({})).expect("merged catalog");
    let catalog =
        IdentifyCatalog::parse(&fs::read(database.join("catalog.json")).expect("catalog"))
            .expect("parsed catalog");
    assert_eq!(catalog.entries().len(), 2);
}

#[test]
fn merged_catalog_writing_rejects_an_unparsable_existing_catalog() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    fs::create_dir_all(&database).expect("database dir");
    fs::write(database.join("catalog.json"), b"[]").expect("catalog fixture");
    assert!(write_merged_catalog(&database, &[], &json!({})).is_err());
}

#[test]
fn import_report_details_carry_every_imported_system() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let imported = vec![ImportedSystem {
        platform: "Sony PlayStation".to_string(),
        slug: "sony-playstation".to_string(),
        file: "sony-playstation.pack".to_string(),
        sha256: "ab".repeat(32),
        games: 3,
        components: 5,
        routed_keys: 4,
        shared_components: 1,
    }];
    let report = import_report(temp.path(), &imported, &["Nintendo 64".to_string()], 7);
    assert_eq!(report.status, OperationStatus::Succeeded);
    assert_eq!(
        report.label,
        "imported 1 platform pack(s); 1 OpenGood platform(s) stay built-in"
    );
    let details = report.details.expect("import details");
    assert_eq!(
        details["imported"][0]["platform"],
        json!("Sony PlayStation")
    );
    assert_eq!(details["imported"][0]["games"], json!(3));
    assert_eq!(details["imported"][0]["routed_keys"], json!(4));
    assert_eq!(details["skipped_opengood"], json!(["Nintendo 64"]));
    assert_eq!(details["skipped_over_caps"], json!(7));
}

// ---------------------------------------------------------------------------
// resolve_install_platform
// ---------------------------------------------------------------------------

#[test]
fn install_targets_resolve_through_redump_then_the_catalog() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    fs::write(
        temp.path().join("catalog.json"),
        catalog_bytes(&[("Custom Machine", "custom-machine", None)]),
    )
    .expect("catalog fixture");
    let provider = IdentifyPackProvider::new(Some(temp.path().to_path_buf())).expect("provider");

    assert_eq!(
        resolve_install_platform(&provider, "sony - playstation").expect("redump system"),
        "Sony PlayStation"
    );
    assert_eq!(
        resolve_install_platform(&provider, "custom-machine").expect("catalog system"),
        "Custom Machine"
    );

    let error = resolve_install_platform(&provider, "Nintendo 64")
        .expect_err("an OpenGood platform is never installed from Redump");
    assert!(error.to_string().contains("never installed from Redump"));

    let error = resolve_install_platform(&provider, "not-a-system")
        .expect_err("an unknown system is rejected");
    assert!(error.to_string().contains("unknown Redump system"));
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

fn dir_command(dir: &Path) -> Box<IdentifyDatabaseDirCommand> {
    Box::new(IdentifyDatabaseDirCommand {
        database_dir: Some(dir.to_path_buf()),
    })
}

#[test]
fn database_list_reports_catalog_platforms_and_install_state() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    fs::write(
        temp.path().join("catalog.json"),
        catalog_bytes(&[("Custom Machine", "custom-machine", None)]),
    )
    .expect("catalog fixture");
    fs::write(
        temp.path().join("custom-machine.pack"),
        encoded_pack(
            "Custom Machine",
            vec![pack_game(
                "A",
                "Custom Machine",
                vec![pack_component(16, "aabbccdd")],
            )],
        ),
    )
    .expect("pack fixture");

    let (app, sink) = recording_app();
    let outcome =
        app.run_identify_database(IdentifyDatabaseCommands::List(dir_command(temp.path())));
    assert_eq!(outcome.status, OperationStatus::Succeeded);
    let (label, _, details) = last_report(&sink);
    assert!(label.ends_with("1 installed"));
    let platforms = details["platforms"].as_array().expect("platform rows");
    let custom = platforms
        .iter()
        .find(|entry| entry["platform"] == json!("Custom Machine"))
        .expect("the dir catalog platform is listed");
    assert_eq!(custom["installed"], json!(true));
    assert_eq!(custom["pack_format"], json!("RWFP1"));
    assert!(
        platforms.len() > 1,
        "the builtin catalog platforms are listed too"
    );
}

#[test]
fn database_status_hashes_each_installed_pack_and_flags_invalid_ones() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let pack = encoded_pack(
        "P",
        vec![pack_game("A", "P", vec![pack_component(16, "aabbccdd")])],
    );
    fs::write(temp.path().join("good.pack"), &pack).expect("pack fixture");
    fs::write(temp.path().join("bad.pack"), b"not a pack").expect("invalid pack fixture");

    let (app, sink) = recording_app();
    let outcome =
        app.run_identify_database(IdentifyDatabaseCommands::Status(dir_command(temp.path())));
    assert_eq!(outcome.status, OperationStatus::Succeeded);
    let (label, _, details) = last_report(&sink);
    assert_eq!(label, "2 installed pack(s)");
    let packs = details["packs"].as_array().expect("pack rows");
    assert_eq!(packs[0]["slug"], json!("bad"));
    assert_eq!(packs[0]["format"], json!("invalid"));
    assert_eq!(packs[1]["slug"], json!("good"));
    assert_eq!(packs[1]["format"], json!("RWFP1"));
    assert_eq!(packs[1]["bytes"], json!(pack.len()));
    assert_eq!(packs[1]["sha256"], json!(sha256_hex(&pack)));
}

#[test]
fn database_status_on_a_missing_dir_reports_no_packs() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let (app, sink) = recording_app();
    let outcome = app.run_identify_database(IdentifyDatabaseCommands::Status(dir_command(
        &temp.path().join("absent"),
    )));
    assert_eq!(outcome.status, OperationStatus::Succeeded);
    assert_eq!(last_report(&sink).0, "0 installed pack(s)");
}

#[test]
fn database_path_prints_the_database_dir() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let (app, sink) = recording_app();
    app.run_identify_database(IdentifyDatabaseCommands::Path(dir_command(temp.path())));
    let (label, _, details) = last_report(&sink);
    assert_eq!(label, temp.path().to_string_lossy());
    assert_eq!(
        details["database_dir"],
        json!(temp.path().to_string_lossy())
    );
}

#[test]
fn database_remove_deletes_an_installed_pack_and_refuses_the_rest() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    fs::write(
        temp.path().join("catalog.json"),
        catalog_bytes(&[("Custom Machine", "custom-machine", None)]),
    )
    .expect("catalog fixture");
    let system_command = |system: &str| {
        IdentifyDatabaseCommands::Remove(Box::new(IdentifyDatabaseSystemCommand {
            system: system.to_string(),
            database_dir: Some(temp.path().to_path_buf()),
        }))
    };

    let (app, sink) = recording_app();
    assert_eq!(
        app.run_identify_database(system_command("not-a-system"))
            .status,
        OperationStatus::Failed
    );
    assert!(last_report(&sink).0.contains("unknown system"));

    let (app, sink) = recording_app();
    assert_eq!(
        app.run_identify_database(system_command("custom-machine"))
            .status,
        OperationStatus::Failed
    );
    assert!(last_report(&sink).0.contains("no installed pack for"));

    let pack = temp.path().join("custom-machine.pack");
    fs::write(
        &pack,
        encoded_pack(
            "Custom Machine",
            vec![pack_game(
                "A",
                "Custom Machine",
                vec![pack_component(16, "aabbccdd")],
            )],
        ),
    )
    .expect("pack fixture");
    let (app, sink) = recording_app();
    assert_eq!(
        app.run_identify_database(system_command("custom-machine"))
            .status,
        OperationStatus::Succeeded
    );
    assert_eq!(last_report(&sink).0, "removed the Custom Machine pack");
    assert!(!pack.exists());
}

#[test]
fn database_import_redump_builds_a_pack_from_a_local_zip() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    let dump = dat_zip(
        temp.path(),
        "psx.zip",
        "Sony - PlayStation",
        &[("Game A", vec![("a.bin", 16, "aabbccdd")])],
    );

    let (app, sink) = recording_app();
    let outcome = app.run_identify_database(IdentifyDatabaseCommands::ImportRedump(Box::new(
        IdentifyDatabaseImportCommand {
            input: dump,
            database_dir: Some(database.clone()),
        },
    )));
    assert_eq!(outcome.status, OperationStatus::Succeeded);
    let (label, _, details) = last_report(&sink);
    assert!(label.starts_with("imported 1 platform pack(s)"));
    assert_eq!(
        details["imported"][0]["platform"],
        json!("Sony PlayStation")
    );
    assert!(database.join("sony-playstation.pack").is_file());
}

#[test]
fn database_install_from_a_local_zip_honors_the_system_selector() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    let dump = dat_zip(
        temp.path(),
        "psx.zip",
        "Sony - PlayStation",
        &[("Game A", vec![("a.bin", 16, "aabbccdd")])],
    );
    let install = |system: Option<&str>, all: bool| {
        IdentifyDatabaseCommands::Install(Box::new(IdentifyDatabaseInstallCommand {
            system: system.map(str::to_string),
            all,
            from: Some(dump.clone()),
            database_dir: Some(database.clone()),
        }))
    };

    let (app, sink) = recording_app();
    assert_eq!(
        app.run_identify_database(install(None, false)).status,
        OperationStatus::Failed
    );
    assert!(last_report(&sink).0.contains("pass a system name or --all"));

    let (app, sink) = recording_app();
    assert_eq!(
        app.run_identify_database(install(Some("sony - playstation"), false))
            .status,
        OperationStatus::Succeeded
    );
    assert_eq!(
        last_report(&sink).2["imported"][0]["slug"],
        json!("sony-playstation")
    );

    let (app, sink) = recording_app();
    assert_eq!(
        app.run_identify_database(install(None, true)).status,
        OperationStatus::Succeeded
    );
    assert!(last_report(&sink).0.starts_with("imported 1 platform"));
}

#[test]
fn database_update_from_a_local_zip_reimports_every_platform_by_default() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let database = temp.path().join("db");
    let dump = dat_zip(
        temp.path(),
        "psx.zip",
        "Sony - PlayStation",
        &[("Game A", vec![("a.bin", 16, "aabbccdd")])],
    );
    let update = |system: Option<&str>| {
        IdentifyDatabaseCommands::Update(Box::new(IdentifyDatabaseUpdateCommand {
            system: system.map(str::to_string),
            from: Some(dump.clone()),
            database_dir: Some(database.clone()),
        }))
    };

    let (app, sink) = recording_app();
    assert_eq!(
        app.run_identify_database(update(None)).status,
        OperationStatus::Succeeded
    );
    assert_eq!(
        last_report(&sink).2["imported"][0]["platform"],
        json!("Sony PlayStation")
    );

    let (app, sink) = recording_app();
    assert_eq!(
        app.run_identify_database(update(Some("psx"))).status,
        OperationStatus::Succeeded
    );
    assert!(last_report(&sink).0.starts_with("imported 1 platform"));

    let (app, sink) = recording_app();
    assert_eq!(
        app.run_identify_database(update(Some("not-a-system")))
            .status,
        OperationStatus::Failed
    );
    assert!(last_report(&sink).0.contains("unknown Redump system"));
}

#[test]
fn database_update_without_installed_redump_packs_is_an_error() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let (app, sink) = recording_app();
    let outcome = app.run_identify_database(IdentifyDatabaseCommands::Update(Box::new(
        IdentifyDatabaseUpdateCommand {
            system: None,
            from: None,
            database_dir: Some(temp.path().to_path_buf()),
        },
    )));
    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(
        last_report(&sink)
            .0
            .contains("no installed Redump packs to update")
    );
}

#[test]
fn database_install_group_rejects_an_invalid_group_id() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let (app, sink) = recording_app();
    let outcome = app.run_identify_database(IdentifyDatabaseCommands::InstallGroup(Box::new(
        IdentifyDatabaseGroupCommand {
            group: "Not A Group".to_string(),
            from: Some(temp.path().join("absent.tar.br")),
            database_dir: Some(temp.path().to_path_buf()),
        },
    )));
    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(last_report(&sink).0.contains("invalid identify pack group"));
}

#[test]
fn the_default_database_dir_ends_in_the_identify_folder() {
    let dir = default_database_dir().expect("a home or data directory resolves");
    assert_eq!(
        dir.file_name().and_then(|name| name.to_str()),
        Some("identify")
    );
    assert!(dir.is_absolute());
}

#[test]
fn write_atomic_reports_a_target_it_cannot_replace() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let occupied = temp.path().join("pack");
    fs::create_dir_all(occupied.join("child")).expect("occupied directory");
    let error = write_atomic(&occupied, b"payload")
        .expect_err("renaming a file over a non-empty directory fails");
    assert!(error.to_string().contains("failed to finalize"));
}

#[test]
fn database_install_without_a_local_zip_still_needs_a_system_or_all() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let (app, sink) = recording_app();
    let outcome = app.run_identify_database(IdentifyDatabaseCommands::Install(Box::new(
        IdentifyDatabaseInstallCommand {
            system: None,
            all: false,
            from: None,
            database_dir: Some(temp.path().to_path_buf()),
        },
    )));
    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(last_report(&sink).0.contains("pass a system name or --all"));
}

#[test]
fn database_update_rejects_an_unknown_system_before_any_download() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let (app, sink) = recording_app();
    let outcome = app.run_identify_database(IdentifyDatabaseCommands::Update(Box::new(
        IdentifyDatabaseUpdateCommand {
            system: Some("not-a-system".to_string()),
            from: None,
            database_dir: Some(temp.path().to_path_buf()),
        },
    )));
    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(last_report(&sink).0.contains("unknown Redump system"));
}
