use std::collections::HashSet;

use super::{
    ERROR_CODE_IO_STORAGE_FULL, ERROR_CODE_RESOURCE_OUT_OF_MEMORY, ERROR_CODE_WORKFLOW_CODES,
    WorkflowErrorCode, workflow_error_code,
};

#[test]
fn error_codes_are_unique_and_resolve_to_their_workflow_code() {
    let mut seen = HashSet::new();
    for (code, workflow) in ERROR_CODE_WORKFLOW_CODES {
        assert!(seen.insert(*code), "duplicate error code `{code}`");
        assert_eq!(workflow_error_code(code), Some(*workflow));
    }
    assert_eq!(workflow_error_code("not.a.code"), None);
}

#[test]
fn storage_and_memory_codes_report_their_own_workflow_codes() {
    assert_eq!(
        workflow_error_code(ERROR_CODE_IO_STORAGE_FULL),
        Some(WorkflowErrorCode::StorageFull)
    );
    assert_eq!(
        workflow_error_code(ERROR_CODE_RESOURCE_OUT_OF_MEMORY),
        Some(WorkflowErrorCode::OutOfMemory)
    );
}

#[test]
fn workflow_error_code_list_matches_serialized_names() {
    let names: Vec<String> = WorkflowErrorCode::ALL
        .iter()
        .map(|code| {
            serde_json::to_value(code)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    let unique: HashSet<&String> = names.iter().collect();
    assert_eq!(unique.len(), names.len());
    assert!(names.contains(&"CHECKSUM_MISMATCH".to_owned()));
    assert!(names.contains(&"WORKFLOW_EVENT_BUFFER_OVERFLOW".to_owned()));
    assert!(names.contains(&"OUT_OF_MEMORY".to_owned()));
    assert!(names.contains(&"STORAGE_FULL".to_owned()));
}
