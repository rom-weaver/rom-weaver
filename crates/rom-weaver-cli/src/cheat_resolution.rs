//! Shared native resolution of `--cheat` selections into classified cheat
//! records, used by `cheat list`, `patch apply`, and `patch create`.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use rom_weaver_core::{OperationContext, OperationReport, Result, RomWeaverError};
use tracing::{debug, trace};

use crate::{
    CliApp,
    cheat_database::{self, GameMatchKind},
    cheats::{self, CheatRecord, CheatSystem, ClassifiedCheatRecord},
    command_args::CheatSelectionArgs,
};

/// Everything the commands need after a `--cheat` lookup.
pub(crate) struct ResolvedCheats {
    pub system: CheatSystem,
    pub match_kind: Option<GameMatchKind>,
    /// The database directory that was read.
    pub directory: Option<PathBuf>,
    pub game_id: Option<String>,
    pub game_title: Option<String>,
    /// Every cheat available for the ROM, classified against its bytes.
    pub available: Vec<ClassifiedCheatRecord>,
    /// The subset named by `--cheat`, in the order the selectors were given.
    pub selected: Vec<ClassifiedCheatRecord>,
}

impl ResolvedCheats {
    /// The selected entries that can be baked into ROM bytes.
    pub fn selected_rom_records(&self) -> Vec<CheatRecord> {
        self.selected
            .iter()
            .filter(|entry| cheat_database::is_rom_bakeable(entry))
            .map(|entry| entry.record.clone())
            .collect()
    }

    /// Selected entries that cannot be baked into the ROM.
    pub fn selected_unusable(&self) -> Vec<&ClassifiedCheatRecord> {
        self.selected
            .iter()
            .filter(|entry| !cheat_database::is_rom_bakeable(entry))
            .collect()
    }
}

impl CliApp {
    /// Load the cheats available for `rom_path` and resolve the `--cheat`
    /// selectors against them.
    pub(crate) fn resolve_cheat_selection(
        &self,
        rom_path: &Path,
        args: &CheatSelectionArgs,
        context: &OperationContext,
    ) -> Result<ResolvedCheats> {
        let system =
            self.cheat_system_for(rom_path, args.cheat_system.as_deref(), "--cheat-system")?;
        let rom = fs::read(rom_path)?;
        trace!(
            rom = %rom_path.display(),
            system = system.id(),
            rom_len = rom.len(),
            selectors = args.cheats.len(),
            "resolving a cheat selection"
        );
        let directory = cheat_database::resolve_directory(args.cheat_database.as_deref())?;
        let shard = cheat_database::load_shard(&directory, system)?;
        let (match_kind, game) = match args.game.as_deref() {
            Some(id) => (
                GameMatchKind::Manual,
                cheat_database::game_by_id(&shard, id)?,
            ),
            None => {
                let checksums = Self::cheat_rom_checksums(rom_path, context)?;
                let title_source = rom_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default();
                cheat_database::match_game(&shard, &checksums, title_source).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "no {} cheat database game matched `{}` by checksum or title; \
                         pass --game ID to pick one",
                        system.id(),
                        rom_path.display()
                    ))
                })?
            }
        };
        let records = game.cheats.clone();
        let (game_id, game_title) = (game.id.clone(), game.title.clone());
        let available = records
            .iter()
            .map(|record| cheats::classify_record(&rom, record))
            .collect::<Vec<_>>();
        let selected_records = cheat_database::resolve_selectors(&records, &args.cheats)?;
        let selected = selected_records
            .iter()
            .map(|record| cheats::classify_record(&rom, record))
            .collect::<Vec<_>>();
        debug!(
            system = system.id(),
            available = available.len(),
            selected = selected.len(),
            match_kind = match_kind.id(),
            "resolved a cheat selection"
        );
        Ok(ResolvedCheats {
            system,
            match_kind: Some(match_kind),
            directory: Some(directory),
            game_id: Some(game_id),
            game_title: Some(game_title),
            available,
            selected,
        })
    }

    /// The checksums the shard's release entries are keyed by.
    fn cheat_rom_checksums(
        rom_path: &Path,
        context: &OperationContext,
    ) -> Result<BTreeMap<String, String>> {
        rom_weaver_checksum::checksum_file_values(rom_path, &["crc32", "md5", "sha1"], context)
    }
}

/// Inputs to [`CliApp::plan_patch_create_cheats`].
pub(crate) struct PatchCreateCheatRequest<'a> {
    pub original: &'a Path,
    pub selection: &'a CheatSelectionArgs,
    /// True when `--modified` or `--code` was also given, which `--cheat` rejects.
    pub has_other_source: bool,
    pub context: &'a OperationContext,
}

/// What `patch create --cheat` needs: the ROM to diff against, plus the cheats
/// that were left out because they cannot be baked.
pub(crate) struct PatchCreateCheatPlan {
    pub modified: PathBuf,
    pub summary: crate::cheats_apply::CheatApplySummary,
    /// Descriptions of the selected cheats a patch cannot carry.
    pub skipped: Vec<String>,
}

impl CliApp {
    /// Add the cheat outcome to a successful `patch create` report: the patch
    /// file, plus the cheats that could not be baked.
    pub(crate) fn annotate_patch_create_cheats(
        mut report: OperationReport,
        patch_output: &Path,
        skipped: &[String],
    ) -> OperationReport {
        // The patch is only in `emitted_files` when --checksum-name ran. A cheat
        // run always lists it, so the report carries the file it wrote.
        report = Self::attach_emitted_files_details(report, vec![patch_output.to_path_buf()], None);
        if !skipped.is_empty() {
            report.label = format!(
                "{}; skipped {} cheat(s) that cannot be baked into the ROM",
                report.label,
                skipped.len()
            );
            let details = report.details.get_or_insert_with(|| serde_json::json!({}));
            if let Some(map) = details.as_object_mut() {
                map.insert(
                    "skipped_cheats".to_string(),
                    serde_json::json!({ "descriptions": skipped }),
                );
            }
        }
        report
    }

    /// Resolve the selection and bake the ROM entries into a temp ROM for the
    /// diff.
    pub(crate) fn plan_patch_create_cheats(
        &self,
        request: PatchCreateCheatRequest<'_>,
    ) -> Result<PatchCreateCheatPlan> {
        let PatchCreateCheatRequest {
            original,
            selection: args,
            has_other_source,
            context,
        } = request;
        if has_other_source {
            return Err(RomWeaverError::Validation(
                "--cheat cannot be combined with --modified or --code".to_string(),
            ));
        }
        let resolved = self.resolve_cheat_selection(original, args, context)?;
        // No `--cheat` means "use every cheat the matched game holds".
        let source = if args.cheats.is_empty() {
            &resolved.available
        } else {
            &resolved.selected
        };
        let mut rom_records = Vec::new();
        let mut skipped = Vec::new();
        for entry in source {
            if cheat_database::is_rom_bakeable(entry) {
                rom_records.push(entry.record.clone());
            } else {
                skipped.push(entry.record.description.clone());
            }
        }
        if rom_records.is_empty() {
            return Err(RomWeaverError::Validation(
                "none of the selected cheats patch ROM bytes, so the patch would be empty"
                    .to_string(),
            ));
        }
        let modified = context
            .temp_paths()
            .next_path("patch-create-cheat-modified", Some("bin"));
        let summary = Self::write_database_cheat_patched_rom(
            original,
            &rom_records,
            args.allow_cheat_conflicts,
            &modified,
        )?;
        debug!(
            rom_cheats = rom_records.len(),
            skipped = skipped.len(),
            "planned a cheat-derived patch create"
        );
        Ok(PatchCreateCheatPlan {
            modified,
            summary,
            skipped,
        })
    }
}
