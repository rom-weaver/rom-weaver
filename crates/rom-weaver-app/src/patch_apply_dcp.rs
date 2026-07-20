//! `patch apply` support for Universal Dreamcast Patcher (`.dcp`) patches.
//!
//! A `.dcp` is not a byte-stream patch: it rebuilds a GD-ROM data track's
//! ISO9660 filesystem. This path therefore diverges from the normal per-track
//! apply. It requires a disc-sheet (`.cue`/`.gdi`) input, finds the GD-ROM
//! high-density data track, rebuilds it with the internal DCP module, reassembles the
//! full disc via the shared disc staging, and emits the result (compressed to
//! CHD by default, or written beside the output sheet with `--no-compress`).

use std::fs::{self, File};
use std::io::{BufReader, BufWriter};

use crate::dcp::rebuild_track_to_writer;
use crate::gdrom::{GD_HIGH_DENSITY_START_LBA, GdRomFs, IsoTimestamp};

use super::*;

impl CliApp {
    /// Run `patch apply` for a `.dcp` patch. Invoked from
    /// [`Self::run_patch_apply`] when the patch list is a single `.dcp`.
    pub(super) fn run_dcp_apply(&self, args: PatchApplyCommand) -> AppRunOutcome {
        let context = self.context(args.threads);
        let single = context.single_thread_execution();
        let fail = |stage: &str, message: String| {
            OperationReport::failed(OperationFamily::Patch, None, stage, message, single.clone())
        };

        // A `.dcp` rebuilds the whole data track, so the byte-level header /
        // checksum transforms and chaining do not apply.
        if args.patches.len() != 1 {
            return self.finish(
                "patch-apply",
                fail(
                    "validate",
                    "a .dcp patch must be applied on its own (no patch chaining)".to_string(),
                ),
            );
        }
        if args.patch_header.contains(&PatchApplyHeaderMode::Strip)
            || args.output_header.is_some()
            || args.repair_checksum
            || args
                .n64_byte_order
                .iter()
                .any(|mode| mode.target().is_some())
        {
            return self.finish(
                "patch-apply",
                fail(
                    "validate",
                    "a .dcp patch cannot be combined with --patch-header strip, --output-header, --repair-checksum, or --n64-byte-order".to_string(),
                ),
            );
        }
        // A `.dcp` rebuilds the GD-ROM filesystem rather than patching ROM bytes,
        // and it auto-selects the high-density data track. Cheats (which patch
        // byte offsets) and an explicit `--target` track have no effect here, so
        // reject them instead of silently dropping them.
        if !args.codes.is_empty() {
            return self.finish(
                "patch-apply",
                fail(
                    "validate",
                    "a .dcp patch cannot be combined with --code; cheats patch ROM byte offsets, not a rebuilt GD-ROM filesystem".to_string(),
                ),
            );
        }
        if args.target.is_some() {
            return self.finish(
                "patch-apply",
                fail(
                    "validate",
                    "a .dcp patch ignores --target; the GD-ROM high-density data track is selected automatically".to_string(),
                ),
            );
        }

        let dcp_path = args.patches[0].clone();
        if let Some(report) = self.require_existing_path(
            "patch-apply",
            OperationFamily::Patch,
            None,
            &args.input,
            single.clone(),
        ) {
            return self.finish("patch-apply", report);
        }
        if let Some(report) = self.require_existing_path(
            "patch-apply",
            OperationFamily::Patch,
            None,
            &dcp_path,
            single.clone(),
        ) {
            return self.finish("patch-apply", report);
        }

        let compression_options = match Self::parse_patch_apply_compression_options(
            args.no_compress,
            args.compress_format.clone(),
            args.compress_codec.clone(),
            args.compress_level.unwrap_or_default(),
        ) {
            Ok(options) => options,
            Err(error) => return self.finish("patch-apply", fail("validate", error.to_string())),
        };

        let disc = match self.build_dcp_disc_context(&args.input) {
            Ok(Some(disc)) => disc,
            Ok(None) => {
                return self.finish(
                    "patch-apply",
                    fail(
                        "validate",
                        "a .dcp patch requires a disc-sheet (.cue/.gdi) input".to_string(),
                    ),
                );
            }
            Err(error) => return self.finish("patch-apply", fail("prepare", error.to_string())),
        };

        let report = self.rebuild_and_emit_dcp(
            &args,
            &dcp_path,
            &disc,
            &compression_options,
            &context,
            single.clone(),
        );
        self.finish("patch-apply", report)
    }

    /// Rebuild the data track from the `.dcp`, reassemble the disc, and emit it.
    fn rebuild_and_emit_dcp(
        &self,
        args: &PatchApplyCommand,
        dcp_path: &Path,
        disc: &super::patch_apply_disc::DiscContext,
        compression_options: &PatchApplyCompressionOptions,
        context: &OperationContext,
        single: Option<ThreadExecution>,
    ) -> OperationReport {
        let fail = |stage: &str, message: String| {
            OperationReport::failed(OperationFamily::Patch, None, stage, message, single.clone())
        };
        let output = args
            .output
            .as_deref()
            .expect("output presence is validated by run_patch_apply");

        self.emit_running(
            OperationLabel {
                command: "patch-apply",
                family: OperationFamily::Patch,
                format: Some("dcp"),
            },
            "apply",
            "rebuilding GD-ROM data track from .dcp".to_string(),
            Some(0.0),
            single.clone(),
        );

        // Rebuild the data track.
        let mut source = match File::open(&disc.target_file)
            .map_err(RomWeaverError::from)
            .and_then(|file| GdRomFs::open(BufReader::new(file), GD_HIGH_DENSITY_START_LBA))
        {
            Ok(fs) => fs,
            Err(error) => return fail("prepare", error.to_string()),
        };
        let mut dcp_reader = match File::open(dcp_path) {
            Ok(file) => BufReader::new(file),
            Err(error) => return fail("prepare", error.to_string()),
        };

        // Stream the rebuilt track straight to a temp file for staging - the
        // cooked image and raw track are never fully held in memory.
        let mut temp_paths: Vec<PathBuf> = Vec::new();
        let rebuilt_path = context
            .temp_paths()
            .next_path("dcp-rebuilt-track", Some("bin"));
        if let Some(parent) = rebuilt_path.parent()
            && let Err(error) = fs::create_dir_all(parent)
        {
            return fail("apply", error.to_string());
        }
        let rebuilt = {
            let track_file = match File::create(&rebuilt_path) {
                Ok(file) => file,
                Err(error) => return fail("apply", error.to_string()),
            };
            let mut sink = BufWriter::new(track_file);
            let summary = match rebuild_track_to_writer(
                &mut dcp_reader,
                &mut source,
                IsoTimestamp::default(),
                &mut sink,
            ) {
                Ok(summary) => summary,
                Err(error) => {
                    Self::cleanup_temp_paths(std::slice::from_ref(&rebuilt_path));
                    return fail("apply", error.to_string());
                }
            };
            if let Err(error) = sink.flush() {
                return fail("apply", error.to_string());
            }
            summary
        };
        temp_paths.push(rebuilt_path.clone());

        let boot_note = if rebuilt.boot_sector_replaced {
            "; IP.BIN boot sector replaced"
        } else {
            ""
        };
        let mut label = format!(
            "rebuilt GD-ROM data track from .dcp ({} files){boot_note}",
            rebuilt.file_count
        );
        for warning in &disc.warnings {
            label = format!("{label}; {warning}");
        }

        // Emit: compress (default) reads every untouched track in place from the
        // source disc and redirects only the rebuilt track via a create override
        // (no whole-disc scratch copy); --no-compress stages the full disc and
        // writes it beside the output sheet.
        let report = if compression_options.enabled {
            let track_override =
                match self.disc_target_track_override(disc, &rebuilt_path, &mut temp_paths) {
                    Ok(track_override) => track_override,
                    Err(error) => {
                        Self::cleanup_temp_paths(&temp_paths);
                        return fail("prepare", error.to_string());
                    }
                };
            self.compress_dcp_disc(
                output,
                &args.input,
                self.primary_disc_sheet(disc),
                std::slice::from_ref(&track_override),
                compression_options,
                context,
                &mut label,
                single.clone(),
            )
        } else {
            let staged_sheet =
                match self.stage_disc_directory(disc, &rebuilt_path, context, &mut temp_paths) {
                    Ok(path) => path,
                    Err(error) => {
                        Self::cleanup_temp_paths(&temp_paths);
                        return fail("prepare", error.to_string());
                    }
                };
            match self.write_disc_output(disc, &staged_sheet, output) {
                Ok(note) => {
                    label = format!("{label}; {note}");
                    OperationReport::succeeded(
                        OperationFamily::Patch,
                        Some("dcp".to_string()),
                        "apply",
                        label,
                        Some(100.0),
                        single.clone(),
                    )
                }
                Err(error) => fail("compat", error.to_string()),
            }
        };

        Self::cleanup_temp_paths(&temp_paths);
        report
    }

    /// Compress the staged disc to the requested container (CHD by default).
    #[expect(clippy::too_many_arguments)]
    fn compress_dcp_disc(
        &self,
        output: &Path,
        extension_source: &Path,
        sheet: &Path,
        overrides: &[CreateInputOverride],
        compression_options: &PatchApplyCompressionOptions,
        context: &OperationContext,
        label: &mut String,
        single: Option<ThreadExecution>,
    ) -> OperationReport {
        let fail = |stage: &str, message: String| {
            OperationReport::failed(OperationFamily::Patch, None, stage, message, single.clone())
        };
        let plan = match self.resolve_patch_apply_compression_plan(
            output,
            extension_source,
            compression_options,
        ) {
            Ok(plan) => plan,
            Err(error) => return fail("compress", error.to_string()),
        };
        let running_label = format!(
            "compressing rebuilt disc as {} (codec={})",
            plan.format,
            plan.codec.as_deref().unwrap_or("default")
        );
        let (compress_report, codec_label) = match self.run_patch_apply_compression(
            &plan,
            vec![sheet.to_path_buf()],
            overrides,
            running_label,
            context,
        ) {
            Ok(result) => result,
            Err(error) => return fail("compress", error.to_string()),
        };
        if compress_report.status != OperationStatus::Succeeded {
            return fail(
                "compress",
                format!("rebuilt disc compression failed: {}", compress_report.label),
            );
        }
        *label = format!(
            "{label}; rebuilt disc compressed as {} (codec={codec_label}, path=`{}`)",
            plan.format,
            plan.output_path.display()
        );
        OperationReport::succeeded(
            OperationFamily::Patch,
            Some(plan.format.clone()),
            "compress",
            label.clone(),
            Some(100.0),
            compress_report.thread_execution,
        )
    }
}
