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
