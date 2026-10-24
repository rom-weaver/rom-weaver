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
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub patches: Option<Vec<CheatPatchSnapshot>>,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CheatPatchSnapshot {
    pub bytes: Vec<u8>,
    pub format: String,
}

fn export_cheat_patches(
    rom: &[u8],
    records: &[ClassifiedCheatRecord],
    conflicts: &[CheatWriteConflict],
) -> Result<Vec<CheatPatchSnapshot>> {
    if !conflicts.is_empty() {
        return Err(RomWeaverError::Validation(
            "cannot export cheat patches with conflicting writes".to_string(),
        ));
    }
    records
        .iter()
        .map(|entry| {
            let CheatResolution::RomBakeable { writes } = &entry.resolution else {
                return Err(RomWeaverError::Validation(format!(
                    "cannot export unsupported cheat `{}`",
                    entry.record.id
                )));
            };
            let bytes =
                crate::cheats_apply::serialize_cheat_patch(writes, rom, entry.record.system)?;
            let format = if bytes.starts_with(b"IPS32") {
                "ips32"
            } else {
                "ips"
            }
            .to_string();
            Ok(CheatPatchSnapshot { bytes, format })
        })
        .collect()
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
        let fail_io = |error: std::io::Error| {
            OperationReport::failed(
                OperationFamily::Patch,
                Some("cheat".to_string()),
                "classify",
                error.to_string(),
                context.single_thread_execution(),
            )
            .with_error_kind(rom_weaver_core::RomWeaverErrorKind::Io)
        };
        let rom = match fs::read(&args.input) {
            Ok(rom) => rom,
            Err(error) => return self.finish("cheat", fail_io(error)),
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

        let patches = if args.export_patches {
            match export_cheat_patches(&rom, &classified, &conflicts) {
                Ok(patches) => Some(patches),
                Err(error) => {
                    return self.finish(
                        "cheat",
                        OperationReport::failed_with_error(
                            OperationFamily::Patch,
                            Some("cheat".to_string()),
                            "classify",
                            error,
                            context.single_thread_execution(),
                        ),
                    );
                }
            }
        } else {
            None
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
                patches,
            }
        }));
        self.finish("cheat", report)
    }
}

/// One row of `cheat list`.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Debug, Serialize)]
pub(crate) struct CheatListEntry {
    pub id: String,
    pub delivery: String,
    pub code: String,
    pub description: String,
}

/// The `cheat_list` details block, mirrored by the terminal table.
#[cfg(not(target_arch = "wasm32"))]
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
        let fail_error = |error: RomWeaverError| {
            OperationReport::failed_with_error(
                OperationFamily::Patch,
                Some("cheat".to_string()),
                "list",
                error,
                context.single_thread_execution(),
            )
        };
        let resolved = match self.resolve_cheat_selection(&args.input, &args.selection, &context) {
            Ok(resolved) => resolved,
            Err(error) => return self.finish("cheat", fail_error(error)),
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

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    use std::collections::BTreeMap;

    fn record(system: CheatSystem, code: &str, kind: CheatKind) -> CheatRecord {
        CheatRecord {
            id: code.to_string(),
            system,
            game_id: String::new(),
            description: String::new(),
            raw_code: Some(code.to_string()),
            code_kind: Some(kind),
            raw_fields: BTreeMap::new(),
            source_file: String::new(),
            source_index: 0,
            source_revision: String::new(),
        }
    }

    fn snapshots(rom: &[u8], records: &[CheatRecord]) -> Result<Vec<CheatPatchSnapshot>> {
        let classified = records
            .iter()
            .map(|record| cheats::classify_record(rom, record))
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
        export_cheat_patches(rom, &classified, &cheats::detect_write_conflicts(&writes))
    }

    #[test]
    fn classification_wire_defaults_to_no_patch_export() {
        let args: CheatCommand = serde_json::from_value(serde_json::json!({
            "input": "game.rom", "records": []
        }))
        .unwrap();
        assert!(!args.export_patches);
        let result = CheatCommandResult {
            records: Vec::new(),
            conflicts: Vec::new(),
            patches: None,
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({"records": [], "conflicts": []})
        );
    }

    #[test]
    fn export_preserves_explicit_noop_and_record_order() {
        let rom = [0u8; 0x200];
        let patches = snapshots(
            &rom,
            &[
                record(
                    CheatSystem::Genesis,
                    "000010:0000",
                    CheatKind::ProActionReplay,
                ),
                record(
                    CheatSystem::Genesis,
                    "000020:1234",
                    CheatKind::ProActionReplay,
                ),
            ],
        )
        .unwrap();
        assert_eq!(patches.len(), 2);
        assert_eq!(patches[0].format, "ips");
        assert_eq!(patches[0].bytes, b"PATCH\x00\x00\x10\x00\x02\x00\x00EOF");
        assert_eq!(patches[1].bytes, b"PATCH\x00\x00\x20\x00\x02\x12\x34EOF");
    }

    #[test]
    fn export_rejects_conflicts_and_unsupported_records() {
        let first = record(
            CheatSystem::Genesis,
            "000010:1234",
            CheatKind::ProActionReplay,
        );
        let second = record(
            CheatSystem::Genesis,
            "000010:5678",
            CheatKind::ProActionReplay,
        );
        assert!(
            snapshots(&[0; 0x200], &[first.clone(), second])
                .unwrap_err()
                .to_string()
                .contains("conflicting")
        );
        let unsupported = record(
            CheatSystem::Genesis,
            "E01234:ABCD",
            CheatKind::ProActionReplay,
        );
        assert!(
            snapshots(&[0; 0x200], &[first, unsupported])
                .unwrap_err()
                .to_string()
                .contains("unsupported")
        );
    }

    #[test]
    fn export_retains_compare_matches_in_multiple_banks() {
        let mut rom = vec![0; 0x10000];
        rom[0x4AC3] = 0x7B;
        rom[0xCAC3] = 0x7B;
        let patches = snapshots(
            &rom,
            &[record(
                CheatSystem::MasterSystem,
                "11A-C3B-0A7",
                CheatKind::GameGenie,
            )],
        )
        .unwrap();
        assert_eq!(
            patches[0].bytes,
            b"PATCH\x00\x4A\xC3\x00\x01\x11\x00\xCA\xC3\x00\x01\x11EOF"
        );
    }

    #[test]
    fn export_selects_ips32_and_little_endian_words() {
        let rom = vec![0; 0x1000002];
        let patches = snapshots(
            &rom,
            &[record(
                CheatSystem::GameBoyAdvance,
                "89000000 ABCD",
                CheatKind::Xploder,
            )],
        )
        .unwrap();
        assert_eq!(patches[0].format, "ips32");
        assert_eq!(
            patches[0].bytes,
            b"IPS32\x01\x00\x00\x00\x00\x02\xCD\xABEEOF"
        );
    }
}
