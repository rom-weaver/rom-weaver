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
