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
        #[cfg(not(target_arch = "wasm32"))]
        match args.action {
            crate::CheatAction::List => return self.run_cheat_list(args),
            crate::CheatAction::Classify => {}
        }
        self.run_cheat_classify(args)
    }

    /// The JSON/WASM boundary's behaviour: classify the supplied records.
    fn run_cheat_classify(&self, args: CheatCommand) -> AppRunOutcome {
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

/// One row of `cheat list`.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct CheatListEntry {
    pub id: String,
    pub delivery: String,
    pub code: String,
    pub description: String,
}

/// The `cheat_list` details block, mirrored by the terminal table.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct CheatListDetails {
    pub system: String,
    pub match_kind: String,
    pub game_id: Option<String>,
    pub game_title: Option<String>,
    pub attribution: String,
    pub entries: Vec<CheatListEntry>,
}

#[cfg(not(target_arch = "wasm32"))]
impl CliApp {
    fn run_cheat_list(&self, args: CheatCommand) -> AppRunOutcome {
        let context = self.context(ThreadBudget::default());
        let fail = |message: String| {
            OperationReport::failed(
                OperationFamily::Patch,
                Some("cheat".to_string()),
                "list",
                message,
                context.single_thread_execution(),
            )
        };
        let resolved = match self.resolve_cheat_selection(&args.input, &args.selection, &context) {
            Ok(resolved) => resolved,
            Err(error) => return self.finish("cheat", fail(error.to_string())),
        };
        let entries = resolved
            .available
            .iter()
            .map(|entry| CheatListEntry {
                id: entry.record.id.clone(),
                delivery: crate::cheat_database::delivery_label(&entry.resolution).to_string(),
                code: entry.record.raw_code.clone().unwrap_or_default(),
                description: entry.record.description.clone(),
            })
            .collect::<Vec<_>>();
        let details = CheatListDetails {
            system: resolved.system.id().to_string(),
            match_kind: resolved
                .match_kind
                .map_or_else(String::new, |kind| kind.id().to_string()),
            game_id: resolved.game_id.clone(),
            game_title: resolved.game_title.clone(),
            attribution: crate::cheat_database::attribution(resolved.directory.as_deref()),
            entries,
        };
        let mut report = OperationReport::succeeded(
            OperationFamily::Patch,
            Some("cheat".to_string()),
            "list",
            format!(
                "{} cheat(s) for {} ({} match)",
                details.entries.len(),
                details
                    .game_title
                    .clone()
                    .unwrap_or_else(|| args.input.display().to_string()),
                details.match_kind
            ),
            Some(100.0),
            context.single_thread_execution(),
        );
        report.details = Some(serde_json::json!({ "cheat_list": details }));
        self.finish("cheat", report)
    }
}
