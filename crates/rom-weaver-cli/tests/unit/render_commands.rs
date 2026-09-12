use rom_weaver_core::OperationFamily;
use serde_json::json;

use super::super::HumanStyle;
use super::*;

/// Every renderer writes through `Surface` to stdout, so these tests pin the
/// pure formatting helpers directly and drive the dispatching entry points for
/// the shapes they must survive: the module's contract is that any `details`
/// value renders, falling back to the label when the expected shape is absent.
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
fn write_summary_commands_are_the_ones_quiet_drops() {
    for command in [
        "extract",
        "compress",
        "patch-apply",
        "patch-create",
        "trim",
        "ingest",
        "bundle-create",
        "bundle-apply",
    ] {
        assert!(success_is_write_summary(command), "{command}");
    }
    for command in ["probe", "checksum", "patch-validate", "identify", "formats"] {
        assert!(!success_is_write_summary(command), "{command}");
    }
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
        emitted_file_row(&file),
        vec![
            "/roms/extracted/game.nes".to_string(),
            humanize_bytes(2048),
            "rom".to_string(),
        ]
    );
    assert_eq!(
        emitted_file_row(&json!({ "file_name": "game.nes" }))[0],
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
fn quiet_keeps_dry_run_plans_visible() {
    let ordinary_write = event("compress", "compressed", Some(json!({})));
    let dry_run = event(
        "compress",
        "dry run: would write; nothing written",
        Some(json!({ "dry_run": true })),
    );
    assert!(quiet_suppresses_success(true, &ordinary_write));
    assert!(!quiet_suppresses_success(true, &dry_run));
    assert!(!quiet_suppresses_success(false, &ordinary_write));
}

#[test]
fn quiet_keeps_patch_format_planning_visible() {
    let planning = event(
        "patch-create",
        "recommended patch create format bps",
        Some(json!({
            "patch_create_format_candidates": {
                "default": "bps",
                "formats": ["bps", "ips"],
            },
        })),
    );
    assert!(!quiet_suppresses_success(true, &planning));
}

#[test]
fn quiet_keeps_save_edit_previews_visible() {
    let preview = ProgressEvent {
        stage: "preview".to_string(),
        ..event(
            "save-set",
            "Save edit preview is valid",
            Some(json!({
                "save_editor": { "result": { "preview": { "changed": true } } },
            })),
        )
    };
    assert!(!quiet_suppresses_success(true, &preview));
    assert!(quiet_suppresses_success(
        true,
        &ProgressEvent {
            stage: "set".to_string(),
            ..preview
        }
    ));
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
fn identify_names_combine_primary_and_alternate_names() {
    let identify = json!({
        "matches": [
            { "name": "OpenGood name", "alternate_names": ["Libretro name", "OpenGood name"] },
            { "name": "Second name", "alternate_names": ["Libretro name"] },
        ]
    });
    assert_eq!(
        identify_names(identify.as_object().expect("identify object")),
        vec![
            "OpenGood name".to_string(),
            "Libretro name".to_string(),
            "Second name".to_string(),
        ]
    );
}

#[test]
fn every_success_shape_renders_without_the_expected_details() {
    // These renderers consume a details value the app builds elsewhere; each
    // one MUST degrade to the plain label rather than panicking when the shape
    // it expects is missing, which is what this drives.
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
        render_success(&surface, &shape);
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
        render_success(&surface, &shape);
    }
}
