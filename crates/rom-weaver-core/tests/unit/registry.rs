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
            thread_fallback_reason: Some(
                "operation not supported on this platform".to_string(),
            ),
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
