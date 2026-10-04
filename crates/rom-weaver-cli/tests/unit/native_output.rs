use super::*;

#[test]
fn report_preserves_every_terminal_result_and_warning() {
    let first = result_event(
        "extract",
        "extract",
        "first",
        Some(json!({
            "emitted_files": [{ "path": "one.bin" }], "warnings": ["first warning"],
        })),
    );
    let second = result_event(
        "extract",
        "extract",
        "second",
        Some(json!({
            "emitted_files": [{ "path": "two.bin" }], "warnings": ["first warning", "second warning"],
        })),
    );
    let output = document(vec![first, second], 0);
    assert_eq!(
        output["reports"][0]["details"]["emitted_files"][0]["path"],
        "one.bin"
    );
    assert_eq!(
        output["reports"][1]["details"]["emitted_files"][0]["path"],
        "two.bin"
    );
    assert_eq!(
        output["warnings"],
        json!(["first warning", "second warning"])
    );
    assert_eq!(output["exit_code"], 0);
    assert!(output["error"].is_null());
}

#[test]
fn partial_failure_is_not_hidden_by_a_later_success() {
    let failed = error_event(
        "extract",
        "extract",
        "extract.failed",
        "cannot extract member",
        1,
    );
    let succeeded = result_event("extract", "extract", "another member extracted", None);
    let output = document(vec![failed, succeeded], 1);
    assert_eq!(output["status"], "failed");
    assert_eq!(output["error"]["code"], "extract.failed");
    assert_eq!(output["reports"].as_array().expect("reports").len(), 2);
}

#[test]
fn filenames_after_the_separator_do_not_select_json() {
    let args = ["rom-weaver", "checksum", "--", "--json"];
    assert_eq!(
        OutputMode::from_args(&args.map(OsString::from)),
        OutputMode::Human
    );
}

#[test]
fn usage_errors_keep_the_actual_exit_code() {
    let output = document(
        vec![error_event(
            "cli",
            "arguments",
            "cli.invalid_arguments",
            "missing input",
            2,
        )],
        2,
    );
    assert_eq!(output["status"], "failed");
    assert_eq!(output["exit_code"], 2);
    assert_eq!(output["error"]["exit_code"], 2);
}

#[test]
fn cancellation_after_a_result_preserves_the_result_and_reports_cancellation() {
    let output = document(
        vec![result_event("extract", "extract", "member extracted", None)],
        130,
    );
    assert_eq!(output["status"], "cancelled");
    assert_eq!(output["exit_code"], 130);
    assert_eq!(output["error"]["code"], "operation.cancelled");
    assert_eq!(output["error"]["message"], "operation cancelled");
    assert_eq!(output["reports"][0]["label"], "member extracted");
}

#[test]
fn native_cancellation_normalizes_failed_pipeline_events_without_losing_context() {
    let mut event = error_event("checksum", "checksum", "operation.failed", "cancelled", 1);
    event.error_kind = Some(RomWeaverErrorKind::Cancelled);
    let event = normalize_event(event);
    assert_eq!(event.status, OperationStatus::Cancelled);
    assert_eq!(event.command, "checksum");
    assert_eq!(event.stage, "checksum");
    assert_eq!(event.error_kind, Some(RomWeaverErrorKind::Cancelled));
    assert_eq!(event.details.as_ref().unwrap()["error"]["exit_code"], 130);
    assert_eq!(
        event.details.as_ref().unwrap()["error"]["code"],
        "operation.cancelled"
    );
    let output = document(vec![event], 130);
    assert_eq!(output["status"], "cancelled");
    assert_eq!(output["exit_code"], 130);
    assert_eq!(output["error"]["exit_code"], 130);
    assert_eq!(output["error"]["code"], "operation.cancelled");
}

#[test]
fn native_cancellation_does_not_reclassify_other_failures_or_successes() {
    let event = error_event("checksum", "checksum", "operation.failed", "cannot read", 1);
    assert_eq!(normalize_event(event).status, OperationStatus::Failed);
    assert_eq!(
        normalize_event(result_event("checksum", "checksum", "ok", None)).status,
        OperationStatus::Succeeded
    );
}

#[test]
fn native_terminal_failures_always_have_structured_error_details() {
    for (status, code, exit) in [
        (OperationStatus::Failed, "operation.failed", 1),
        (OperationStatus::Unsupported, "operation.unsupported", 2),
        (OperationStatus::Cancelled, "operation.cancelled", 130),
    ] {
        let mut event = result_event("probe", "validate", "cannot read input", None);
        event.status = status;
        let event = normalize_event(event);
        assert_eq!(
            event.details.as_ref().expect("error details")["error"],
            json!({"code": code, "exit_code": exit, "message": "cannot read input"})
        );
    }
    let mut event = result_event(
        "probe",
        "validate",
        "cannot read input",
        Some(json!({"path": "a.nes"})),
    );
    event.status = OperationStatus::Failed;
    let event = normalize_event(event);
    assert_eq!(event.details.as_ref().unwrap()["path"], "a.nes");
    assert_eq!(event.details.as_ref().unwrap()["error"]["exit_code"], 1);
    let event = normalize_event(error_event(
        "cli",
        "arguments",
        "cli.invalid_arguments",
        "bad argument",
        2,
    ));
    assert_eq!(
        event.details.as_ref().unwrap()["error"]["code"],
        "cli.invalid_arguments"
    );
    assert_eq!(event.details.as_ref().unwrap()["error"]["exit_code"], 2);
}

#[test]
fn jsonl_final_event_agrees_with_cancelled_or_failed_exit() {
    let success = result_event("compress", "create", "created output", None);
    let cancelled = stream_exit_event(Some(&success), 130).expect("cancellation event");
    assert_eq!(cancelled.command, "compress");
    assert_eq!(cancelled.status, OperationStatus::Cancelled);
    assert_eq!(
        cancelled.details.as_ref().unwrap()["error"]["exit_code"],
        130
    );
    assert!(stream_exit_event(Some(&cancelled), 130).is_none());
    assert!(stream_exit_event(Some(&success), 0).is_none());
    assert_eq!(
        stream_exit_event(None, 130).unwrap().status,
        OperationStatus::Cancelled
    );
    assert_eq!(
        stream_exit_event(Some(&success), 1).unwrap().status,
        OperationStatus::Failed
    );
    let usage = error_event(
        "cli",
        "arguments",
        "cli.invalid_arguments",
        "bad argument",
        2,
    );
    assert!(stream_exit_event(Some(&usage), 2).is_none());
}
