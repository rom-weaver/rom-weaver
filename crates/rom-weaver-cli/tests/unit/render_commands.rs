use rom_weaver_core::OperationFamily;
use serde_json::json;

use super::super::HumanStyle;
use super::*;

/// Every renderer writes through `Surface` to stdout, so these tests pin the
/// pure formatting helpers directly and check that incomplete report details
/// cannot panic the command dispatcher.
fn surface() -> Surface {
    Surface::new(HumanStyle::Simple, Some(false))
}

fn event(command: &str, label: &str, details: Option<Value>) -> ProgressEvent {
    ProgressEvent {
        command: command.to_string(),
        family: OperationFamily::Container,
        stage: "run".to_string(),
        label: label.to_string(),
        details,
        ..ProgressEvent::from_thread_execution(None)
    }
}

#[test]
fn explicit_outputs_are_silent_and_generated_names_remain_results() {
    let file = json!({ "path": "game.bps" });
    assert!(OutputSelection::default().shows_file(&file));
    let explicit = OutputSelection {
        explicit_output: Some("game.bps".into()),
        ..OutputSelection::default()
    };
    assert!(!explicit.shows_file(&file));
    assert!(explicit.shows_file(&json!({ "path": "game-patched.bps" })));
    let in_place = OutputSelection {
        suppress_files: true,
        ..OutputSelection::default()
    };
    assert!(!in_place.shows_file(&file));
}

#[test]
fn elapsed_below_a_second_stays_in_milliseconds() {
    assert_eq!(format_elapsed_ms(0), "0ms");
    assert_eq!(format_elapsed_ms(999), "999ms");
}

#[test]
fn elapsed_under_a_minute_reads_as_tenths_of_a_second() {
    assert_eq!(format_elapsed_ms(1_000), "1.0s");
    assert_eq!(format_elapsed_ms(59_949), "59.9s");
}

#[test]
fn elapsed_under_an_hour_reads_as_minutes_and_padded_seconds() {
    assert_eq!(format_elapsed_ms(60_000), "1m 00s");
    assert_eq!(format_elapsed_ms(3_599_000), "59m 59s");
}

#[test]
fn elapsed_past_an_hour_reads_as_hours_minutes_and_seconds() {
    assert_eq!(format_elapsed_ms(3_600_000), "1h 00m 00s");
    assert_eq!(format_elapsed_ms(45_296_000), "12h 34m 56s");
}

#[test]
fn humanize_key_preserves_parent_context() {
    assert_eq!(humanize_key("repaired_files"), "Repaired files");
    assert_eq!(
        humanize_key("container.entry_count"),
        "Container / Entry count"
    );
    assert_eq!(humanize_key(""), "");
}

#[test]
fn scalar_renders_strings_numbers_and_booleans_only() {
    assert_eq!(scalar(&json!("text")), Some("text".to_string()));
    assert_eq!(scalar(&json!(42)), Some("42".to_string()));
    assert_eq!(scalar(&json!(true)), Some("true".to_string()));
    assert_eq!(scalar(&json!(null)), None);
    assert_eq!(scalar(&json!([1, 2])), None);
    assert_eq!(scalar(&json!({ "a": 1 })), None);
}

#[test]
fn a_bytes_suffixed_number_is_humanized() {
    assert_eq!(
        scalar_for_key("size_bytes", &json!(1_500_000)),
        Some(humanize_bytes(1_500_000))
    );
    assert_eq!(
        scalar_for_key("size_bytes", &json!("not a number")),
        Some("not a number".to_string()),
        "a non-numeric *_bytes value falls through to the plain scalar"
    );
    assert_eq!(
        scalar_for_key("count", &json!(1_500_000)),
        Some("1500000".to_string())
    );
}

#[test]
fn string_and_size_fields_fall_back_to_a_dash() {
    let entry = json!({ "file_name": "game.nes", "size_bytes": 2048 });
    assert_eq!(string_field(&entry, "file_name"), "game.nes");
    assert_eq!(size_field(&entry, "size_bytes"), humanize_bytes(2048));
    assert_eq!(string_field(&entry, "missing"), "-");
    assert_eq!(size_field(&entry, "missing"), "-");
    assert_eq!(
        string_field(&json!({ "file_name": 7 }), "file_name"),
        "-",
        "a non-string value is not rendered as a name"
    );
}

#[test]
fn emitted_file_rows_prefer_the_destination_path() {
    let file = json!({
        "file_name": "game.nes",
        "path": "/roms/extracted/game.nes",
        "size_bytes": 2048,
        "kind": "rom",
    });
    assert_eq!(
        emitted_file_row(&file, false),
        vec!["/roms/extracted/game.nes".to_string()]
    );
    assert_eq!(
        emitted_file_row(&json!({ "file_name": "game.nes" }), false)[0],
        "game.nes",
        "the old file-name-only detail remains readable"
    );
}

#[test]
fn collect_pairs_flattens_nested_objects_and_humanizes_byte_counts() {
    let value = json!({
        "format": "chd",
        "container": { "entry_count": 3, "total_bytes": 2048 },
    });
    let mut pairs = Vec::new();
    collect_pairs("", value.as_object().expect("object"), &mut pairs);
    assert_eq!(
        pairs,
        vec![
            ("Container / Entry count".to_string(), "3".to_string()),
            ("Container / Total bytes".to_string(), humanize_bytes(2048)),
            ("Format".to_string(), "chd".to_string()),
        ]
    );
}

#[test]
fn collect_pairs_keeps_object_and_empty_arrays_visible() {
    let value = json!({
        "codecs": ["zstd", "lzma", 7, true],
        "objects": [{ "a": 1 }],
        "nulls": [null],
        "flag": false,
        "absent": null,
    });
    let mut pairs = Vec::new();
    collect_pairs("", value.as_object().expect("object"), &mut pairs);
    let rendered: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    assert_eq!(
        rendered,
        vec![
            ("Codecs", "zstd, lzma, 7, true"),
            ("Flag", "false"),
            ("Nulls", "none"),
            ("Objects[1] / A", "1"),
        ],
        "arrays of objects and empty values remain visible in a human summary"
    );
}

#[test]
fn empty_details_report_that_the_label_must_be_rendered() {
    assert!(
        !render_object(&surface(), &json!({})),
        "the caller uses this false result to show the event label"
    );
}

#[test]
fn dry_run_pairs_show_planned_destinations_and_no_side_effects() {
    let details = json!({
        "dry_run": true,
        "command": "compress",
        "input": "/roms/game.iso",
        "output": "/roms/game.chd",
        "writes": ["/roms/game.chd"],
        "downloads": [],
        "read_only": false,
    });
    assert_eq!(
        dry_run_pairs(details.as_object().expect("plan object")),
        vec![
            ("Input".to_string(), "/roms/game.iso".to_string()),
            ("Output".to_string(), "/roms/game.chd".to_string()),
            ("Writes".to_string(), "/roms/game.chd".to_string()),
            ("Downloads".to_string(), "none".to_string()),
            ("Read only".to_string(), "no".to_string()),
        ]
    );
}

#[test]
fn dry_run_pairs_mark_read_only_plans_with_no_writes() {
    let details = json!({
        "dry_run": true,
        "command": "checksum",
        "writes": [],
        "downloads": [],
        "read_only": true,
    });
    assert_eq!(
        dry_run_pairs(details.as_object().expect("plan object")),
        vec![
            ("Writes".to_string(), "none".to_string()),
            ("Downloads".to_string(), "none".to_string()),
            ("Read only".to_string(), "yes".to_string()),
        ]
    );
}

#[test]
fn dry_run_requires_the_explicit_detail_flag() {
    assert!(is_dry_run(&event(
        "compress",
        "dry run: would write; nothing written",
        Some(json!({ "dry_run": true })),
    )));
    assert!(!is_dry_run(&event(
        "compress",
        "dry run: would write; nothing written",
        Some(json!({})),
    )));
}

#[test]
fn emitted_file_results_keep_requested_checksums_and_probe_fields() {
    let file = json!({
        "path": " game.bin ",
        "kind": "bin",
        "platform": "nes",
        "checksums": { "crc32": "deadbeef" },
    });
    assert_eq!(
        emitted_file_row(&file, false),
        vec![" game.bin ", "crc32=deadbeef"]
    );
    assert_eq!(
        emitted_file_row(&file, true),
        vec![" game.bin ", "bin", "platform=nes", "crc32=deadbeef"]
    );
}

#[test]
fn probe_results_exclude_recommendations_without_hiding_header_information() {
    let details = json!({
        "platform": "nes",
        "rom_header": { "profile": "ines", "stripped_bytes": 16 },
        "recommended_compress_format": "7z",
        "reason": "generic archive",
    });
    assert_eq!(
        probe_pairs(&details),
        vec![
            ("Platform".into(), "nes".into()),
            ("Rom header / Profile".into(), "ines".into()),
            ("Rom header / Stripped bytes".into(), humanize_bytes(16)),
        ]
    );
}

#[test]
fn save_edit_preview_is_distinct_from_a_completed_write() {
    let preview = ProgressEvent {
        stage: "preview".to_string(),
        ..event("save-set", "Save edit preview is valid", None)
    };
    assert!(is_save_preview(&preview));
    assert!(!is_save_preview(&ProgressEvent {
        stage: "set".to_string(),
        ..preview
    }));
}

#[test]
fn checksum_digests_ignore_label_context_and_use_structured_values() {
    let checksum = event(
        "checksum",
        "range=0..1024 sha1=old; sha1 reused from chd raw_sha1 metadata",
        Some(json!({ "checksums": { "sha1": "correct" } })),
    );
    assert_eq!(
        checksum_pairs(&checksum),
        vec![("SHA1".to_string(), "correct".to_string())]
    );
}

#[test]
fn checksum_label_fallback_excludes_suffixes_range_and_cache() {
    let checksum = event(
        "checksum",
        "range=0..1024 cache=hit crc32=deadbeef; checksum source resolved via 1 container extract step(s)",
        None,
    );
    assert_eq!(
        checksum_pairs(&checksum),
        vec![("CRC32".to_string(), "deadbeef".to_string())]
    );
}

#[test]
fn nested_arrays_keep_each_result_and_distinguish_matching_field_names() {
    let details = json!({
        "patches": [
            { "source": { "size_bytes": 1024 }, "target": { "size_bytes": 2048 } },
            { "source": { "size_bytes": 2048 }, "target": { "size_bytes": 3072 } },
        ],
        "options": {},
    });
    let mut pairs = Vec::new();
    collect_pairs("", details.as_object().expect("details object"), &mut pairs);
    assert_eq!(
        pairs,
        vec![
            ("Options".to_string(), "none".to_string()),
            (
                "Patches[1] / Source / Size bytes".to_string(),
                humanize_bytes(1024)
            ),
            (
                "Patches[1] / Target / Size bytes".to_string(),
                humanize_bytes(2048)
            ),
            (
                "Patches[2] / Source / Size bytes".to_string(),
                humanize_bytes(2048)
            ),
            (
                "Patches[2] / Target / Size bytes".to_string(),
                humanize_bytes(3072)
            ),
        ]
    );
}

#[test]
fn normal_summaries_omit_execution_telemetry_without_hiding_plan_budgets() {
    let details = json!({
        "extraction": {
            "written_bytes": 1024,
            "requested_threads": 4,
            "effective_threads": 4,
            "thread_mode": "fixed",
            "used_parallelism": true,
            "thread_fallback": false,
            "thread_fallback_reason": "none",
        },
        "extract_batch_plan": { "threads_per_job": 4 },
    });
    let mut pairs = Vec::new();
    collect_pairs("", details.as_object().expect("details object"), &mut pairs);
    assert_eq!(
        pairs,
        vec![
            (
                "Extract batch plan / Threads per job".to_string(),
                "4".to_string()
            ),
            (
                "Extraction / Written bytes".to_string(),
                humanize_bytes(1024)
            ),
        ]
    );
}

#[test]
fn dry_run_without_a_no_write_label_gets_a_clear_notice() {
    assert!(needs_no_files_written_notice("trim simulation complete"));
    assert!(!needs_no_files_written_notice(
        "dry run: would write `/roms/game.chd`; nothing written"
    ));
    assert!(!needs_no_files_written_notice(
        "dry run: checksum only reads; no changes planned"
    ));
}

#[test]
fn collect_pairs_prefixes_nested_keys_for_uniqueness() {
    let value = json!({ "outer": { "inner": { "leaf_bytes": 1024 } } });
    let mut pairs = Vec::new();
    collect_pairs("root", value.as_object().expect("object"), &mut pairs);
    assert_eq!(
        pairs,
        vec![(
            "Root / Outer / Inner / Leaf bytes".to_string(),
            humanize_bytes(1024)
        )]
    );
}

#[test]
fn identify_rows_keep_alternate_names_and_distinguish_dump_variants() {
    let matches = json!([
        { "name": "Game", "platform": "nes", "region": "USA", "revision": "1", "variant": "raw", "alternate_names": ["Alternate", "Game"], "expected_components": [{ "crc32": "deadbeef" }] },
        { "name": "Game", "platform": "nes", "region": "USA", "revision": "2", "variant": "raw", "expected_components": [{ "crc32": "12345678" }] },
    ]);
    let rows = identify_rows(matches.as_array().expect("matches"));
    assert_eq!(rows.len(), 2);
    assert!(rows[0].contains(&"also=Alternate".to_string()));
    assert!(rows[0].contains(&"revision=1".to_string()));
    assert!(rows[1].contains(&"revision=2".to_string()));
    assert!(rows[0].contains(&"crc32=deadbeef".to_string()));
    assert!(rows[1].contains(&"crc32=12345678".to_string()));
}

#[test]
fn every_success_shape_renders_without_the_expected_details() {
    // Renderers MUST accept missing optional details without panicking.
    let surface = surface();
    let shapes = [
        event("probe", "probe label", None),
        event("probe", "probe label", Some(json!("not an object"))),
        event("probe", "probe label", Some(json!({ "other": 1 }))),
        event("extract", "extract label", None),
        event(
            "extract",
            "extract label",
            Some(json!({ "emitted_files": 3 })),
        ),
        event("compress", "compress label", Some(json!({}))),
        event("patch-apply", "apply label", None),
        event("patch-create", "create label", None),
        event(
            "patch-create",
            "create label",
            Some(json!({ "patch_create_format_candidates": { "other": 1 } })),
        ),
        event("checksum", "no tokens here", None),
        event("checksum", "novalue", None),
        event("identify", String::new().as_str(), None),
        event("formats", "formats label", Some(json!([1, 2, 3]))),
    ];
    for shape in shapes {
        render_success(&surface, &shape, &OutputSelection::default());
    }
}

#[test]
fn every_success_shape_renders_with_its_expected_details() {
    let surface = surface();
    let shapes = [
        event(
            "probe",
            "probe label",
            Some(json!({
                "container": {
                    "entry_records": [
                        { "file_name": "a.bin", "size_bytes": 1024 },
                        { "size_bytes": 2048 },
                        { "file_name": "c.bin" },
                    ]
                }
            })),
        ),
        event(
            "probe",
            "probe label",
            Some(json!({ "container": { "compress_recommendation": "chd" } })),
        ),
        event(
            "probe",
            "probe label",
            Some(json!({ "patch": { "format": "bps", "size_bytes": 4096 } })),
        ),
        event(
            "extract",
            "extract label",
            Some(json!({
                "emitted_files": [
                    { "file_name": "a.bin", "size_bytes": 1024, "kind": "rom" },
                    { "file_name": "b.bin" },
                ]
            })),
        ),
        event("checksum", "crc32=deadbeef range=0-1023 cache=hit", None),
        event(
            "patch-create",
            "create label",
            Some(json!({
                "patch_create_format_candidates": {
                    "default": "bps",
                    "formats": ["bps", "ips", 7]
                }
            })),
        ),
        event(
            "patch-create",
            "create label",
            Some(json!({ "patch_create_format_candidates": { "default": "bps" } })),
        ),
        ProgressEvent {
            elapsed_ms: Some(1_234),
            ..event(
                "identify",
                "identify label",
                Some(json!({ "system": "nes" })),
            )
        },
    ];
    for shape in shapes {
        render_success(&surface, &shape, &OutputSelection::default());
    }
}
