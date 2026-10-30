// Registry-driven coverage gate plus end-to-end extract tests for formats that had no
// content-verified CLI test.
//
// The gate reads `formats --json` and fails when a registered container or patch format has no
// entry in the coverage tables below. Every named test must exist in the test sources, so
// renaming or deleting one breaks the gate. The gate checks that a test exists, not what it
// asserts; `nfs`, `cso` and `tgc` point at container-crate unit tests, not a CLI extract.

use super::shared::*;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn extract_only_fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/extract-only")
        .join(name)
}

fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(root).ok()? {
        let path = entry.ok()?.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) {
                return Some(found);
            }
        } else if path.file_name().is_some_and(|file| file == name) {
            return Some(path);
        }
    }
    None
}

fn extract_to(source: &Path, out_dir: &Path) -> Value {
    let output = command_stdout(
        &[
            "extract",
            "--no-ignore",
            "--input",
            source.to_str().expect("path"),
            "--output",
            out_dir.to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    parse_json_lines(&output).pop().expect("terminal event")
}

/// Extract-only container formats: each fixture was produced by the reference tool for the
/// format (bzip2, xz, tar, gzip, lz4, zstd, Info-ZIP) from `payload.txt`.
const EXTRACT_ONLY_FIXTURES: &[(&str, &str)] = &[
    ("zipx", "payload.zipx"),
    ("tar", "payload.tar"),
    ("tar.gz", "payload.tar.gz"),
    ("tar.bz2", "payload.tar.bz2"),
    ("tar.xz", "payload.tar.xz"),
    ("gz", "payload.txt.gz"),
    ("bz2", "payload.txt.bz2"),
    ("xz", "payload.txt.xz"),
    ("zst", "payload.txt.zst"),
    ("lz4", "payload.txt.lz4"),
];

#[test]
fn extract_only_formats_extract_reference_tool_fixtures_byte_exact() {
    let expected = fs::read(extract_only_fixture("payload.txt")).expect("payload");
    for (format, fixture) in EXTRACT_ONLY_FIXTURES {
        let temp = setup_temp_dir();
        let source = temp.child(fixture);
        fs::copy(extract_only_fixture(fixture), source.path()).expect("copy fixture");
        let out_dir = temp.child("extract");
        let terminal = extract_to(source.path(), out_dir.path());
        assert_eq!(
            terminal["format"], *format,
            "{format}: a sibling handler took {fixture}"
        );
        let extracted = find_file(out_dir.path(), "payload.txt")
            .unwrap_or_else(|| panic!("{format}: no payload.txt extracted from {fixture}"));
        assert_eq!(
            fs::read(extracted).expect("extracted payload"),
            expected,
            "{format}: extracted bytes differ from the {fixture} source"
        );
    }
}

#[test]
fn xiso_extract_yields_the_source_image_byte_exact() {
    let temp = setup_temp_dir();
    let tree = temp.child("tree");
    let image = temp.child("game.xiso");
    write_xiso_fixture_from_directory(tree.path(), image.path());
    let out_dir = temp.child("extract");
    extract_to(image.path(), out_dir.path());
    let extracted = find_file(out_dir.path(), "game.iso").expect("game.iso extracted");
    assert_eq!(
        fs::read(extracted).expect("extracted image"),
        fs::read(image.path()).expect("source image")
    );
}

/// Every test source a coverage entry may name.
const TEST_SOURCES: &[&str] = &[
    include_str!("compress.rs"),
    include_str!("format_coverage.rs"),
    include_str!("patch.rs"),
    include_str!("pbp.rs"),
    include_str!("probe_extract.rs"),
    include_str!("rvz_z3ds.rs"),
    include_str!("wbfs_split.rs"),
    include_str!("chd.rs"),
    include_str!("../../../rom-weaver-containers/tests/unit/handlers.rs"),
    include_str!("../../../rom-weaver-containers/tests/unit/nod_tgc.rs"),
    include_str!("../../../rom-weaver-containers/tests/unit/nod_nfs.rs"),
];

fn test_exists(name: &str) -> bool {
    // `round_trip_test!` generates its functions, so accept a macro invocation as well.
    let function = format!("fn {name}(");
    let generated = format!("round_trip_test!(\n    {name},");
    TEST_SOURCES
        .iter()
        .any(|source| source.contains(&function) || source.contains(&generated))
}

/// Container formats: the named test extracts (and for creatable formats, compresses) real data
/// and compares bytes. `nfs`, `tgc` and `cso` are covered by the container-crate unit tests only.
const CONTAINER_EXTRACT: &[(&str, &str)] = &[
    ("zip", "archive_container_formats_round_trip"),
    ("7z", "archive_container_formats_round_trip"),
    (
        "zipx",
        "extract_only_formats_extract_reference_tool_fixtures_byte_exact",
    ),
    ("rar", "extract_rar_reports_thread_fallback_in_json"),
    (
        "tar",
        "extract_only_formats_extract_reference_tool_fixtures_byte_exact",
    ),
    (
        "tar.gz",
        "extract_only_formats_extract_reference_tool_fixtures_byte_exact",
    ),
    (
        "tar.bz2",
        "extract_only_formats_extract_reference_tool_fixtures_byte_exact",
    ),
    (
        "tar.xz",
        "extract_only_formats_extract_reference_tool_fixtures_byte_exact",
    ),
    (
        "gz",
        "extract_only_formats_extract_reference_tool_fixtures_byte_exact",
    ),
    (
        "bz2",
        "extract_only_formats_extract_reference_tool_fixtures_byte_exact",
    ),
    (
        "xz",
        "extract_only_formats_extract_reference_tool_fixtures_byte_exact",
    ),
    (
        "zst",
        "extract_only_formats_extract_reference_tool_fixtures_byte_exact",
    ),
    (
        "lz4",
        "extract_only_formats_extract_reference_tool_fixtures_byte_exact",
    ),
    ("cso", "cso_extract_round_trips_to_iso_output"),
    ("pbp", "extract_pbp_select_cue_emits_matching_bin_pair"),
    ("chd", "chd_compress_and_extract_raw_round_trip"),
    ("gc-ciso", "gamecube_ciso_extracts_and_converts_byte_exact"),
    ("gcz", "gcz_extract_round_trips_to_iso"),
    ("wia", "compress_wia_rejects_create_but_extract_round_trips"),
    (
        "tgc",
        "block_reader_rebuilds_the_original_gcm_byte_for_byte",
    ),
    (
        "nfs",
        "read_block_decrypts_mapped_sectors_and_zeroes_unmapped_ones",
    ),
    ("wbfs", "split_wbfs_sets_extract_byte_exactly"),
    ("rvz", "rvz_compress_and_extract_round_trips"),
    ("z3ds", "z3ds_compress_probe_and_extract_round_trip"),
    ("xiso", "xiso_extract_yields_the_source_image_byte_exact"),
];

/// Creatable container formats: the named test compresses and extracts back to the input.
const CONTAINER_CREATE: &[(&str, &str)] = &[
    ("zip", "archive_container_formats_round_trip"),
    ("7z", "archive_container_formats_round_trip"),
    ("chd", "chd_compress_and_extract_raw_round_trip"),
    ("rvz", "rvz_compress_and_extract_round_trips"),
    ("z3ds", "z3ds_compress_probe_and_extract_round_trip"),
];

/// Patch formats that can be created: the named test runs `patch create` then `patch apply` and
/// compares the output bytes.
const PATCH_ROUND_TRIP: &[(&str, &str)] = &[
    ("IPS", "patch_create_succeeds_for_ips_and_round_trips"),
    ("IPS32", "patch_create_succeeds_for_ips32_and_round_trips"),
    ("SOLID", "patch_create_succeeds_for_solid_and_round_trips"),
    ("BPS", "patch_create_succeeds_for_bps_and_round_trips"),
    ("UPS", "patch_create_succeeds_for_ups_and_round_trips"),
    ("VCDIFF", "patch_create_succeeds_for_vcdiff_and_round_trips"),
    ("xdelta", "patch_create_succeeds_for_xdelta_and_round_trips"),
    ("GDIFF", "patch_create_succeeds_for_gdiff_and_round_trips"),
    ("APS", "patch_create_succeeds_for_aps_and_round_trips"),
    ("APSGBA", "patch_create_succeeds_for_apsgba_and_round_trips"),
    ("RUP", "patch_create_succeeds_for_rup_and_round_trips"),
    ("PPF", "patch_create_succeeds_for_ppf_and_round_trips"),
    ("PAT", "patch_create_succeeds_for_pat_and_round_trips"),
    ("EBP", "patch_create_succeeds_for_ebp_and_round_trips"),
    (
        "BDF/BSDIFF40",
        "patch_create_succeeds_for_bdf_and_round_trips",
    ),
    ("MOD", "patch_create_succeeds_for_mod_and_round_trips"),
    ("DLDI", "patch_create_succeeds_for_dldi_and_round_trips"),
    ("DPS", "patch_create_succeeds_for_dps_and_round_trips"),
];

/// Apply-only patch formats (the registry cannot create them): the named test applies a patch
/// and checks the result.
const PATCH_APPLY_ONLY: &[(&str, &str)] = &[
    (
        "HDiffPatch/HPatchZ",
        "patch_apply_hdiffpatch_reports_parallel_execution_for_multi_chunk_patch",
    ),
    ("BSP", "patch_apply_succeeds_for_valid_bsp_patch"),
];

fn registry_names(report: &Value, section: &str, flag: &str) -> Vec<String> {
    report[section]
        .as_array()
        .unwrap_or_else(|| panic!("formats report has no {section}"))
        .iter()
        .filter(|entry| entry[flag] == true)
        .map(|entry| entry["name"].as_str().expect("format name").to_owned())
        .collect()
}

fn assert_covered(kind: &str, registry: &[String], table: &[(&str, &str)]) {
    for name in registry {
        assert!(
            table.iter().any(|(covered, _)| covered == name),
            "{kind} format {name:?} is registered but has no entry in the coverage table; add a \
             content-verifying test and list it"
        );
    }
    for (covered, test) in table {
        assert!(
            registry.iter().any(|name| name == covered),
            "{kind} coverage table names {covered:?}, which the registry no longer reports"
        );
        assert!(
            test_exists(test),
            "{kind} {covered:?} points at test {test:?}, which no longer exists"
        );
    }
}

#[test]
fn every_registered_format_has_a_content_verifying_test() {
    let report = parse_single_json_line(&command_stdout(&["formats", "--json"], 0));
    assert_covered(
        "container extract",
        &registry_names(&report, "containers", "extract"),
        CONTAINER_EXTRACT,
    );
    assert_covered(
        "container create",
        &registry_names(&report, "containers", "create"),
        CONTAINER_CREATE,
    );
    assert_covered(
        "patch create",
        &registry_names(&report, "patches", "create"),
        PATCH_ROUND_TRIP,
    );
    let apply_only = registry_names(&report, "patches", "apply")
        .into_iter()
        .filter(|name| !PATCH_ROUND_TRIP.iter().any(|(covered, _)| covered == name))
        .collect::<Vec<_>>();
    assert_covered("patch apply-only", &apply_only, PATCH_APPLY_ONLY);
}
