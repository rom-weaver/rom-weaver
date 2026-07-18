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
        let mut details = operation_report_details(&mut report);
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
        let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let mut entry = rom_weaver_core::build_emitted_file_detail(path)?;
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
        // Directory portion of an emitted file's path, normalized to forward slashes.
        let dir_key = |path: &str| -> String {
            Path::new(path)
                .parent()
                .map(|parent| parent.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default()
        };
        // Map (directory, basename) → leaf index. Keying on the emitting directory as well as the
        // basename keeps a multi-disc archive's repeated `track01.bin` entries distinct, so a sheet
        // annotates only the tracks in its own directory instead of whichever leaf was seen last.
        let index_by_dir_name: std::collections::HashMap<(String, String), usize> = leaves
            .iter()
            .enumerate()
            .filter_map(|(index, leaf)| {
                let map = leaf.as_object()?;
                let path = map.get("path").and_then(Value::as_str)?;
                let name = map.get("file_name").and_then(Value::as_str)?;
                Some(((dir_key(path), base_name(name)), index))
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
            let sheet_dir = dir_key(path);
            let tracks = refs
                .referenced_files
                .iter()
                .enumerate()
                .filter_map(|(order, reference)| {
                    // References are relative to the sheet's directory and may include a
                    // subdirectory; resolve that against the sheet's directory so the
                    // (dir, basename) key matches the track leaf sitting beside the sheet.
                    let reference_dir = match Path::new(reference).parent() {
                        Some(parent) if !parent.as_os_str().is_empty() => Path::new(&sheet_dir)
                            .join(parent)
                            .to_string_lossy()
                            .replace('\\', "/"),
                        _ => sheet_dir.clone(),
                    };
                    index_by_dir_name
                        .get(&(reference_dir, base_name(reference)))
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

#[cfg(test)]
mod disc_group_tests {
    use serde_json::{Value, json};

    use super::CliApp;

    #[test]
    fn multi_disc_tracks_with_same_basename_are_scoped_by_directory() {
        // Two discs whose data tracks share the basename `track01.bin`. The
        // annotation map keys on directory + basename, so each sheet annotates
        // only the track sitting beside it - never the other disc's track.
        let base = std::env::temp_dir().join(format!(
            "rw-disc-group-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        let disc1 = base.join("disc1");
        let disc2 = base.join("disc2");
        std::fs::create_dir_all(&disc1).expect("disc1 dir");
        std::fs::create_dir_all(&disc2).expect("disc2 dir");
        let cue_text =
            "FILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n";
        std::fs::write(disc1.join("game1.cue"), cue_text).expect("disc1 cue");
        std::fs::write(disc2.join("game2.cue"), cue_text).expect("disc2 cue");

        let leaf = |path: std::path::PathBuf, file_name: &str| -> Value {
            json!({
                "path": path.to_string_lossy().replace('\\', "/"),
                "file_name": file_name,
            })
        };
        let leaves = vec![
            leaf(disc1.join("game1.cue"), "game1.cue"),
            leaf(disc1.join("track01.bin"), "track01.bin"),
            leaf(disc2.join("game2.cue"), "game2.cue"),
            leaf(disc2.join("track01.bin"), "track01.bin"),
        ];

        let annotated = CliApp::attach_disc_group_details(leaves);

        assert_eq!(annotated[1]["disc_group_id"].as_str(), Some("game1.cue"));
        assert_eq!(annotated[1]["track_number"], 1);
        assert_eq!(annotated[3]["disc_group_id"].as_str(), Some("game2.cue"));
        assert_eq!(annotated[3]["track_number"], 1);

        let _ = std::fs::remove_dir_all(&base);
    }
}
