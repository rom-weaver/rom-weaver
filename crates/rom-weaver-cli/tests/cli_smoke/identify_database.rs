use super::shared::*;

const PACK_V2_MAGIC: &[u8] = b"RWFP2\0\0\0";
const CONFLICT_VALUE_FLAG: u32 = 0x8000_0000;

/// One route entry: ((crc32 bytes, size), ref ids).
type RouteEntry = (([u8; 4], u64), Vec<u32>);

fn crc32_of(bytes: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new();
    crc.update(bytes);
    crc.sum()
}

// ---------------------------------------------------------------------------
// RWFP2 fixture builders (mirror the byte layout the reader expects)
// ---------------------------------------------------------------------------

fn build_pack_container(members: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(PACK_V2_MAGIC);
    out.extend_from_slice(&(members.len() as u32).to_le_bytes());
    for (name, bytes) in members {
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
    }
    for (_, bytes) in members {
        out.extend_from_slice(bytes);
    }
    out
}

fn build_refs(refs: &[(u32, u16)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"RWX2");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&6u16.to_le_bytes());
    for (game, component) in refs {
        out.extend_from_slice(&game.to_le_bytes());
        out.extend_from_slice(&component.to_le_bytes());
    }
    out
}

fn build_route(mut entries: Vec<RouteEntry>) -> Vec<u8> {
    entries.sort_by_key(|entry| entry.0);
    let mut conflict_offsets = vec![0u32];
    let mut conflict_values: Vec<u32> = Vec::new();
    let mut records = Vec::new();
    for ((crc, size), ids) in &entries {
        records.extend_from_slice(crc);
        records.extend_from_slice(&size.to_le_bytes());
        let value = if ids.len() == 1 {
            ids[0]
        } else {
            let index = (conflict_offsets.len() - 1) as u32;
            conflict_values.extend_from_slice(ids);
            conflict_offsets.push(conflict_values.len() as u32);
            CONFLICT_VALUE_FLAG + index
        };
        records.extend_from_slice(&value.to_le_bytes());
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"RWR2");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    out.extend_from_slice(&((conflict_offsets.len() - 1) as u32).to_le_bytes());
    out.extend_from_slice(&(conflict_values.len() as u32).to_le_bytes());
    out.extend_from_slice(&records);
    for offset in conflict_offsets {
        out.extend_from_slice(&offset.to_le_bytes());
    }
    for value in conflict_values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

fn component_json(
    ordinal: u32,
    size: u64,
    crc32: Option<&str>,
    required: bool,
    discriminating: bool,
) -> Value {
    let mut value = serde_json::json!({
        "role": "primary_payload",
        "ordinal": ordinal,
        "size": size,
        "required": required,
        "discriminating": discriminating,
    });
    if let Some(crc32) = crc32 {
        value["crc32"] = serde_json::json!(crc32);
    }
    value
}

/// Build an RWFP2 pack for one platform. Every discriminating component with a
/// crc32 and a size is routed.
fn pack_v2(platform: &str, profile: &str, games: &[(&str, Vec<Value>)]) -> Vec<u8> {
    let mut refs: Vec<(u32, u16)> = Vec::new();
    let mut route: Vec<RouteEntry> = Vec::new();
    for (game_index, (_, components)) in games.iter().enumerate() {
        for (component_index, component) in components.iter().enumerate() {
            let discriminating = component["discriminating"].as_bool().unwrap();
            let size = component["size"].as_u64().unwrap();
            let crc32 = component["crc32"].as_str();
            if !discriminating || size == 0 {
                continue;
            }
            let Some(crc32) = crc32 else { continue };
            let mut crc_bytes = [0u8; 4];
            for (index, byte) in crc_bytes.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&crc32[index * 2..index * 2 + 2], 16).unwrap();
            }
            let ref_id = refs.len() as u32;
            refs.push((game_index as u32, component_index as u16));
            match route.iter_mut().find(|(key, _)| *key == (crc_bytes, size)) {
                Some((_, ids)) => ids.push(ref_id),
                None => route.push(((crc_bytes, size), vec![ref_id])),
            }
        }
    }
    let games_json = serde_json::to_vec(
        &games
            .iter()
            .map(|(name, components)| {
                serde_json::json!({
                    "name": name,
                    "platform": platform,
                    "source": "redump",
                    "upstreamSource": "redump",
                    "components": components,
                })
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let manifest = serde_json::to_vec(&serde_json::json!({
        "format": "rom-weaver-identify-system-pack-v2",
        "platform": platform,
        "source": "redump",
        "canonicalizationProfile": profile,
        "canonicalizationVersion": 1,
        "counts": { "games": games.len(), "components": 0, "routedKeys": route.len() },
    }))
    .unwrap();
    build_pack_container(&[
        ("games.json", games_json),
        ("route.bin", build_route(route)),
        ("refs.bin", build_refs(&refs)),
        ("manifest.json", manifest),
    ])
}

fn catalog_json(platforms: &[(&str, &[&str], &str, &str)]) -> Vec<u8> {
    let entries: Vec<Value> = platforms
        .iter()
        .map(|(canonical, aliases, slug, profile)| {
            serde_json::json!({
                "canonicalPlatform": canonical,
                "aliases": aliases,
                "source": "redump",
                "mediaProfiles": [profile],
                "packSlug": slug,
                "packFormat": "RWFP2",
                "canonicalizationVersion": 1,
            })
        })
        .collect();
    serde_json::to_vec_pretty(&serde_json::json!({
        "format": "rom-weaver-identify-catalog-v1",
        "platforms": entries,
    }))
    .unwrap()
}

// ---------------------------------------------------------------------------
// Minimal STORE-only zip writer for Redump DAT fixtures.
// ---------------------------------------------------------------------------

fn store_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let crc = crc32_of(data);
        let offset = out.len() as u32;
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);

        central.extend_from_slice(b"PK\x01\x02");
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// One temp database dir with a Sony PlayStation catalog entry and (when
/// `with_pack`) a matching one-game pack for `payload`.
fn playstation_database(temp: &TempDir, payload: &[u8], with_pack: bool) -> PathBuf {
    let dir = temp.child("identify-db").path().to_path_buf();
    fs::create_dir_all(&dir).expect("database dir");
    fs::write(
        dir.join("catalog.json"),
        catalog_json(&[(
            "Sony PlayStation",
            &["psx", "ps1"],
            "sony-playstation",
            "nointro-single-image-v1",
        )]),
    )
    .expect("catalog fixture");
    if with_pack {
        let crc = format!("{:08x}", crc32_of(payload));
        let pack = pack_v2(
            "Sony PlayStation",
            "nointro-single-image-v1",
            &[(
                "Ridge Racer (USA)",
                vec![component_json(
                    0,
                    payload.len() as u64,
                    Some(&crc),
                    true,
                    true,
                )],
            )],
        );
        fs::write(dir.join("sony-playstation.pack"), pack).expect("pack fixture");
    }
    dir
}

#[test]
fn identify_system_alias_routes_to_an_installed_v2_pack() {
    let temp = setup_temp_dir();
    let payload = b"playstation payload".to_vec();
    fs::write(temp.child("game.bin").path(), &payload).expect("ROM fixture");
    let dir = playstation_database(&temp, &payload, true);

    let output = command_stdout(
        &[
            "identify",
            "--input",
            temp.child("game.bin").path().to_str().expect("ROM path"),
            "--system",
            "psx",
            "--database-dir",
            dir.to_str().expect("dir path"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    let identify = &json["details"]["identify"];

    assert_eq!(json["status"], "succeeded");
    assert_eq!(identify["status"], "matched");
    assert_eq!(identify["matches"][0]["name"], "Ridge Racer (USA)");
    assert_eq!(identify["matches"][0]["platform"], "Sony PlayStation");
    assert_eq!(identify["quality"], "exact");
    assert_eq!(identify["database"]["pack_format"], "RWFP2");
    assert_eq!(
        identify["database"]["canonicalization_profile"],
        "nointro-single-image-v1"
    );
    assert_eq!(
        identify["platform_candidates"][0]["platform"],
        "Sony PlayStation"
    );
    assert_eq!(
        identify["platform_candidates"][0]["evidence"]["kind"],
        "user_override"
    );
    assert_eq!(identify["evidence"]["layout_matched"], true);
}

#[test]
fn identify_matches_a_v2_pack_passed_via_database() {
    let temp = setup_temp_dir();
    let payload = b"v2 explicit pack payload".to_vec();
    fs::write(temp.child("game.bin").path(), &payload).expect("ROM fixture");
    let crc = format!("{:08x}", crc32_of(&payload));
    let pack = pack_v2(
        "Test Platform",
        "nointro-single-image-v1",
        &[(
            "Explicit Game",
            vec![component_json(
                0,
                payload.len() as u64,
                Some(&crc),
                true,
                true,
            )],
        )],
    );
    fs::write(temp.child("test-v2.pack").path(), pack).expect("pack fixture");

    let output = command_stdout(
        &[
            "identify",
            "--input",
            temp.child("game.bin").path().to_str().expect("ROM path"),
            "--database",
            temp.child("test-v2.pack").path().to_str().expect("pack"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    let identify = &json["details"]["identify"];

    assert_eq!(identify["status"], "matched");
    assert_eq!(identify["matches"][0]["name"], "Explicit Game");
    assert_eq!(identify["matches"][0]["algorithm"], "components");
    assert_eq!(identify["matches"][0]["database"], "test-v2.pack");
    assert_eq!(identify["quality"], "exact");
}

#[test]
#[cfg(not(feature = "bundled-identify-data"))]
fn identify_reports_database_required_for_an_uninstalled_platform() {
    let temp = setup_temp_dir();
    let payload = b"unmatched payload".to_vec();
    fs::write(temp.child("game.bin").path(), &payload).expect("ROM fixture");
    let dir = playstation_database(&temp, &payload, false);

    let output = command_stdout(
        &[
            "identify",
            "--input",
            temp.child("game.bin").path().to_str().expect("ROM path"),
            "--system",
            "ps1",
            "--database-dir",
            dir.to_str().expect("dir path"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    let identify = &json["details"]["identify"];

    assert_eq!(json["status"], "succeeded");
    assert_eq!(identify["status"], "unknown");
    assert_eq!(identify["condition"], "database_required");
    let hint = identify["hint"].as_str().expect("hint");
    assert!(hint.contains("Sony PlayStation"));
    assert!(hint.contains("identify database install"));
}

#[test]
fn identify_routes_from_header_detection_without_a_system_flag() {
    let temp = setup_temp_dir();
    // fwNES FDS header: "FDS\x1a" + disk-side count + padding to the 16-byte
    // header, then payload. Detection alone must route to the FDS catalog entry.
    let mut payload = b"FDS\x1a\x01".to_vec();
    payload.resize(16, 0);
    payload.extend_from_slice(b"famicom disk system payload");
    fs::write(temp.child("game.fds").path(), &payload).expect("ROM fixture");
    let dir = temp.child("identify-db").path().to_path_buf();
    fs::create_dir_all(&dir).expect("database dir");
    fs::write(
        dir.join("catalog.json"),
        catalog_json(&[(
            "Nintendo Famicom Disk System",
            &["fds"],
            "nintendo-famicom-disk-system",
            "nointro-single-image-v1",
        )]),
    )
    .expect("catalog fixture");

    let output = command_stdout(
        &[
            "identify",
            "--input",
            temp.child("game.fds").path().to_str().expect("ROM path"),
            "--database-dir",
            dir.to_str().expect("dir path"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    let identify = &json["details"]["identify"];

    assert_eq!(json["status"], "succeeded");
    assert_eq!(identify["status"], "unknown");
    assert_eq!(identify["condition"], "database_required");
    let hint = identify["hint"].as_str().expect("hint");
    assert!(hint.contains("Nintendo Famicom Disk System"));
}

#[test]
fn identify_rejects_an_unknown_system_name() {
    let temp = setup_temp_dir();
    fs::write(temp.child("game.bin").path(), b"payload").expect("ROM fixture");
    let output = command_stdout(
        &[
            "identify",
            "--input",
            temp.child("game.bin").path().to_str().expect("ROM path"),
            "--system",
            "not-a-real-console",
            "--json",
        ],
        1,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "failed");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("not-a-real-console"));
    assert!(label.contains("identify database list"));
}

#[test]
fn missing_required_track_is_a_partial_match() {
    let temp = setup_temp_dir();
    let track1 = b"data track payload".to_vec();
    fs::write(temp.child("track1.bin").path(), &track1).expect("track fixture");
    let crc1 = format!("{:08x}", crc32_of(&track1));
    let pack = pack_v2(
        "Test Platform",
        "nointro-single-image-v1",
        &[(
            "Two Track Game",
            vec![
                component_json(0, track1.len() as u64, Some(&crc1), true, true),
                component_json(1, 999, Some("deadbeef"), true, false),
            ],
        )],
    );
    fs::write(temp.child("disc.pack").path(), pack).expect("pack fixture");

    let output = command_stdout(
        &[
            "identify",
            "--input",
            temp.child("track1.bin").path().to_str().expect("ROM path"),
            "--database",
            temp.child("disc.pack").path().to_str().expect("pack"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    let identify = &json["details"]["identify"];

    assert_eq!(identify["status"], "matched");
    assert_eq!(identify["matches"][0]["name"], "Two Track Game");
    assert_eq!(identify["quality"], "partial");
    assert_eq!(identify["evidence"]["required_components_matched"], 1);
    assert_eq!(identify["evidence"]["required_components_total"], 2);
    assert_eq!(identify["evidence"]["layout_matched"], false);
    assert_eq!(
        identify["evidence"]["missing_components"],
        serde_json::json!(["PrimaryPayload#1"])
    );
    assert!(identify["evidence"].get("unexpected_components").is_none());
    assert_eq!(
        identify["database"]["upstream_sources"],
        serde_json::json!(["redump"])
    );
}

#[test]
fn shared_only_component_stays_unknown() {
    let temp = setup_temp_dir();
    let shared = b"shared audio payload".to_vec();
    fs::write(temp.child("audio.bin").path(), &shared).expect("track fixture");
    let crc = format!("{:08x}", crc32_of(&shared));
    // The shared component is non-discriminating, so it is not routed and can
    // never pick a game on its own.
    let pack = pack_v2(
        "Test Platform",
        "nointro-single-image-v1",
        &[(
            "Disc Game",
            vec![
                component_json(0, 555, Some("11111111"), true, true),
                component_json(1, shared.len() as u64, Some(&crc), true, false),
            ],
        )],
    );
    fs::write(temp.child("disc.pack").path(), pack).expect("pack fixture");

    let output = command_stdout(
        &[
            "identify",
            "--input",
            temp.child("audio.bin").path().to_str().expect("ROM path"),
            "--database",
            temp.child("disc.pack").path().to_str().expect("pack"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    let identify = &json["details"]["identify"];
    assert_eq!(identify["status"], "unknown");
    assert_eq!(identify["matches"], serde_json::json!([]));
}

#[test]
fn corrupt_pack_fails_the_command_instead_of_reporting_unknown() {
    let temp = setup_temp_dir();
    fs::write(temp.child("game.bin").path(), b"payload").expect("ROM fixture");
    fs::write(temp.child("broken.pack").path(), b"RWFP2\0\0\0garbage").expect("pack fixture");

    let output = command_stdout(
        &[
            "identify",
            "--input",
            temp.child("game.bin").path().to_str().expect("ROM path"),
            "--database",
            temp.child("broken.pack").path().to_str().expect("pack"),
            "--json",
        ],
        1,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "failed");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("broken.pack"));
}

#[test]
fn database_list_status_path_remove_round_trip() {
    let temp = setup_temp_dir();
    let payload = b"round trip payload".to_vec();
    let dir = playstation_database(&temp, &payload, true);
    let dir_arg = dir.to_str().expect("dir path");

    let list = parse_single_json_line(&command_stdout(
        &[
            "identify",
            "database",
            "list",
            "--database-dir",
            dir_arg,
            "--json",
        ],
        0,
    ));
    assert_eq!(list["status"], "succeeded");
    let platforms = list["details"]["platforms"].as_array().expect("platforms");
    let playstation = platforms
        .iter()
        .find(|entry| entry["platform"] == "Sony PlayStation")
        .expect("PlayStation entry");
    assert_eq!(playstation["installed"], true);
    assert_eq!(playstation["pack_format"], "RWFP2");
    // The builtin OpenGood catalog entries are listed too.
    assert!(
        platforms
            .iter()
            .any(|entry| entry["platform"] == "Nintendo Entertainment System")
    );

    let status = parse_single_json_line(&command_stdout(
        &[
            "identify",
            "database",
            "status",
            "--database-dir",
            dir_arg,
            "--json",
        ],
        0,
    ));
    let packs = status["details"]["packs"].as_array().expect("packs");
    assert_eq!(packs.len(), 1);
    assert_eq!(packs[0]["slug"], "sony-playstation");
    assert_eq!(packs[0]["format"], "RWFP2");
    assert_eq!(packs[0]["sha256"].as_str().expect("sha256").len(), 64);

    let path = parse_single_json_line(&command_stdout(
        &[
            "identify",
            "database",
            "path",
            "--database-dir",
            dir_arg,
            "--json",
        ],
        0,
    ));
    assert_eq!(
        path["details"]["database_dir"].as_str().expect("dir"),
        dir_arg
    );

    let remove = parse_single_json_line(&command_stdout(
        &[
            "identify",
            "database",
            "remove",
            "psx",
            "--database-dir",
            dir_arg,
            "--json",
        ],
        0,
    ));
    assert_eq!(remove["status"], "succeeded");
    assert!(!dir.join("sony-playstation.pack").is_file());

    let list_after = parse_single_json_line(&command_stdout(
        &[
            "identify",
            "database",
            "list",
            "--database-dir",
            dir_arg,
            "--json",
        ],
        0,
    ));
    let playstation = list_after["details"]["platforms"]
        .as_array()
        .expect("platforms")
        .iter()
        .find(|entry| entry["platform"] == "Sony PlayStation")
        .cloned()
        .expect("PlayStation entry");
    assert_eq!(playstation["installed"], false);
}

#[test]
fn install_rejects_an_opengood_system() {
    let temp = setup_temp_dir();
    let dir = temp.child("identify-db").path().to_path_buf();
    fs::create_dir_all(&dir).expect("database dir");
    let output = command_stdout(
        &[
            "identify",
            "database",
            "install",
            "Atari 2600",
            "--database-dir",
            dir.to_str().expect("dir path"),
            "--json",
        ],
        1,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "failed");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("OpenGood platform"));
}

fn redump_dat_for(platform: &str, games: &[(&str, &[u8])]) -> Vec<u8> {
    let mut xml =
        format!("<?xml version=\"1.0\"?><datafile><header><name>{platform}</name></header>");
    for (name, payload) in games {
        xml.push_str(&format!(
            "<game name=\"{name}\"><rom name=\"{name}.bin\" size=\"{}\" crc=\"{:08x}\"/></game>",
            payload.len(),
            crc32_of(payload)
        ));
    }
    xml.push_str("</datafile>");
    xml.into_bytes()
}

fn redump_dat(games: &[(&str, &[u8])]) -> Vec<u8> {
    redump_dat_for("Sony - PlayStation", games)
}

#[test]
fn install_from_imports_only_the_requested_redump_system() {
    let temp = setup_temp_dir();
    let playstation = redump_dat(&[("PlayStation Game", b"playstation")]);
    let saturn = redump_dat_for("Sega - Saturn", &[("Saturn Game", b"saturn")]);
    let zip = store_zip(&[
        ("Sony - PlayStation.dat", &playstation),
        ("Sega - Saturn.dat", &saturn),
    ]);
    fs::write(temp.child("redump.zip").path(), zip).expect("dump fixture");
    let dir = temp.child("identify-db").path().to_path_buf();
    fs::create_dir_all(&dir).expect("database dir");

    let install = parse_single_json_line(&command_stdout(
        &[
            "identify",
            "database",
            "install",
            "Sony PlayStation",
            "--from",
            temp.child("redump.zip").path().to_str().expect("zip path"),
            "--database-dir",
            dir.to_str().expect("dir path"),
            "--json",
        ],
        0,
    ));
    assert_eq!(
        install["details"]["imported"]
            .as_array()
            .expect("imported")
            .len(),
        1
    );
    assert!(dir.join("sony-playstation.pack").is_file());
    assert!(!dir.join("sega-saturn.pack").is_file());
}

#[test]
fn import_skips_records_over_pack_caps_and_reports_the_count() {
    let temp = setup_temp_dir();
    let oversized_name = "A".repeat(5000);
    let dat = redump_dat(&[
        ("Good Game (USA)", b"good payload"),
        (&oversized_name, b"oversized payload"),
    ]);
    let zip = store_zip(&[("Sony - PlayStation.dat", &dat)]);
    fs::write(temp.child("redump.zip").path(), zip).expect("dump fixture");
    let dir = temp.child("identify-db").path().to_path_buf();
    fs::create_dir_all(&dir).expect("database dir");

    let import = parse_single_json_line(&command_stdout(
        &[
            "identify",
            "database",
            "import-redump",
            temp.child("redump.zip").path().to_str().expect("zip path"),
            "--database-dir",
            dir.to_str().expect("dir path"),
            "--json",
        ],
        0,
    ));
    assert_eq!(import["status"], "succeeded");
    assert_eq!(import["details"]["skipped_over_caps"], 1);
    let imported = import["details"]["imported"].as_array().expect("imported");
    assert_eq!(imported.len(), 1);
    assert_eq!(imported[0]["games"], 1);
}

#[test]
fn import_redump_builds_packs_and_identify_uses_them() {
    let temp = setup_temp_dir();
    let payload = b"imported redump payload".to_vec();
    let dat = redump_dat(&[("Imported Game (USA)", &payload)]);
    let zip = store_zip(&[("Sony - PlayStation.dat", &dat)]);
    fs::write(temp.child("redump.zip").path(), zip).expect("dump fixture");
    let dir = temp.child("identify-db").path().to_path_buf();
    fs::create_dir_all(&dir).expect("database dir");
    let dir_arg = dir.to_str().expect("dir path");

    let import = parse_single_json_line(&command_stdout(
        &[
            "identify",
            "database",
            "import-redump",
            temp.child("redump.zip").path().to_str().expect("zip path"),
            "--database-dir",
            dir_arg,
            "--json",
        ],
        0,
    ));
    assert_eq!(import["status"], "succeeded");
    let imported = import["details"]["imported"].as_array().expect("imported");
    assert_eq!(imported.len(), 1);
    assert_eq!(imported[0]["platform"], "Sony PlayStation");
    assert_eq!(imported[0]["slug"], "sony-playstation");
    assert_eq!(import["details"]["skipped_opengood"], serde_json::json!([]));
    assert!(dir.join("sony-playstation.pack").is_file());
    assert!(dir.join("catalog.json").is_file());

    // The imported pack identifies the payload through the catalog alias.
    fs::write(temp.child("game.bin").path(), &payload).expect("ROM fixture");
    let output = command_stdout(
        &[
            "identify",
            "--input",
            temp.child("game.bin").path().to_str().expect("ROM path"),
            "--system",
            "psx",
            "--database-dir",
            dir_arg,
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    let identify = &json["details"]["identify"];
    assert_eq!(identify["status"], "matched");
    assert_eq!(identify["matches"][0]["name"], "Imported Game (USA)");
    assert_eq!(identify["database"]["source"], "redump");
    assert_eq!(identify["database"]["pack_format"], "RWFP2");
    // The imported game's SignatureSource is Redump.
    assert_eq!(
        identify["database"]["upstream_sources"],
        serde_json::json!(["redump"])
    );
    // An exact match reports no missing or unexpected components.
    assert!(identify["evidence"].get("missing_components").is_none());
    assert!(identify["evidence"].get("unexpected_components").is_none());
}
