use std::fs;

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
                    Some((entry.record.id.clone(), entry.record.system, writes.clone()))
                }
                CheatResolution::Unsupported { .. } => None,
            })
            .collect::<Vec<_>>();
        let conflicts = crate::cheats::detect_write_conflicts(&writes);

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
            }
        }));
        self.finish("cheat", report)
    }
}
