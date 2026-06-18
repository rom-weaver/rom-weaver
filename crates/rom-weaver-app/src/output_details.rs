use super::*;

pub(super) const EMITTED_ARCHIVE_EXTENSIONS: &[&str] = &[
    ".7z", ".zip", ".zipx", ".tar", ".tgz", ".tar.gz", ".tbz2", ".tar.bz2", ".txz", ".tar.xz",
    ".zst", ".zstd", ".gz", ".bz2", ".xz", ".chd", ".rvz", ".gcz", ".wbfs", ".wia", ".cso",
    ".ciso", ".rar", ".pbp", ".z3d", ".z3ds",
];
pub(super) const EMITTED_ROM_EXTENSIONS: &[&str] = &[
    ".iso", ".img", ".bin", ".gdi", ".nds", ".dsi", ".srl", ".gba", ".3ds", ".3dsx", ".app",
    ".cci", ".cia", ".cxi", ".n64", ".z64", ".v64", ".nes", ".fds", ".sfc", ".smc", ".gen", ".md",
    ".gb", ".gbc", ".pce", ".a78", ".lnx", ".msx",
];

impl CliApp {
    pub(super) fn attach_emitted_files_details(
        report: OperationReport,
        emitted_files: Vec<PathBuf>,
        default_kind: Option<&str>,
    ) -> OperationReport {
        if report.status != OperationStatus::Succeeded {
            return report;
        }
        let emitted = Self::build_emitted_file_detail_values(
            report.details.as_ref(),
            &emitted_files,
            default_kind,
        );
        Self::set_emitted_files_detail(report, emitted)
    }

    /// Builds the `emitted_files` detail objects for the given paths, merging in any checksum (or
    /// other) fields already present for the same path in `report_details`. Used both by the
    /// single-level attach and by the nested descent, which captures each level's outputs.
    pub(super) fn build_emitted_file_detail_values(
        report_details: Option<&Value>,
        emitted_files: &[PathBuf],
        default_kind: Option<&str>,
    ) -> Vec<Value> {
        let existing = match report_details {
            Some(Value::Object(map)) => match map.get("emitted_files") {
                Some(Value::Array(entries)) => entries
                    .iter()
                    .filter_map(|entry| match entry {
                        Value::Object(map) => {
                            let key = Self::emitted_file_detail_key(map)?;
                            Some((key, map.clone()))
                        }
                        _ => None,
                    })
                    .collect::<BTreeMap<_, _>>(),
                _ => BTreeMap::new(),
            },
            _ => BTreeMap::new(),
        };
        emitted_files
            .iter()
            .filter_map(|path| {
                let mut detail = match Self::build_emitted_file_detail(path, default_kind)? {
                    Value::Object(map) => map,
                    _ => return None,
                };
                if let Some(extra) = existing.get(&Self::normalized_emitted_path_key(path)) {
                    for (key, value) in extra {
                        detail.entry(key.clone()).or_insert_with(|| value.clone());
                    }
                }
                Some(Value::Object(detail))
            })
            .collect::<Vec<_>>()
    }

    pub(super) fn build_or_existing_emitted_file_detail_values(
        report_details: Option<&Value>,
        emitted_files: &[PathBuf],
        default_kind: Option<&str>,
    ) -> Vec<Value> {
        let emitted =
            Self::build_emitted_file_detail_values(report_details, emitted_files, default_kind);
        if emitted.is_empty() {
            Self::existing_emitted_file_detail_values(report_details)
        } else {
            emitted
        }
    }

    pub(super) fn existing_emitted_file_detail_values(
        report_details: Option<&Value>,
    ) -> Vec<Value> {
        match report_details {
            Some(Value::Object(map)) => match map.get("emitted_files") {
                Some(Value::Array(entries)) => entries
                    .iter()
                    .filter_map(|entry| match entry {
                        Value::Object(map) if Self::emitted_file_detail_key(map).is_some() => {
                            Some(entry.clone())
                        }
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    pub(super) fn emitted_file_detail_paths(report_details: Option<&Value>) -> Vec<PathBuf> {
        match report_details {
            Some(Value::Object(map)) => match map.get("emitted_files") {
                Some(Value::Array(entries)) => entries
                    .iter()
                    .filter_map(|entry| match entry {
                        Value::Object(map) => map.get("path").and_then(Value::as_str),
                        _ => None,
                    })
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .map(PathBuf::from)
                    .collect(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// Replaces the report's `emitted_files` detail with the given pre-built objects, preserving any
    /// other detail keys already present.
    pub(super) fn set_emitted_files_detail(
        mut report: OperationReport,
        emitted: Vec<Value>,
    ) -> OperationReport {
        let mut details = match report.details.take() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        details.insert("emitted_files".to_string(), Value::Array(emitted));
        report.details = Some(Value::Object(details));
        report
    }

    pub(super) fn emitted_file_detail_key(entry: &Map<String, Value>) -> Option<String> {
        entry
            .get("path")
            .and_then(Value::as_str)
            .map(Self::normalize_emitted_path_string)
    }

    pub(super) fn normalized_emitted_path_key(path: &Path) -> String {
        let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        Self::normalize_emitted_path_string(&canonical.to_string_lossy())
    }

    pub(super) fn normalize_emitted_path_string(path: &str) -> String {
        path.replace('\\', "/")
    }

    pub(super) fn build_emitted_file_detail(
        path: &Path,
        default_kind: Option<&str>,
    ) -> Option<Value> {
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
        if let Some(kind) = Self::infer_emitted_file_kind(&canonical).or(default_kind) {
            entry.insert("kind".to_string(), json!(kind));
        }
        Some(Value::Object(entry))
    }

    /// Annotate the leaf `emitted_files` with disc-group structure so the host can render a
    /// multi-track disc as one card without parsing the sheet itself: each `.cue`/`.gdi` sheet
    /// gets its full text (`cue_text`/`gdi_text`) and a `disc_group_id`, and every referenced
    /// track gets the same `disc_group_id` plus its 1-based `track_number`. Non-disc outputs are
    /// untouched. Sheet/ref resolution reuses the core disc-sheet parser, so it matches the
    /// grouping the selection resolver already applies.
    pub(super) fn attach_disc_group_details(mut leaves: Vec<Value>) -> Vec<Value> {
        let base_name = |name: &str| -> String {
            Path::new(name)
                .file_name()
                .map(|file| file.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_else(|| name.to_ascii_lowercase())
        };
        // Map every leaf's basename → its index, so a sheet's referenced files resolve to the
        // emitted track entries to annotate.
        let index_by_name: std::collections::HashMap<String, usize> = leaves
            .iter()
            .enumerate()
            .filter_map(|(index, leaf)| {
                let name = leaf.as_object()?.get("file_name")?.as_str()?;
                Some((base_name(name), index))
            })
            .collect();

        struct DiscGroupPlan {
            sheet_index: usize,
            sheet_text_key: &'static str,
            sheet_text: String,
            group_id: String,
            tracks: Vec<(usize, usize)>,
        }

        let mut plans = Vec::new();
        for (index, leaf) in leaves.iter().enumerate() {
            let Some(map) = leaf.as_object() else {
                continue;
            };
            let Some(path) = map.get("path").and_then(Value::as_str) else {
                continue;
            };
            let sheet_path = Path::new(path);
            let Some(kind) = detect_disc_sheet(sheet_path) else {
                continue;
            };
            let (Ok(refs), Ok(text)) = (
                enumerate_disc_sheet_refs(sheet_path),
                std::fs::read_to_string(sheet_path),
            ) else {
                continue;
            };
            let group_id = map
                .get("file_name")
                .and_then(Value::as_str)
                .unwrap_or(path)
                .to_string();
            let tracks = refs
                .referenced_files
                .iter()
                .enumerate()
                .filter_map(|(order, reference)| {
                    index_by_name
                        .get(&base_name(reference))
                        .map(|&track_index| (track_index, order + 1))
                })
                .collect::<Vec<_>>();
            plans.push(DiscGroupPlan {
                sheet_index: index,
                sheet_text_key: match kind {
                    DiscSheetKind::Cue => "cue_text",
                    DiscSheetKind::Gdi => "gdi_text",
                },
                sheet_text: text,
                group_id,
                tracks,
            });
        }

        for plan in plans {
            if let Some(map) = leaves[plan.sheet_index].as_object_mut() {
                map.insert("disc_group_id".to_string(), json!(plan.group_id));
                map.insert(plan.sheet_text_key.to_string(), json!(plan.sheet_text));
            }
            for (track_index, track_number) in plan.tracks {
                if let Some(map) = leaves[track_index].as_object_mut() {
                    map.insert("disc_group_id".to_string(), json!(plan.group_id));
                    map.insert("track_number".to_string(), json!(track_number));
                }
            }
        }
        leaves
    }

    pub(super) fn infer_emitted_file_kind(path: &Path) -> Option<&'static str> {
        let file_name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
        if file_name.ends_with(".cue") {
            return Some("cue");
        }
        if file_name.ends_with(".bin") {
            return Some("bin");
        }
        if EMITTED_ARCHIVE_EXTENSIONS
            .iter()
            .any(|extension| file_name.ends_with(extension))
        {
            return Some("archive");
        }
        if EMITTED_ROM_EXTENSIONS
            .iter()
            .any(|extension| file_name.ends_with(extension))
        {
            return Some("rom");
        }
        None
    }
}

#[cfg(test)]
mod emitted_files_tests {
    use serde_json::json;

    use super::CliApp;

    #[test]
    fn reported_emitted_paths_are_read_from_report_details() {
        // Handlers report their full output set here; the extract command now trusts it verbatim
        // (no out_dir scan) so a sibling op's file in a shared out dir can never join the set.
        let details = json!({
            "emitted_files": [
                { "path": "/work/disc.cue" },
                { "path": "/work/track01.bin" },
                { "path": "" },
                { "not_a_path": true },
            ]
        });
        let reported = CliApp::emitted_file_detail_paths(Some(&details));
        assert_eq!(
            reported,
            vec![
                std::path::PathBuf::from("/work/disc.cue"),
                std::path::PathBuf::from("/work/track01.bin"),
            ]
        );
    }

    #[test]
    fn missing_emitted_files_detail_reports_nothing() {
        assert!(CliApp::emitted_file_detail_paths(None).is_empty());
        assert!(CliApp::emitted_file_detail_paths(Some(&json!({}))).is_empty());
    }
}
