use super::*;
/// Identifies the operation a progress event belongs to: the command name, its family, and the
/// optional format. Grouped so `emit_running` takes one label instead of three positional values.
#[derive(Clone, Copy)]
pub(super) struct OperationLabel<'a> {
    pub(super) command: &'a str,
    pub(super) family: OperationFamily,
    pub(super) format: Option<&'a str>,
}

impl CliApp {
    pub(super) fn emit_running(
        &self,
        op: OperationLabel,
        stage: impl Into<String>,
        label: impl Into<String>,
        percent: Option<f32>,
        thread_execution: Option<ThreadExecution>,
    ) {
        if !self.emit_progress_events {
            return;
        }

        let OperationLabel {
            command,
            family,
            format,
        } = op;

        let stage = stage.into();
        let label = label.into();
        // Progress is emitted per 1% (≈100 calls per op); tracing every tick floods the log with
        // near-identical lines. Trace only at coarse 10% milestones (and non-percent/indeterminate
        // emits) - enough to spot a stall without burying the rest of the trace. The progress event
        // below is still emitted on every call, so the UI is unaffected.
        if percent.is_none_or(|value| (value as u32).is_multiple_of(10)) {
            trace!(
                command,
                family = ?family,
                format = ?format,
                stage = %stage,
                label = %label,
                percent = ?percent,
                requested_threads = ?thread_execution.as_ref().map(|value| value.requested_threads),
                effective_threads = ?thread_execution.as_ref().map(|value| value.effective_threads),
                thread_mode = ?thread_execution.as_ref().map(|value| value.thread_mode),
                used_parallelism = ?thread_execution.as_ref().map(|value| value.used_parallelism),
                thread_fallback = ?thread_execution.as_ref().map(|value| value.thread_fallback),
                thread_fallback_reason = ?thread_execution
                    .as_ref()
                    .and_then(|value| value.thread_fallback_reason.as_deref()),
                "emitting running progress event"
            );
        }
        let thread_execution = thread_execution.as_ref();
        self.reporter.emit(ProgressEvent {
            command: command.to_string(),
            family,
            format: format.map(str::to_string),
            stage,
            label,
            details: None,
            percent,
            elapsed_ms: None,
            status: OperationStatus::Running,
            ..ProgressEvent::from_thread_execution(thread_execution)
        });
    }

    pub(super) fn context(&self, thread_budget: ThreadBudget) -> OperationContext {
        let temp_root = Self::default_temp_root();
        let reporter: Arc<dyn ProgressSink> = if self.emit_progress_events {
            self.reporter.clone()
        } else {
            Arc::new(ProgressFilterReporter::suppress_running(
                self.reporter.clone(),
            ))
        };
        OperationContext::new(thread_budget, temp_root, reporter, CancellationToken::new())
    }

    pub(super) fn default_temp_root() -> PathBuf {
        if let Some(pwd) = std::env::var_os("PWD").map(PathBuf::from)
            && pwd.is_absolute()
        {
            return pwd.join("rom-weaver-out");
        }

        PathBuf::from("rom-weaver-out")
    }

    pub(super) fn runtime_process_id() -> u32 {
        #[cfg(target_family = "wasm")]
        {
            return 1;
        }

        #[cfg(not(target_family = "wasm"))]
        {
            std::process::id()
        }
    }

    pub(super) fn resolve_codec_level(
        codecs: Vec<String>,
        flag_name: &str,
    ) -> Result<(Option<String>, Option<i32>)> {
        let profile_flag = if flag_name == "--compress-codec" {
            "--compress-level"
        } else {
            "--level"
        };
        let parsed_codecs = Self::parse_codec_entries(codecs, flag_name)?;
        if parsed_codecs.is_empty() {
            return Ok((None, None));
        }

        let mut codec_entries = Vec::with_capacity(parsed_codecs.len());
        let mut level: Option<i32> = None;
        for entry in parsed_codecs {
            let (codec_name, entry_level) = if let Some((name, level_text)) = entry.split_once(':')
            {
                let codec_name = name.trim();
                if codec_name.is_empty() {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} contains an empty codec entry"
                    )));
                }
                let trimmed_level = level_text.trim();
                if trimmed_level.is_empty() {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} level cannot be empty"
                    )));
                }
                let parsed_level = trimmed_level.parse::<i32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "{flag_name} level `{trimmed_level}` is not a valid integer"
                    ))
                })?;
                (codec_name.to_string(), Some(parsed_level))
            } else {
                (entry, None)
            };

            if let Some(entry_level) = entry_level {
                if let Some(existing_level) = level
                    && existing_level != entry_level
                {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} mixes conflicting codec levels ({existing_level} and {entry_level}); use one shared `:level` value or rely on {profile_flag} <min|very-low|low|medium|high|very-high|max>"
                    )));
                }
                level = Some(entry_level);
            }
            codec_entries.push(codec_name);
        }
        Ok((Some(codec_entries.join("+")), level))
    }

    pub(super) fn parse_codec_entries(codecs: Vec<String>, flag_name: &str) -> Result<Vec<String>> {
        let mut entries = Vec::new();
        for raw in codecs {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} cannot be empty"
                )));
            }
            for entry in trimmed.split([',', '+']) {
                let entry = entry.trim();
                if entry.is_empty() {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} contains an empty codec entry"
                    )));
                }
                entries.push(entry.to_string());
            }
        }
        Ok(entries)
    }

    pub(super) fn primary_codec_name(codec: Option<&str>) -> Option<&str> {
        codec.and_then(|value| {
            value
                .split([',', '+'])
                .map(str::trim)
                .find(|entry| !entry.is_empty())
        })
    }

    pub(super) fn resolve_compression_level_for_profile(
        format_name: &str,
        codec: Option<&str>,
        explicit_level: Option<i32>,
        profile: CompressionLevelProfile,
    ) -> Option<i32> {
        if let Some(level) = explicit_level {
            return Some(level);
        }
        let codec_kind = codec
            .and_then(Self::profile_codec_kind_for_codec_name)
            .or_else(|| Self::default_profile_codec_kind_for_format(format_name));
        match codec_kind {
            Some(ProfileCodecKind::Standard) => Some(profile.standard_level()),
            Some(ProfileCodecKind::Zstd) => Some(profile.zstd_level()),
            Some(ProfileCodecKind::NoLevel) | None => None,
        }
    }

    pub(super) fn default_profile_codec_kind_for_format(
        format_name: &str,
    ) -> Option<ProfileCodecKind> {
        let normalized = format_name.trim().to_ascii_lowercase();
        if normalized == "chd" || normalized.starts_with("chd-") {
            return Some(ProfileCodecKind::Standard);
        }
        match normalized.as_str() {
            "zip" | "7z" => Some(ProfileCodecKind::Standard),
            "zst" | "zstd" | "zstandard" => Some(ProfileCodecKind::Zstd),
            "rvz" | "z3ds" => Some(ProfileCodecKind::Zstd),
            _ => None,
        }
    }

    pub(super) fn profile_codec_kind_for_codec_name(codec_name: &str) -> Option<ProfileCodecKind> {
        let codec = codec_name.trim();
        if codec.is_empty() {
            return None;
        }
        compression_metadata()
            .codecs
            .iter()
            .find(|metadata| {
                metadata.name.eq_ignore_ascii_case(codec)
                    || metadata
                        .aliases
                        .iter()
                        .any(|alias| alias.eq_ignore_ascii_case(codec))
            })
            .and_then(|metadata| Self::profile_codec_kind_from_metadata_kind(metadata.profile_kind))
    }

    pub(super) fn profile_codec_kind_from_metadata_kind(kind: &str) -> Option<ProfileCodecKind> {
        match kind {
            "standard" => Some(ProfileCodecKind::Standard),
            "zstd" => Some(ProfileCodecKind::Zstd),
            "none" => Some(ProfileCodecKind::NoLevel),
            _ => None,
        }
    }

    pub(super) fn parse_patch_apply_compression_options(
        no_compress: bool,
        compress_format: Option<String>,
        compress_codec: Vec<String>,
        compress_level: CompressionLevelProfile,
    ) -> Result<PatchApplyCompressionOptions> {
        if no_compress {
            if compress_format.is_some() {
                return Err(RomWeaverError::Validation(
                    "--no-compress cannot be combined with --compress-format".to_string(),
                ));
            }
            if !compress_codec.is_empty() {
                return Err(RomWeaverError::Validation(
                    "--no-compress cannot be combined with --compress-codec".to_string(),
                ));
            }
            return Ok(PatchApplyCompressionOptions {
                enabled: false,
                requested_format: None,
                codec: None,
                level: None,
                profile: CompressionLevelProfile::Max,
            });
        }

        let requested_format = match compress_format {
            Some(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return Err(RomWeaverError::Validation(
                        "--compress-format cannot be empty".to_string(),
                    ));
                }
                Some(trimmed.to_string())
            }
            None => None,
        };
        let (codec, level) = Self::resolve_codec_level(compress_codec, "--compress-codec")?;
        Ok(PatchApplyCompressionOptions {
            enabled: true,
            requested_format,
            codec,
            level,
            profile: compress_level,
        })
    }

    /// Resolve a container output format from an explicit format flag and/or the output path's
    /// extension, per the precedence in the plan: the extension is authoritative when no flag is
    /// given; an explicit flag wins (with a warning) when it disagrees with the extension; and an
    /// extensionless output with no flag is an error. Capability checks (extract-only, registered)
    /// are left to the caller so the existing per-command error messages are reused.
    pub(super) fn resolve_container_output_format(
        &self,
        flag: Option<&str>,
        output: &Path,
        flag_label: &str,
        raw_output_hint: &str,
    ) -> Result<FormatResolution> {
        let extension_display = output
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{value}"));
        let extension_handler = self.containers.find_by_output_extension(output);

        if let Some(flag) = flag {
            let flag_canonical = self
                .containers
                .find_by_name(flag)
                .map(|handler| handler.descriptor().name.to_string());
            let warning = match &extension_display {
                None => None,
                Some(extension) => {
                    let extension_name = extension_handler
                        .as_ref()
                        .map(|handler| handler.descriptor().name);
                    let matches = match (&flag_canonical, extension_name) {
                        (Some(flag_name), Some(extension_name)) => {
                            flag_name.eq_ignore_ascii_case(extension_name)
                        }
                        _ => false,
                    };
                    if matches {
                        None
                    } else {
                        Some(format!(
                            "output extension `{extension}` does not match {flag_label} `{flag}`; writing `{flag}`"
                        ))
                    }
                }
            };
            return Ok(FormatResolution {
                format: flag.to_string(),
                note: format!("explicit format={flag}"),
                warning,
            });
        }

        let Some(extension_display) = extension_display else {
            return Err(RomWeaverError::Validation(format!(
                "output has no file extension; pass {flag_label} <name> or use a supported extension{raw_output_hint}"
            )));
        };
        match extension_handler {
            Some(handler) => {
                let resolved = handler.descriptor().name.to_string();
                Ok(FormatResolution {
                    note: format!("format={resolved} from output extension"),
                    format: resolved,
                    warning: None,
                })
            }
            None => Err(RomWeaverError::Validation(format!(
                "output extension `{extension_display}` is not a supported format; pass {flag_label} <name> or use a supported extension{raw_output_hint}"
            ))),
        }
    }

    pub(super) fn resolve_patch_apply_compression_plan(
        &self,
        requested_output: &Path,
        extension_source: &Path,
        options: &PatchApplyCompressionOptions,
    ) -> Result<PatchApplyCompressionPlan> {
        if !options.enabled {
            return Err(RomWeaverError::Validation(
                "patch-output compression was not enabled".to_string(),
            ));
        }

        let resolution = self.resolve_container_output_format(
            options.requested_format.as_deref(),
            requested_output,
            "--compress-format",
            "; or pass --no-compress to write raw patched bytes",
        )?;

        let handler = self.containers.find_creatable_by_name(&resolution.format)?;
        let resolved_format = handler.descriptor().name.to_string();

        let mut codec = options.codec.clone();
        if codec.is_none() && resolved_format.eq_ignore_ascii_case("7z") {
            codec = Some("lzma2".to_string());
        }
        let level = Self::resolve_compression_level_for_profile(
            &resolved_format,
            Self::primary_codec_name(codec.as_deref()),
            options.level,
            options.profile,
        );

        // Only append the container extension when the user gave an extensionless output name. A
        // name that already carries an extension (matching, or an explicit --compress-format that
        // deliberately mismatches) is written exactly as requested.
        let (output_path, extension_appended) = if requested_output.extension().is_none() {
            Self::append_output_extension_if_missing(
                requested_output,
                handler.descriptor().extensions,
                Some(extension_source),
            )
        } else {
            (requested_output.to_path_buf(), false)
        };

        if let Some(warning) = resolution.warning.as_deref() {
            warn!(
                command = "patch-apply",
                format = %resolved_format,
                output = %output_path.display(),
                "{warning}"
            );
        }

        Ok(PatchApplyCompressionPlan {
            format: resolved_format,
            codec,
            level,
            output_path,
            extension_appended,
            note: resolution.note,
            warning: resolution.warning,
        })
    }

    pub(super) fn append_output_extension_if_missing(
        requested_output: &Path,
        extensions: &[&str],
        source_extension_hint: Option<&Path>,
    ) -> (PathBuf, bool) {
        let Some(primary_extension) = extensions.first().copied() else {
            return (requested_output.to_path_buf(), false);
        };

        let preferred_extension = if extensions
            .iter()
            .any(|extension| extension.eq_ignore_ascii_case(".z3ds"))
        {
            Self::z3ds_compressed_extension_for_path(requested_output)
                .or_else(|| {
                    source_extension_hint.and_then(Self::z3ds_compressed_extension_for_path)
                })
                .unwrap_or(primary_extension)
        } else {
            primary_extension
        };

        let Some(file_name) = requested_output.file_name() else {
            return (requested_output.to_path_buf(), false);
        };
        let file_name_text = file_name.to_string_lossy().to_ascii_lowercase();
        let has_matching_extension = extensions
            .iter()
            .any(|extension| file_name_text.ends_with(&extension.to_ascii_lowercase()));
        if has_matching_extension {
            return (requested_output.to_path_buf(), false);
        }

        let mut appended_name = file_name.to_os_string();
        appended_name.push(preferred_extension);
        let mut appended_path = requested_output.to_path_buf();
        appended_path.set_file_name(appended_name);
        (appended_path, true)
    }

    pub(super) fn z3ds_compressed_extension_for_path(path: &Path) -> Option<&'static str> {
        let extension = path.extension()?.to_str()?.trim().to_ascii_lowercase();
        match extension.as_str() {
            "cia" | "zcia" => Some(".zcia"),
            "3ds" | "z3d" | "z3ds" => Some(".z3ds"),
            "cci" | "zcci" => Some(".zcci"),
            "cxi" | "app" | "zcxi" => Some(".zcxi"),
            "3dsx" | "z3dsx" => Some(".z3dsx"),
            _ => None,
        }
    }

    pub(super) fn normalize_trim_extension(extension: &str) -> Result<String> {
        let extension = extension.trim();
        if extension.is_empty() {
            return Err(RomWeaverError::Validation(
                "--extension cannot be empty".to_string(),
            ));
        }
        if extension.contains('/') || extension.contains('\\') {
            return Err(RomWeaverError::Validation(
                "--extension cannot contain path separators".to_string(),
            ));
        }
        Ok(extension.to_string())
    }

    pub(super) const fn default_trim_extension_pattern(operation: TrimOperation) -> &'static str {
        match operation {
            TrimOperation::Trim => "trim.{ext}",
            TrimOperation::Revert => "untrim.{ext}",
        }
    }
}
