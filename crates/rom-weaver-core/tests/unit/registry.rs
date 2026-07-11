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

// ---------------------------------------------------------------------------
// Container wrapper forwarding guard.
//
// Containers register through a single wrapper (`traced_container_handler`).
// Because `ContainerHandlerOperations` has default methods, a wrapper that
// forgets to forward one silently resolves to the trait default instead of the
// concrete handler - no compile error, arguments vanish at runtime. These tests
// lock that down: the stub returns a sentinel from every method, and the wrapped
// handler must surface the sentinel, not the default. When adding a new
// `ContainerHandlerOperations` method, add it to the stub + an assertion here.
// ---------------------------------------------------------------------------

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::{
    ArchiveEntryKindFilter, CancellationToken, ContainerCapabilities, ContainerCreateRequest,
    ContainerExtractRequest, ContainerHandlerOperations, ContainerHandlerRegistration,
    ContainerListEntry, ContainerProbeRequest, CreateInputOverride, CreateSupport,
    FormatDescriptor, NoopProgressSink, OperationContext, ProbeConfidence, Result, RomWeaverError,
    ThreadBudget, ThreadCapability, UnsupportedOp,
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
        is_single_payload_disc_image: true,
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
    assert!(handler.is_single_payload_disc_image());
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
