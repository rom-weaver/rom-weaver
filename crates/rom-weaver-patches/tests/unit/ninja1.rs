use std::path::PathBuf;

use rom_weaver_core::{
    OperationStatus, PatchApplyRequest, PatchCreateRequest, PatchHandler, PatchValidateRequest,
};

use super::Ninja1PatchHandler;
use crate::{
    NINJA1,
    test_support::{TestDir, test_context_with_threads},
};

fn placeholder() -> PathBuf {
    PathBuf::from("never-opened.rup")
}

#[test]
fn every_stage_reports_the_ninja1_variant_as_unsupported() {
    let temp = TestDir::new();
    let context = test_context_with_threads(&temp, 1);
    let handler = Ninja1PatchHandler::new(&NINJA1);
    assert_eq!(handler.descriptor().name, "NINJA1");

    let reports = [
        handler.parse(&placeholder(), &context).expect("parse"),
        handler
            .apply(
                &PatchApplyRequest {
                    input: placeholder(),
                    patches: vec![placeholder()],
                    output: placeholder(),
                },
                &context,
            )
            .expect("apply"),
        handler
            .validate(
                &PatchValidateRequest {
                    input: placeholder(),
                    patches: vec![placeholder()],
                },
                &context,
            )
            .expect("validate"),
        handler
            .create(
                &PatchCreateRequest {
                    original: placeholder(),
                    modified: placeholder(),
                    output: placeholder(),
                    format: "NINJA1".into(),
                },
                &context,
            )
            .expect("create"),
    ];

    // No stage touches the filesystem: the handler recognises the header and
    // declines before any path is opened.
    for (report, stage) in reports.iter().zip(["parse", "apply", "validate", "create"]) {
        assert_eq!(report.status, OperationStatus::Unsupported, "{stage}");
        assert_eq!(report.stage, stage);
        assert!(report.label.contains("NINJA2/RUP is supported"), "{stage}");
    }
}

#[test]
fn capabilities_advertise_nothing() {
    let capabilities = Ninja1PatchHandler::new(&NINJA1).capabilities();

    assert!(!capabilities.parse);
    assert!(!capabilities.apply);
    assert!(!capabilities.create);
    assert!(!capabilities.threaded_scan);
    assert!(!capabilities.threaded_diff);
    assert!(!capabilities.threaded_output);
}
