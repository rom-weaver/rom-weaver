//! Bundle cheat entries: recording a `--cheat` selection into a bundle, and
//! resolving a bundle's `cheats` array back into cheat records at apply time.

use std::path::Path;

use rom_weaver_core::{OperationContext, Result, RomWeaverError, ValidationCodeError};
use tracing::{debug, trace};

use crate::{
    BundleCheatEntry, CliApp,
    cheat_database::{self},
    cheat_resolution::ResolvedCheats,
    cheats::{self, CheatRecord, CheatSystem},
    command_args::CheatSelectionArgs,
};

/// The command that installs the local cheat database, named by every error
/// that needs it.
const SETUP_COMMAND: &str = "rom-weaver setup";

/// A bundle's `cheats` array, resolved against the input ROM.
#[derive(Debug, Default)]
pub(crate) struct ResolvedBundleCheats {
    /// Baked into the ROM after the patch chain, in bundle order.
    pub rom_records: Vec<CheatRecord>,
    /// The optional entries that could not be resolved.
    pub skipped: Vec<SkippedBundleCheat>,
}

/// An optional bundle cheat that was left out, and why. The index identifies
/// the entry: two entries may legitimately share an id.
#[derive(Debug)]
pub(crate) struct SkippedBundleCheat {
    pub index: usize,
    pub id: String,
    pub reason: String,
}

impl std::fmt::Display for SkippedBundleCheat {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} ({})", self.id, self.reason)
    }
}

impl ResolvedCheats {
    /// The selection as bundle entries, in selection order. With no selectors
    /// the whole matched game is recorded, which is what the commands act on.
    /// Only bakeable entries are recorded; callers reject the rest first.
    pub(crate) fn bundle_cheat_entries(&self, selectors: &[String]) -> Vec<BundleCheatEntry> {
        let source = self.directory.as_deref().map(cheat_database::source_name);
        let selected = if selectors.is_empty() {
            &self.available
        } else {
            &self.selected
        };
        selected
            .iter()
            .filter(|entry| cheat_database::is_rom_bakeable(entry))
            .map(|entry| BundleCheatEntry {
                id: entry.record.id.clone(),
                source: source.clone(),
                revision: Some(entry.record.source_revision.clone()),
                description: Some(entry.record.description.clone()),
                // The snapshot lets the entry apply without the database.
                code: entry.record.raw_code.clone(),
                optional: false,
            })
            .collect()
    }
}

impl CliApp {
    /// Resolve a bundle's cheat entries against `rom_path`: by ID through the
    /// local cheat database when it holds the record, otherwise from the
    /// entry's own `code` snapshot. An entry that resolves to nothing, or that
    /// this ROM's bytes cannot bake, fails the apply unless it is `optional`.
    pub(crate) fn resolve_bundle_cheats(
        &self,
        rom_path: &Path,
        entries: &[BundleCheatEntry],
        args: &CheatSelectionArgs,
        context: &OperationContext,
    ) -> Result<ResolvedBundleCheats> {
        let system =
            self.cheat_system_for(rom_path, args.cheat_system.as_deref(), "--cheat-system")?;
        let rom = std::fs::read(rom_path)?;
        // The database is optional: ROM entries carrying a code snapshot still
        // apply without it, so a load failure is only reported by the entries
        // that actually needed it.
        let (candidates, database_error) =
            match self.bundle_cheat_candidates(rom_path, args, context) {
                Ok(records) => (records, None),
                Err(error) => (Vec::new(), Some(error.to_string())),
            };
        trace!(
            rom = %rom_path.display(),
            system = system.id(),
            entries = entries.len(),
            candidates = candidates.len(),
            database_error = ?database_error,
            "resolving bundle cheats"
        );
        let mut resolved = ResolvedBundleCheats::default();
        for (index, entry) in entries.iter().enumerate() {
            let outcome = Self::bundle_cheat_record(
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
                    ValidationCodeError::new("bundle_cheat_not_bakeable")
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
                    debug!(cheat = %entry.id, %error, "skipping an optional bundle cheat");
                    resolved.skipped.push(SkippedBundleCheat {
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
            "resolved bundle cheats"
        );
        Ok(resolved)
    }

    /// The database records a bundle's entries can be looked up in: the shard
    /// game matched for `rom_path`.
    fn bundle_cheat_candidates(
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

    /// One bundle entry's record: the database hit, else the `code` snapshot.
    fn bundle_cheat_record(
        entry: &BundleCheatEntry,
        candidates: &[CheatRecord],
        database_error: Option<&str>,
        system: CheatSystem,
        index: usize,
    ) -> Result<CheatRecord> {
        if !candidates.is_empty() {
            match cheat_database::resolve_selectors(candidates, std::slice::from_ref(&entry.id)) {
                Ok(found) => {
                    if let Some(record) = found.into_iter().next() {
                        return Ok(record);
                    }
                }
                // An ID that now names several records is never resolved by
                // guessing; the snapshot does not make the choice safe either.
                Err(error) if is_ambiguous_selector(&error) => return Err(error),
                Err(error) => {
                    trace!(cheat = %entry.id, %error, "bundle cheat is not in the database");
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
                "the bundle carries no `code` snapshot for it",
            )),
        }
    }
}

fn is_ambiguous_selector(error: &RomWeaverError) -> bool {
    matches!(error, RomWeaverError::ValidationCode(coded) if coded.code() == "cheat_selector_ambiguous")
}

/// A record built from the bundle's own snapshot, so a ROM entry applies with
/// no database installed.
fn snapshot_record(
    entry: &BundleCheatEntry,
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
        game_id: "bundle".to_string(),
        description: description.clone(),
        raw_code: Some(code.to_string()),
        code_kind: None,
        raw_fields: std::collections::BTreeMap::from([
            ("desc".to_string(), description),
            ("code".to_string(), code.to_string()),
        ]),
        source_file: entry
            .source
            .clone()
            .unwrap_or_else(|| "rom-weaver-bundle.json".to_string()),
        source_index: index,
        source_revision: entry
            .revision
            .clone()
            .unwrap_or_else(|| "bundle-snapshot".to_string()),
    }
}

fn missing_record_error(
    entry: &BundleCheatEntry,
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
        "bundle cheats[{index}] `{}` could not be resolved: {reason}; {advice}",
        entry.id
    ))
}
