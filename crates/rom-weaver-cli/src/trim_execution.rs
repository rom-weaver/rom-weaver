use super::*;
use crate::path_access::paths_refer_to_same_file;

/// The mode/operation settings for a single trim operation, grouped so `trim_file` takes one
/// request descriptor instead of four positional flags.
#[derive(Clone, Copy)]
pub(super) struct TrimRequest {
    pub(super) in_place: bool,
    pub(super) dry_run: bool,
    pub(super) operation: TrimOperation,
    pub(super) kind: TrimInputKind,
    /// Append the original size and detected fill byte for a later padding restore.
    pub(super) revert_marker: bool,
}

/// Where a trim writes its result for a given destination path.
pub(super) enum TrimOutputPlan {
    /// The destination itself holds the trimmed file (or, for a GameCube/Wii disc, the RVZ).
    Direct,
    /// The result is packed inside the destination container under `entry_name`.
    Pack {
        handler: Arc<dyn ContainerHandler>,
        entry_name: String,
        /// The format name passed to the container's `create`; a media-layout variant such as
        /// `chd-dvd` where the container name alone would be inferred from the file.
        create_format: &'static str,
    },
}

impl CliApp {
    pub(super) fn trim_file(
        &self,
        source: &Path,
        destination: &Path,
        request: TrimRequest,
        context: &OperationContext,
    ) -> Result<NdsTrimOutcome> {
        let TrimRequest {
            in_place,
            dry_run,
            operation,
            kind,
            revert_marker,
        } = request;

        Self::validate_trim_destination(source, destination, in_place)?;

        let supports_revert = matches!(
            kind,
            TrimInputKind::NdsFamily | TrimInputKind::Gba | TrimInputKind::ThreeDs
        );
        if operation == TrimOperation::Trim && revert_marker && !supports_revert {
            return Err(RomWeaverError::Validation(format!(
                "{} trim does not support --revert-marker; the original disc layout cannot be reconstructed from padding",
                kind.mode_label()
            )));
        }

        // Stored size and fill take precedence over format-specific restoration heuristics.
        if operation == TrimOperation::Revert
            && supports_revert
            && let Some(footer) = Self::read_revert_footer(source)?
        {
            return Self::revert_with_footer(source, destination, in_place, dry_run, kind, footer);
        }

        // The source fill MUST be captured before an in-place trim removes its padding.
        let restore_fill = if operation == TrimOperation::Trim && revert_marker && !dry_run {
            Some(Self::detect_trailing_pad_byte(source)?.unwrap_or(0xFF))
        } else {
            None
        };

        let outcome = match kind {
            TrimInputKind::NdsFamily => {
                Self::trim_nds_file(source, destination, in_place, dry_run, operation)
            }
            TrimInputKind::Gba | TrimInputKind::ThreeDs => Self::trim_power_of_two_file(
                source,
                destination,
                in_place,
                dry_run,
                operation,
                kind,
            ),
            TrimInputKind::Xiso => {
                Self::trim_xiso_file(source, destination, in_place, dry_run, operation)
            }
            TrimInputKind::RvzConvert => self.trim_rvz_convert_file(
                source,
                destination,
                in_place,
                dry_run,
                operation,
                context,
            ),
        }?;

        // Unchanged files need no restoration metadata.
        if let Some(pad_byte) = restore_fill
            && !outcome.already_target_size
        {
            Self::write_revert_footer(&outcome.output_path, outcome.original_size, pad_byte)?;
        }

        Ok(outcome)
    }

    pub(super) fn trim_nds_file(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
    ) -> Result<NdsTrimOutcome> {
        Self::validate_trim_destination(source, destination, in_place)?;
        let mutate_source = in_place || source == destination;
        let mut input = File::options()
            .read(true)
            .write(mutate_source && !dry_run)
            .open(source)?;
        let original_size = input.metadata()?.len();
        if original_size < NDS_HEADER_TOTAL_BYTES as u64 {
            return Err(RomWeaverError::Validation(format!(
                "input is too small to contain a valid NDS/DSi header: `{}`",
                source.display()
            )));
        }

        let plan = Self::read_nds_trim_plan(
            &mut input,
            original_size,
            operation == TrimOperation::Revert,
            0,
        )?;
        let (target_size, already_target_size, fill_byte) = match operation {
            TrimOperation::Trim => (
                original_size.min(plan.trimmed_size),
                original_size <= plan.trimmed_size,
                0x00_u8,
            ),
            TrimOperation::Revert => {
                let mut revert_size = Self::power_of_two_target_size_for_revert(original_size)?;
                if revert_size < plan.trimmed_size {
                    revert_size = plan.trimmed_size;
                }
                // Without a footer, use conventional 0xFF padding; the original fill is unknown.
                (revert_size, original_size == revert_size, 0xFF_u8)
            }
        };

        if dry_run {
            return Ok(NdsTrimOutcome {
                original_size,
                result_size: target_size,
                output_path: if in_place {
                    source.to_path_buf()
                } else {
                    destination.to_path_buf()
                },
                mode: if plan.dsi_mode { "dsi" } else { "ds" },
                preserved_download_play_cert: plan.preserved_download_play_cert,
                already_target_size,
                revert_supported: true,
            });
        }

        Self::apply_file_size_target(
            source,
            destination,
            in_place,
            original_size,
            target_size,
            fill_byte,
        )?;

        Ok(NdsTrimOutcome {
            original_size,
            result_size: target_size,
            output_path: if in_place {
                source.to_path_buf()
            } else {
                destination.to_path_buf()
            },
            mode: if plan.dsi_mode { "dsi" } else { "ds" },
            preserved_download_play_cert: plan.preserved_download_play_cert,
            already_target_size,
            revert_supported: true,
        })
    }

    pub(super) fn trim_power_of_two_file(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
        kind: TrimInputKind,
    ) -> Result<NdsTrimOutcome> {
        Self::validate_trim_destination(source, destination, in_place)?;
        let original_size = fs::metadata(source)?.len();
        let minimum_size = if kind == TrimInputKind::ThreeDs {
            Self::three_ds_data_extent(source, original_size, operation == TrimOperation::Revert)?
        } else {
            1
        };
        if original_size == 0 {
            return Err(RomWeaverError::Validation(format!(
                "input is empty and cannot be processed: `{}`",
                source.display()
            )));
        }

        let fill_byte = kind.default_padding_byte();
        let (target_size, already_target_size) = match operation {
            TrimOperation::Trim => {
                // Detect the actual trailing pad byte (0x00 or 0xFF) so both conventions trim,
                // instead of assuming a single fixed fill. Files that do not end in recognizable
                // padding are left untouched.
                match Self::detect_trailing_pad_byte(source)? {
                    Some(pad_byte) => {
                        let trimmed_size =
                            Self::scan_trimmed_size_from_trailing_padding(source, pad_byte)?
                                .max(minimum_size);
                        (trimmed_size, trimmed_size == original_size)
                    }
                    None => (original_size, true),
                }
            }
            TrimOperation::Revert => {
                let revert_size =
                    Self::power_of_two_target_size_for_revert(original_size)?.max(minimum_size);
                (revert_size, revert_size == original_size)
            }
        };

        if dry_run {
            return Ok(NdsTrimOutcome {
                original_size,
                result_size: target_size,
                output_path: if in_place {
                    source.to_path_buf()
                } else {
                    destination.to_path_buf()
                },
                mode: kind.mode_label(),
                preserved_download_play_cert: false,
                already_target_size,
                revert_supported: true,
            });
        }

        Self::apply_file_size_target(
            source,
            destination,
            in_place,
            original_size,
            target_size,
            fill_byte,
        )?;

        Ok(NdsTrimOutcome {
            original_size,
            result_size: target_size,
            output_path: if in_place {
                source.to_path_buf()
            } else {
                destination.to_path_buf()
            },
            mode: kind.mode_label(),
            preserved_download_play_cert: false,
            already_target_size,
            revert_supported: true,
        })
    }

    pub(super) fn trim_xiso_file(
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
    ) -> Result<NdsTrimOutcome> {
        if operation == TrimOperation::Revert {
            return Err(RomWeaverError::Validation(
                "xiso trim revert is not supported; trimmed padding cannot be reconstructed"
                    .to_string(),
            ));
        }

        let original_size = fs::metadata(source)?.len();
        if original_size == 0 {
            return Err(RomWeaverError::Validation(format!(
                "input is empty and cannot be processed: `{}`",
                source.display()
            )));
        }

        if dry_run {
            let result_size = Self::measure_trimmed_xiso_size(source).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "xiso trim simulation failed while rebuilding `{}`: {error}",
                    source.display()
                ))
            })?;
            return Ok(NdsTrimOutcome {
                original_size,
                result_size,
                output_path: if in_place {
                    source.to_path_buf()
                } else {
                    destination.to_path_buf()
                },
                mode: TrimInputKind::Xiso.mode_label(),
                preserved_download_play_cert: false,
                already_target_size: result_size == original_size,
                revert_supported: false,
            });
        }

        if in_place || source == destination {
            let temp_path = Self::temporary_xiso_trim_path(source);
            // A failed build leaves a partial temp beside the user's ROM; remove it before
            // propagating so repeated failed trims don't accumulate multi-GB junk.
            if let Err(build_error) = Self::create_trimmed_xiso(source, &temp_path) {
                fs::remove_file(&temp_path).ok();
                return Err(build_error);
            }
            // Only rename can replace the source atomically. Never fall back to copy-over-source:
            // a partial copy would destroy the original with no way back. Rename failure leaves the
            // source untouched, so surface where the intact trimmed image lives instead.
            if let Err(rename_error) = fs::rename(&temp_path, source) {
                tracing::debug!(
                    source = %source.display(),
                    temp = %temp_path.display(),
                    error = %rename_error,
                    "xiso in-place trim rename failed; leaving source untouched"
                );
                return Err(RomWeaverError::Validation(format!(
                    "failed to replace `{}` with the trimmed xiso (rename error: {rename_error}); the original was left untouched and the trimmed image is intact at `{}`",
                    source.display(),
                    temp_path.display()
                )));
            }
            let result_size = fs::metadata(source)?.len();
            return Ok(NdsTrimOutcome {
                original_size,
                result_size,
                output_path: source.to_path_buf(),
                mode: TrimInputKind::Xiso.mode_label(),
                preserved_download_play_cert: false,
                already_target_size: result_size == original_size,
                revert_supported: false,
            });
        }

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        Self::create_trimmed_xiso(source, destination)?;
        let result_size = fs::metadata(destination)?.len();
        Ok(NdsTrimOutcome {
            original_size,
            result_size,
            output_path: destination.to_path_buf(),
            mode: TrimInputKind::Xiso.mode_label(),
            preserved_download_play_cert: false,
            already_target_size: result_size == original_size,
            revert_supported: false,
        })
    }

    /// Decide what a trim destination asks for, from its extension, the way `compress` and
    /// `patch apply` read an output name: an archive or container extension packs the result
    /// inside it, but only a container valid for this kind of input; any other container name
    /// is an error, so a trimmed file is never written under a name that misdescribes it.
    /// Names that match no container write the trimmed file itself.
    pub(super) fn plan_trim_output(
        &self,
        kind: TrimInputKind,
        source: &Path,
        destination: &Path,
    ) -> Result<TrimOutputPlan> {
        let subject = kind.output_subject();
        let extension = destination
            .extension()
            .map(|extension| extension.to_string_lossy().to_ascii_lowercase());
        let Some(handler) = self.containers.find_by_output_extension(destination) else {
            // A GameCube/Wii trim writes RVZ, so any other extension would misname it. Only an
            // extensionless name (such as the staging file behind `--output -`) is left alone.
            if kind == TrimInputKind::RvzConvert && extension.is_some() {
                debug!(destination = %destination.display(), "rvz-convert trim rejected a non-rvz output name");
                return Err(RomWeaverError::Validation(format!(
                    "`{}` is not a valid trim output for {subject}: trim converts them to RVZ, so the name must end in .rvz, .zip, or .7z; use `extract` to write the disc as a plain image",
                    destination.display()
                )));
            }
            return Ok(TrimOutputPlan::Direct);
        };
        let descriptor = handler.descriptor();
        let format = descriptor.name;
        if kind
            .direct_output_format()
            .is_some_and(|direct| descriptor.matches_name(direct))
        {
            return Ok(TrimOutputPlan::Direct);
        }
        // A 3DS trim input is always a `.3ds` cartridge image, but the other Z3DS descriptor
        // extensions (`.zcci`, `.zcxi`, `.zcia`, `.z3dsx`) name different payload types and make
        // `extract` write a file of that type (`.zcia` -> `.cia`) around the cartridge image.
        if kind == TrimInputKind::ThreeDs
            && descriptor.matches_name("z3ds")
            && !extension
                .as_deref()
                .is_some_and(|extension| extension == "z3ds")
        {
            debug!(
                destination = %destination.display(),
                "3ds trim rejected a Z3DS descriptor extension other than .z3ds"
            );
            return Err(RomWeaverError::Validation(format!(
                "`{}` is not a valid trim output for {subject}: a trimmed .3ds is a cartridge image, so a Z3DS output must end in .z3ds (the .zcci, .zcxi, .zcia and .z3dsx names mark other 3DS file types)",
                destination.display()
            )));
        }
        let packable = kind.packable_output_formats();
        if !handler.capabilities().create
            || !packable.iter().any(|name| descriptor.matches_name(name))
        {
            let accepted = kind
                .direct_output_format()
                .into_iter()
                .chain(packable.iter().copied())
                .map(|name| format!(".{name}"))
                .collect::<Vec<_>>()
                .join(", ");
            debug!(
                destination = %destination.display(),
                format,
                ?kind,
                "trim rejected an output container that is not valid for the input"
            );
            // GameCube/Wii trims reject every plain extension, so only the other kinds can be
            // told to use a plain name.
            let plain_name = if kind == TrimInputKind::RvzConvert {
                String::new()
            } else {
                let source_extension = source
                    .extension()
                    .map(|extension| format!(" such as `.{}`", extension.to_string_lossy()))
                    .unwrap_or_default();
                format!(
                    ", or be a plain name{source_extension} that writes the trimmed file itself"
                )
            };
            return Err(RomWeaverError::Validation(format!(
                "{} is not a valid trim output for {subject}: `{}` must end in one of {accepted}{plain_name}",
                format.to_ascii_uppercase(),
                destination.display()
            )));
        }
        let entry_name = Self::trim_pack_entry_name(kind, source, destination);
        // CHD infers its media from the packed file, which would build a CD or raw CHD for an
        // XISO; it is a DVD-class disc, so ask for the DVD layout outright.
        let create_format = if kind == TrimInputKind::Xiso && descriptor.matches_name("chd") {
            "chd-dvd"
        } else {
            format
        };
        debug!(
            destination = %destination.display(),
            format,
            entry_name,
            "trim output will be packed into a container"
        );
        Ok(TrimOutputPlan::Pack {
            handler,
            entry_name,
            create_format,
        })
    }

    /// The name the trimmed file carries inside its container: the destination's name without
    /// the container extension, ending in the extension the trimmed file has (`.rvz` for a
    /// GameCube/Wii conversion, else the source's own). `game.zip` packs `game.nds`;
    /// `game.nds.zip` packs `game.nds`; `v1.2.zip` packs `v1.2.nds`.
    fn trim_pack_entry_name(kind: TrimInputKind, source: &Path, destination: &Path) -> String {
        let stem = destination
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .filter(|stem| !stem.is_empty())
            .unwrap_or_else(|| "trimmed".to_string());
        let payload_extension = if kind == TrimInputKind::RvzConvert {
            Some("rvz".to_string())
        } else {
            source
                .extension()
                .map(|extension| extension.to_string_lossy().into_owned())
                .filter(|extension| !extension.is_empty())
        };
        match payload_extension {
            Some(extension)
                if !stem
                    .to_ascii_lowercase()
                    .ends_with(&format!(".{extension}").to_ascii_lowercase()) =>
            {
                format!("{stem}.{extension}")
            }
            _ => stem,
        }
    }

    /// Run [`Self::trim_file`] for a destination that may be a container. A packed output is
    /// trimmed into a scratch file named as it will be inside the container, then packed with
    /// the container's own `create`; a dry run only reports the container as the output.
    /// For a completed GameCube/Wii conversion the second value is the disc's logical size,
    /// read from the RVZ itself (before it is packed away from the scratch file).
    pub(super) fn trim_file_into_output(
        &self,
        source: &Path,
        destination: &Path,
        plan: &TrimOutputPlan,
        request: TrimRequest,
        context: &OperationContext,
    ) -> Result<(NdsTrimOutcome, Option<u64>)> {
        let logical_size = |rvz: &Path| {
            (request.kind == TrimInputKind::RvzConvert && !request.dry_run)
                .then(|| self.rvz_logical_size(rvz, context))
                .flatten()
        };
        let TrimOutputPlan::Pack {
            handler,
            entry_name,
            create_format,
        } = plan
        else {
            let outcome = self.trim_file(source, destination, request, context)?;
            let size = logical_size(&outcome.output_path);
            return Ok((outcome, size));
        };
        if request.dry_run {
            return Ok((self.trim_file(source, destination, request, context)?, None));
        }
        let scratch = context.temp_paths().next_path("trim-pack", None);
        fs::create_dir_all(&scratch)?;
        let trimmed = scratch.join(entry_name);
        let result = self
            .trim_file(source, &trimmed, request, context)
            .and_then(|mut outcome| {
                let size = logical_size(&trimmed);
                Self::pack_trimmed_output(
                    handler.as_ref(),
                    entry_name,
                    create_format,
                    &trimmed,
                    destination,
                    context,
                )?;
                outcome.output_path = destination.to_path_buf();
                Ok((outcome, size))
            });
        if let Err(error) = fs::remove_dir_all(&scratch) {
            debug!(scratch = %scratch.display(), %error, "trim pack scratch cleanup failed");
        }
        result
    }

    /// The uncompressed disc size recorded inside an RVZ, if it can be read.
    fn rvz_logical_size(&self, rvz: &Path, context: &OperationContext) -> Option<u64> {
        let handler = self.containers.find_by_name("rvz")?;
        let entries = handler
            .list_entry_records(
                &ContainerProbeRequest {
                    source: rvz.to_path_buf(),
                    split_bin: false,
                },
                context,
            )
            .ok()?;
        entries.first().and_then(|entry| entry.size)
    }

    /// Pack `trimmed` into `destination` with `handler`, keeping an existing file at the
    /// destination if the pack fails (the same staging `compress` uses for `--force`).
    fn pack_trimmed_output(
        handler: &dyn ContainerHandler,
        entry_name: &str,
        create_format: &str,
        trimmed: &Path,
        destination: &Path,
        context: &OperationContext,
    ) -> Result<()> {
        let format = handler.descriptor().name;
        let names_entries =
            handler.descriptor().matches_name("zip") || handler.descriptor().matches_name("7z");
        if let Some(parent) = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }
        let staged = StagedOutput::new(destination)?;
        trace!(
            format,
            entry_name,
            trimmed = %trimmed.display(),
            destination = %destination.display(),
            "packing trimmed output"
        );
        let report = handler.create(
            &ContainerCreateRequest {
                rvz_block_size: None,
                archive_names: names_entries.then(|| vec![entry_name.to_string()]),
                inputs: vec![trimmed.to_path_buf()],
                output: staged.path().to_path_buf(),
                format: create_format.to_string(),
                codec: None,
                level: None,
                parent: None,
            },
            context,
        )?;
        if report.status != OperationStatus::Succeeded {
            return Err(RomWeaverError::Validation(format!(
                "packing the trimmed output into {} failed: {}",
                format.to_ascii_uppercase(),
                report.label
            )));
        }
        context.cancel().check()?;
        staged.commit()
    }

    pub(super) fn trim_rvz_convert_file(
        &self,
        source: &Path,
        destination: &Path,
        in_place: bool,
        dry_run: bool,
        operation: TrimOperation,
        context: &OperationContext,
    ) -> Result<NdsTrimOutcome> {
        if operation == TrimOperation::Revert {
            return Err(RomWeaverError::Validation(
                "rvz-convert trim revert is not supported; original source container layout cannot be reconstructed"
                    .to_string(),
            ));
        }

        if in_place || paths_refer_to_same_file(source, destination) {
            return Err(RomWeaverError::Validation(
                "rvz-convert trim requires a separate output file; in-place replacement is not supported"
                    .to_string(),
            ));
        }

        let original_size = fs::metadata(source)?.len();
        if original_size == 0 {
            return Err(RomWeaverError::Validation(format!(
                "input is empty and cannot be processed: `{}`",
                source.display()
            )));
        }

        if dry_run {
            let result_size =
                self.measure_rvz_converted_size(source, context)
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "rvz-convert trim simulation failed while rebuilding `{}`: {error}",
                            source.display()
                        ))
                    })?;
            return Ok(NdsTrimOutcome {
                original_size,
                result_size,
                output_path: if in_place {
                    source.to_path_buf()
                } else {
                    destination.to_path_buf()
                },
                mode: TrimInputKind::RvzConvert.mode_label(),
                preserved_download_play_cert: false,
                already_target_size: result_size == original_size,
                revert_supported: false,
            });
        }

        self.create_rvz_converted_output(source, destination, context)?;
        let result_size = fs::metadata(destination)?.len();
        Ok(NdsTrimOutcome {
            original_size,
            result_size,
            output_path: destination.to_path_buf(),
            mode: TrimInputKind::RvzConvert.mode_label(),
            preserved_download_play_cert: false,
            already_target_size: result_size == original_size,
            revert_supported: false,
        })
    }

    pub(super) fn create_rvz_converted_output(
        &self,
        source: &Path,
        destination: &Path,
        context: &OperationContext,
    ) -> Result<()> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let handler = self
            .containers
            .find_by_name("rvz")
            .ok_or(RomWeaverError::Unsupported(
                UnsupportedOp::HandlerNotRegistered {
                    handler: "rvz",
                    feature: "rvz-convert trim",
                },
            ))?;
        handler
            .create(
                &ContainerCreateRequest {
                    rvz_block_size: None,
                    archive_names: None,
                    inputs: vec![source.to_path_buf()],
                    output: destination.to_path_buf(),
                    format: "rvz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "rvz-convert trim failed while rebuilding `{}`: {error}",
                    source.display()
                ))
            })?;
        Ok(())
    }

    pub(super) fn measure_rvz_converted_size(
        &self,
        source: &Path,
        context: &OperationContext,
    ) -> Result<u64> {
        let handler = self
            .containers
            .find_by_name("rvz")
            .ok_or(RomWeaverError::Unsupported(
                UnsupportedOp::HandlerNotRegistered {
                    handler: "rvz",
                    feature: "rvz-convert trim",
                },
            ))?;
        handler
            .create_dry_run_size(
                &ContainerCreateRequest {
                    rvz_block_size: None,
                    archive_names: None,
                    inputs: vec![source.to_path_buf()],
                    output: source.with_extension("rvz"),
                    format: "rvz".to_string(),
                    codec: None,
                    level: None,
                    parent: None,
                },
                context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "rvz-convert trim simulation failed while rebuilding `{}`: {error}",
                    source.display()
                ))
            })
    }

    pub(super) fn open_xiso_trim_source_filesystem(
        source_path: &Path,
    ) -> Result<XisoTrimSourceFilesystem> {
        let source_file = File::options()
            .read(true)
            .open(source_path)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open xiso source `{}`: {error}",
                    source_path.display()
                ))
            })?;
        let source_reader = BufReader::new(source_file);
        let source_device = XdvdfsOffsetWrapper::new(source_reader).map_err(|error| {
            RomWeaverError::Validation(format!(
                "source `{}` is not an Xbox XDVDFS image (raw/XGD probe failed: {error})",
                source_path.display()
            ))
        })?;
        XdvdfsFilesystem::new(source_device).ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "source `{}` could not be read as an XDVDFS filesystem",
                source_path.display()
            ))
        })
    }

    pub(super) fn create_trimmed_xiso(source: &Path, destination: &Path) -> Result<()> {
        let mut source_fs = Self::open_xiso_trim_source_filesystem(source)?;
        let output = File::create(destination)?;
        let mut output = BufWriter::new(output);
        create_xdvdfs_image(&mut source_fs, &mut output, |_| {}).map_err(|error| {
            RomWeaverError::Validation(format!(
                "xiso trim failed while rebuilding `{}`: {error}",
                source.display()
            ))
        })?;
        output.flush()?;
        Ok(())
    }

    pub(super) fn measure_trimmed_xiso_size(source: &Path) -> Result<u64> {
        let mut source_fs = Self::open_xiso_trim_source_filesystem(source)?;
        let mut sink = XisoMeasuredLengthSink::default();
        create_xdvdfs_image(&mut source_fs, &mut sink, |_| {}).map_err(|error| {
            RomWeaverError::Validation(format!(
                "xiso trim failed while rebuilding `{}`: {error}",
                source.display()
            ))
        })?;
        Ok(sink.output_len())
    }

    pub(super) fn temporary_xiso_trim_path(source: &Path) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let name = source
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "xiso".to_string());
        let temp_name = format!(
            ".{name}.{}-{}-{timestamp}",
            XISO_TRIM_TEMP_SUFFIX,
            Self::runtime_process_id()
        );
        source
            .parent()
            .map(|parent| parent.join(&temp_name))
            .unwrap_or_else(|| PathBuf::from(temp_name))
    }

    pub(super) fn apply_file_size_target(
        source: &Path,
        destination: &Path,
        in_place: bool,
        original_size: u64,
        target_size: u64,
        fill_byte: u8,
    ) -> Result<()> {
        Self::validate_trim_destination(source, destination, in_place)?;
        if in_place || source == destination {
            let mut input = File::options().read(true).write(true).open(source)?;
            if target_size < original_size {
                input.set_len(target_size)?;
            } else if target_size > original_size {
                input.seek(SeekFrom::Start(original_size))?;
                Self::write_padding_bytes(&mut input, target_size - original_size, fill_byte)?;
            }
            return Ok(());
        }

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut input = BufReader::new(File::open(source)?);
        let mut output = BufWriter::new(File::create(destination)?);
        let copy_len = original_size.min(target_size);
        let mut limited = std::io::Read::by_ref(&mut input).take(copy_len);
        rom_weaver_core::copy_retrying_interrupted(&mut limited, &mut output)?;
        // `Take` counts down across retried attempts, so what remains is what was never copied.
        let copied = copy_len - limited.limit();
        if copied != copy_len {
            return Err(RomWeaverError::Validation(format!(
                "trim source ended after {copied} bytes; expected {copy_len} bytes"
            )));
        }
        if target_size > copy_len {
            Self::write_padding_bytes(&mut output, target_size - copy_len, fill_byte)?;
        }
        output.flush()?;
        Ok(())
    }

    fn validate_trim_destination(source: &Path, destination: &Path, in_place: bool) -> Result<()> {
        if !in_place && source != destination && paths_refer_to_same_file(source, destination) {
            return Err(RomWeaverError::Validation(
                "trim output refers to the input file; use --in-place for intentional replacement"
                    .into(),
            ));
        }
        Ok(())
    }

    fn three_ds_media_unit(header: &[u8; 0x200]) -> Result<u64> {
        // Sizes MUST use the unit exponent in the NCSD/NCCH flags, rather than assuming 512-byte units.
        // https://www.3dbrew.org/wiki/NCSD#Partition_Flags and https://www.3dbrew.org/wiki/NCCH#NCCH_Flags
        let shift = u32::from(header[0x18E]);
        if shift > 22 {
            return Err(RomWeaverError::Validation(
                "invalid 3DS media unit size".into(),
            ));
        }
        Ok(0x200_u64 << shift)
    }

    fn three_ds_data_extent(source: &Path, file_size: u64, reverting: bool) -> Result<u64> {
        let mut file = File::open(source)?;
        let mut header = [0_u8; 0x200];
        file.read_exact(&mut header)?;
        let unit = Self::three_ds_media_unit(&header)?;
        let extent = match &header[0x100..0x104] {
            b"NCCH" => u64::from(Self::read_u32_le(&header, 0x104, "NCCH size")?) * unit,
            b"NCSD" => {
                let media_size =
                    u64::from(Self::read_u32_le(&header, 0x104, "NCSD media size")?) * unit;
                let mut end = 0x200;
                let mut partitions = Vec::new();
                for index in 0..8 {
                    let offset = u64::from(Self::read_u32_le(
                        &header,
                        0x120 + index * 8,
                        "partition offset",
                    )?) * unit;
                    let length = u64::from(Self::read_u32_le(
                        &header,
                        0x124 + index * 8,
                        "partition size",
                    )?) * unit;
                    if length == 0 {
                        if offset != 0 {
                            return Err(RomWeaverError::Validation(
                                "NCSD partition has an offset but no size".into(),
                            ));
                        }
                        continue;
                    }
                    let partition_end = offset + length;
                    if offset < 0x200 || partition_end > media_size || length < 0x200 {
                        return Err(RomWeaverError::Validation(
                            "invalid NCSD partition extent".into(),
                        ));
                    }
                    if partitions.iter().any(|&(start, previous_end)| {
                        offset < previous_end && start < partition_end
                    }) {
                        return Err(RomWeaverError::Validation(
                            "overlapping NCSD partitions".into(),
                        ));
                    }
                    partitions.push((offset, partition_end));
                    // NAND partitions MUST NOT be treated as cartridge NCCH content.
                    // https://www.3dbrew.org/wiki/NCSD#NCSD_Header
                    if header[0x110 + index] != 0 {
                        return Err(RomWeaverError::Validation(
                            "unsupported NCSD partition filesystem".into(),
                        ));
                    }
                    file.seek(SeekFrom::Start(offset))?;
                    let mut partition_header = [0_u8; 0x200];
                    file.read_exact(&mut partition_header)?;
                    let content_size =
                        u64::from(Self::read_u32_le(&partition_header, 0x104, "NCCH size")?)
                            * Self::three_ds_media_unit(&partition_header)?;
                    if &partition_header[0x100..0x104] != b"NCCH"
                        || content_size < 0x200
                        || content_size > length
                    {
                        return Err(RomWeaverError::Validation(
                            "invalid NCCH partition header or size".into(),
                        ));
                    }
                    end = end.max(partition_end);
                }
                if partitions.is_empty() {
                    return Err(RomWeaverError::Validation(
                        "NCSD contains no partitions".into(),
                    ));
                }
                end
            }
            _ => {
                return Err(RomWeaverError::Validation(
                    "3DS input must contain an NCSD or NCCH header".into(),
                ));
            }
        };
        if extent < 0x200 || (!reverting && extent > file_size) {
            return Err(RomWeaverError::Validation(
                "3DS data extent is invalid or exceeds the input size".into(),
            ));
        }
        Ok(extent)
    }

    pub(super) fn write_padding_bytes(
        writer: &mut dyn Write,
        length: u64,
        fill_byte: u8,
    ) -> io::Result<()> {
        if length == 0 {
            return Ok(());
        }

        let chunk = [fill_byte; 8192];
        let mut remaining = length;
        while remaining > 0 {
            let write_len =
                usize::try_from(remaining.min(chunk.len() as u64)).unwrap_or(chunk.len());
            writer.write_all(&chunk[..write_len])?;
            remaining -= write_len as u64;
        }
        Ok(())
    }

    pub(super) fn read_nds_trim_plan(
        input: &mut File,
        file_size: u64,
        allow_boundary_past_eof: bool,
        start_offset: u64,
    ) -> Result<NdsTrimPlan> {
        let mut header = vec![0_u8; NDS_HEADER_TOTAL_BYTES];
        input.seek(SeekFrom::Start(start_offset))?;
        input.read_exact(&mut header)?;
        Self::validate_nds_header(&header)?;

        let unit_code = header[NDS_HEADER_UNIT_CODE_OFFSET];
        let dsi_mode = unit_code != 0x00;
        let ntr_rom_size = u64::from(Self::read_u32_le(
            &header,
            NDS_HEADER_NTR_ROM_SIZE_OFFSET,
            "NTR ROM size",
        )?);
        let ntr_twl_rom_size = u64::from(Self::read_u32_le(
            &header,
            NDS_HEADER_NTR_TWL_ROM_SIZE_OFFSET,
            "NTR+TWL ROM size",
        )?);

        let mut trimmed_size = if dsi_mode {
            ntr_twl_rom_size
        } else {
            ntr_rom_size
        };
        if trimmed_size == 0 {
            return Err(RomWeaverError::Validation(
                "NDS header reported a zero trim boundary".into(),
            ));
        }

        let header_size = u64::from(Self::read_u32_le(
            &header,
            NDS_HEADER_HEADER_SIZE_OFFSET,
            "header size",
        )?);
        let mut minimum_size = header_size.max(if dsi_mode { 0x1000 } else { 0x160 });
        let mut regions = vec![
            (0x20, 0x2C),
            (0x30, 0x3C),
            (0x40, 0x44),
            (0x48, 0x4C),
            (0x50, 0x54),
            (0x58, 0x5C),
        ];
        if dsi_mode {
            regions.extend([(0x1C0, 0x1CC), (0x1D0, 0x1DC)]);
        }
        for (offset_field, size_field) in regions {
            let offset = u64::from(Self::read_u32_le(&header, offset_field, "data offset")?);
            let length = u64::from(Self::read_u32_le(&header, size_field, "data size")?);
            if length != 0 {
                minimum_size = minimum_size.max(offset + length);
            }
        }
        let banner = u64::from(Self::read_u32_le(&header, 0x68, "banner offset")?);
        if banner != 0 {
            input.seek(SeekFrom::Start(start_offset + banner))?;
            let mut version = [0; 2];
            input.read_exact(&mut version)?;
            let banner_size = match u16::from_le_bytes(version) {
                1 => 0x840,
                2 => 0x940,
                3 => 0xA40,
                0x103 => 0x23C0,
                version => {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported NDS banner version {version:#X}"
                    )));
                }
            };
            minimum_size = minimum_size.max(banner + banner_size);
        }
        if trimmed_size < minimum_size {
            return Err(RomWeaverError::Validation(format!(
                "NDS trim boundary ({trimmed_size} bytes) is below the header or referenced data extent ({minimum_size} bytes)"
            )));
        }

        let mut preserved_download_play_cert = false;
        if !dsi_mode && trimmed_size + 2 <= file_size {
            input.seek(SeekFrom::Start(start_offset.saturating_add(trimmed_size)))?;
            let mut cert_magic = [0_u8; 2];
            input.read_exact(&mut cert_magic)?;
            if cert_magic == NDS_DOWNLOAD_PLAY_CERT_MAGIC {
                trimmed_size = trimmed_size.saturating_add(NDS_DOWNLOAD_PLAY_CERT_SIZE_BYTES);
                preserved_download_play_cert = true;
            }
        }

        if trimmed_size > file_size && !allow_boundary_past_eof {
            return Err(RomWeaverError::Validation(format!(
                "trim boundary ({trimmed_size} byte(s)) exceeds input size ({file_size} byte(s)); input may already be incorrectly trimmed or corrupt"
            )));
        }

        Ok(NdsTrimPlan {
            trimmed_size,
            dsi_mode,
            preserved_download_play_cert,
        })
    }

    pub(super) fn validate_nds_header(header: &[u8]) -> Result<()> {
        if header.len() < NDS_HEADER_TOTAL_BYTES {
            return Err(RomWeaverError::Validation(
                "NDS header buffer is truncated".into(),
            ));
        }

        let header_size = Self::read_u32_le(header, NDS_HEADER_HEADER_SIZE_OFFSET, "header size")?;
        if header_size < 0x160 {
            return Err(RomWeaverError::Validation(format!(
                "invalid NDS header size {header_size:#X}; expected at least 0x160"
            )));
        }

        let logo = &header[NDS_HEADER_LOGO_OFFSET..NDS_HEADER_LOGO_OFFSET + NDS_HEADER_LOGO_LENGTH];
        let expected_logo_crc = Self::read_u16_le(header, NDS_HEADER_LOGO_CRC_OFFSET, "logo CRC")?;
        let calculated_logo_crc = Self::nds_crc16(logo);
        if expected_logo_crc != calculated_logo_crc {
            return Err(RomWeaverError::Validation(format!(
                "NDS logo CRC mismatch: expected {expected_logo_crc:04X}, got {calculated_logo_crc:04X}"
            )));
        }

        let expected_header_crc = Self::read_u16_le(header, NDS_HEADER_CRC_OFFSET, "header CRC")?;
        let calculated_header_crc = Self::nds_crc16(&header[..NDS_HEADER_CRC_OFFSET]);
        if expected_header_crc != calculated_header_crc {
            return Err(RomWeaverError::Validation(format!(
                "NDS header CRC mismatch: expected {expected_header_crc:04X}, got {calculated_header_crc:04X}"
            )));
        }

        Ok(())
    }

    pub(super) fn nds_crc16(bytes: &[u8]) -> u16 {
        let mut crc = 0xFFFF_u16;
        for byte in bytes {
            crc ^= u16::from(*byte);
            for _ in 0..8 {
                let carry = (crc & 1) != 0;
                crc >>= 1;
                if carry {
                    crc ^= 0xA001;
                }
            }
        }
        crc
    }

    pub(super) fn read_u16_le(buffer: &[u8], offset: usize, label: &str) -> Result<u16> {
        let bytes = buffer.get(offset..offset + 2).ok_or_else(|| {
            RomWeaverError::Validation(format!("missing {label} bytes at offset 0x{offset:X}"))
        })?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    pub(super) fn read_u32_le(buffer: &[u8], offset: usize, label: &str) -> Result<u32> {
        let bytes = buffer.get(offset..offset + 4).ok_or_else(|| {
            RomWeaverError::Validation(format!("missing {label} bytes at offset 0x{offset:X}"))
        })?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}

#[cfg(test)]
#[path = "../tests/unit/trim_execution.rs"]
mod tests;
