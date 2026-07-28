use super::*;

impl CliApp {
    pub(super) fn format_mode_counts(mode_counts: &BTreeMap<&'static str, usize>) -> String {
        if mode_counts.is_empty() {
            return "none".to_string();
        }

        mode_counts
            .iter()
            .map(|(mode, count)| format!("{mode}:{count}"))
            .collect::<Vec<_>>()
            .join(",")
    }

    pub(super) fn probe_compress_recommendation(
        &self,
        source: &Path,
    ) -> Option<CompressFormatRecommendation> {
        if source.is_file() {
            Some(self.containers.recommend_compress_format(source))
        } else {
            None
        }
    }

    /// The rom-specific container the source should compress into, or `None` when the
    /// recommender lands on the generic 7z fallback. Gating here keeps the host free to apply
    /// its own extension heuristics for everything that is not a disc/3DS image, and is the
    /// single definition of "rom-specific" shared by the early probe-manifest event and the
    /// end-of-run per-asset stamp.
    pub(super) fn rom_specific_recommended_format(format_name: &str) -> Option<&'static str> {
        match format_name {
            "chd" => Some("chd"),
            "rvz" => Some("rvz"),
            "z3ds" => Some("z3ds"),
            _ => None,
        }
    }

    pub(super) fn append_recommended_compress_label(
        mut report: OperationReport,
        recommendation: Option<&CompressFormatRecommendation>,
    ) -> OperationReport {
        if let Some(recommendation) = recommendation {
            report.label =
                Self::append_compress_recommendation_label(&report.label, recommendation);
        }
        report
    }

    pub(super) fn attach_container_probe_details(
        mut report: OperationReport,
        listed_entries: Option<Vec<ContainerListEntry>>,
        recommendation: Option<&CompressFormatRecommendation>,
    ) -> OperationReport {
        if report.status != OperationStatus::Succeeded {
            return report;
        }

        let mut details = operation_report_details(&mut report);
        let mut container = match details.remove("container") {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };

        let entry_count = listed_entries.as_ref().map(Vec::len);
        container.insert(
            "entry_count".to_string(),
            entry_count.map_or(Value::Null, |value| json!(value)),
        );
        if let Some(entries) = listed_entries {
            container.insert(
                "entries".to_string(),
                json!(
                    entries
                        .iter()
                        .map(|entry| entry.path.clone())
                        .collect::<Vec<_>>()
                ),
            );
            container.insert(
                "entry_records".to_string(),
                json!(
                    entries
                        .iter()
                        .map(|entry| {
                            let mut record = Map::new();
                            record.insert("file_name".to_string(), json!(entry.path));
                            record.insert(
                                "size_bytes".to_string(),
                                entry.size.map_or(Value::Null, |value| json!(value)),
                            );
                            Value::Object(record)
                        })
                        .collect::<Vec<_>>()
                ),
            );
        }
        if let Some(recommendation) = recommendation {
            container.insert(
                "recommended_compress_format".to_string(),
                json!(recommendation.format_name),
            );
            container.insert("reason".to_string(), json!(recommendation.reason));
        }

        details.insert("container".to_string(), Value::Object(container));
        report.details = Some(Value::Object(details));
        report
    }

    pub(super) fn attach_patch_probe_details(mut report: OperationReport) -> OperationReport {
        if report.status != OperationStatus::Succeeded {
            return report;
        }

        let mut details = operation_report_details(&mut report);
        let mut patch = match details.remove("patch") {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };

        patch.entry("format".to_string()).or_insert_with(|| {
            report
                .format
                .as_ref()
                .map_or(Value::Null, |format| json!(format))
        });
        for field in [
            "source_size",
            "target_size",
            "source_crc32",
            "target_crc32",
            "patch_crc32",
            "record_count",
        ] {
            patch.entry(field.to_string()).or_insert(Value::Null);
        }

        details.insert("patch".to_string(), Value::Object(patch));
        report.details = Some(Value::Object(details));
        report
    }
}
