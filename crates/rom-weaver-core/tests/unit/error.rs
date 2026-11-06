use std::{io, path::PathBuf};

use super::{
    ChdMediaScope, FormatOperationKind, IoOp, IoResultExt, RomWeaverError, RomWeaverErrorKind,
    UnsupportedOp, ValidationCodeError, ValidationFieldValue,
};

fn assert_error_contract(error: RomWeaverError, expected: RomWeaverErrorKind) {
    assert_eq!(
        error.kind(),
        expected,
        "kind() mismatch for `{error}`: expected {expected:?}, got {:?}",
        error.kind()
    );
    // The production classifier must round-trip this variant's `Display` back to
    // the same kind. `classify_message` is what populates the typed `error_kind`
    // on failed `ProgressEvent`s, so this locks Display ⇄ classify_message ⇄
    // kind() together: a changed `#[error("...")]` prefix breaks this assertion
    // unless `classify_message` is updated in lock-step.
    let rendered = error.to_string();
    assert_eq!(
        RomWeaverErrorKind::classify_message(&rendered),
        Some(expected),
        "classify_message must map Display `{rendered}` to {expected:?}"
    );
}

#[test]
fn validation_variants_map_to_validation_kind_and_prefix() {
    assert_error_contract(
        RomWeaverError::Validation("boom".to_string()),
        RomWeaverErrorKind::Validation,
    );
    assert_error_contract(
        RomWeaverError::ValidationCode(ValidationCodeError::new("E_BAD")),
        RomWeaverErrorKind::Validation,
    );
}

#[test]
fn unknown_format_maps_to_unknown_format_kind_and_prefix() {
    assert_error_contract(
        RomWeaverError::UnknownFormat {
            path: PathBuf::from("/tmp/mystery.bin"),
        },
        RomWeaverErrorKind::UnknownFormat,
    );
}

#[test]
fn unsupported_maps_to_unsupported_kind_and_prefix() {
    assert_error_contract(
        RomWeaverError::Unsupported(UnsupportedOp::ChdStoreModeOnly),
        RomWeaverErrorKind::Unsupported,
    );
}

#[test]
fn cancelled_maps_to_cancelled_kind_and_exact_message() {
    let error = RomWeaverError::Cancelled;
    assert_eq!(error.kind(), RomWeaverErrorKind::Cancelled);
    // Cancelled has no arguments; lock the whole message, not just the prefix.
    assert_eq!(error.to_string(), "operation cancelled");
    assert_eq!(
        RomWeaverErrorKind::classify_message("operation cancelled"),
        Some(RomWeaverErrorKind::Cancelled)
    );
}

#[test]
fn classify_message_ignores_non_core_and_context_wrapped_messages() {
    // A message that is not a bare `RomWeaverError` rendering must classify to
    // `None` so the event omits `error_kind` and the JS side falls back to its
    // own inference, exactly as before this typed field existed.
    assert_eq!(
        RomWeaverErrorKind::classify_message("totally unrelated"),
        None
    );
    // Context-wrapped failures (`format!("...: {error}")`) are intentionally not
    // classified here: the prefix is the wrapper, not the error kind.
    assert_eq!(
        RomWeaverErrorKind::classify_message("failed to prepare output path `/x`: i/o error: nope"),
        None
    );
}

#[test]
fn io_maps_to_io_kind_and_prefix() {
    assert_error_contract(
        RomWeaverError::Io(io::Error::other("disk gone")),
        RomWeaverErrorKind::Io,
    );
}

#[test]
fn io_path_maps_to_io_kind_and_prefix() {
    assert_error_contract(
        RomWeaverError::io_path(IoOp::Open, "/roms/game.iso", io::Error::other("disk gone")),
        RomWeaverErrorKind::Io,
    );
}

#[test]
fn io_path_names_the_operation_and_the_path() {
    let error = RomWeaverError::io_path(
        IoOp::Create,
        "/out/patched.iso",
        io::Error::from(io::ErrorKind::NotFound),
    );
    let rendered = error.to_string();
    assert!(
        rendered.starts_with("i/o error: cannot create `/out/patched.iso`: "),
        "IoPath must name the verb and the path: {rendered}"
    );
    // Only access denials collect advice; everything else stays terse.
    assert!(
        !rendered.contains('('),
        "unexpected advice suffix: {rendered}"
    );
    assert_eq!(error.permission_denied_path(), None);
}

#[test]
fn permission_denied_path_reports_the_blamed_path() {
    let error = RomWeaverError::io_path(
        IoOp::Open,
        "/roms/locked.iso",
        io::Error::from(io::ErrorKind::PermissionDenied),
    );
    assert_eq!(
        error.permission_denied_path(),
        Some(PathBuf::from("/roms/locked.iso").as_path())
    );
    // A bare `Io` carries no path, so it can never answer the question.
    assert_eq!(
        RomWeaverError::Io(io::Error::from(io::ErrorKind::PermissionDenied))
            .permission_denied_path(),
        None
    );
}

#[test]
fn io_op_extension_attaches_context_to_a_bare_io_result() {
    let result: std::result::Result<(), io::Error> = Err(io::Error::other("nope"));
    let error = result
        .io_op(IoOp::ReadDir, "/roms")
        .expect_err("io_op must preserve the failure");
    assert_eq!(
        error.to_string(),
        "i/o error: cannot list directory `/roms`: nope"
    );
}

#[test]
fn thread_pool_build_maps_to_thread_pool_build_kind_and_prefix() {
    assert_error_contract(
        RomWeaverError::ThreadPoolBuild("no threads".to_string()),
        RomWeaverErrorKind::ThreadPoolBuild,
    );
}

/// Exhaustiveness guard: the `match` forces every `RomWeaverError` variant to be
/// named here, so adding a new variant fails to compile until its expected kind
/// (and therefore its `Display`-prefix coverage above) is declared. This is the
/// loud signal that prevents a new error variant from slipping past the
/// message-prefix ⇄ kind contract.
#[test]
fn every_variant_is_covered_by_the_contract() {
    fn expected_kind(error: &RomWeaverError) -> RomWeaverErrorKind {
        match error {
            RomWeaverError::Validation(_) => RomWeaverErrorKind::Validation,
            RomWeaverError::ValidationCode(_) => RomWeaverErrorKind::Validation,
            RomWeaverError::UnknownFormat { .. } => RomWeaverErrorKind::UnknownFormat,
            RomWeaverError::Unsupported(_) => RomWeaverErrorKind::Unsupported,
            RomWeaverError::Cancelled => RomWeaverErrorKind::Cancelled,
            RomWeaverError::Io(_) => RomWeaverErrorKind::Io,
            RomWeaverError::IoPath { .. } => RomWeaverErrorKind::Io,
            RomWeaverError::ThreadPoolBuild(_) => RomWeaverErrorKind::ThreadPoolBuild,
        }
    }

    let samples = [
        RomWeaverError::Validation("x".to_string()),
        RomWeaverError::ValidationCode(ValidationCodeError::new("E")),
        RomWeaverError::UnknownFormat {
            path: PathBuf::from("/x"),
        },
        RomWeaverError::Unsupported(UnsupportedOp::ChdStoreModeOnly),
        RomWeaverError::Cancelled,
        RomWeaverError::Io(io::Error::other("x")),
        RomWeaverError::io_path(IoOp::Open, "/x", io::Error::other("x")),
        RomWeaverError::ThreadPoolBuild("x".to_string()),
    ];

    for error in samples {
        let expected = expected_kind(&error);
        assert_eq!(error.kind(), expected);
        // Every variant's Display must round-trip through the production
        // classifier that feeds the typed event field.
        assert_eq!(
            RomWeaverErrorKind::classify_message(&error.to_string()),
            Some(expected),
            "classify_message lost the kind for `{error}`"
        );
    }
}

#[test]
fn validation_code_error_renders_code_message_and_fields() {
    let bare = ValidationCodeError::new("E_BAD");
    assert_eq!(bare.code(), "E_BAD");
    assert!(bare.fields().is_empty());
    assert_eq!(bare.to_string(), "E_BAD");
    assert_eq!(
        RomWeaverError::ValidationCode(bare).to_string(),
        "validation failed: E_BAD"
    );

    assert_eq!(
        ValidationCodeError::new("E_BAD")
            .with_message("bad input")
            .to_string(),
        "bad input [E_BAD]"
    );

    let mut full = ValidationCodeError::new("E_RANGE")
        .with_message("out of range")
        .with_field("enabled", true)
        .with_field("start", -1i32);
    full.push_field("length", 42u64);
    full.push_field("index", 7usize);
    full.push_field("path", "/roms/game.iso");
    assert_eq!(full.fields().len(), 5);
    assert_eq!(full.fields()[0].key, "enabled");
    assert_eq!(
        full.to_string(),
        "out of range [E_RANGE] (enabled=true, start=-1, length=42, index=7, path=/roms/game.iso)"
    );

    // A code with fields but no message keeps the bare-code head.
    assert_eq!(
        ValidationCodeError::new("E_CODE")
            .with_field("count", 3u8)
            .to_string(),
        "E_CODE (count=3)"
    );
}

#[test]
fn validation_field_value_converts_and_renders_every_supported_width() {
    let cases: Vec<(ValidationFieldValue, &str)> = vec![
        (true.into(), "true"),
        (false.into(), "false"),
        (7i8.into(), "7"),
        ((-8i16).into(), "-8"),
        (9i32.into(), "9"),
        ((-10i64).into(), "-10"),
        (11u8.into(), "11"),
        (12u16.into(), "12"),
        (13u32.into(), "13"),
        (14u64.into(), "14"),
        (15usize.into(), "15"),
        (String::from("owned").into(), "owned"),
        ("borrowed".into(), "borrowed"),
    ];
    for (value, rendered) in &cases {
        assert_eq!(value.to_string(), *rendered);
    }

    // Every signed width collapses to `I64` and every unsigned one to `U64`;
    // `usize` keeps its own variant so a pointer-width value never renders as a
    // signed number.
    assert_eq!(
        ValidationFieldValue::from(1i8),
        ValidationFieldValue::I64(1)
    );
    assert_eq!(
        ValidationFieldValue::from(1i16),
        ValidationFieldValue::I64(1)
    );
    assert_eq!(
        ValidationFieldValue::from(1i32),
        ValidationFieldValue::I64(1)
    );
    assert_eq!(
        ValidationFieldValue::from(1i64),
        ValidationFieldValue::I64(1)
    );
    assert_eq!(
        ValidationFieldValue::from(1u8),
        ValidationFieldValue::U64(1)
    );
    assert_eq!(
        ValidationFieldValue::from(1u16),
        ValidationFieldValue::U64(1)
    );
    assert_eq!(
        ValidationFieldValue::from(1u32),
        ValidationFieldValue::U64(1)
    );
    assert_eq!(
        ValidationFieldValue::from(1u64),
        ValidationFieldValue::U64(1)
    );
    assert_eq!(
        ValidationFieldValue::from(1usize),
        ValidationFieldValue::Usize(1)
    );
    assert_eq!(
        ValidationFieldValue::from("s"),
        ValidationFieldValue::Text("s".to_string())
    );
    assert_eq!(
        ValidationFieldValue::from(String::from("s")),
        ValidationFieldValue::Text("s".to_string())
    );
}

#[test]
fn io_op_renders_a_verb_for_every_operation() {
    let cases = [
        (IoOp::Open, "open"),
        (IoOp::Create, "create"),
        (IoOp::Write, "write to"),
        (IoOp::CreateDir, "create directory"),
        (IoOp::ReadDir, "list directory"),
        (IoOp::Inspect, "inspect"),
    ];
    for (op, verb) in cases {
        assert_eq!(op.to_string(), verb);
        // The verb is spliced straight into the user-facing message.
        assert_eq!(
            RomWeaverError::io_path(op, "/x", io::Error::other("nope")).to_string(),
            format!("i/o error: cannot {verb} `/x`: nope")
        );
    }
}

#[test]
fn unsupported_op_renders_every_variant() {
    let cases = [
        (
            UnsupportedOp::FormatOperation {
                format: "zip".to_string(),
                operation: FormatOperationKind::ListEntries,
            },
            "zip does not support listing entries",
        ),
        (
            UnsupportedOp::FormatOperation {
                format: "chd".to_string(),
                operation: FormatOperationKind::CreateDryRunSize,
            },
            "chd does not support create dry-run size measurement",
        ),
        (
            UnsupportedOp::HandlerNotRegistered {
                handler: "chd",
                feature: "disc extract",
            },
            "chd handler is not registered; disc extract is unavailable",
        ),
        (
            UnsupportedOp::ExtractOnlyCreate {
                format: "rar".to_string(),
                supported_create_formats: "zip, 7z".to_string(),
            },
            "rar is extract-only; supported create formats are zip, 7z",
        ),
        (
            UnsupportedOp::LibarchiveCodec {
                format: "7z".to_string(),
                codec: "brotli".to_string(),
            },
            "libarchive does not support 7z codec `brotli`",
        ),
        (
            UnsupportedOp::ChdCodecForMedia {
                codec: "flac".to_string(),
                scope: ChdMediaScope::CompressedMediaMode,
            },
            "rust chd compressed create does not support codec `flac` for this media mode",
        ),
        (
            UnsupportedOp::ChdCodecForMedia {
                codec: "avhu".to_string(),
                scope: ChdMediaScope::Disc,
            },
            "rust chd compressed create does not support codec `avhu` for disc media",
        ),
        (
            UnsupportedOp::ChdCodecInvalidForMedia {
                codec: "cdlz".to_string(),
                media: "hd".to_string(),
            },
            "chd codec `cdlz` is not valid for hd media",
        ),
        (
            UnsupportedOp::ChdCodecListInvalid {
                media: "raw".to_string(),
            },
            "chd codec list is invalid for raw media",
        ),
        (
            UnsupportedOp::PatchCreateNotImplemented {
                format: "RUP",
                alternative: "bps",
            },
            "RUP patch creation is not implemented; use bps",
        ),
        (
            UnsupportedOp::RupNamedFileEntries,
            "RUP patches with named file entries are not supported by single-file patch-apply",
        ),
        (
            UnsupportedOp::HdiffDirectoryPatch,
            "HDiffPatch directory patches (HDIFF19) are not supported for patch-apply; expected single-file patch (.hdiff/.hpatchz)",
        ),
        (
            UnsupportedOp::BspInteractiveMenu,
            "interactive BSP menus are not supported; use a BSP patcher that supports menu choices",
        ),
        (
            UnsupportedOp::ChdAvhuffRequiresChavFrames,
            "rust chd compressed create supports `avhuff` only for `chav` frame inputs",
        ),
        (
            UnsupportedOp::ChdStoreModeOnly,
            "rust chd create currently supports only raw/dvd/hd/disc `store` mode",
        ),
        (
            UnsupportedOp::ChdParentRequiresCompression,
            "chd create with parent requires at least one compressed codec; `store` mode cannot reference parent hunks",
        ),
        (
            UnsupportedOp::ChdAvhuffSampleLimit {
                max_samples_per_channel: 4096,
            },
            "avhuff encode currently supports up to 4096 audio samples per channel",
        ),
    ];

    for (op, expected) in cases {
        assert_eq!(op.to_string(), expected);
        // Every reason reaches the user wrapped in the shared error, whose
        // prefix the worker-error classifier keys off.
        let error = RomWeaverError::Unsupported(op);
        assert_eq!(
            error.to_string(),
            format!("unsupported operation: {expected}")
        );
        assert_eq!(
            RomWeaverErrorKind::classify_message(&error.to_string()),
            Some(RomWeaverErrorKind::Unsupported)
        );
    }
}

#[test]
fn io_path_appends_access_advice_only_for_permission_denials() {
    let denied = RomWeaverError::io_path(
        IoOp::Open,
        std::env::temp_dir(),
        io::Error::from(io::ErrorKind::PermissionDenied),
    );
    let rendered = denied.to_string();
    assert!(
        rendered.starts_with("i/o error: cannot open `"),
        "{rendered}"
    );
    // Advice is optional (it depends on what the path resolves to), but the
    // blamed path is not.
    assert_eq!(
        denied.permission_denied_path(),
        Some(std::env::temp_dir().as_path())
    );
}

#[test]
fn coded_error_exposes_code_and_fields_and_display_round_trips() {
    let error = RomWeaverError::ValidationCode(
        ValidationCodeError::new("wbfs.size_mismatch")
            .with_message("WBFS size differs")
            .with_field("actual", 10u64)
            .with_field("expected", 20u64)
            .with_field("split", true)
            .with_field("path", "game [beta].wbfs"),
    );
    assert_eq!(error.code(), Some("wbfs.size_mismatch"));
    let fields = error.fields_json().expect("fields");
    assert_eq!(fields["actual"], 10);
    assert_eq!(fields["split"], true);

    // The label fallback recovers the same code and fields, also behind context text.
    let label = format!("extract failed: {error}");
    let (code, parsed) = ValidationCodeError::parse_display_tag(&label).expect("tag");
    assert_eq!(code, "wbfs.size_mismatch");
    assert_eq!(parsed, Some(fields));
}

#[test]
fn parse_display_tag_ignores_text_without_a_trailing_code_tag() {
    for text in [
        "validation failed: plain message",
        "no entries in `game [USA].zip`",
        "validation failed: see [docs]: more",
        "message (detail)",
        "validation failed:[code]",
        "validation failed: [9bad]",
    ] {
        assert_eq!(ValidationCodeError::parse_display_tag(text), None, "{text}");
    }
    assert_eq!(
        ValidationCodeError::parse_display_tag("msg [extract.no_container]"),
        Some(("extract.no_container".to_owned(), None))
    );
    assert_eq!(
        ValidationCodeError::split_display_tag(
            "bad patch [patch.file_checksum_invalid] (expected=1)"
        )
        .map(|(message, code, _)| (message, code)),
        Some(("bad patch", "patch.file_checksum_invalid".to_owned()))
    );
}

#[test]
fn split_display_tag_ignores_bracketed_text_in_uncoded_path_labels() {
    // A ROM name with `[b1] (USA)` and `[v1.1] (Beta)` is path text, not an engine tag.
    for label in [
        "patch 1/1: no registered patch handler matched `/r/Hack [b1] (USA).xyz` (resolved from `/o/Hack [b1] (USA).zip`)",
        "nested extract exceeded max depth of 8 at `/r/Game [v1.1] (Beta).zip`",
        "failed on /r/Game [v1.1] (Beta)",
    ] {
        assert_eq!(
            ValidationCodeError::split_display_tag(label),
            None,
            "{label}"
        );
    }
}

#[test]
fn split_display_tag_anchors_on_the_code_that_ends_the_text() {
    let label = "nested extract exceeded max depth of 8 at `/r/Game [v1.1] (Beta).zip` [extract.max_depth_exceeded] (max_depth=8, path=/r/Game [v1.1] (Beta).zip)";
    let (head, code, fields) = ValidationCodeError::split_display_tag(label).expect("tag");
    assert_eq!(
        head,
        "nested extract exceeded max depth of 8 at `/r/Game [v1.1] (Beta).zip`"
    );
    assert_eq!(code, "extract.max_depth_exceeded");
    let fields = fields.expect("fields");
    assert_eq!(fields["max_depth"], 8);
    assert_eq!(fields["path"], "/r/Game [v1.1] (Beta).zip");

    // A field value with a `, ` keeps the code but not the fields.
    let (head, code, fields) = ValidationCodeError::split_display_tag(
        "bad [patch.checksum_mismatch] (path=/r/Zelda, The (USA).zip)",
    )
    .expect("tag");
    assert_eq!(
        (head, code.as_str(), fields),
        ("bad", "patch.checksum_mismatch", None)
    );
}

#[test]
fn with_context_keeps_codes_and_codes_uncoded_errors_on_request() {
    let coded = RomWeaverError::ValidationCode(
        ValidationCodeError::new("archive.storage_failed")
            .with_message("Failed to open '/x'")
            .with_field("errno", 2),
    )
    .with_context("zip list failed while reading entry 0", None);
    assert_eq!(coded.code(), Some("archive.storage_failed"));
    assert_eq!(
        coded.to_string(),
        "validation failed: zip list failed while reading entry 0: Failed to open '/x' [archive.storage_failed] (errno=2)"
    );

    let fallback = RomWeaverError::Validation("bad header".to_owned())
        .with_context("zip list failed", Some("archive.read_failed"));
    assert_eq!(fallback.code(), Some("archive.read_failed"));
    assert_eq!(
        fallback.to_string(),
        "validation failed: zip list failed: validation failed: bad header [archive.read_failed]"
    );

    let plain = RomWeaverError::Validation("bad".to_owned()).with_context("ctx", None);
    assert!(
        matches!(plain, RomWeaverError::Validation(ref message) if message == "ctx: validation failed: bad")
    );
}

#[test]
fn storage_full_io_errors_carry_the_storage_full_code() {
    let full = RomWeaverError::Io(io::Error::from(io::ErrorKind::StorageFull));
    assert_eq!(full.code(), Some("io.storage_full"));
    let path_full = RomWeaverError::io_path(
        IoOp::Write,
        "/out.bin",
        io::Error::from(io::ErrorKind::StorageFull),
    );
    assert_eq!(path_full.code(), Some("io.storage_full"));
    let wrapped = format!("write failed: {path_full}");
    assert!(wrapped.ends_with(" [io.storage_full]"), "{wrapped}");
    assert_eq!(
        ValidationCodeError::parse_display_tag(&wrapped).map(|(code, _)| code),
        Some("io.storage_full".to_owned())
    );
    assert_eq!(RomWeaverError::Io(io::Error::other("x")).code(), None);
}

#[test]
fn out_of_memory_io_errors_carry_the_out_of_memory_code() {
    let oom = RomWeaverError::Io(io::Error::from(io::ErrorKind::OutOfMemory));
    assert_eq!(oom.code(), Some("resource.out_of_memory"));
    assert!(
        oom.to_string().ends_with(" [resource.out_of_memory]"),
        "{oom}"
    );
}

#[test]
fn with_context_keeps_an_io_code_over_the_fallback_without_repeating_its_tag() {
    let full = RomWeaverError::Io(io::Error::from(io::ErrorKind::StorageFull)).with_context(
        "zip extract failed while writing entry 0",
        Some("archive.read_failed"),
    );
    assert_eq!(full.code(), Some("io.storage_full"));
    let text = full.to_string();
    assert!(
        text.starts_with(
            "validation failed: zip extract failed while writing entry 0: i/o error: "
        ),
        "{text}"
    );
    assert_eq!(text.matches("[io.storage_full]").count(), 1, "{text}");
}
