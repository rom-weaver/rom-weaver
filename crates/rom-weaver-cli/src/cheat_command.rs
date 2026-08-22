use std::{collections::BTreeMap, fs};

use rom_weaver_core::{OperationFamily, OperationReport};
use serde::Serialize;
#[cfg(feature = "typescript-types")]
use ts_rs::TS;

use super::*;

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CheatCommandResult {
    pub records: Vec<ClassifiedCheatRecord>,
    pub conflicts: Vec<CheatWriteConflict>,
    pub runtime_output: Option<PathBuf>,
}

impl CliApp {
    pub(super) fn run_cheat(&self, args: CheatCommand) -> AppRunOutcome {
        let context = self.context(ThreadBudget::default());
        let fail = |message: String| {
            OperationReport::failed(
                OperationFamily::Patch,
                Some("cheat".to_string()),
                "classify",
                message,
                context.single_thread_execution(),
            )
        };
        let rom = match fs::read(&args.input) {
            Ok(rom) => rom,
            Err(error) => return self.finish("cheat", fail(error.to_string())),
        };
        let classified = args
            .records
            .iter()
            .map(|record| crate::cheats::classify_record(&rom, record))
            .collect::<Vec<_>>();
        let writes = classified
            .iter()
            .filter_map(|entry| match &entry.resolution {
                CheatResolution::RomBakeable { writes } => {
                    Some((entry.record.id.clone(), writes.clone()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        let conflicts = crate::cheats::detect_write_conflicts(&writes);

        let runtime_output = if args.selected_ids.is_empty() {
            None
        } else {
            let Some(output) = args.output.as_ref() else {
                return self.finish(
                    "cheat",
                    fail(
                        "--output is required when selectedIds contains runtime cheats".to_string(),
                    ),
                );
            };
            let by_id = classified
                .iter()
                .map(|entry| (entry.record.id.as_str(), entry))
                .collect::<BTreeMap<_, _>>();
            let mut selected = Vec::with_capacity(args.selected_ids.len());
            for id in &args.selected_ids {
                let Some(entry) = by_id.get(id.as_str()) else {
                    return self.finish(
                        "cheat",
                        fail(format!("selected cheat ID `{id}` does not exist")),
                    );
                };
                match entry.resolution {
                    CheatResolution::Runtime { .. } | CheatResolution::Mixed { .. } => {
                        selected.push(entry.record.clone());
                    }
                    _ => {
                        return self.finish(
                            "cheat",
                            fail(format!(
                                "selected cheat ID `{id}` is not a runtime or mixed cheat"
                            )),
                        );
                    }
                }
            }
            let rendered = match crate::cheats::export_retroarch_cht(&selected) {
                Ok(rendered) => rendered,
                Err(error) => return self.finish("cheat", fail(error.to_string())),
            };
            if let Some(parent) = output
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                && let Err(error) = fs::create_dir_all(parent)
            {
                return self.finish("cheat", fail(error.to_string()));
            }
            if let Err(error) = fs::write(output, rendered.as_bytes()) {
                return self.finish("cheat", fail(error.to_string()));
            }
            Some(output.clone())
        };

        let mut report = OperationReport::succeeded(
            OperationFamily::Patch,
            Some("cheat".to_string()),
            "classify",
            format!("classified {} cheat record(s)", classified.len()),
            Some(100.0),
            context.single_thread_execution(),
        );
        report.details = Some(serde_json::json!({
            "cheats": CheatCommandResult {
                records: classified,
                conflicts,
                runtime_output,
            }
        }));
        self.finish("cheat", report)
    }
}
