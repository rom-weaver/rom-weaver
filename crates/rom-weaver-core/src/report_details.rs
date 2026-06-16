//! Shared `OperationReport.details` JSON builders.
//!
//! Container extract/compression reporting in `rom-weaver-containers` and
//! `rom-weaver-chd` emit the same `extraction`/thread-execution detail shapes;
//! these helpers are the single source so the JSON stays consistent across
//! crates.

use std::{fs, path::Path};

use serde_json::{Map, Value, json};

use crate::{OperationReport, OperationStatus, ThreadExecution};

/// Take the report's existing `details` object (or an empty map) so callers can
/// extend it without clobbering prior keys.
pub fn operation_report_details(report: &mut OperationReport) -> Map<String, Value> {
    match report.details.take() {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Insert the flattened thread-execution fields shared by the `extraction` and
/// `compression` detail blocks.
pub fn insert_thread_execution_details(
    details: &mut Map<String, Value>,
    execution: &ThreadExecution,
) {
    details.insert(
        "requested_threads".to_string(),
        json!(execution.requested_threads),
    );
    details.insert(
        "effective_threads".to_string(),
        json!(execution.effective_threads),
    );
    details.insert("thread_mode".to_string(), json!(execution.thread_mode));
    details.insert(
        "used_parallelism".to_string(),
        json!(execution.used_parallelism),
    );
    details.insert(
        "thread_fallback".to_string(),
        json!(execution.thread_fallback),
    );
    if let Some(reason) = &execution.thread_fallback_reason {
        details.insert("thread_fallback_reason".to_string(), json!(reason));
    }
}

/// Record the full set of files an extract wrote into `report.details["emitted_files"]` as path-only
/// entries, so the app can treat the handler's report as the authoritative output set rather than
/// inferring outputs from a filesystem scan of the (possibly shared) out dir — a scan that, under
/// concurrent extracts into one dir, also picks up a sibling op's freshly-written files. Call this
/// AFTER any checksum-detail attach: paths already reported (with their checksums) are skipped, and the
/// rest are appended as `{path, file_name, size_bytes}` (the app re-derives kind and merges checksums by
/// path). Every container handler must pass its COMPLETE output set here.
pub fn attach_emitted_file_paths<P: AsRef<Path>>(
    mut report: OperationReport,
    paths: &[P],
) -> OperationReport {
    if report.status != OperationStatus::Succeeded || paths.is_empty() {
        return report;
    }
    let mut details = operation_report_details(&mut report);
    let mut emitted = match details.remove("emitted_files") {
        Some(Value::Array(entries)) => entries,
        _ => Vec::new(),
    };
    let mut seen = emitted
        .iter()
        .filter_map(|entry| {
            entry
                .as_object()
                .and_then(|map| map.get("path"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    for path in paths {
        let Some(entry) = build_emitted_file_path_detail(path.as_ref()) else {
            continue;
        };
        let key = entry
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_default();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        emitted.push(entry);
    }
    if !emitted.is_empty() {
        details.insert("emitted_files".to_string(), Value::Array(emitted));
    }
    report.details = Some(Value::Object(details));
    report
}

fn build_emitted_file_path_detail(path: &Path) -> Option<Value> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let file_name = canonical.file_name()?.to_string_lossy().into_owned();
    let mut entry = Map::new();
    entry.insert(
        "path".to_string(),
        json!(canonical.to_string_lossy().replace('\\', "/")),
    );
    entry.insert("file_name".to_string(), json!(file_name));
    entry.insert("size_bytes".to_string(), json!(metadata.len()));
    Some(Value::Object(entry))
}

/// Attach an `extraction` detail block (entry/file/byte counts + thread
/// execution) to an extract report.
pub fn attach_extraction_details(
    mut report: OperationReport,
    entry_count: usize,
    file_count: usize,
    written_bytes: u64,
    execution: &ThreadExecution,
) -> OperationReport {
    let mut details = operation_report_details(&mut report);
    let mut extraction = Map::new();
    extraction.insert("entries".to_string(), json!(entry_count));
    extraction.insert("files".to_string(), json!(file_count));
    extraction.insert("written_bytes".to_string(), json!(written_bytes));
    insert_thread_execution_details(&mut extraction, execution);
    details.insert("extraction".to_string(), Value::Object(extraction));
    report.details = Some(Value::Object(details));
    report
}
