use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use super::{
    CliApp, CompressionLevelProfile, ParsedSelectionInput, RomWeaverRunOutputOptions,
    RunCommandOptions,
};

// `RunCommandOptions::resolve_emit_progress_events` was replaced by
// `RomWeaverRunOutputOptions::emit_progress_events` (combined with the
// `--progress`/`--no-progress` -> `Option<bool>` mapping tested in
// `src/cli.rs`'s own test module). These two tests exercise the same
// defaulting/override behavior through the current API.
fn output_options(json: bool, progress: Option<bool>) -> RomWeaverRunOutputOptions {
    RomWeaverRunOutputOptions {
        json,
        progress,
        log_level: None,
        dep_trace: false,
        interactive_selection_enabled: false,
        assume_yes: false,
    }
}

#[test]
fn progress_defaults_follow_tty_and_json_mode() {
    assert!(RunCommandOptions::from_output(output_options(false, None), true).emit_progress_events);
    assert!(
        !RunCommandOptions::from_output(output_options(false, None), false).emit_progress_events
    );
    assert!(RunCommandOptions::from_output(output_options(true, None), false).emit_progress_events);
}

#[test]
fn progress_flags_override_defaults() {
    assert!(
        RunCommandOptions::from_output(output_options(false, Some(true)), false)
            .emit_progress_events
    );
    assert!(
        !RunCommandOptions::from_output(output_options(true, Some(false)), true)
            .emit_progress_events
    );
}

#[test]
fn parse_selection_input_accepts_valid_indexes() {
    assert_eq!(
        CliApp::parse_selection_input("1", 3),
        ParsedSelectionInput::Selected(0)
    );
    assert_eq!(
        CliApp::parse_selection_input("3", 3),
        ParsedSelectionInput::Selected(2)
    );
}

#[test]
fn parse_selection_input_handles_cancel_and_invalid_values() {
    assert_eq!(
        CliApp::parse_selection_input("q", 4),
        ParsedSelectionInput::Cancelled
    );
    assert_eq!(
        CliApp::parse_selection_input("  quit ", 4),
        ParsedSelectionInput::Cancelled
    );
    assert_eq!(
        CliApp::parse_selection_input("0", 4),
        ParsedSelectionInput::Invalid
    );
    assert_eq!(
        CliApp::parse_selection_input("5", 4),
        ParsedSelectionInput::Invalid
    );
    assert_eq!(
        CliApp::parse_selection_input("abc", 4),
        ParsedSelectionInput::Invalid
    );
}

#[test]
fn selection_error_detection_matches_known_selection_failures() {
    assert!(CliApp::is_selection_resolution_error(
        "validation failed: requested selections were not found: missing.iso"
    ));
    assert!(CliApp::is_selection_resolution_error(
        "validation failed: requested selections resolved to no extractable cd outputs"
    ));
    assert!(CliApp::is_selection_resolution_error(
        "validation failed: gcz extract does not support --select yet"
    ));
    assert!(!CliApp::is_selection_resolution_error(
        "validation failed: no registered handler matched `sample.bin`"
    ));
}

#[test]
fn compression_profile_defaults_to_max_levels() {
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "zip",
            None,
            None,
            CompressionLevelProfile::Max,
        ),
        Some(9)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "zst",
            None,
            None,
            CompressionLevelProfile::Min,
        ),
        Some(-7)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "zst",
            None,
            None,
            CompressionLevelProfile::Max,
        ),
        Some(22)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "chd-dvd",
            None,
            None,
            CompressionLevelProfile::Max,
        ),
        Some(9)
    );
}

#[test]
fn compression_profile_respects_codec_types() {
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "zip",
            Some("store"),
            None,
            CompressionLevelProfile::Max,
        ),
        None
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "chd",
            Some("cdzs"),
            None,
            CompressionLevelProfile::Min,
        ),
        Some(-7)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "chd",
            Some("cdzs"),
            None,
            CompressionLevelProfile::VeryHigh,
        ),
        Some(19)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "chd",
            Some("cdlz"),
            None,
            CompressionLevelProfile::Max,
        ),
        Some(9)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "chd",
            Some("cdfl"),
            None,
            CompressionLevelProfile::Max,
        ),
        Some(9)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "chd",
            Some("flac"),
            None,
            CompressionLevelProfile::VeryHigh,
        ),
        Some(8)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "zst",
            Some("zstd"),
            None,
            CompressionLevelProfile::Min,
        ),
        Some(-7)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "zst",
            Some("zstd"),
            None,
            CompressionLevelProfile::Max,
        ),
        Some(22)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "chd",
            CliApp::primary_codec_name(Some("cdlz+cdzs+cdfl")),
            None,
            CompressionLevelProfile::Max,
        ),
        Some(9)
    );
}

#[test]
fn compression_profile_prefers_explicit_codec_level() {
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "chd",
            Some("cdzs"),
            Some(15),
            CompressionLevelProfile::Max,
        ),
        Some(15)
    );
    assert_eq!(
        CliApp::resolve_compression_level_for_profile(
            "zip",
            Some("store"),
            Some(3),
            CompressionLevelProfile::Max,
        ),
        Some(3)
    );
}

#[test]
fn z3ds_compressed_extension_mapping_covers_known_source_types() {
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.cia")),
        Some(".zcia")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.cci")),
        Some(".zcci")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.cxi")),
        Some(".zcxi")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.app")),
        Some(".zcxi")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.3ds")),
        Some(".z3ds")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.3dsx")),
        Some(".z3dsx")
    );
    assert_eq!(
        CliApp::z3ds_compressed_extension_for_path(Path::new("disc.bin")),
        None
    );
}

#[test]
fn z3ds_extension_append_uses_hint_when_output_has_no_extension() {
    let extensions = [".z3ds", ".zcci", ".zcxi", ".zcia", ".z3dsx"];
    let cases = [
        ("source.cia", "patched.zcia"),
        ("source.cci", "patched.zcci"),
        ("source.cxi", "patched.zcxi"),
        ("source.3dsx", "patched.z3dsx"),
        ("source.3ds", "patched.z3ds"),
    ];

    for (source, expected) in cases {
        let (output_path, appended) = CliApp::append_output_extension_if_missing(
            Path::new("patched"),
            &extensions,
            Some(Path::new(source)),
        );
        assert!(appended);
        assert_eq!(output_path, PathBuf::from(expected));
    }
}

#[test]
fn resolve_codec_level_supports_multi_codec_lists() {
    let (codec, level) =
        CliApp::resolve_codec_level(vec!["cdzs,cdzl".to_string(), "cdfl".to_string()], "--codec")
            .expect("codec list should parse");
    assert_eq!(codec.as_deref(), Some("cdzs+cdzl+cdfl"));
    assert_eq!(level, None);
}

#[test]
fn resolve_codec_level_supports_codec_level_syntax() {
    let (codec, level) = CliApp::resolve_codec_level(
        vec!["cdzs:19,cdzl".to_string(), "cdfl".to_string()],
        "--codec",
    )
    .expect("codec:level should parse");
    assert_eq!(codec.as_deref(), Some("cdzs+cdzl+cdfl"));
    assert_eq!(level, Some(19));

    let (codec, level) = CliApp::resolve_codec_level(vec!["cdzs:-7,cdzl".to_string()], "--codec")
        .expect("negative codec:level should parse");
    assert_eq!(codec.as_deref(), Some("cdzs+cdzl"));
    assert_eq!(level, Some(-7));
}

#[test]
fn resolve_codec_level_rejects_invalid_level_values() {
    let error = CliApp::resolve_codec_level(vec!["cdzs:fast".to_string()], "--codec")
        .expect_err("invalid codec level should fail");
    assert!(error.to_string().contains("not a valid integer"));
}

#[test]
fn resolve_codec_level_rejects_conflicting_levels() {
    let error =
        CliApp::resolve_codec_level(vec!["cdzs:19".to_string(), "cdzl:9".to_string()], "--codec")
            .expect_err("conflicting codec levels should fail");
    assert!(error.to_string().contains("conflicting codec levels"));
}

fn test_app() -> CliApp {
    CliApp::new(
        Arc::new(rom_weaver_core::NoopProgressSink),
        Arc::new(rom_weaver_core::NoninteractivePrompter),
        false,
        false,
        false,
    )
}

fn compression_plan_error(format: &str, codec: &str) -> rom_weaver_core::RomWeaverError {
    let app = test_app();
    let options = CliApp::parse_patch_apply_compression_options(
        false,
        Some(format.to_string()),
        vec![codec.to_string()],
        None,
    )
    .expect("test codec options should parse");
    app.resolve_patch_apply_compression_plan(
        Path::new("patched"),
        Path::new("source.sfc"),
        &options,
    )
    .expect_err("test compression plan should fail")
}

#[test]
fn compression_options_reject_conflicting_no_compress_flags() {
    let format = CliApp::parse_patch_apply_compression_options(
        true,
        Some("zip".to_string()),
        Vec::new(),
        None,
    )
    .expect_err("--no-compress and --compress-format must conflict");
    assert!(format.to_string().contains("--no-compress"));

    let codec = CliApp::parse_patch_apply_compression_options(
        true,
        None,
        vec!["deflate".to_string()],
        None,
    )
    .expect_err("--no-compress and --compress-codec must conflict");
    assert!(codec.to_string().contains("--compress-codec"));

    let empty_format = CliApp::parse_patch_apply_compression_options(
        false,
        Some("  ".to_string()),
        Vec::new(),
        None,
    )
    .expect_err("an empty compression format must fail");
    assert!(empty_format.to_string().contains("cannot be empty"));
}

#[test]
fn compression_codec_validation_covers_format_specific_rules() {
    let multiple_zip_codecs = compression_plan_error("zip", "deflate+store");
    assert!(
        multiple_zip_codecs
            .to_string()
            .contains("zip accepts one --compress-codec value")
    );

    let unknown_codec = compression_plan_error("zip", "not-a-codec");
    assert!(unknown_codec.to_string().contains("unsupported zip codec"));

    let store_with_following = compression_plan_error("chd", "store+zstd");
    assert!(
        store_with_following
            .to_string()
            .contains("store` cannot be combined")
    );

    let avhuff_not_first = compression_plan_error("chd", "zstd+avhuff");
    assert!(
        avhuff_not_first
            .to_string()
            .contains("must be the first codec")
    );

    let too_many = compression_plan_error("chd", "zstd+lzma+zlib+huff+flac");
    assert!(too_many.to_string().contains("at most 4 codecs"));

    let level_without_support = compression_plan_error("zip", "store:1");
    assert!(
        level_without_support
            .to_string()
            .contains("does not accept --level")
    );

    let level_out_of_range = compression_plan_error("zip", "deflate:10");
    assert!(
        level_out_of_range
            .to_string()
            .contains("compression level 10 is invalid")
    );
}

#[test]
fn compression_output_resolution_distinguishes_raw_and_container_outputs() {
    let app = test_app();

    let raw = app
        .resolve_patch_apply_compression_options(
            false,
            None,
            Vec::new(),
            None,
            Path::new("patched.sfc"),
            Path::new("source.sfc"),
        )
        .expect("matching ROM extensions should select raw output");
    assert!(!raw.enabled);

    let container = app
        .resolve_patch_apply_compression_options(
            false,
            None,
            Vec::new(),
            None,
            Path::new("patched.zip"),
            Path::new("source.sfc"),
        )
        .expect("registered output extensions should select compression");
    assert!(container.enabled);

    let no_extension = app
        .resolve_patch_apply_compression_options(
            false,
            None,
            Vec::new(),
            None,
            Path::new("patched"),
            Path::new("source.sfc"),
        )
        .expect_err("extensionless output needs an explicit mode");
    assert!(no_extension.to_string().contains("has no file extension"));

    let unknown_extension = app
        .resolve_patch_apply_compression_options(
            false,
            None,
            Vec::new(),
            None,
            Path::new("patched.unknown"),
            Path::new("source.sfc"),
        )
        .expect_err("unknown output extensions must fail");
    assert!(
        unknown_extension
            .to_string()
            .contains("neither a registered container")
    );

    let explicit_raw = app
        .resolve_patch_apply_compression_options(
            true,
            None,
            Vec::new(),
            None,
            Path::new("patched"),
            Path::new("source.sfc"),
        )
        .expect("--no-compress must allow extensionless output");
    assert!(!explicit_raw.enabled);
}

#[test]
fn explicit_compression_plan_appends_format_extensions_and_defaults_7z_codec() {
    let app = test_app();

    let zip = app
        .resolve_patch_apply_compression_options(
            false,
            Some("zip".to_string()),
            Vec::new(),
            None,
            Path::new("patched"),
            Path::new("source.sfc"),
        )
        .expect("explicit zip compression should resolve");
    assert!(zip.enabled);
    let zip_plan = app
        .resolve_patch_apply_compression_plan(Path::new("patched"), Path::new("source.sfc"), &zip)
        .expect("explicit zip plan should resolve");
    assert_eq!(zip_plan.format, "zip");
    assert_eq!(zip_plan.output_path, PathBuf::from("patched.zip"));
    assert!(zip_plan.extension_appended);

    let seven_zip = app
        .resolve_patch_apply_compression_options(
            false,
            Some("7z".to_string()),
            Vec::new(),
            None,
            Path::new("patched"),
            Path::new("source.sfc"),
        )
        .expect("explicit 7z compression should resolve");
    let seven_zip_plan = app
        .resolve_patch_apply_compression_plan(
            Path::new("patched"),
            Path::new("source.sfc"),
            &seven_zip,
        )
        .expect("explicit 7z plan should resolve");
    assert_eq!(seven_zip_plan.format, "7z");
    assert_eq!(seven_zip_plan.codec.as_deref(), Some("lzma2"));
    assert_eq!(seven_zip_plan.output_path, PathBuf::from("patched.7z"));
}

#[test]
fn container_output_resolution_reports_extension_and_flag_errors() {
    let app = test_app();

    let from_extension = app
        .resolve_container_output_format(
            None,
            Path::new("output.zip"),
            "--format",
            "; or use --no-compress",
        )
        .expect("zip extension should select zip");
    assert_eq!(from_extension.format, "zip");
    assert!(from_extension.note.contains("from output extension"));
    assert!(from_extension.warning.is_none());

    let explicit_mismatch = app
        .resolve_container_output_format(Some("zip"), Path::new("output.7z"), "--format", "")
        .expect("an explicit format must win over an extension");
    assert_eq!(explicit_mismatch.format, "zip");
    assert!(
        explicit_mismatch
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("does not match"))
    );

    let missing_extension = app
        .resolve_container_output_format(None, Path::new("output"), "--format", "")
        .expect_err("an extensionless output needs a format flag");
    assert!(
        missing_extension
            .to_string()
            .contains("has no file extension")
    );

    let unsupported_extension = app
        .resolve_container_output_format(None, Path::new("output.unknown"), "--format", "")
        .expect_err("an unknown output extension must fail");
    assert!(
        unsupported_extension
            .to_string()
            .contains("is not a supported format")
    );
}

#[test]
fn patch_output_resolution_preserves_patch_specific_extension_errors() {
    let app = test_app();

    let missing_extension = app
        .resolve_patch_create_format(None, Path::new("output"))
        .expect_err("an extensionless patch output needs a format flag");
    assert_eq!(
        missing_extension.to_string(),
        "validation failed: output has no file extension; pass --format <name> or use a supported patch extension"
    );

    let unsupported_extension = app
        .resolve_patch_create_format(None, Path::new("output.unknown"))
        .expect_err("an unknown patch output extension must fail");
    assert_eq!(
        unsupported_extension.to_string(),
        "validation failed: output extension `.unknown` is not a supported patch format; pass --format <name> or use a supported extension"
    );
}

#[test]
fn trim_extension_helpers_validate_paths_and_choose_operation_patterns() {
    assert_eq!(
        CliApp::normalize_trim_extension("  trimmed  ").unwrap(),
        "trimmed"
    );

    let empty =
        CliApp::normalize_trim_extension(" ").expect_err("an empty trim extension must fail");
    assert!(empty.to_string().contains("cannot be empty"));

    let slash = CliApp::normalize_trim_extension("nested/ext")
        .expect_err("a trim extension cannot contain slash");
    assert!(slash.to_string().contains("path separators"));

    let backslash = CliApp::normalize_trim_extension("nested\\ext")
        .expect_err("a trim extension cannot contain backslash");
    assert!(backslash.to_string().contains("path separators"));

    assert_eq!(
        CliApp::default_trim_extension_pattern(super::TrimOperation::Trim),
        "trim.{ext}"
    );
    assert_eq!(
        CliApp::default_trim_extension_pattern(super::TrimOperation::Revert),
        "untrim.{ext}"
    );
}

#[test]
fn output_extension_append_handles_empty_and_existing_extensions() {
    let (unchanged, appended) =
        CliApp::append_output_extension_if_missing(Path::new("patched.zip"), &[".zip"], None);
    assert_eq!(unchanged, PathBuf::from("patched.zip"));
    assert!(!appended);

    let (case_insensitive, appended) =
        CliApp::append_output_extension_if_missing(Path::new("patched.ZIP"), &[".zip"], None);
    assert_eq!(case_insensitive, PathBuf::from("patched.ZIP"));
    assert!(!appended);

    let (no_extensions, appended) =
        CliApp::append_output_extension_if_missing(Path::new("patched"), &[], None);
    assert_eq!(no_extensions, PathBuf::from("patched"));
    assert!(!appended);

    let (root, appended) =
        CliApp::append_output_extension_if_missing(Path::new("/"), &[".zip"], None);
    assert_eq!(root, PathBuf::from("/"));
    assert!(!appended);
}
