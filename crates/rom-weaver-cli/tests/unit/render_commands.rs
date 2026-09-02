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
fn humanize_key_title_cases_the_last_dotted_segment() {
    assert_eq!(humanize_key("repaired_files"), "Repaired files");
    assert_eq!(humanize_key("container.entry_count"), "Entry count");
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
            ("Entry count".to_string(), "3".to_string()),
            ("Total bytes".to_string(), humanize_bytes(2048)),
            ("Format".to_string(), "chd".to_string()),
        ]
    );
}

#[test]
fn collect_pairs_joins_scalar_arrays_and_drops_empty_ones() {
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
        vec![("Codecs", "zstd, lzma, 7, true"), ("Flag", "false"),],
        "null scalars and arrays with no scalar members are omitted"
    );
}

#[test]
fn collect_pairs_prefixes_nested_keys_for_uniqueness() {
    let value = json!({ "outer": { "inner": { "leaf_bytes": 1024 } } });
    let mut pairs = Vec::new();
    collect_pairs("root", value.as_object().expect("object"), &mut pairs);
    assert_eq!(
        pairs,
        vec![("Leaf bytes".to_string(), humanize_bytes(1024))]
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
