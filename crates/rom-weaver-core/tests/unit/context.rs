use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::Arc;

use super::*;
use crate::{NoopProgressSink, OperationFamily, OperationStatus, RecordingProgressSink};

fn test_context() -> OperationContext {
    OperationContext::new(
        ThreadBudget::Fixed(1),
        std::env::temp_dir(),
        Arc::new(NoopProgressSink),
        CancellationToken::new(),
    )
}

#[test]
fn patch_policy_default_pins_every_field() {
    let policy = PatchPolicy::default();
    assert_eq!(policy.extract_checksum_algorithms, Vec::<String>::new());
    assert!(!policy.extract_checksum_rom_only);
    assert_eq!(
        policy.patch_checksum_validation,
        PatchChecksumValidation::Strict
    );
    assert_eq!(policy.patch_check_scopes, None);
    assert_eq!(policy.patch_endpoint_selection, None);
    assert_eq!(policy.patch_input_n64_byte_order, None);
    assert_eq!(policy.xdelta_secondary_mode, XdeltaSecondaryMode::Lzma);
    assert_eq!(policy.patch_apply_in_memory_limit, None);
}

#[test]
fn patch_check_scopes_all_toggles_every_field_together() {
    let enabled = PatchCheckScopes::all(true);
    assert!(enabled.patch_integrity);
    assert!(enabled.source);
    assert!(enabled.target);

    let disabled = PatchCheckScopes::all(false);
    assert!(!disabled.patch_integrity);
    assert!(!disabled.source);
    assert!(!disabled.target);
}

#[test]
fn operation_context_new_threads_default_patch_policy_through_getters() {
    let context = test_context();

    // Strict is the default validation, so every derived scope must default to enforced -
    // a wrong default here silently disables patch checksum validation workspace-wide.
    assert!(context.strict_patch_checksums());
    assert!(context.validate_source_checks());
    assert!(context.validate_target_checks());
    assert!(context.validate_patch_integrity());

    assert_eq!(context.patch_apply_in_memory_limit(), None);
    assert!(!context.extract_checksum_rom_only());
    assert!(context.extract_checksum_algorithms().is_empty());
    assert_eq!(context.xdelta_secondary_mode(), XdeltaSecondaryMode::Lzma);
    assert_eq!(context.patch_endpoint_selection(), None);
    assert_eq!(context.patch_input_n64_byte_order(), None);
}

#[test]
fn with_patch_checksum_validation_ignore_disables_every_derived_scope() {
    let context = test_context().with_patch_checksum_validation(PatchChecksumValidation::Ignore);

    assert!(!context.strict_patch_checksums());
    assert!(!context.validate_source_checks());
    assert!(!context.validate_target_checks());
    assert!(!context.validate_patch_integrity());
}

#[test]
fn with_patch_check_scopes_overrides_the_strict_derived_default() {
    // Context otherwise strict (patch_check_scopes still None by default via new()), but an
    // explicit scope override must win over what strict validation would imply.
    let context = test_context().with_patch_check_scopes(PatchCheckScopes {
        patch_integrity: true,
        source: false,
        target: true,
    });

    assert!(context.strict_patch_checksums());
    assert!(context.validate_patch_integrity());
    assert!(!context.validate_source_checks());
    assert!(context.validate_target_checks());
}

#[test]
fn with_patch_apply_in_memory_limit_round_trips() {
    let context = test_context().with_patch_apply_in_memory_limit(1234);
    assert_eq!(context.patch_apply_in_memory_limit(), Some(1234));
}

#[test]
fn with_extract_checksum_algorithms_round_trips() {
    let context = test_context().with_extract_checksum_algorithms(vec!["crc32".to_string()]);
    assert_eq!(context.extract_checksum_algorithms(), ["crc32".to_string()]);
}

#[test]
fn with_extract_checksum_rom_only_round_trips() {
    let context = test_context().with_extract_checksum_rom_only(true);
    assert!(context.extract_checksum_rom_only());
}

#[test]
fn with_patch_endpoint_selection_round_trips() {
    let selection = PatchEndpointSelection {
        variant: 3,
        direction: PatchApplyDirection::Reverse,
    };
    let context = test_context().with_patch_endpoint_selection(selection);
    assert_eq!(context.patch_endpoint_selection(), Some(selection));
}

#[test]
fn with_patch_input_n64_byte_order_round_trips() {
    let context =
        test_context().with_patch_input_n64_byte_order(PatchInputN64ByteOrder::ByteSwapped);
    assert_eq!(
        context.patch_input_n64_byte_order(),
        Some(PatchInputN64ByteOrder::ByteSwapped)
    );
}

#[test]
fn with_xdelta_secondary_mode_round_trips() {
    let context = test_context().with_xdelta_secondary_mode(XdeltaSecondaryMode::Djw);
    assert_eq!(context.xdelta_secondary_mode(), XdeltaSecondaryMode::Djw);
}

#[test]
fn with_progress_sink_swaps_the_sink_emit_reaches() {
    let recorder = Arc::new(RecordingProgressSink::default());
    let context = test_context().with_progress_sink(recorder.clone());

    let event = ProgressEvent {
        command: "test-command".to_string(),
        family: OperationFamily::Test,
        format: None,
        stage: "stage".to_string(),
        label: "label".to_string(),
        details: None,
        percent: None,
        requested_threads: None,
        effective_threads: None,
        thread_mode: None,
        used_parallelism: None,
        thread_fallback: None,
        thread_fallback_reason: None,
        elapsed_ms: None,
        error_kind: None,
        status: OperationStatus::Running,
    };
    context.emit(event);

    let snapshot = recorder.snapshot();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].command, "test-command");
}

#[test]
fn with_patch_policy_replaces_the_whole_group_at_once() {
    let replacement = PatchPolicy {
        extract_checksum_algorithms: vec!["md5".to_string()],
        extract_checksum_rom_only: true,
        patch_checksum_validation: PatchChecksumValidation::Ignore,
        patch_check_scopes: None,
        patch_endpoint_selection: None,
        patch_input_n64_byte_order: None,
        xdelta_secondary_mode: XdeltaSecondaryMode::Fgk,
        patch_apply_in_memory_limit: Some(99),
    };
    let context = test_context().with_patch_policy(replacement);

    assert_eq!(context.extract_checksum_algorithms(), ["md5".to_string()]);
    assert!(context.extract_checksum_rom_only());
    assert!(!context.strict_patch_checksums());
    assert_eq!(context.xdelta_secondary_mode(), XdeltaSecondaryMode::Fgk);
    assert_eq!(context.patch_apply_in_memory_limit(), Some(99));
}

#[test]
fn xdelta_secondary_mode_from_str_accepts_all_variants_case_insensitively() {
    assert_eq!(
        XdeltaSecondaryMode::from_str("Auto").unwrap(),
        XdeltaSecondaryMode::Auto
    );
    assert_eq!(
        XdeltaSecondaryMode::from_str("DJW").unwrap(),
        XdeltaSecondaryMode::Djw
    );
    assert_eq!(
        XdeltaSecondaryMode::from_str("fgk").unwrap(),
        XdeltaSecondaryMode::Fgk
    );
    assert_eq!(
        XdeltaSecondaryMode::from_str("LZMA").unwrap(),
        XdeltaSecondaryMode::Lzma
    );
    assert_eq!(
        XdeltaSecondaryMode::from_str("None").unwrap(),
        XdeltaSecondaryMode::None
    );
}

#[test]
fn xdelta_secondary_mode_from_str_rejects_unknown_values() {
    let error = XdeltaSecondaryMode::from_str("bogus").unwrap_err();
    match error {
        RomWeaverError::Validation(message) => {
            assert!(
                message.contains("invalid xdelta secondary mode"),
                "unexpected message: {message}"
            );
        }
        other => panic!("expected Validation error, got {other:?}"),
    }
}

#[test]
fn xdelta_secondary_mode_display_round_trips_to_from_str() {
    for mode in [
        XdeltaSecondaryMode::Auto,
        XdeltaSecondaryMode::Djw,
        XdeltaSecondaryMode::Fgk,
        XdeltaSecondaryMode::Lzma,
        XdeltaSecondaryMode::None,
    ] {
        let rendered = format!("{mode}");
        assert_eq!(XdeltaSecondaryMode::from_str(&rendered).unwrap(), mode);
    }
}

#[test]
fn seed_checksums_and_seeded_checksum_normalize_case() {
    let context = test_context();
    let path = std::path::Path::new("rom.bin");

    let mut checksums = BTreeMap::new();
    checksums.insert("crc32".to_string(), "ABCDEF".to_string());
    context.seed_checksums(path, &checksums);

    assert_eq!(
        context.seeded_checksum(path, "CRC32"),
        Some("abcdef".to_string())
    );
}

#[test]
fn seeded_checksum_returns_none_for_an_unseeded_path() {
    let context = test_context();
    assert_eq!(
        context.seeded_checksum(std::path::Path::new("never-seeded.bin"), "crc32"),
        None
    );
}

#[test]
fn seed_checksums_with_an_empty_map_is_a_no_op() {
    let context = test_context();
    let path = std::path::Path::new("rom.bin");

    context.seed_checksums(path, &BTreeMap::new());

    assert_eq!(context.seeded_checksum(path, "crc32"), None);
}

#[test]
fn seed_checksums_merges_and_keeps_the_first_write_per_algorithm() {
    let context = test_context();
    let path = std::path::Path::new("rom.bin");

    let mut first = BTreeMap::new();
    first.insert("crc32".to_string(), "aaa".to_string());
    context.seed_checksums(path, &first);

    let mut second = BTreeMap::new();
    second.insert("crc32".to_string(), "bbb".to_string());
    second.insert("md5".to_string(), "ccc".to_string());
    context.seed_checksums(path, &second);

    assert_eq!(
        context.seeded_checksum(path, "crc32"),
        Some("aaa".to_string())
    );
    assert_eq!(
        context.seeded_checksum(path, "md5"),
        Some("ccc".to_string())
    );
}

#[test]
fn single_thread_execution_reports_no_parallelism() {
    let context = test_context();
    let execution = context.single_thread_execution().expect("some execution");
    assert_eq!(execution.effective_threads, 1);
    assert!(!execution.used_parallelism);
}

#[test]
fn getters_round_trip_the_constructor_arguments() {
    let temp_root = std::env::temp_dir();
    let cancel = CancellationToken::new();
    let context = OperationContext::new(
        ThreadBudget::Fixed(2),
        temp_root.clone(),
        Arc::new(NoopProgressSink),
        cancel.clone(),
    );

    assert_eq!(context.thread_budget(), ThreadBudget::Fixed(2));
    assert_eq!(context.temp_root(), temp_root.as_path());
    assert_eq!(context.temp_paths().root(), temp_root.as_path());
    assert!(!context.cancel().is_cancelled());
    cancel.cancel();
    assert!(context.cancel().is_cancelled());
}
