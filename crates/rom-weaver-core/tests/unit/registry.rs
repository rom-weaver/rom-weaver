use super::OperationReport;
use crate::{OperationFamily, OperationStatus, ThreadExecution, ThreadMode};

#[test]
fn into_event_preserves_thread_fallback_metadata() {
    let report = OperationReport {
        family: OperationFamily::Patch,
        format: Some("IPS".to_string()),
        stage: "apply".to_string(),
        label: "patched".to_string(),
        details: None,
        percent: Some(1.0),
        thread_execution: Some(ThreadExecution {
            requested_threads: 8,
            effective_threads: 1,
            thread_mode: ThreadMode::Fixed,
            used_parallelism: false,
            thread_fallback: true,
            thread_fallback_reason: Some("operation not supported on this platform".to_string()),
        }),
        status: OperationStatus::Succeeded,
    };

    let event = report.into_event("patch-apply");
    assert_eq!(event.thread_fallback, Some(true));
    assert_eq!(
        event.thread_fallback_reason.as_deref(),
        Some("operation not supported on this platform")
    );
}

#[test]
fn into_event_classifies_failed_report_error_kind() {
    // A failure whose label is a bare RomWeaverError rendering carries the typed
    // kind on the emitted event, so the webapp keys off the generated enum
    // instead of re-deriving the kind from the message.
    let report = OperationReport::failed(
        OperationFamily::Patch,
        Some("BPS".to_string()),
        "apply",
        crate::RomWeaverError::Validation("bad checksum".to_string()).to_string(),
        None,
    );
    let event = report.into_event("patch-apply");
    assert_eq!(event.status, OperationStatus::Failed);
    assert_eq!(
        event.error_kind,
        Some(crate::RomWeaverErrorKind::Validation)
    );
}

#[test]
fn into_event_omits_error_kind_for_success_and_context_wrapped_failures() {
    // Succeeded events never carry an error kind.
    let ok = OperationReport::succeeded(
        OperationFamily::Patch,
        None,
        "apply",
        "done",
        Some(100.0),
        None,
    );
    assert_eq!(ok.into_event("patch-apply").error_kind, None);

    // A failure message wrapped in extra context is not a bare RomWeaverError
    // rendering, so it stays unclassified here and falls back to JS-side
    // inference, exactly as before the typed field existed.
    let wrapped = OperationReport::failed(
        OperationFamily::Patch,
        None,
        "prepare",
        format!(
            "failed to prepare output path `/x`: {}",
            crate::RomWeaverError::Cancelled
        ),
        None,
    );
    assert_eq!(wrapped.into_event("patch-apply").error_kind, None);
}

// Container wrapper forwarding guard.
//
// Default trait methods can hide a missing forwarder. The stub returns sentinels
// from every operation; add an assertion whenever the trait gains a method.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::{
    ArchiveEntryKindFilter, CancellationToken, ContainerCapabilities, ContainerCreateRequest,
    ContainerExtractRequest, ContainerHandler as _, ContainerHandlerOperations,
    ContainerHandlerRegistration, ContainerListEntry, ContainerProbeRequest, CreateInputOverride,
    CreateSupport, FormatDescriptor, NoopProgressSink, OperationContext, PatchHandler as _,
    ProbeConfidence, Result, RomWeaverError, ThreadBudget, ThreadCapability, UnsupportedOp,
};

static GUARD_DESCRIPTOR: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "guard",
    aliases: &[],
    extensions: &[".guard"],
};

fn guard_report(stage: &str) -> OperationReport {
    OperationReport {
        family: OperationFamily::Container,
        format: Some("guard".to_string()),
        stage: stage.to_string(),
        label: format!("{stage}_called"),
        details: None,
        percent: None,
        thread_execution: None,
        status: OperationStatus::Succeeded,
    }
}

/// Stub whose every method returns a value distinct from the trait default.
struct SentinelHandler;

impl ContainerHandlerOperations for SentinelHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &GUARD_DESCRIPTOR
    }

    fn probe(&self, _source: &Path) -> ProbeConfidence {
        // Trait default is `Extension`; `Signature` proves the override fired.
        ProbeConfidence::Signature
    }

    fn probe_details(
        &self,
        _request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(guard_report("probe_details"))
    }

    fn list_entries(
        &self,
        _request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        Ok(vec!["from_list_entries".to_string()])
    }

    fn list_entry_records(
        &self,
        _request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<ContainerListEntry>> {
        Ok(vec![ContainerListEntry {
            path: "from_list_entry_records".to_string(),
            size: Some(42),
        }])
    }

    fn extract(
        &self,
        _request: &ContainerExtractRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(guard_report("extract"))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(guard_report("create"))
    }

    fn create_with_input_overrides(
        &self,
        _request: &ContainerCreateRequest,
        _overrides: &[CreateInputOverride],
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(guard_report("create_with_overrides"))
    }

    fn create_dry_run_size(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<u64> {
        // Trait default is an error; a real value proves the override fired.
        Ok(12345)
    }
}

fn guard_context() -> OperationContext {
    OperationContext::new(
        ThreadBudget::Fixed(1),
        std::env::temp_dir(),
        Arc::new(NoopProgressSink),
        CancellationToken::new(),
    )
}

fn guard_registration(create_support: CreateSupport) -> ContainerHandlerRegistration {
    ContainerHandlerRegistration {
        descriptor: &GUARD_DESCRIPTOR,
        capabilities: ContainerCapabilities {
            probe_details: true,
            extract: true,
            create: matches!(create_support, CreateSupport::Supported),
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        },
        is_single_payload_codec_container: true,
        create_support,
    }
}

fn guard_probe_request() -> ContainerProbeRequest {
    ContainerProbeRequest {
        source: PathBuf::from("x.guard"),
        split_bin: false,
    }
}

fn guard_create_request() -> ContainerCreateRequest {
    ContainerCreateRequest {
        inputs: Vec::new(),
        output: PathBuf::from("out.guard"),
        format: "guard".to_string(),
        codec: None,
        level: None,
        parent: None,
    }
}

#[test]
fn traced_container_handler_forwards_every_operation() {
    let handler = crate::traced_container_handler(
        Arc::new(SentinelHandler),
        guard_registration(CreateSupport::Supported),
    );
    let context = guard_context();

    assert_eq!(handler.descriptor().name, "guard");
    assert!(handler.is_single_payload_codec_container());
    assert!(handler.capabilities().create);

    assert_eq!(
        handler.probe(Path::new("x.guard")),
        ProbeConfidence::Signature
    );

    let probe = guard_probe_request();
    assert_eq!(
        handler.probe_details(&probe, &context).unwrap().label,
        "probe_details_called"
    );
    assert_eq!(
        handler.list_entries(&probe, &context).unwrap(),
        vec!["from_list_entries".to_string()]
    );

    // Key silent-drop guard: `list_entry_records` must reach the inner override,
    // not fall back to the default that re-maps `list_entries`.
    let records = handler.list_entry_records(&probe, &context).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].path, "from_list_entry_records");
    assert_eq!(records[0].size, Some(42));

    let extract = ContainerExtractRequest {
        source: PathBuf::from("x.guard"),
        selections: Vec::new(),
        kind_filter: ArchiveEntryKindFilter::default(),
        out_dir: PathBuf::from("out"),
        split_bin: false,
        ignore_common_files: false,
        overwrite: false,
        parent: None,
        containing_archive: None,
    };
    assert_eq!(
        handler.extract(&extract, &context).unwrap().label,
        "extract_called"
    );

    let create = guard_create_request();
    assert_eq!(
        handler.create(&create, &context).unwrap().label,
        "create_called"
    );

    // Silent-drop guard for the override path: the default delegates to
    // `create`, so a distinct sentinel proves the inner override is reached.
    assert_eq!(
        handler
            .create_with_input_overrides(&create, &[], &context)
            .unwrap()
            .label,
        "create_with_overrides_called"
    );

    assert_eq!(
        handler.create_dry_run_size(&create, &context).unwrap(),
        12345
    );
}

#[test]
fn traced_container_handler_gates_create_for_extract_only() {
    let handler = crate::traced_container_handler(
        Arc::new(SentinelHandler),
        guard_registration(CreateSupport::ExtractOnly {
            supported_create_formats: "zip, 7z".to_string(),
        }),
    );
    let context = guard_context();
    let create = guard_create_request();

    assert!(!handler.capabilities().create);

    match handler.create(&create, &context) {
        Err(RomWeaverError::Unsupported(UnsupportedOp::ExtractOnlyCreate {
            format,
            supported_create_formats,
        })) => {
            assert_eq!(format, "guard");
            assert_eq!(supported_create_formats, "zip, 7z");
        }
        other => panic!("expected extract-only create error, got {other:?}"),
    }

    assert!(matches!(
        handler.create_with_input_overrides(&create, &[], &context),
        Err(RomWeaverError::Unsupported(
            UnsupportedOp::ExtractOnlyCreate { .. }
        ))
    ));

    assert!(matches!(
        handler.create_dry_run_size(&create, &context),
        Err(RomWeaverError::Unsupported(
            UnsupportedOp::ExtractOnlyCreate { .. }
        ))
    ));
}

// --- FormatDescriptor matching ----------------------------------------------

static MATCH_DESCRIPTOR: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "SevenZip",
    aliases: &["7z", "7-zip"],
    extensions: &[".7z", ".7Z.001"],
};

#[test]
fn format_descriptor_matches_its_name_and_aliases_case_insensitively() {
    for candidate in ["SevenZip", "sevenzip", "SEVENZIP", "  7z  ", "7-ZIP"] {
        assert!(
            MATCH_DESCRIPTOR.matches_name(candidate),
            "`{candidate}` must match"
        );
    }
    for candidate in ["7zip", "zip", "", "seven zip"] {
        assert!(
            !MATCH_DESCRIPTOR.matches_name(candidate),
            "`{candidate}` must not match"
        );
    }
}

#[test]
fn format_descriptor_matches_paths_by_extension_regardless_of_case() {
    for candidate in ["a.7z", "/roms/A.7Z", "deep/dir/x.7z.001", "X.7z.001"] {
        assert!(
            MATCH_DESCRIPTOR.matches_path(Path::new(candidate)),
            "`{candidate}` must match"
        );
    }
    for candidate in ["a.zip", "7z", "a.7z.002"] {
        assert!(
            !MATCH_DESCRIPTOR.matches_path(Path::new(candidate)),
            "`{candidate}` must not match"
        );
    }
    // A path with no file name component cannot carry an extension.
    assert!(!MATCH_DESCRIPTOR.matches_path(Path::new("..")));
    assert!(!MATCH_DESCRIPTOR.matches_path(Path::new("/")));
}

// --- ContainerExtractRequest::ensure_single_output_selected ------------------

fn single_output_request(
    selections: &[&str],
    kind_filter: ArchiveEntryKindFilter,
) -> ContainerExtractRequest {
    ContainerExtractRequest {
        source: PathBuf::from("/roms/game.chd"),
        selections: selections
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        kind_filter,
        out_dir: PathBuf::from("out"),
        split_bin: false,
        ignore_common_files: false,
        overwrite: false,
        parent: None,
        containing_archive: None,
    }
}

#[test]
fn ensure_single_output_selected_accepts_a_matching_selection() {
    assert!(
        single_output_request(&[], ArchiveEntryKindFilter::default())
            .ensure_single_output_selected("game.bin")
            .is_ok()
    );
    assert!(
        single_output_request(&["game.bin"], ArchiveEntryKindFilter::default())
            .ensure_single_output_selected("game.bin")
            .is_ok()
    );
}

#[test]
fn ensure_single_output_selected_rejects_an_unmatched_selection() {
    let error = single_output_request(&["other.bin"], ArchiveEntryKindFilter::default())
        .ensure_single_output_selected("game.bin")
        .expect_err("an unmatched selection must fail");
    assert!(error.to_string().contains("other.bin"), "{error}");
}

#[test]
fn ensure_single_output_selected_rejects_an_output_the_kind_filter_excludes() {
    let error = single_output_request(&[], ArchiveEntryKindFilter::new(true, false))
        .ensure_single_output_selected("readme.txt")
        .expect_err("a filtered-out output must fail");
    assert_eq!(
        error.to_string(),
        "validation failed: no extract entries from `/roms/game.chd` matched --filter rom"
    );
    // The same output passes once the filter admits its kind.
    assert!(
        single_output_request(&[], ArchiveEntryKindFilter::new(true, false))
            .ensure_single_output_selected("game.iso")
            .is_ok()
    );
}

// --- Trait defaults ----------------------------------------------------------

static DEFAULTS_DESCRIPTOR: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Container,
    name: "defaults",
    aliases: &[],
    extensions: &[".defaults"],
};

/// Implements only the required methods, so every call below exercises a trait
/// default rather than an override.
struct DefaultsContainerHandler;

impl ContainerHandlerOperations for DefaultsContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &DEFAULTS_DESCRIPTOR
    }

    fn probe_details(
        &self,
        _request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(guard_report("probe_details"))
    }

    fn extract(
        &self,
        _request: &ContainerExtractRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(guard_report("extract"))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(guard_report("create"))
    }
}

impl crate::ContainerHandler for DefaultsContainerHandler {
    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            probe_details: true,
            extract: true,
            create: true,
            extract_threads: ThreadCapability::single_threaded(),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

#[test]
fn container_trait_defaults_describe_an_unimplemented_operation() {
    let handler = DefaultsContainerHandler;
    let context = guard_context();
    let probe = guard_probe_request();
    let create = guard_create_request();

    assert_eq!(
        handler.probe(Path::new("x.defaults")),
        ProbeConfidence::Extension
    );
    assert!(!handler.is_single_payload_codec_container());

    // The two unimplemented operations name themselves rather than failing
    // opaquely, so the CLI can tell the user which format lacks what.
    match handler.list_entries(&probe, &context) {
        Err(RomWeaverError::Unsupported(UnsupportedOp::FormatOperation { format, operation })) => {
            assert_eq!(format, "defaults");
            assert_eq!(operation, crate::FormatOperationKind::ListEntries);
        }
        other => panic!("expected a list-entries unsupported error, got {other:?}"),
    }
    match handler.create_dry_run_size(&create, &context) {
        Err(RomWeaverError::Unsupported(UnsupportedOp::FormatOperation { format, operation })) => {
            assert_eq!(format, "defaults");
            assert_eq!(operation, crate::FormatOperationKind::CreateDryRunSize);
        }
        other => panic!("expected a dry-run-size unsupported error, got {other:?}"),
    }

    // `list_entry_records` defaults to re-mapping `list_entries`, so it inherits
    // that failure rather than reporting an empty listing.
    assert!(matches!(
        handler.list_entry_records(&probe, &context),
        Err(RomWeaverError::Unsupported(
            UnsupportedOp::FormatOperation { .. }
        ))
    ));

    // The override-aware create defaults to plain `create`.
    assert_eq!(
        handler
            .create_with_input_overrides(&create, &[], &context)
            .expect("create with overrides")
            .label,
        "create_called"
    );
}

#[test]
fn container_list_entry_records_default_maps_entries_without_sizes() {
    struct ListOnlyHandler;

    impl ContainerHandlerOperations for ListOnlyHandler {
        fn descriptor(&self) -> &'static FormatDescriptor {
            &DEFAULTS_DESCRIPTOR
        }

        fn probe_details(
            &self,
            _request: &ContainerProbeRequest,
            _context: &OperationContext,
        ) -> Result<OperationReport> {
            Ok(guard_report("probe_details"))
        }

        fn list_entries(
            &self,
            _request: &ContainerProbeRequest,
            _context: &OperationContext,
        ) -> Result<Vec<String>> {
            Ok(vec!["a.bin".to_string(), "b.bin".to_string()])
        }

        fn extract(
            &self,
            _request: &ContainerExtractRequest,
            _context: &OperationContext,
        ) -> Result<OperationReport> {
            Ok(guard_report("extract"))
        }

        fn create(
            &self,
            _request: &ContainerCreateRequest,
            _context: &OperationContext,
        ) -> Result<OperationReport> {
            Ok(guard_report("create"))
        }
    }

    let records = ListOnlyHandler
        .list_entry_records(&guard_probe_request(), &guard_context())
        .expect("records");
    assert_eq!(
        records,
        vec![
            ContainerListEntry {
                path: "a.bin".to_string(),
                size: None
            },
            ContainerListEntry {
                path: "b.bin".to_string(),
                size: None
            },
        ]
    );
}

// --- Patch handler wrapper and trait defaults -------------------------------

static PATCH_DESCRIPTOR: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "guardpatch",
    aliases: &["gp"],
    extensions: &[".gp"],
};

fn patch_report(stage: &str) -> OperationReport {
    OperationReport {
        family: OperationFamily::Patch,
        format: Some("guardpatch".to_string()),
        stage: stage.to_string(),
        label: format!("{stage}_called"),
        details: None,
        percent: None,
        thread_execution: None,
        status: OperationStatus::Succeeded,
    }
}

fn patch_capabilities() -> crate::PatchCapabilities {
    crate::PatchCapabilities {
        parse: true,
        apply: true,
        create: true,
        threaded_scan: false,
        threaded_diff: false,
        threaded_output: false,
    }
}

fn patch_apply_request() -> crate::PatchApplyRequest {
    crate::PatchApplyRequest {
        input: PathBuf::from("in.bin"),
        patches: vec![PathBuf::from("a.gp")],
        output: PathBuf::from("out.bin"),
    }
}

fn patch_validate_request() -> crate::PatchValidateRequest {
    crate::PatchValidateRequest {
        input: PathBuf::from("in.bin"),
        patches: vec![PathBuf::from("a.gp")],
    }
}

fn patch_create_request() -> crate::PatchCreateRequest {
    crate::PatchCreateRequest {
        original: PathBuf::from("orig.bin"),
        modified: PathBuf::from("mod.bin"),
        output: PathBuf::from("out.gp"),
        format: "guardpatch".to_string(),
    }
}

/// Stub whose every method returns a value distinct from the trait default, so
/// a wrapper that silently drops a forward is caught.
struct SentinelPatchHandler;

impl crate::PatchHandler for SentinelPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &PATCH_DESCRIPTOR
    }

    fn header_magic(&self) -> Option<&'static [u8]> {
        Some(b"GPATCH")
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Signature
    }

    fn parse(&self, _patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        Ok(patch_report("parse"))
    }

    fn describe_metadata(
        &self,
        _patch_path: &Path,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(patch_report("describe"))
    }

    fn resolve_endpoint_selections(
        &self,
        _patch_path: &Path,
        _input_path: &Path,
        _context: &OperationContext,
    ) -> Result<Vec<crate::PatchEndpointSelection>> {
        Ok(vec![crate::PatchEndpointSelection {
            variant: 7,
            direction: crate::PatchApplyDirection::Reverse,
        }])
    }

    fn apply(
        &self,
        _request: &crate::PatchApplyRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(patch_report("apply"))
    }

    fn validate(
        &self,
        _request: &crate::PatchValidateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(patch_report("validate"))
    }

    fn create(
        &self,
        _request: &crate::PatchCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(patch_report("create"))
    }

    fn create_with_options(
        &self,
        _request: &crate::PatchCreateRequest,
        options: Option<&crate::PatchCreateFormatOptions>,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        // The trait default rejects any options, so accepting them proves the
        // override was reached.
        Ok(patch_report(if options.is_some() {
            "create_with_options"
        } else {
            "create_without_options"
        }))
    }

    fn capabilities(&self) -> crate::PatchCapabilities {
        patch_capabilities()
    }
}

#[test]
fn traced_patch_handler_forwards_every_operation() {
    let handler = crate::traced_patch_handler(Arc::new(SentinelPatchHandler));
    let context = guard_context();

    assert_eq!(handler.descriptor().name, "guardpatch");
    assert_eq!(handler.header_magic(), Some(b"GPATCH".as_slice()));
    assert_eq!(handler.probe(Path::new("a.gp")), ProbeConfidence::Signature);
    assert!(handler.capabilities().parse);

    assert_eq!(
        handler
            .parse(Path::new("a.gp"), &context)
            .expect("parse")
            .label,
        "parse_called"
    );
    assert_eq!(
        handler
            .resolve_endpoint_selections(Path::new("a.gp"), Path::new("in.bin"), &context)
            .expect("endpoints"),
        vec![crate::PatchEndpointSelection {
            variant: 7,
            direction: crate::PatchApplyDirection::Reverse,
        }]
    );
    assert_eq!(
        handler
            .apply(&patch_apply_request(), &context)
            .expect("apply")
            .label,
        "apply_called"
    );
    assert_eq!(
        handler
            .validate(&patch_validate_request(), &context)
            .expect("validate")
            .label,
        "validate_called"
    );

    // `TracingPatchHandler::create` routes through `create_with_options`, so the
    // inner handler must still see `None` for a plain create.
    assert_eq!(
        handler
            .create(&patch_create_request(), &context)
            .expect("create")
            .label,
        "create_without_options_called"
    );
    let options = crate::PatchCreateFormatOptions::Solid(crate::SolidPatchMetadata::default());
    assert_eq!(
        handler
            .create_with_options(&patch_create_request(), Some(&options), &context)
            .expect("create with options")
            .label,
        "create_with_options_called"
    );
}

/// Implements only the required `PatchHandler` methods. `apply_status` decides
/// what the dry-run apply inside `validate_via_apply` reports back.
struct DefaultsPatchHandler {
    apply_status: OperationStatus,
    apply_fails: bool,
}

impl DefaultsPatchHandler {
    fn succeeding() -> Self {
        Self {
            apply_status: OperationStatus::Succeeded,
            apply_fails: false,
        }
    }
}

impl crate::PatchHandler for DefaultsPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        &PATCH_DESCRIPTOR
    }

    fn parse(&self, _patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        Ok(patch_report("parse"))
    }

    fn apply(
        &self,
        request: &crate::PatchApplyRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        if self.apply_fails {
            return Err(RomWeaverError::Validation("dry-run apply failed".into()));
        }
        // The default `validate_via_apply` removes this file afterwards; writing
        // it proves the cleanup runs against a file that really existed.
        std::fs::write(&request.output, b"patched").expect("write dry-run output");
        let mut report = patch_report("apply");
        report.status = self.apply_status;
        Ok(report)
    }

    fn validate(
        &self,
        _request: &crate::PatchValidateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(patch_report("validate"))
    }

    fn create(
        &self,
        _request: &crate::PatchCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Ok(patch_report("create"))
    }

    fn capabilities(&self) -> crate::PatchCapabilities {
        patch_capabilities()
    }
}

#[test]
fn patch_trait_defaults_fall_back_to_the_required_methods() {
    let handler = DefaultsPatchHandler::succeeding();
    let context = guard_context();

    assert_eq!(handler.header_magic(), None);
    assert_eq!(handler.probe(Path::new("a.gp")), ProbeConfidence::Extension);
    // `describe_metadata` defaults to a full parse.
    assert_eq!(
        handler
            .describe_metadata(Path::new("a.gp"), &context)
            .expect("describe")
            .label,
        "parse_called"
    );
    assert!(
        handler
            .resolve_endpoint_selections(Path::new("a.gp"), Path::new("in.bin"), &context)
            .expect("endpoints")
            .is_empty()
    );

    // The default `create_with_options` refuses options it cannot interpret,
    // and passes a plain create straight through.
    let options = crate::PatchCreateFormatOptions::Solid(crate::SolidPatchMetadata::default());
    let error = handler
        .create_with_options(&patch_create_request(), Some(&options), &context)
        .map(|_| ())
        .expect_err("format-specific options must be refused");
    assert_eq!(
        error.to_string(),
        "validation failed: guardpatch patch create does not accept format-specific options"
    );
    assert_eq!(
        handler
            .create_with_options(&patch_create_request(), None, &context)
            .expect("plain create")
            .label,
        "create_called"
    );
}

#[test]
fn validate_via_apply_reports_a_successful_dry_run_and_removes_its_output() {
    let context = guard_context();
    let report = DefaultsPatchHandler::succeeding()
        .validate_via_apply(&patch_validate_request(), &context)
        .expect("dry-run validate");

    assert_eq!(report.stage, "validate");
    assert_eq!(report.status, OperationStatus::Succeeded);
    assert_eq!(report.label, "validated guardpatch patch via dry-run apply");
    assert_eq!(report.percent, Some(100.0));

    // The scratch output is deleted, so a validate leaves nothing behind.
    let namespace = context
        .temp_paths()
        .root()
        .join(context.temp_paths().namespace());
    let leftovers = std::fs::read_dir(&namespace)
        .map(|entries| entries.count())
        .unwrap_or(0);
    assert_eq!(leftovers, 0, "dry-run output was left in {namespace:?}");
}

#[test]
fn validate_via_apply_propagates_a_non_successful_apply_as_a_validate_stage() {
    let context = guard_context();
    let handler = DefaultsPatchHandler {
        apply_status: OperationStatus::Failed,
        apply_fails: false,
    };
    let report = handler
        .validate_via_apply(&patch_validate_request(), &context)
        .expect("a non-succeeded apply is still a report, not an error");

    // The apply report is re-stamped as `validate` but keeps its own status and
    // label, so the caller sees why the dry run did not succeed.
    assert_eq!(report.stage, "validate");
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.label, "apply_called");
}

#[test]
fn validate_via_apply_propagates_an_apply_error() {
    let context = guard_context();
    let handler = DefaultsPatchHandler {
        apply_status: OperationStatus::Succeeded,
        apply_fails: true,
    };
    let error = handler
        .validate_via_apply(&patch_validate_request(), &context)
        .map(|_| ())
        .expect_err("an apply failure must surface");
    assert_eq!(error.to_string(), "validation failed: dry-run apply failed");
}
