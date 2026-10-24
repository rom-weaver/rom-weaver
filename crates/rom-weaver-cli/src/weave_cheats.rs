//! Weave cheat entries: recording a `--cheat` selection into a weave, and
//! resolving a weave's `cheats` array back into cheat records at apply time.

use std::path::Path;

use rom_weaver_core::{OperationContext, Result, RomWeaverError, ValidationCodeError};
use tracing::{debug, trace};

use crate::{
    CliApp, WeaveCheatEntry,
    cheat_database::{self},
    cheat_resolution::ResolvedCheats,
    cheats::{self, CheatRecord, CheatSystem},
    command_args::CheatSelectionArgs,
};

/// The command that installs the local cheat database, named by every error
/// that needs it.
const SETUP_COMMAND: &str = "rom-weaver setup";

/// A weave's `cheats` array, resolved against the input ROM.
#[derive(Debug, Default)]
pub(crate) struct ResolvedWeaveCheats {
    /// Baked into the ROM after the patch chain, in weave order.
    pub rom_records: Vec<CheatRecord>,
    /// The optional entries that could not be resolved.
    pub skipped: Vec<SkippedWeaveCheat>,
}

/// An optional weave cheat that was left out, and why. The index identifies
/// the entry: two entries may legitimately share an id.
#[derive(Debug)]
pub(crate) struct SkippedWeaveCheat {
    pub index: usize,
    pub id: String,
    pub reason: String,
}

impl std::fmt::Display for SkippedWeaveCheat {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} ({})", self.id, self.reason)
    }
}

impl ResolvedCheats {
    /// The selection as weave entries, in selection order. With no selectors
    /// the whole matched game is recorded, which is what the commands act on.
    /// Only bakeable entries are recorded; callers reject the rest first.
    pub(crate) fn weave_cheat_entries(&self, selectors: &[String]) -> Vec<WeaveCheatEntry> {
        let source = self.directory.as_deref().map(cheat_database::source_name);
        let selected = if selectors.is_empty() {
            &self.available
        } else {
            &self.selected
        };
        selected
            .iter()
            .filter(|entry| cheat_database::is_rom_bakeable(entry))
            .map(|entry| WeaveCheatEntry {
                id: entry.record.id.clone(),
                source: source.clone(),
                revision: Some(entry.record.source_revision.clone()),
                description: Some(entry.record.description.clone()),
                // The snapshot lets the entry apply without the database.
                code: entry.record.raw_code.clone(),
                code_kind: entry.record.code_kind,
                optional: false,
            })
            .collect()
    }
}

impl CliApp {
    /// Resolve a weave's cheat entries against `rom_path`: by ID through the
    /// local cheat database when it holds the record, otherwise from the
    /// entry's own `code` snapshot. An entry that resolves to nothing, or that
    /// this ROM's bytes cannot bake, fails the apply unless it is `optional`.
    pub(crate) fn resolve_weave_cheats(
        &self,
        rom_path: &Path,
        entries: &[WeaveCheatEntry],
        args: &CheatSelectionArgs,
        context: &OperationContext,
    ) -> Result<ResolvedWeaveCheats> {
        let system =
            self.cheat_system_for(rom_path, args.cheat_system.as_deref(), "--cheat-system")?;
        let rom = std::fs::read(rom_path)?;
        // The database is optional: ROM entries carrying a code snapshot still
        // apply without it, so a load failure is only reported by the entries
        // that actually needed it.
        let (candidates, database_error) =
            match self.weave_cheat_candidates(rom_path, args, context) {
                Ok(records) => (records, None),
                Err(error) => (Vec::new(), Some(error.to_string())),
            };
        trace!(
            rom = %rom_path.display(),
            system = system.id(),
            entries = entries.len(),
            candidates = candidates.len(),
            database_error = ?database_error,
            "resolving weave cheats"
        );
        let mut resolved = ResolvedWeaveCheats::default();
        for (index, entry) in entries.iter().enumerate() {
            let outcome = Self::weave_cheat_record(
                entry,
                &candidates,
                database_error.as_deref(),
                system,
                index,
            )
            .and_then(|record| {
                let classified = cheats::classify_record(&rom, &record);
                if cheat_database::is_rom_bakeable(&classified) {
                    return Ok(record);
                }
                Err(RomWeaverError::ValidationCode(
                    ValidationCodeError::new("weave_cheat_not_bakeable")
                        .with_message("this ROM's bytes do not let the bundled cheat bake")
                        .with_field("entry", format!("cheats[{index}]"))
                        .with_field("cheat_id", entry.id.clone())
                        .with_field(
                            "actual",
                            cheat_database::delivery_label(&classified.resolution),
                        ),
                ))
            });
            match outcome {
                Ok(record) => resolved.rom_records.push(record),
                Err(error) if entry.optional => {
                    debug!(cheat = %entry.id, %error, "skipping an optional weave cheat");
                    resolved.skipped.push(SkippedWeaveCheat {
                        index,
                        id: entry.id.clone(),
                        reason: error.to_string(),
                    });
                }
                Err(error) => return Err(error),
            }
        }
        debug!(
            rom_cheats = resolved.rom_records.len(),
            skipped = resolved.skipped.len(),
            "resolved weave cheats"
        );
        Ok(resolved)
    }

    /// The database records a weave's entries can be looked up in: the shard
    /// game matched for `rom_path`.
    fn weave_cheat_candidates(
        &self,
        rom_path: &Path,
        args: &CheatSelectionArgs,
        context: &OperationContext,
    ) -> Result<Vec<CheatRecord>> {
        // Reuse the whole selector pipeline with no selectors, so game
        // matching (`--game`, checksum, title) stays single-sourced.
        let lookup = CheatSelectionArgs {
            cheats: Vec::new(),
            ..args.clone()
        };
        let resolved = self.resolve_cheat_selection(rom_path, &lookup, context)?;
        Ok(resolved
            .available
            .into_iter()
            .map(|entry| entry.record)
            .collect())
    }

    /// One weave entry's record: the database hit, else the `code` snapshot.
    fn weave_cheat_record(
        entry: &WeaveCheatEntry,
        candidates: &[CheatRecord],
        database_error: Option<&str>,
        system: CheatSystem,
        index: usize,
    ) -> Result<CheatRecord> {
        if !candidates.is_empty() {
            match cheat_database::resolve_selectors(candidates, std::slice::from_ref(&entry.id)) {
                Ok(found) => {
                    if let Some(mut record) = found.into_iter().next() {
                        record.code_kind = record.code_kind.or(entry.code_kind);
                        return Ok(record);
                    }
                }
                // An ID that now names several records is never resolved by
                // guessing; the snapshot does not make the choice safe either.
                Err(error) if is_ambiguous_selector(&error) => return Err(error),
                Err(error) => {
                    trace!(cheat = %entry.id, %error, "weave cheat is not in the database");
                }
            }
        }
        let snapshot = entry
            .code
            .as_deref()
            .map(str::trim)
            .filter(|code| !code.is_empty());
        match snapshot {
            Some(code) => Ok(snapshot_record(entry, code, system, index)),
            None => Err(missing_record_error(
                entry,
                index,
                database_error,
                "the weave carries no `code` snapshot for it",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cheats::CheatKind;

    #[test]
    fn snapshot_record_keeps_explicit_decoder_without_database() {
        let entry = WeaveCheatEntry {
            id: "rocky-snapshot".to_string(),
            source: None,
            revision: None,
            description: None,
            code: Some("12345678".to_string()),
            code_kind: Some(CheatKind::ProActionRocky),
            optional: false,
        };

        let record = snapshot_record(&entry, "12345678", CheatSystem::Nes, 0);

        assert_eq!(record.code_kind, Some(CheatKind::ProActionRocky));
    }

    #[test]
    fn weave_decoder_fills_missing_database_kind() {
        let entry = WeaveCheatEntry {
            id: "gba-snapshot".to_string(),
            source: None,
            revision: None,
            description: None,
            code: None,
            code_kind: Some(CheatKind::ActionReplayV3),
            optional: false,
        };
        let candidate = CheatRecord {
            id: entry.id.clone(),
            system: CheatSystem::GameBoyAdvance,
            game_id: "game".to_string(),
            description: "Patch".to_string(),
            raw_code: Some("code".to_string()),
            code_kind: None,
            raw_fields: Default::default(),
            source_file: "database".to_string(),
            source_index: 0,
            source_revision: "revision".to_string(),
        };

        let record =
            CliApp::weave_cheat_record(&entry, &[candidate], None, CheatSystem::GameBoyAdvance, 0)
                .unwrap();

        assert_eq!(record.code_kind, Some(CheatKind::ActionReplayV3));
    }

    #[test]
    fn legacy_snapshot_without_decoder_stays_backward_compatible() {
        let entry: WeaveCheatEntry =
            serde_json::from_str(r#"{"id":"legacy","code":"AKE-LVS"}"#).unwrap();

        assert_eq!(entry.code_kind, None);
        let record = snapshot_record(&entry, "AKE-LVS", CheatSystem::Nes, 0);
        assert_eq!(record.code_kind, None);
    }

    #[test]
    fn serializes_decoder_as_camel_case_code_kind() {
        let entry = WeaveCheatEntry {
            id: "gba-snapshot".to_string(),
            source: None,
            revision: None,
            description: None,
            code: Some("CDE69477 3E02C83D".to_string()),
            code_kind: Some(CheatKind::GameSharkV1),
            optional: false,
        };

        let json = serde_json::to_value(entry).unwrap();
        assert_eq!(json["codeKind"], "game-shark-v1");
        assert!(json.get("code_kind").is_none());
    }
}

fn is_ambiguous_selector(error: &RomWeaverError) -> bool {
    matches!(error, RomWeaverError::ValidationCode(coded) if coded.code() == "cheat_selector_ambiguous")
}

/// A record built from the weave's own snapshot, so a ROM entry applies with
/// no database installed.
fn snapshot_record(
    entry: &WeaveCheatEntry,
    code: &str,
    system: CheatSystem,
    index: usize,
) -> CheatRecord {
    let description = entry
        .description
        .clone()
        .unwrap_or_else(|| entry.id.clone());
    CheatRecord {
        id: entry.id.clone(),
        system,
        game_id: "weave".to_string(),
        description: description.clone(),
        raw_code: Some(code.to_string()),
        code_kind: entry.code_kind,
        raw_fields: std::collections::BTreeMap::from([
            ("desc".to_string(), description),
            ("code".to_string(), code.to_string()),
        ]),
        source_file: entry
            .source
            .clone()
            .unwrap_or_else(|| "rom-weaver-weave.json".to_string()),
        source_index: index,
        source_revision: entry
            .revision
            .clone()
            .unwrap_or_else(|| "weave-snapshot".to_string()),
    }
}

fn missing_record_error(
    entry: &WeaveCheatEntry,
    index: usize,
    database_error: Option<&str>,
    reason: &str,
) -> RomWeaverError {
    // The shard-read failure already names the recovery command and the
    // directory it looked in, so it replaces the generic advice.
    let advice = database_error.map_or_else(
        || {
            format!(
                "install the cheat database with `{SETUP_COMMAND}`, or point --cheat-database at \
                 one that holds this record"
            )
        },
        str::to_owned,
    );
    RomWeaverError::Validation(format!(
        "weave cheats[{index}] `{}` could not be resolved: {reason}; {advice}",
        entry.id
    ))
}

/// Every cheat one `patch apply` run applies, from both sources.
#[derive(Default)]
pub(crate) struct PatchApplyCheats {
    /// Baked into the ROM after the patch chain.
    pub rom_records: Vec<CheatRecord>,
    /// Optional weave entries that could not be resolved.
    pub skipped: Vec<SkippedWeaveCheat>,
    /// The selection as weave entries, for `--emit-weave`.
    pub applied: Vec<WeaveCheatEntry>,
}

impl CliApp {
    /// Resolve a weave's recorded cheats and the `--cheat` selection against
    /// `rom_path` into one record list, baked after the patch chain.
    pub(crate) fn resolve_patch_apply_cheats(
        &self,
        rom_path: &Path,
        weave_cheats: &[WeaveCheatEntry],
        selection: &CheatSelectionArgs,
        native_selection: bool,
        context: &OperationContext,
    ) -> Result<PatchApplyCheats> {
        let mut cheats = PatchApplyCheats::default();
        if !weave_cheats.is_empty() {
            let resolved = self.resolve_weave_cheats(rom_path, weave_cheats, selection, context)?;
            // A skipped entry is identified by index: two entries may share an
            // id, and dropping the applied twin would lose it from the weave.
            cheats.applied.extend(
                weave_cheats
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| {
                        !resolved
                            .skipped
                            .iter()
                            .any(|skipped| skipped.index == *index)
                    })
                    .map(|(_, entry)| entry.clone()),
            );
            cheats.rom_records.extend(resolved.rom_records);
            cheats.skipped = resolved.skipped;
        }
        if native_selection {
            let resolved = self.resolve_cheat_selection(rom_path, selection, context)?;
            if let Some(entry) = resolved.selected_unusable().first() {
                return Err(RomWeaverError::Validation(format!(
                    "cheat `{}` cannot be baked into the ROM",
                    entry.record.description
                )));
            }
            cheats
                .applied
                .extend(resolved.weave_cheat_entries(&selection.cheats));
            cheats.rom_records.extend(resolved.selected_rom_records());
        }
        debug!(
            rom_cheats = cheats.rom_records.len(),
            skipped = cheats.skipped.len(),
            "resolved a patch apply cheat set"
        );
        Ok(cheats)
    }
}
