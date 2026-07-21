use std::{io, path::PathBuf};

use super::{
    IoOp, IoResultExt, RomWeaverError, RomWeaverErrorKind, UnsupportedOp, ValidationCodeError,
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
