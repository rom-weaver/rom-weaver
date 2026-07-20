//! Disc-aware support for `patch apply`.
//!
//! A multi-track CD/GD disc is a single logical ROM: many `.bin` data files
//! described by a `.cue` and/or sibling `.gdi` sheet. `patch apply` lets the
//! user target one track within such a disc with `--target <glob>` (the same
//! glob matching as `--select`), patch only that track, and emit the full disc
//! (the patched track plus every other track and the sheet copied through
//! verbatim) - which is then usually compressed to CHD by the existing
//! compression path.
//!
//! This module owns the disc-specific pieces: detecting a sheet input,
//! enumerating its tracks, resolving the `--target` glob to exactly one track,
//! confirming when the directory holds unreferenced data files, and staging the
//! reassembled disc for the compressor.

use super::patch_filename_checksum::parse_filename_requirements;
use super::*;

/// One data file referenced by a disc sheet.
struct DiscFile {
    /// The name exactly as written in the sheet (used as the staged filename so
    /// the sheet stays valid).
    name: String,
    /// Absolute path to the file next to the sheet.
    path: PathBuf,
}

/// A disc resolved from a sheet input for patching.
pub(super) struct DiscContext {
    /// Sheets to copy into the staged disc verbatim: the `.cue` and, for a
    /// GD-ROM `.cue` with a sibling `.gdi`, that `.gdi` too.
    sheet_paths: Vec<PathBuf>,
    /// Every referenced data file (union across sheets), in declaration order.
    files: Vec<DiscFile>,
    /// The single track selected by `--target` (or the only track).
    pub target_file: PathBuf,
    /// Non-fatal notes (e.g. ignored unreferenced files) to surface in the
    /// report label.
    pub warnings: Vec<String>,
}

/// Default cap for buffering a single freshly produced disc track in memory
/// instead of a temp file during compression.
const DISC_TRACK_IN_MEMORY_LIMIT_BYTES: u64 = 256 * 1024 * 1024;

/// Effective in-memory cap for a single patched/rebuilt disc track. Defaults to
/// [`DISC_TRACK_IN_MEMORY_LIMIT_BYTES`]; override via
/// `ROM_WEAVER_DISC_TRACK_IN_MEMORY_LIMIT` (in bytes, `0` forces the on-disk
/// path) for regression/parity runs. Only ever bounds one track, never the disc.
fn disc_track_in_memory_limit_bytes() -> u64 {
    // Goes through the shared env helper so a malformed override is logged
    // (a silent parse-fail-to-default hides typos in parity/regression runs)
    // rather than swallowed; `0` still parses and forces the on-disk path.
    env_u64(
        "ROM_WEAVER_DISC_TRACK_IN_MEMORY_LIMIT",
        DISC_TRACK_IN_MEMORY_LIMIT_BYTES,
    )
}

/// Directory holding the disc sheet's tracks. `Path::parent` returns `Some("")`
/// (not `None`) for a bare filename, so a plain `unwrap_or(".")` never fires and
/// `read_dir("")` fails ENOENT - breaking "cd into the disc folder, pass
/// game.cue". Normalize an empty parent to `.`.
fn sheet_directory(input: &Path) -> &Path {
    match input.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    }
}

impl CliApp {
    pub(super) fn patch_source_crc32_for_auto_target(
        &self,
        patch: &Path,
        context: &OperationContext,
    ) -> Option<String> {
        self.embedded_patch_source_crc32(patch, context)
            .or_else(|| {
                patch
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(|name| {
                        parse_filename_requirements(name)
                            .checksums
                            .get("crc32")
                            .cloned()
                    })
            })
    }

    /// Resolve `input` as a disc sheet for patching. Returns `Ok(None)` when
    /// `input` is not a `.cue`/`.gdi` (the caller falls back to the plain
    /// single-file path). Errors when a referenced track is missing, when
    /// `--target` does not resolve to exactly one track, or when the user
    /// declines the unreferenced-files confirmation.
    pub(super) fn build_disc_context(
        &self,
        input: &Path,
        target: Option<&str>,
        patch_source_crc32: Option<&str>,
        context: &OperationContext,
    ) -> Result<Option<DiscContext>> {
        let Some(kind) = detect_disc_sheet(input) else {
            return Ok(None);
        };
        trace!(input = %input.display(), ?kind, ?target, "resolving disc patch input");

        let mut sheet_paths = vec![input.to_path_buf()];
        let mut referenced_names = enumerate_disc_sheet_refs(input)?.referenced_files;
        // A `.cue` with a sibling `.gdi` is a GD-ROM whose tracks are the union
        // of both sheets; the CHD create path reads both, so stage both.
        if kind == DiscSheetKind::Cue
            && let Some(gdi) = sibling_gdi_path(input)
        {
            for name in enumerate_disc_sheet_refs(&gdi)?.referenced_files {
                if !referenced_names
                    .iter()
                    .any(|existing| existing.eq_ignore_ascii_case(&name))
                {
                    referenced_names.push(name);
                }
            }
            sheet_paths.push(gdi);
        }

        let sheet_dir = sheet_directory(input);
        let mut files = Vec::with_capacity(referenced_names.len());
        for name in &referenced_names {
            let path = sheet_dir.join(name);
            if !path.is_file() {
                return Err(RomWeaverError::Validation(format!(
                    "disc sheet `{}` references `{name}`, which was not found next to it",
                    input.display()
                )));
            }
            files.push(DiscFile {
                name: name.clone(),
                path,
            });
        }
        trace!(tracks = files.len(), "enumerated disc tracks");

        let target_index =
            self.select_disc_target(input, &files, target, patch_source_crc32, context)?;
        let target_file = files[target_index].path.clone();
        trace!(target = %target_file.display(), "selected disc patch target track");

        let warnings = self.confirm_disc_grouping(input, sheet_dir, &files)?;

        Ok(Some(DiscContext {
            sheet_paths,
            files,
            target_file,
            warnings,
        }))
    }

    /// Build a disc context for a `.dcp` apply: enumerate the disc's tracks and
    /// auto-select the GD-ROM high-density data track (the one whose ISO9660
    /// filesystem the patch rebuilds) as the target, without requiring
    /// `--target`. Returns `Ok(None)` when `input` is not a disc sheet.
    pub(super) fn build_dcp_disc_context(&self, input: &Path) -> Result<Option<DiscContext>> {
        let Some(kind) = detect_disc_sheet(input) else {
            return Ok(None);
        };
        trace!(input = %input.display(), ?kind, "resolving .dcp disc input");

        let mut sheet_paths = vec![input.to_path_buf()];
        let mut referenced_names = enumerate_disc_sheet_refs(input)?.referenced_files;
        if kind == DiscSheetKind::Cue
            && let Some(gdi) = sibling_gdi_path(input)
        {
            for name in enumerate_disc_sheet_refs(&gdi)?.referenced_files {
                if !referenced_names
                    .iter()
                    .any(|existing| existing.eq_ignore_ascii_case(&name))
                {
                    referenced_names.push(name);
                }
            }
            sheet_paths.push(gdi);
        }

        let sheet_dir = sheet_directory(input);
        let mut files = Vec::with_capacity(referenced_names.len());
        for name in &referenced_names {
            let path = sheet_dir.join(name);
            if !path.is_file() {
                return Err(RomWeaverError::Validation(format!(
                    "disc sheet `{}` references `{name}`, which was not found next to it",
                    input.display()
                )));
            }
            files.push(DiscFile {
                name: name.clone(),
                path,
            });
        }

        let target_index = self.select_dcp_data_track(input, &files)?;
        let target_file = files[target_index].path.clone();
        trace!(target = %target_file.display(), "selected GD-ROM data track for .dcp rebuild");
        let warnings = self.confirm_disc_grouping(input, sheet_dir, &files)?;

        Ok(Some(DiscContext {
            sheet_paths,
            files,
            target_file,
            warnings,
        }))
    }

    /// Choose the GD-ROM high-density data track from a disc's files: the
    /// largest track whose bytes parse as an ISO9660 filesystem at the GD high
    /// density start LBA. That is the track a `.dcp` rebuilds.
    fn select_dcp_data_track(&self, input: &Path, files: &[DiscFile]) -> Result<usize> {
        let mut order: Vec<usize> = (0..files.len()).collect();
        order.sort_by_key(|&i| {
            std::cmp::Reverse(fs::metadata(&files[i].path).map(|m| m.len()).unwrap_or(0))
        });
        for &index in &order {
            let file = match fs::File::open(&files[index].path) {
                Ok(file) => file,
                Err(_) => continue,
            };
            if crate::gdrom::GdRomFs::open(
                std::io::BufReader::new(file),
                crate::gdrom::GD_HIGH_DENSITY_START_LBA,
            )
            .is_ok()
            {
                return Ok(index);
            }
        }
        Err(RomWeaverError::Validation(format!(
            "disc `{}` has no GD-ROM data track (ISO9660 filesystem) for a .dcp patch",
            input.display()
        )))
    }

    /// Resolve `--target` to exactly one track index. With no `--target`, a
    /// single-track disc is targeted implicitly. A multi-track disc uses the
    /// first patch's source CRC32 when available, otherwise it requires an
    /// explicit `--target`. A glob must match exactly one track.
    fn select_disc_target(
        &self,
        input: &Path,
        files: &[DiscFile],
        target: Option<&str>,
        patch_source_crc32: Option<&str>,
        context: &OperationContext,
    ) -> Result<usize> {
        let track_list = || {
            files
                .iter()
                .map(|file| file.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        };
        let Some(glob) = target else {
            if files.len() == 1 {
                return Ok(0);
            }
            if let Some(expected) = patch_source_crc32 {
                let mut matches = Vec::new();
                for (index, file) in files.iter().enumerate() {
                    let mut reader = BufReader::new(File::open(&file.path)?);
                    if Self::crc32_of_reader(&mut reader, context)?
                        .is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
                    {
                        matches.push(index);
                    }
                }
                return match matches.as_slice() {
                    [only] => Ok(*only),
                    [] => Err(RomWeaverError::Validation(format!(
                        "patch source crc32 `{expected}` matched none of the {} tracks in `{}` ({})",
                        files.len(),
                        input.display(),
                        track_list()
                    ))),
                    many => Err(RomWeaverError::Validation(format!(
                        "patch source crc32 `{expected}` matched {} tracks in `{}` ({}); pass --target <glob> to choose one",
                        many.len(),
                        input.display(),
                        many.iter()
                            .map(|index| files[*index].name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ))),
                };
            }
            return Err(RomWeaverError::Validation(format!(
                "disc sheet `{}` references {} tracks; pass --target <glob> to choose one ({})",
                input.display(),
                files.len(),
                track_list()
            )));
        };

        let mut matcher = SelectionMatcher::new(&[glob.to_string()]);
        let matched = files
            .iter()
            .enumerate()
            .filter(|(_, file)| matcher.matches(&file.name))
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        match matched.as_slice() {
            [] => Err(RomWeaverError::Validation(format!(
                "--target `{glob}` matched none of the {} track(s) in `{}` ({})",
                files.len(),
                input.display(),
                track_list()
            ))),
            [only] => Ok(*only),
            many => Err(RomWeaverError::Validation(format!(
                "--target `{glob}` matched {} tracks in `{}` ({}); narrow the pattern to select exactly one",
                many.len(),
                input.display(),
                many.iter()
                    .map(|index| files[*index].name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }

    /// Look for `.bin`/`.img`/`.iso` files in the sheet's directory that the
    /// sheet does not reference. Interactively confirm proceeding (ignoring
    /// them); non-interactively, proceed and return a warning note. Only
    /// sheet-referenced files are ever staged, so compressed output stays
    /// byte-identical to the original disc except for the patched track.
    fn confirm_disc_grouping(
        &self,
        input: &Path,
        sheet_dir: &Path,
        files: &[DiscFile],
    ) -> Result<Vec<String>> {
        let referenced = files
            .iter()
            .map(|file| file.name.to_ascii_lowercase())
            .collect::<std::collections::BTreeSet<_>>();
        let mut loose = Vec::new();
        for entry in fs::read_dir(sheet_dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_ascii_lowercase();
            if !(lower.ends_with(".bin") || lower.ends_with(".img") || lower.ends_with(".iso")) {
                continue;
            }
            if referenced.contains(&lower) {
                continue;
            }
            loose.push(name);
        }
        if loose.is_empty() {
            return Ok(Vec::new());
        }
        loose.sort();
        trace!(
            unreferenced = loose.len(),
            "disc directory has unreferenced data files"
        );

        let sheet_name = input
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| input.display().to_string());
        if self.interactive_selection_enabled {
            let heading = format!(
                "Directory `{}` contains data file(s) not referenced by `{sheet_name}`. Proceed patching the disc, ignoring them?",
                sheet_dir.display()
            );
            if !self.prompter.confirm(&heading, &loose) {
                return Err(RomWeaverError::Validation(format!(
                    "disc patch cancelled: `{}` contains data file(s) not referenced by `{sheet_name}` ({})",
                    sheet_dir.display(),
                    loose.join(", ")
                )));
            }
            Ok(Vec::new())
        } else {
            Ok(vec![format!(
                "ignored {} unreferenced data file(s) in disc directory ({})",
                loose.len(),
                loose.join(", ")
            )])
        }
    }

    /// The original disc sheet to feed the compressor when reassembling in
    /// place: its directory still holds every untouched track (and any sibling
    /// `.gdi`), so the create handler resolves and reads them where they sit -
    /// only the patched/rebuilt track is redirected via a create input override.
    pub(super) fn primary_disc_sheet<'a>(&self, disc: &'a DiscContext) -> &'a Path {
        &disc.sheet_paths[0]
    }

    /// Build the single create input override that redirects the disc's target
    /// track to a freshly produced track at `track_path` (the patched or
    /// `.dcp`-rebuilt track temp). When the track fits under the in-memory cap
    /// it is read into memory and its temp deleted - so no whole-disc copy and
    /// no lingering scratch - otherwise it streams from the temp file. Every
    /// untouched track stays read in place from the original disc.
    pub(super) fn disc_target_track_override(
        &self,
        disc: &DiscContext,
        track_path: &Path,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<CreateInputOverride> {
        let len = fs::metadata(track_path)?.len();
        let cap = disc_track_in_memory_limit_bytes();
        let source = if len <= cap {
            let bytes = fs::read(track_path)?;
            // The track now lives in memory; drop the transient temp so no disc
            // scratch lingers through compression.
            let _ = fs::remove_file(track_path);
            temp_paths.retain(|path| path != track_path);
            trace!(
                track = %track_path.display(),
                bytes = len,
                "buffered patched disc track in memory"
            );
            CreateInputSource::Bytes(std::sync::Arc::from(bytes))
        } else {
            trace!(
                track = %track_path.display(),
                bytes = len,
                cap,
                "streaming patched disc track from temp (over in-memory cap)"
            );
            CreateInputSource::Path(track_path.to_path_buf())
        };
        Ok(CreateInputOverride {
            original_path: disc.target_file.clone(),
            source,
        })
    }

    /// Stage the reassembled disc in a temp directory: every sheet copied
    /// verbatim, every untouched track copied under its sheet-referenced name,
    /// and the patched track written under the target's name. Registers the
    /// stage directory in `temp_paths` for cleanup. Returns the path to the
    /// primary sheet inside the stage directory (the input to the compressor).
    /// Used only for `--no-compress`; the compress path reads tracks in place
    /// via [`Self::disc_target_track_override`] instead of copying the disc.
    pub(super) fn stage_disc_directory(
        &self,
        disc: &DiscContext,
        patched_target: &Path,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<PathBuf> {
        let stage_dir = context
            .temp_paths()
            .next_path("patch-apply-disc-stage", None);
        fs::create_dir_all(&stage_dir)?;
        temp_paths.push(stage_dir.clone());
        trace!(stage_dir = %stage_dir.display(), "staging patched disc");

        let mut primary_sheet = None;
        for (index, sheet) in disc.sheet_paths.iter().enumerate() {
            let name = sheet.file_name().ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "disc sheet `{}` has no file name",
                    sheet.display()
                ))
            })?;
            let dest = stage_dir.join(name);
            fs::copy(sheet, &dest)?;
            if index == 0 {
                primary_sheet = Some(dest);
            }
        }

        for file in &disc.files {
            let dest = stage_dir.join(&file.name);
            if let Some(parent) = dest.parent()
                && !parent.exists()
            {
                fs::create_dir_all(parent)?;
            }
            let source = if file.path == disc.target_file {
                patched_target
            } else {
                file.path.as_path()
            };
            fs::copy(source, &dest)?;
        }

        primary_sheet
            .ok_or_else(|| RomWeaverError::Validation("disc has no sheet to stage".to_string()))
    }

    /// Write the reassembled disc to disk for `--no-compress` output: the
    /// primary sheet is written to `output` (which must be a `.cue`/`.gdi`
    /// path) and every track (and any secondary sheet) is written beside it
    /// under its sheet-referenced name. `staged_sheet` points into the stage
    /// directory produced by [`Self::stage_disc_directory`].
    pub(super) fn write_disc_output(
        &self,
        disc: &DiscContext,
        staged_sheet: &Path,
        output: &Path,
    ) -> Result<String> {
        if detect_disc_sheet(output).is_none() {
            return Err(RomWeaverError::Validation(format!(
                "--no-compress disc output `{}` must be a .cue/.gdi path so the tracks can be written beside it",
                output.display()
            )));
        }
        let stage_dir = staged_sheet.parent().ok_or_else(|| {
            RomWeaverError::Validation("staged disc sheet has no parent directory".to_string())
        })?;
        let out_dir = output.parent().unwrap_or_else(|| Path::new("."));
        if !out_dir.as_os_str().is_empty() {
            fs::create_dir_all(out_dir)?;
        }
        // The primary sheet's content is unchanged; it references tracks by name
        // and those names are written beside it.
        fs::copy(staged_sheet, output)?;
        for sheet in disc.sheet_paths.iter().skip(1) {
            if let Some(name) = sheet.file_name() {
                fs::copy(stage_dir.join(name), out_dir.join(name))?;
            }
        }
        for file in &disc.files {
            let dest = out_dir.join(&file.name);
            if let Some(parent) = dest.parent()
                && !parent.as_os_str().is_empty()
                && !parent.exists()
            {
                fs::create_dir_all(parent)?;
            }
            fs::copy(stage_dir.join(&file.name), dest)?;
        }
        Ok(format!(
            "wrote full disc ({} track(s)) beside `{}`",
            disc.files.len(),
            output.display()
        ))
    }
}
