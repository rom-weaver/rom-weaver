//! Shared `OperationReport.details` JSON builders.
//!
//! Container extract/compression reporting in `rom-weaver-containers` and
//! the CHD handler emit the same `extraction`/thread-execution detail shapes;
//! these helpers are the single source so the JSON stays consistent across
//! crates.

use std::{collections::HashSet, fs, path::Path};

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

/// Attach the handler's complete output set so callers never scan a shared
/// directory and capture sibling-operation files. Call after checksum details;
/// existing paths are preserved and missing paths gain name and size.
/// Normalize an emitted-file path into the single shape every comparison uses.
/// Windows callers seed `emitted_files` with backslash separators while this
/// module stores forward slashes, so the two MUST be folded together before
/// they are compared or a seeded entry is duplicated.
fn emitted_path_key(path: &str) -> String {
    path.replace('\\', "/")
}

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
                .map(emitted_path_key)
        })
        .collect::<HashSet<_>>();
    for path in paths {
        let path = path.as_ref();
        let direct_key = emitted_path_key(&path.to_string_lossy());
        if seen.contains(&direct_key) {
            continue;
        }
        let Some(entry) = build_emitted_file_detail(path) else {
            continue;
        };
        let key = entry
            .get("path")
            .and_then(Value::as_str)
            .map(emitted_path_key)
            .unwrap_or_default();
        // The canonical key decides whether this is new, and the requested
        // shape is recorded afterwards so a later duplicate in either shape is
        // suppressed. Recording it first would swallow the entry whenever the
        // two shapes are identical.
        let is_new = seen.insert(key);
        seen.insert(direct_key);
        if is_new {
            emitted.push(Value::Object(entry));
        }
    }
    if !emitted.is_empty() {
        details.insert("emitted_files".to_string(), Value::Array(emitted));
    }
    report.details = Some(Value::Object(details));
    report
}

/// Build the common path, file-name, and size fields for an emitted file.
/// Format-specific callers may append checksums, identity, timing, or kind.
pub fn build_emitted_file_detail(path: &Path) -> Option<Map<String, Value>> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    build_known_emitted_file_detail(path, metadata.len())
}

/// Build emitted-file details when the successful producer already knows the
/// output size, avoiding a redundant metadata read.
pub fn build_known_emitted_file_detail(path: &Path, size_bytes: u64) -> Option<Map<String, Value>> {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let file_name = canonical.file_name()?.to_string_lossy().into_owned();
    let mut entry = Map::new();
    entry.insert(
        "path".to_string(),
        json!(emitted_path_key(&canonical.to_string_lossy())),
    );
    entry.insert("file_name".to_string(), json!(file_name));
    entry.insert("size_bytes".to_string(), json!(size_bytes));
    Some(entry)
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

#[cfg(test)]
mod tests {
    use assert_fs::{TempDir, prelude::*};

    use super::*;

    #[test]
    fn emitted_file_detail_has_the_shared_base_fields() {
        let temp = TempDir::new().expect("temp dir");
        let output = temp.child("output.bin");
        output.write_binary(b"rom").expect("fixture");

        let detail = build_emitted_file_detail(output.path()).expect("file detail");

        assert_eq!(detail.get("file_name"), Some(&json!("output.bin")));
        assert_eq!(detail.get("size_bytes"), Some(&json!(3)));
        assert!(
            detail
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|path| path.ends_with("/output.bin"))
        );
        assert!(build_emitted_file_detail(temp.path()).is_none());
    }

    #[test]
    fn known_emitted_file_detail_needs_no_metadata_read() {
        let temp = TempDir::new().expect("temp dir");
        let missing = temp.child("already-produced.bin");

        let detail =
            build_known_emitted_file_detail(missing.path(), 42).expect("known file detail");

        assert_eq!(
            detail.get("file_name"),
            Some(&json!("already-produced.bin"))
        );
        assert_eq!(detail.get("size_bytes"), Some(&json!(42)));
    }

    #[test]
    fn operation_report_details_preserves_only_existing_objects() {
        let mut report = OperationReport::succeeded(
            crate::OperationFamily::Patch,
            Some("test".to_string()),
            "apply",
            "done",
            Some(100.0),
            None,
        );
        report.details = Some(json!({"checksum": "abc123"}));
        let details = operation_report_details(&mut report);
        assert_eq!(details.get("checksum"), Some(&json!("abc123")));
        assert!(report.details.is_none());

        report.details = Some(json!(["not an object"]));
        assert!(operation_report_details(&mut report).is_empty());
    }

    #[test]
    fn thread_execution_details_include_an_optional_fallback_reason() {
        let execution = ThreadExecution {
            requested_threads: 8,
            effective_threads: 2,
            thread_mode: crate::ThreadMode::Fixed,
            used_parallelism: false,
            thread_fallback: true,
            thread_fallback_reason: Some("pool unavailable".to_string()),
        };
        let mut details = Map::new();
        insert_thread_execution_details(&mut details, &execution);
        assert_eq!(details.get("requested_threads"), Some(&json!(8)));
        assert_eq!(details.get("effective_threads"), Some(&json!(2)));
        assert_eq!(details.get("thread_mode"), Some(&json!("fixed")));
        assert_eq!(details.get("used_parallelism"), Some(&json!(false)));
        assert_eq!(details.get("thread_fallback"), Some(&json!(true)));
        assert_eq!(
            details.get("thread_fallback_reason"),
            Some(&json!("pool unavailable"))
        );

        let no_reason = ThreadExecution {
            thread_fallback_reason: None,
            ..execution
        };
        let mut details = Map::new();
        insert_thread_execution_details(&mut details, &no_reason);
        assert!(!details.contains_key("thread_fallback_reason"));
    }

    #[test]
    fn attach_emitted_file_paths_folds_backslash_separators_into_one_key() {
        // A Windows caller seeds the path with backslashes while this module
        // stores forward slashes. Without folding the two shapes the seeded
        // entry is duplicated, which only ever failed on Windows.
        let temp = TempDir::new().expect("temp dir");
        let existing = temp.child("existing.bin");
        existing.write_binary(b"old").expect("existing fixture");

        let seeded = existing.path().to_string_lossy().replace('/', "\\");
        let mut report = OperationReport::succeeded(
            crate::OperationFamily::Container,
            Some("test".to_string()),
            "extract",
            "done",
            Some(100.0),
            None,
        );
        report.details = Some(json!({
            "emitted_files": [{"path": seeded, "kind": "rom"}]
        }));

        let report = attach_emitted_file_paths(report, &[existing.path()]);
        let emitted = report
            .details
            .expect("details")
            .get("emitted_files")
            .and_then(Value::as_array)
            .cloned()
            .expect("emitted files");
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].get("kind"), Some(&json!("rom")));
    }

    #[test]
    fn emitted_path_key_folds_a_windows_drive_letter_path() {
        // The shape the Windows CI job actually produces: a drive letter and
        // backslash separators. Only the separators are rewritten - the drive
        // letter and its colon MUST survive, or the path stops naming the file.
        assert_eq!(
            emitted_path_key("D:\\a\\rom-weaver\\out\\game.nes"),
            "D:/a/rom-weaver/out/game.nes"
        );
        // A path already in the stored shape is left exactly as it is.
        assert_eq!(
            emitted_path_key("D:/a/rom-weaver/out/game.nes"),
            "D:/a/rom-weaver/out/game.nes"
        );
        // A posix path never contains a backslash separator to rewrite.
        assert_eq!(emitted_path_key("/tmp/out/game.nes"), "/tmp/out/game.nes");
    }

    #[test]
    fn attach_emitted_file_paths_matches_a_seeded_windows_path_against_the_stored_shape() {
        // Both shapes of the same file MUST collapse to one entry: the seeded
        // Windows path and the forward-slash path this module stores.
        let temp = TempDir::new().expect("temp dir");
        let emitted = temp.child("emitted.bin");
        emitted.write_binary(b"data").expect("emitted fixture");

        let stored = emitted.path().to_string_lossy().replace('\\', "/");
        let seeded = stored.replace('/', "\\");
        assert_ne!(stored, seeded, "the two shapes must actually differ");

        let mut report = OperationReport::succeeded(
            crate::OperationFamily::Container,
            Some("test".to_string()),
            "extract",
            "done",
            Some(100.0),
            None,
        );
        report.details = Some(json!({
            "emitted_files": [{"path": seeded, "kind": "rom"}]
        }));

        // Attaching the same file twice must not add it either time.
        let report = attach_emitted_file_paths(report, &[emitted.path()]);
        let report = attach_emitted_file_paths(report, &[emitted.path()]);
        let entries = report
            .details
            .expect("details")
            .get("emitted_files")
            .and_then(Value::as_array)
            .cloned()
            .expect("emitted files");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].get("kind"), Some(&json!("rom")));
    }

    #[test]
    fn attach_emitted_file_paths_deduplicates_and_skips_non_files() {
        let temp = TempDir::new().expect("temp dir");
        let existing = temp.child("existing.bin");
        existing.write_binary(b"old").expect("existing fixture");
        let added = temp.child("added.bin");
        added.write_binary(b"new data").expect("added fixture");

        let mut report = OperationReport::succeeded(
            crate::OperationFamily::Container,
            Some("test".to_string()),
            "extract",
            "done",
            Some(100.0),
            None,
        );
        report.details = Some(json!({
            "checksum": {"sha1": "seeded"},
            "emitted_files": [{"path": existing.path().to_string_lossy(), "kind": "rom"}]
        }));
        let missing = temp.child("missing.bin");
        let report = attach_emitted_file_paths(
            report,
            &[existing.path(), added.path(), temp.path(), missing.path()],
        );

        let details = report.details.expect("details");
        assert_eq!(details.get("checksum"), Some(&json!({"sha1": "seeded"})));
        let emitted = details
            .get("emitted_files")
            .and_then(Value::as_array)
            .expect("emitted files");
        assert_eq!(emitted.len(), 2);
        assert_eq!(emitted[0].get("kind"), Some(&json!("rom")));
        assert_eq!(emitted[1].get("file_name"), Some(&json!("added.bin")));

        let failed = OperationReport::failed(
            crate::OperationFamily::Container,
            Some("test".to_string()),
            "extract",
            "failed",
            None,
        );
        assert!(
            attach_emitted_file_paths(failed, &[added.path()])
                .details
                .is_none()
        );
    }

    #[test]
    fn attach_extraction_details_preserves_existing_fields_and_thread_data() {
        let mut report = OperationReport::succeeded(
            crate::OperationFamily::Container,
            Some("test".to_string()),
            "extract",
            "done",
            Some(100.0),
            None,
        );
        report.details = Some(json!({"checksum": {"crc32": "deadbeef"}}));
        let execution = ThreadExecution {
            requested_threads: 4,
            effective_threads: 4,
            thread_mode: crate::ThreadMode::Fixed,
            used_parallelism: true,
            thread_fallback: false,
            thread_fallback_reason: None,
        };
        let report = attach_extraction_details(report, 7, 3, 4096, &execution);
        let details = report.details.expect("details");
        assert_eq!(details.get("checksum"), Some(&json!({"crc32": "deadbeef"})));
        assert_eq!(
            details.get("extraction"),
            Some(&json!({
                "entries": 7,
                "files": 3,
                "written_bytes": 4096,
                "requested_threads": 4,
                "effective_threads": 4,
                "thread_mode": "fixed",
                "used_parallelism": true,
                "thread_fallback": false
            }))
        );
    }
}
