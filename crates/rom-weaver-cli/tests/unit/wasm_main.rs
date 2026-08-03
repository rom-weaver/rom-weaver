use super::{WASM_PANIC_MARKER, parse_wasm_run_request};

#[test]
fn panic_marker_is_the_literal_the_js_host_pins() {
    // The webapp-side counterpart lives in
    // packages/rom-weaver-webapp/tests/unit/wasm-panic-marker.test.mjs and
    // hard-codes this same string - there is no single source of truth
    // shared across the Rust/JS boundary, so this assertion is the guard
    // against the two silently drifting apart.
    assert_eq!(WASM_PANIC_MARKER, "[rom-weaver-panic]");
}

#[test]
fn parses_a_minimal_valid_run_request() {
    let request =
        parse_wasm_run_request(r#"{"command":{"type":"probe","args":{"input":"game.bin"}}}"#)
            .expect("minimal probe run request should parse");
    assert!(!request.output.json);
}

#[test]
fn parses_a_run_request_with_output_options() {
    let request = parse_wasm_run_request(
        r#"{"command":{"type":"probe","args":{"input":"game.bin"}},"output":{"json":true}}"#,
    )
    .expect("run request with output options should parse");
    assert!(request.output.json);
}

#[test]
fn empty_stdin_reports_a_missing_request_error() {
    let error = parse_wasm_run_request("").expect_err("empty input should fail to parse");
    assert_eq!(error, "missing typed run request on stdin");
}

#[test]
fn whitespace_only_stdin_reports_a_missing_request_error() {
    let error = parse_wasm_run_request("   \n\t  ").expect_err("blank input should fail to parse");
    assert_eq!(error, "missing typed run request on stdin");
}

#[test]
fn malformed_json_reports_an_invalid_json_error() {
    let error =
        parse_wasm_run_request("{not valid json").expect_err("malformed JSON should fail to parse");
    assert!(
        error.starts_with("invalid typed run request JSON: "),
        "unexpected error message: {error}"
    );
}

#[test]
fn well_formed_json_with_an_unknown_command_type_reports_an_invalid_json_error() {
    let error = parse_wasm_run_request(r#"{"command":{"type":"not-a-real-command"}}"#)
        .expect_err("unknown command type should fail to parse");
    assert!(
        error.starts_with("invalid typed run request JSON: "),
        "unexpected error message: {error}"
    );
}
