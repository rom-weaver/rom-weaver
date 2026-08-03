use std::path::Path;

use super::{
    COMMAND_TYPES_OUTPUT_PATH, METADATA_OUTPUT_PATH, TYPES_OUTPUT_PATH, render_command_types,
    render_metadata, render_types, strip_trailing_whitespace,
};

// `typegen_main` renders straight from the Rust type/metadata registries; CI's
// `mise run typegen-check` only re-runs that same generator and diffs the
// result against the committed files, so a bug in the generator itself (e.g.
// a struct silently dropped from `render_types`) would regenerate "clean" and
// slip past drift detection. Pinning the render functions against the
// committed output here exercises the generation logic directly - no shelling
// out to `mise` or `cargo run` - so a regression fails `cargo test` too.
fn repo_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/rom-weaver-cli/../.. resolves to the repo root")
}

fn read_committed(relative_path: &str) -> Option<String> {
    let path = repo_root().join(relative_path);
    // The packaged crate (crates.io / vendored source) does not ship the
    // webapp tree, so only assert when the checkout has it - matches the
    // pattern used by `bundle_schema.rs`'s canonical-docs-copy test.
    std::fs::read_to_string(&path).ok()
}

#[test]
fn rendered_types_match_committed_output() {
    let Some(committed) = read_committed(TYPES_OUTPUT_PATH) else {
        return;
    };
    let rendered = strip_trailing_whitespace(render_types());
    assert_eq!(
        rendered, committed,
        "generated TS types drifted from {TYPES_OUTPUT_PATH}; run `mise run typegen`"
    );
}

#[test]
fn rendered_metadata_matches_committed_output() {
    let Some(committed) = read_committed(METADATA_OUTPUT_PATH) else {
        return;
    };
    let rendered = strip_trailing_whitespace(render_metadata());
    assert_eq!(
        rendered, committed,
        "generated format metadata drifted from {METADATA_OUTPUT_PATH}; run `mise run typegen`"
    );
}

#[test]
fn rendered_command_types_match_committed_output() {
    let Some(committed) = read_committed(COMMAND_TYPES_OUTPUT_PATH) else {
        return;
    };
    let rendered = strip_trailing_whitespace(render_command_types());
    assert_eq!(
        rendered, committed,
        "generated command types drifted from {COMMAND_TYPES_OUTPUT_PATH}; run `mise run typegen`"
    );
}

#[test]
fn render_types_declares_every_expected_top_level_export() {
    let rendered = render_types();
    for expected in [
        "export type ProgressEvent",
        "export type RomWeaverBundle",
        "export type RomWeaverRunRequest",
        "export type RomWeaverCommand = Commands;",
    ] {
        assert!(
            rendered.contains(expected),
            "expected rendered types to contain `{expected}`, got:\n{rendered}"
        );
    }
}

#[test]
fn render_metadata_declares_the_aggregate_format_metadata_const() {
    let rendered = render_metadata();
    assert!(rendered.contains("export const ROM_WEAVER_FORMAT_METADATA = {"));
    assert!(rendered.contains("archiveFormats: ROM_WEAVER_ARCHIVE_FORMATS,"));
}

#[test]
fn render_command_types_declares_known_command_type_guards() {
    let rendered = render_command_types();
    assert!(rendered.contains("export const KNOWN_COMMAND_TYPES"));
    assert!(rendered.contains("export function isKnownRomWeaverCommandType"));
    assert!(rendered.contains("export function assertKnownRomWeaverCommandType"));
}
